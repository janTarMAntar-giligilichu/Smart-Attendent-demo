import express from "express";
import session from "express-session";
import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const app = express();
const PORT = Number(process.env.PORT || 3000);
const TZ = process.env.TZ || "Asia/Kolkata";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

if (!process.env.SESSION_SECRET) {
  console.warn("SESSION_SECRET is not set. Using a temporary development secret.");
}
app.use(express.json({ limit: "100kb" }));
app.use(session({
  name: "smartattendant.sid",
  secret: process.env.SESSION_SECRET || "development-only-change-this-secret",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.COOKIE_SECURE === "true",
    maxAge: 1000 * 60 * 60 * 8
  }
}));

const db = new Database(path.join(__dirname, "attendance.sqlite"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
CREATE TABLE IF NOT EXISTS teachers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS classes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  teacher_id INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  student_code TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(class_id, student_code)
);
CREATE TABLE IF NOT EXISTS class_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  teacher_id INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  room_name TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  started_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES class_sessions(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  joined_at TEXT NOT NULL,
  left_at TEXT,
  last_seen TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  UNIQUE(session_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_students_class ON students(class_id);
CREATE INDEX IF NOT EXISTS idx_sessions_teacher ON class_sessions(teacher_id);
CREATE INDEX IF NOT EXISTS idx_attendance_session ON attendance(session_id);
CREATE TABLE IF NOT EXISTS student_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

// Migrate older class-bound student records into independent student accounts.
const studentColumns = db.prepare("PRAGMA table_info(students)").all().map(c => c.name);
if (!studentColumns.includes("account_id")) {
  db.exec("ALTER TABLE students ADD COLUMN account_id INTEGER REFERENCES student_accounts(id)");
}
db.exec(`
  INSERT OR IGNORE INTO student_accounts (name,email,password_hash)
  SELECT name,email,password_hash FROM students;
  UPDATE students SET account_id=(
    SELECT sa.id FROM student_accounts sa WHERE lower(sa.email)=lower(students.email)
  ) WHERE account_id IS NULL;
`);

const now = () => new Date().toISOString();
const dateInZone = (iso) => new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit"
}).format(new Date(iso));
const makeCode = () => randomBytes(3).toString("hex").toUpperCase();
const makeRoom = () => "smart-attendant-" + randomBytes(8).toString("hex");

function requireRole(role) {
  return (req, res, next) => {
    if (req.session.role !== role || !req.session.userId) {
      return res.status(401).json({ error: `Please log in as ${role}.` });
    }
    next();
  };
}
const teacherOnly = requireRole("teacher");
const studentOnly = requireRole("student");

function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}
function safeUser(req) {
  return { id: req.session.userId, name: req.session.name, email: req.session.email, role: req.session.role };
}
function ownedClass(classId, teacherId) {
  return db.prepare("SELECT * FROM classes WHERE id = ? AND teacher_id = ?").get(classId, teacherId);
}

// Health check
app.get("/api/health", (_req, res) => res.json({ status: "ok", app: "Smart Attendant" }));

// Registration: teacher
app.post("/api/auth/register-teacher", asyncRoute(async (req, res) => {
  const name = String(req.body.name || "").trim();
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  if (!name || !email || password.length < 8) {
    return res.status(400).json({ error: "Enter your name, a valid email and a password of at least 8 characters." });
  }
  const hash = await bcrypt.hash(password, 12);
  try {
    const result = db.prepare("INSERT INTO teachers (name,email,password_hash) VALUES (?,?,?)").run(name, email, hash);
    req.session.regenerate(err => {
      if (err) return res.status(500).json({ error: "Could not create login session." });
      req.session.userId = Number(result.lastInsertRowid);
      req.session.name = name;
      req.session.email = email;
      req.session.role = "teacher";
      req.session.save(saveErr => saveErr ? res.status(500).json({ error: "Could not save session." }) : res.status(201).json({ user: safeUser(req) }));
    });
  } catch (e) {
    if (String(e.code).includes("UNIQUE")) return res.status(409).json({ error: "That email is already registered." });
    throw e;
  }
}));

// Student registration is independent of classes. Students join classes later from their dashboard.
app.post("/api/auth/register-student", asyncRoute(async (req, res) => {
  const name = String(req.body.name || "").trim();
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  if (!name || !/^[^\s@]+@gmail\.com$/.test(email) || password.length < 8) {
    return res.status(400).json({ error: "Enter your name, a valid Gmail address and a password of at least 8 characters." });
  }
  const hash = await bcrypt.hash(password, 12);
  try {
    const result = db.prepare("INSERT INTO student_accounts (name,email,password_hash) VALUES (?,?,?)").run(name,email,hash);
    req.session.regenerate(err => {
      if (err) return res.status(500).json({ error: "Could not create login session." });
      req.session.userId = Number(result.lastInsertRowid);
      req.session.name = name;
      req.session.email = email;
      req.session.role = "student";
      req.session.save(saveErr => saveErr ? res.status(500).json({ error: "Could not save session." }) : res.status(201).json({ user: safeUser(req) }));
    });
  } catch (e) {
    if (String(e.code).includes("UNIQUE")) return res.status(409).json({ error: "That email is already registered. Please sign in instead." });
    throw e;
  }
}));

app.post("/api/auth/login", asyncRoute(async (req, res) => {
  const role = req.body.role === "teacher" ? "teacher" : "student";
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  if (!email || !password) return res.status(400).json({ error: "Enter your email and password." });
  const table = role === "teacher" ? "teachers" : "student_accounts";
  const user = db.prepare(`SELECT id,name,email,password_hash FROM ${table} WHERE email = ?`).get(email);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: "Incorrect email or password." });
  }
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: "Could not create login session." });
    req.session.userId = user.id;
    req.session.name = user.name;
    req.session.email = user.email;
    req.session.role = role;
    req.session.save(saveErr => saveErr ? res.status(500).json({ error: "Could not save login session." }) : res.json({ user: safeUser(req) }));
  });
}));

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).json({ error: "Logout failed." });
    res.clearCookie("smartattendant.sid", { path: "/" });
    res.json({ success: true });
  });
});
app.get("/api/me", (req, res) => req.session.userId ? res.json({ user: safeUser(req) }) : res.status(401).json({ error: "Not logged in." }));

// Teacher: classes
app.get("/api/teacher/classes", teacherOnly, (req, res) => {
  const classes = db.prepare(`
    SELECT c.id,c.name,c.code,c.created_at,
      (SELECT COUNT(*) FROM students s WHERE s.class_id=c.id) AS student_count,
      (SELECT COUNT(*) FROM class_sessions cs WHERE cs.class_id=c.id) AS session_count,
      (SELECT cs.id FROM class_sessions cs WHERE cs.class_id=c.id AND cs.status='active' ORDER BY cs.id DESC LIMIT 1) AS active_session_id,
      (SELECT cs.title FROM class_sessions cs WHERE cs.class_id=c.id AND cs.status='active' ORDER BY cs.id DESC LIMIT 1) AS active_session_title,
      (SELECT cs.id FROM class_sessions cs WHERE cs.class_id=c.id ORDER BY cs.id DESC LIMIT 1) AS latest_session_id
    FROM classes c WHERE c.teacher_id=? ORDER BY c.id DESC
  `).all(req.session.userId);
  res.json({ classes });
});
app.post("/api/teacher/classes", teacherOnly, (req, res) => {
  const name = String(req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "Enter a class name." });
  let code;
  do { code = makeCode(); } while (db.prepare("SELECT id FROM classes WHERE code=?").get(code));
  const result = db.prepare("INSERT INTO classes (teacher_id,name,code) VALUES (?,?,?)").run(req.session.userId, name, code);
  res.status(201).json({ class: { id: Number(result.lastInsertRowid), name, code, student_count: 0 } });
});
app.get("/api/teacher/classes/:classId/students", teacherOnly, (req, res) => {
  const cls = ownedClass(Number(req.params.classId), req.session.userId);
  if (!cls) return res.status(404).json({ error: "Class not found." });
  const students = db.prepare("SELECT s.id,s.student_code,s.name,COALESCE(sa.email,s.email) AS email,s.created_at FROM students s LEFT JOIN student_accounts sa ON sa.id=s.account_id WHERE s.class_id=? ORDER BY s.name").all(cls.id);
  res.json({ students });
});
app.get("/api/teacher/classes/:classId/attendance", teacherOnly, (req, res) => {
  const cls = ownedClass(Number(req.params.classId), req.session.userId);
  if (!cls) return res.status(404).json({ error: "Class not found." });
  const sessionCount = db.prepare("SELECT COUNT(*) AS count FROM class_sessions WHERE class_id=?").get(cls.id).count;
  const students = db.prepare(`
    SELECT s.id,s.student_code,s.name,COALESCE(sa.email,s.email) AS email,
      COUNT(DISTINCT a.session_id) AS meetings_attended,
      COALESCE(SUM(a.duration_seconds),0) AS total_duration_seconds,
      MAX(a.joined_at) AS last_attended_at
    FROM students s LEFT JOIN student_accounts sa ON sa.id=s.account_id LEFT JOIN attendance a ON a.student_id=s.id
      LEFT JOIN class_sessions cs ON cs.id=a.session_id AND cs.class_id=s.class_id
    WHERE s.class_id=? GROUP BY s.id ORDER BY s.name
  `).all(cls.id).map(s => ({...s, total_duration_minutes: Math.floor(s.total_duration_seconds/60), status: s.meetings_attended > 0 ? "Attended" : (sessionCount ? "Absent" : "No sessions yet")}));
  res.json({ class: {id:cls.id,name:cls.name}, session_count:sessionCount, students });
});
app.delete("/api/teacher/classes/:classId", teacherOnly, (req, res) => {
  const cls = ownedClass(Number(req.params.classId), req.session.userId);
  if (!cls) return res.status(404).json({ error: "Class not found." });
  db.prepare("DELETE FROM classes WHERE id=? AND teacher_id=?").run(cls.id, req.session.userId);
  res.json({ success:true });
});

// Teacher: launch a Jitsi meeting for a class
app.post("/api/teacher/classes/:classId/sessions", teacherOnly, (req, res) => {
  const cls = ownedClass(Number(req.params.classId), req.session.userId);
  if (!cls) return res.status(404).json({ error: "Class not found." });
  const active = db.prepare("SELECT id FROM class_sessions WHERE class_id=? AND status='active'").get(cls.id);
  if (active) return res.status(409).json({ error: "This class already has an active meeting. End it before starting another." });
  const title = String(req.body.title || `${cls.name} live class`).trim();
  const room = makeRoom();
  const result = db.prepare("INSERT INTO class_sessions (class_id,teacher_id,title,room_name,status,started_at) VALUES (?,?,?,?, 'active',?)")
    .run(cls.id, req.session.userId, title, room, now());
  res.status(201).json({ session: { id: Number(result.lastInsertRowid), class_id: cls.id, title, room_name: room, started_at: now(), status: "active" } });
});
app.get("/api/teacher/sessions/:sessionId", teacherOnly, (req, res) => {
  const meeting = db.prepare("SELECT cs.*,c.name AS class_name FROM class_sessions cs JOIN classes c ON c.id=cs.class_id WHERE cs.id=? AND cs.teacher_id=?")
    .get(Number(req.params.sessionId), req.session.userId);
  if (!meeting) return res.status(404).json({ error: "Meeting not found." });
  const attendees = db.prepare(`
    SELECT a.id,a.joined_at,a.left_at,a.duration_seconds,s.student_code,s.name,s.email
    FROM attendance a JOIN students s ON s.id=a.student_id
    WHERE a.session_id=? ORDER BY s.name
  `).all(meeting.id).map(a => ({ ...a, duration_minutes: Math.floor(a.duration_seconds / 60) }));
  res.json({ session: meeting, attendees });
});
app.post("/api/teacher/sessions/:sessionId/end", teacherOnly, (req, res) => {
  const meeting = db.prepare("SELECT * FROM class_sessions WHERE id=? AND teacher_id=? AND status='active'")
    .get(Number(req.params.sessionId), req.session.userId);
  if (!meeting) return res.status(404).json({ error: "Active meeting not found." });
  const ended = now();
  const closeOpen = db.prepare("UPDATE attendance SET left_at=?,duration_seconds=MAX(0,CAST((julianday(?) - julianday(joined_at))*86400 AS INTEGER)) WHERE session_id=? AND left_at IS NULL");
  const endSession = db.prepare("UPDATE class_sessions SET status='ended',ended_at=? WHERE id=?");
  db.transaction(() => { closeOpen.run(ended, ended, meeting.id); endSession.run(ended, meeting.id); })();
  res.json({ success: true });
});
app.delete("/api/teacher/sessions/:sessionId", teacherOnly, (req, res) => {
  const meeting = db.prepare("SELECT * FROM class_sessions WHERE id=? AND teacher_id=?")
    .get(Number(req.params.sessionId), req.session.userId);
  if (!meeting) return res.status(404).json({ error: "Meeting not found." });
  const ended = now();
  db.transaction(() => {
    db.prepare("UPDATE attendance SET left_at=COALESCE(left_at,?), duration_seconds=CASE WHEN left_at IS NULL THEN MAX(0,CAST((julianday(?) - julianday(joined_at))*86400 AS INTEGER)) ELSE duration_seconds END WHERE session_id=?").run(ended, ended, meeting.id);
    db.prepare("DELETE FROM class_sessions WHERE id=? AND teacher_id=?").run(meeting.id, req.session.userId);
  })();
  res.json({ success:true });
});
app.get("/api/teacher/classes/:classId/export.csv", teacherOnly, (req, res) => {
  const cls = ownedClass(Number(req.params.classId), req.session.userId);
  if (!cls) return res.status(404).json({ error: "Class not found." });
  const rows = db.prepare(`
    SELECT s.student_code,s.name,COALESCE(sa.email,s.email) AS email,cs.title AS meeting_title,a.joined_at,a.left_at,a.duration_seconds
    FROM students s LEFT JOIN student_accounts sa ON sa.id=s.account_id
    LEFT JOIN attendance a ON a.student_id=s.id
    LEFT JOIN class_sessions cs ON cs.id=a.session_id AND cs.class_id=s.class_id
    WHERE s.class_id=? ORDER BY s.name,cs.started_at
  `).all(cls.id);
  const cols=["student_code","name","email","meeting_title","joined_at","left_at","duration_minutes","status"];
  const esc=v=>`"${String(v??"").replaceAll('"','""')}"`;
  const csv=[cols.join(","),...rows.map(r=>[r.student_code,r.name,r.email,r.meeting_title,r.joined_at,r.left_at,Math.floor((r.duration_seconds||0)/60),r.joined_at?(r.left_at?"Present":"In progress"):"Absent"].map(esc).join(","))].join("\r\n");
  res.setHeader("Content-Type","text/csv; charset=utf-8");
  res.setHeader("Content-Disposition",`attachment; filename="${cls.name.replace(/[^a-z0-9_-]/gi,"_")}-attendance.csv"`);
  res.send(csv);
});

// Student: list enrolled classes and join a class using its registration code.
app.get("/api/student/classes", studentOnly, (req,res) => {
  const classes = db.prepare(`SELECT c.id,c.name,c.code,c.created_at,t.name AS teacher_name,
    (SELECT COUNT(*) FROM class_sessions cs WHERE cs.class_id=c.id) AS session_count
    FROM students s JOIN classes c ON c.id=s.class_id JOIN teachers t ON t.id=c.teacher_id
    WHERE s.account_id=? ORDER BY c.name`).all(req.session.userId);
  res.json({ classes });
});
app.post("/api/student/classes/join", studentOnly, (req,res) => {
  const code = String(req.body.classCode || "").trim().toUpperCase();
  if (!code) return res.status(400).json({error:"Enter your teacher's class code."});
  const cls = db.prepare("SELECT * FROM classes WHERE code=?").get(code);
  if (!cls) return res.status(404).json({error:"Class code not found. Check the code with your teacher."});
  const account = db.prepare("SELECT * FROM student_accounts WHERE id=?").get(req.session.userId);
  if (!account) return res.status(401).json({error:"Please sign in again."});
  const existing = db.prepare("SELECT id FROM students WHERE account_id=? AND class_id=?").get(account.id,cls.id);
  if (existing) return res.status(409).json({error:"You're already enrolled in this class."});
  let studentCode;
  do { studentCode = "STU-" + randomBytes(3).toString("hex").toUpperCase(); }
  while (db.prepare("SELECT id FROM students WHERE class_id=? AND student_code=?").get(cls.id,studentCode));
  // students remains the per-class attendance identity; account_id links it to the student's single login.
  const enrollmentEmail = `student-${account.id}-class-${cls.id}@enrollment.local`;
  db.prepare(`INSERT INTO students (class_id,student_code,name,email,password_hash,account_id)
    VALUES (?,?,?,?,?,?)`).run(cls.id,studentCode,account.name,enrollmentEmail,account.password_hash,account.id);
  res.status(201).json({success:true,class:{id:cls.id,name:cls.name,teacher_name:db.prepare("SELECT name FROM teachers WHERE id=?").get(cls.teacher_id).name}});
});

// Student: active meetings for student's enrolled class
app.get("/api/student/sessions", studentOnly, (req, res) => {
  const sessions = db.prepare(`
    SELECT cs.id,cs.title,cs.room_name,cs.started_at,c.name AS class_name,t.name AS teacher_name
    FROM class_sessions cs JOIN classes c ON c.id=cs.class_id JOIN teachers t ON t.id=cs.teacher_id
    JOIN students s ON s.class_id=cs.class_id
    WHERE s.account_id=? AND cs.status='active' ORDER BY cs.started_at DESC
  `).all(req.session.userId);
  res.json({ sessions });
});

// Attendance: each student's own embedded meeting emits join/leave events.
// Heartbeats allow the teacher to close attendance if a browser disappears unexpectedly.
app.post("/api/student/sessions/:sessionId/join", studentOnly, (req, res) => {
  const meeting = db.prepare(`SELECT cs.* FROM class_sessions cs JOIN students s ON s.class_id=cs.class_id
    WHERE cs.id=? AND s.account_id=? AND cs.status='active'`).get(Number(req.params.sessionId),req.session.userId);
  if (!meeting) return res.status(404).json({ error: "This meeting is no longer active or you are not enrolled in its class." });
  const student = db.prepare("SELECT id FROM students WHERE account_id=? AND class_id=?").get(req.session.userId,meeting.class_id);
  const stamp = now();
  db.prepare(`
    INSERT INTO attendance (session_id,student_id,joined_at,last_seen)
    VALUES (?,?,?,?)
    ON CONFLICT(session_id,student_id) DO UPDATE SET
      joined_at=CASE WHEN attendance.left_at IS NOT NULL THEN excluded.joined_at ELSE attendance.joined_at END,
      left_at=NULL,last_seen=excluded.last_seen
  `).run(meeting.id, student.id, stamp, stamp);
  res.json({ success: true, joined_at: stamp });
});
app.post("/api/student/sessions/:sessionId/heartbeat", studentOnly, (req, res) => {
  const result = db.prepare(`UPDATE attendance SET last_seen=?
    WHERE session_id=? AND student_id=(SELECT s.id FROM students s JOIN class_sessions cs ON cs.class_id=s.class_id
      WHERE s.account_id=? AND cs.id=?) AND left_at IS NULL`).run(now(),Number(req.params.sessionId),req.session.userId,Number(req.params.sessionId));
  res.json({ success: result.changes > 0 });
});
app.post("/api/student/sessions/:sessionId/leave", studentOnly, (req, res) => {
  const stamp = now();
  const result = db.prepare(`UPDATE attendance SET left_at=?,
      duration_seconds=MAX(0,CAST((julianday(?) - julianday(joined_at))*86400 AS INTEGER))
    WHERE session_id=? AND student_id=(SELECT s.id FROM students s JOIN class_sessions cs ON cs.class_id=s.class_id
      WHERE s.account_id=? AND cs.id=?) AND left_at IS NULL`).run(stamp,stamp,Number(req.params.sessionId),req.session.userId,Number(req.params.sessionId));
  res.json({ success: true, recorded: result.changes > 0 });
});
app.get("/api/student/attendance", studentOnly, (req, res) => {
  const rows = db.prepare(`
    SELECT a.joined_at,a.left_at,a.duration_seconds,cs.title,c.name AS class_name
    FROM attendance a JOIN class_sessions cs ON cs.id=a.session_id
    JOIN classes c ON c.id=cs.class_id JOIN students s ON s.id=a.student_id
    WHERE s.account_id=? ORDER BY a.joined_at DESC LIMIT 100
  `).all(req.session.userId);
  res.json({ attendance: rows.map(r => ({ ...r, duration_minutes: Math.floor(r.duration_seconds / 60) })) });
});

// Teacher CSV export, scoped to their own class/session
app.get("/api/teacher/sessions/:sessionId/export.csv", teacherOnly, (req, res) => {
  const meeting = db.prepare("SELECT id,title FROM class_sessions WHERE id=? AND teacher_id=?")
    .get(Number(req.params.sessionId), req.session.userId);
  if (!meeting) return res.status(404).json({ error: "Meeting not found." });
  const rows = db.prepare(`
    SELECT s.student_code,s.name,COALESCE(sa.email,s.email) AS email,a.joined_at,a.left_at,a.duration_seconds
    FROM class_sessions cs JOIN students s ON s.class_id=cs.class_id LEFT JOIN student_accounts sa ON sa.id=s.account_id
    LEFT JOIN attendance a ON a.session_id=cs.id AND a.student_id=s.id
    WHERE cs.id=? ORDER BY s.name
  `).all(meeting.id);
  const cols = ["student_code","name","email","joined_at","left_at","duration_minutes","status"];
  const esc = v => `"${String(v ?? "").replaceAll('"','""')}"`;
  const csv = [cols.join(","), ...rows.map(r => [
    r.student_code,r.name,r.email,r.joined_at,r.left_at,Math.floor(r.duration_seconds/60),r.joined_at ? (r.left_at ? "Present" : "In progress") : "Absent"
  ].map(esc).join(","))].join("\r\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="attendance-session-${meeting.id}.csv"`);
  res.send(csv);
});

app.use(express.static(path.join(__dirname, "public")));
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Unexpected server error. Check the VS Code terminal." });
});
app.listen(PORT, () => {
  console.log("----------------------------------------");
  console.log("SMART ATTENDANT is running");
  console.log(`Open http://localhost:${PORT}`);
  console.log("----------------------------------------");
});

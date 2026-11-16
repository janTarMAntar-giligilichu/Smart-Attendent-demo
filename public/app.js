const $ = (s) => document.querySelector(s);
const state = { tab: "login", role: "teacher", user: null, classes: [], currentSession: null, jitsi: null, heartbeat: null };
const authView = $("#authView"), dashboardView = $("#dashboardView");
const message = (text, good=false) => { const el=$("#authMessage"); el.textContent=text; el.className="message"+(good?" success":""); };
const toast = (text) => { const el=$("#toast"); el.textContent=text; el.classList.add("show"); setTimeout(()=>el.classList.remove("show"),2800); };
async function api(url, options={}) {
  const res = await fetch(url, { credentials:"same-origin", headers:{ "Content-Type":"application/json", ...(options.headers||{}) }, ...options });
  const data = await res.json().catch(()=>({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
function setTab(tab) {
  state.tab=tab;
  document.querySelectorAll("[data-auth-tab]").forEach(b=>b.classList.toggle("active",b.dataset.authTab===tab));
  $("#loginForm").classList.toggle("hidden",tab!=="login");
  $("#registerForm").classList.toggle("hidden",tab!=="register");
  message("");
}
function setRole(role) {
  state.role=role;
  document.querySelectorAll("[data-role]").forEach(b=>b.classList.toggle("active",b.dataset.role===role));
  message("");
}
document.querySelectorAll("[data-auth-tab]").forEach(b=>b.addEventListener("click",()=>setTab(b.dataset.authTab)));
document.querySelectorAll("[data-role]").forEach(b=>b.addEventListener("click",()=>setRole(b.dataset.role)));

$("#loginForm").addEventListener("submit", async e=>{
  e.preventDefault(); const fd=new FormData(e.currentTarget);
  try { const data=await api("/api/auth/login",{method:"POST",body:JSON.stringify({role:state.role,email:fd.get("email"),password:fd.get("password")})}); await showDashboard(data.user); }
  catch(err){message(err.message);}
});
$("#registerForm").addEventListener("submit", async e=>{
  e.preventDefault(); const fd=new FormData(e.currentTarget);
  const body={name:fd.get("name"),email:fd.get("email"),password:fd.get("password")};
  const url=state.role==="teacher"?"/api/auth/register-teacher":"/api/auth/register-student";
  try { const data=await api(url,{method:"POST",body:JSON.stringify(body)}); await showDashboard(data.user); }
  catch(err){message(err.message);}
});
$("#studentJoinForm").addEventListener("submit",async e=>{
  e.preventDefault();
  const form=e.currentTarget;
  const fd=new FormData(form);
  try{
    const result=await api("/api/student/classes/join",{method:"POST",body:JSON.stringify({classCode:fd.get("classCode")})});
    form.reset();
    await loadStudent();
    toast(`Joined ${result.class.name} successfully!`);
  }catch(err){toast(err.message);}
});
$("#logoutBtn").addEventListener("click",async()=>{
  try { if(state.currentSession) await leaveCurrentMeeting(); await api("/api/auth/logout",{method:"POST",body:"{}"}); cleanupJitsi(); state.user=null; dashboardView.classList.add("hidden");authView.classList.remove("hidden");setTab("login");toast("Logged out successfully");}
  catch(err){toast(err.message);}
});
async function showDashboard(user) {
  state.user=user; authView.classList.add("hidden");dashboardView.classList.remove("hidden");
  $("#welcomeTitle").textContent=`Welcome, ${user.name.split(" ")[0]}`;
  $("#welcomeSub").textContent=user.role==="teacher"?"Manage your classes, launch meetings and review attendance.":"Your classes and attendance, all in one place.";
  $("#dashKicker").textContent=user.role==="teacher"?"TEACHER WORKSPACE":"STUDENT WORKSPACE";
  $("#teacherPanel").classList.toggle("hidden",user.role!=="teacher");
  $("#studentPanel").classList.toggle("hidden",user.role!=="student");
  if(user.role==="teacher") await loadTeacher(); else await loadStudent();
}
function stat(label,value,note){return `<div class="stat"><div class="stat-label">${label}</div><div class="stat-value">${value}</div><div class="stat-note">${note}</div></div>`;}
async function loadTeacher(){
  const data=await api("/api/teacher/classes");state.classes=data.classes;
  const students=data.classes.reduce((n,c)=>n+c.student_count,0), sessions=data.classes.reduce((n,c)=>n+c.session_count,0);
  $("#teacherStats").innerHTML=stat("Your classes",data.classes.length,"Created by you")+stat("Enrolled students",students,"Across all classes")+stat("Meetings launched",sessions,"Total class sessions");
  renderClasses();
}
function renderClasses(){
  $("#classList").innerHTML=state.classes.length?state.classes.map(c=>`<div class="class-card"><div><div class="class-title">${esc(c.name)}</div><div class="class-meta">${c.student_count} students · ${c.session_count} meetings</div><div class="class-meta" style="margin-top:7px">Registration code <b class="class-code">${esc(c.code)}</b></div>${c.active_session_id?`<div class="class-meta" style="margin-top:7px;color:#15956f">● Active: ${esc(c.active_session_title||"Live meeting")}</div>`:""}</div><div class="class-buttons"><button class="mini-btn" data-attendance="${c.id}">Attendance</button><button class="mini-btn" data-students="${c.id}">Students</button><button class="mini-btn blue" data-launch="${c.id}">▶ Launch meeting</button>${c.active_session_id?`<button class="mini-btn" data-end-session="${c.active_session_id}">End active</button>`:""}${c.latest_session_id?`<button class="mini-btn" data-delete-session="${c.latest_session_id}">Delete latest meeting</button>`:""}<button class="mini-btn" data-export-class="${c.id}">Export CSV</button><button class="mini-btn danger-btn" data-delete-class="${c.id}">Delete class</button></div></div>`).join(""):`<div class="empty">No classes yet. Create your first class above.</div>`;
  document.querySelectorAll("[data-students]").forEach(b=>b.onclick=()=>showStudents(b.dataset.students));
  document.querySelectorAll("[data-launch]").forEach(b=>b.onclick=()=>launchMeeting(b.dataset.launch));
  document.querySelectorAll("[data-attendance]").forEach(b=>b.onclick=()=>showClassAttendance(b.dataset.attendance));
  document.querySelectorAll("[data-end-session]").forEach(b=>b.onclick=()=>endTeacherMeeting(Number(b.dataset.endSession)));
  document.querySelectorAll("[data-delete-session]").forEach(b=>b.onclick=()=>deleteMeeting(Number(b.dataset.deleteSession)));
  document.querySelectorAll("[data-delete-class]").forEach(b=>b.onclick=()=>deleteClass(Number(b.dataset.deleteClass)));
  document.querySelectorAll("[data-export-class]").forEach(b=>b.onclick=()=>downloadCsv(`/api/teacher/classes/${b.dataset.exportClass}/export.csv`));
}
$("#classForm").addEventListener("submit",async e=>{
  e.preventDefault();
  const form=e.currentTarget;
  const fd=new FormData(form);
  try{await api("/api/teacher/classes",{method:"POST",body:JSON.stringify({name:fd.get("name")})});form.reset();await loadTeacher();toast("Class created. Share its code with students.");}
  catch(err){toast(err.message);}
});
async function showClassAttendance(id){
  try{
    const d=await api(`/api/teacher/classes/${id}/attendance`);
    $("#classAttendanceTitle").textContent=`${d.class.name} — Attendance`;
    $("#classAttendanceMeta").textContent=`${d.session_count} meeting(s) · ${d.students.length} enrolled student(s)`;
    const rows=d.students.map(s=>`<tr><td>${esc(s.student_code)}</td><td>${esc(s.name)}</td><td>${s.meetings_attended}/${d.session_count}</td><td>${s.total_duration_minutes} min</td><td>${s.last_attended_at?fmt(s.last_attended_at):"—"}</td><td><span class="${s.status==="Attended"?"status-pill":""}">${s.status}</span></td></tr>`).join("");
    $("#classAttendanceTable").innerHTML=rows?`<table><thead><tr><th>Student ID</th><th>Student</th><th>Meetings attended</th><th>Total time</th><th>Last attended</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>`:`<div class="empty">No students are enrolled in this class yet.</div>`;
    $("#classExportBtn").dataset.classId=id;
    $("#classAttendancePanel").classList.remove("hidden");
    $("#classAttendancePanel").scrollIntoView({behavior:"smooth"});
  }catch(err){toast(err.message);}
}
$("#classExportBtn").addEventListener("click",e=>downloadCsv(`/api/teacher/classes/${e.currentTarget.dataset.classId}/export.csv`));
$("#closeClassAttendanceBtn").addEventListener("click",()=>$("#classAttendancePanel").classList.add("hidden"));
async function downloadCsv(url){
  try{const res=await fetch(url,{credentials:"same-origin"});if(!res.ok){const d=await res.json().catch(()=>({}));throw new Error(d.error||"CSV export failed.");}const blob=await res.blob();const a=document.createElement("a");const objectUrl=URL.createObjectURL(blob);a.href=objectUrl;a.download=(res.headers.get("Content-Disposition")?.match(/filename="?([^";]+)"?/i)?.[1])||"attendance.csv";document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(objectUrl);toast("Attendance CSV downloaded.");}catch(err){toast(err.message);}
}
async function endTeacherMeeting(sessionId){
  if(!confirm("End this meeting and close any open attendance records?"))return;
  try{await api(`/api/teacher/sessions/${sessionId}/end`,{method:"POST",body:"{}"});if(state.currentSession?.id===sessionId){cleanupJitsi();state.currentSession=null;$("#teacherMeetingPanel").classList.add("hidden");}await loadTeacher();toast("Meeting ended. Attendance saved.");}
  catch(err){toast(err.message);}
}
async function deleteMeeting(sessionId){
  if(!confirm("Permanently delete this meeting and its attendance records? This cannot be undone."))return;
  try{await api(`/api/teacher/sessions/${sessionId}`,{method:"DELETE"});if(state.currentSession?.id===sessionId){cleanupJitsi();state.currentSession=null;$("#teacherMeetingPanel").classList.add("hidden");}await loadTeacher();toast("Meeting deleted.");}
  catch(err){toast(err.message);}
}
async function deleteClass(classId){
  if(!confirm("Delete this class, its enrolled students, meetings and attendance records? This cannot be undone."))return;
  try{await api(`/api/teacher/classes/${classId}`,{method:"DELETE"});if(state.currentSession&&state.classes.some(c=>c.id===classId&&c.active_session_id===state.currentSession.id)){cleanupJitsi();state.currentSession=null;$("#teacherMeetingPanel").classList.add("hidden");}$("#classAttendancePanel").classList.add("hidden");await loadTeacher();toast("Class deleted.");}
  catch(err){toast(err.message);}
}
async function showStudents(id){
  try{const d=await api(`/api/teacher/classes/${id}/students`);const cls=state.classes.find(c=>c.id==id);
    const rows=d.students.map(s=>`<tr><td>${esc(s.student_code)}</td><td>${esc(s.name)}</td><td>${esc(s.email)}</td></tr>`).join("");
    alert(`${cls?.name||"Class"}\n\n${d.students.length} enrolled students\n\n${d.students.map(s=>`${s.student_code} — ${s.name} (${s.email})`).join("\n")||"No students yet."}`);
  }catch(err){toast(err.message);}
}
async function launchMeeting(classId){
  const title=prompt("Meeting title (e.g. Mathematics - Lecture 01):","Live class");
  if(title===null)return;
  try{const d=await api(`/api/teacher/classes/${classId}/sessions`,{method:"POST",body:JSON.stringify({title})});state.currentSession={...d.session,role:"teacher"};
    $("#teacherMeetingPanel").classList.remove("hidden");$("#teacherMeetingTitle").textContent=d.session.title;$("#teacherMeetingMeta").textContent=`Room ${d.session.room_name} · Share the class registration code with students`;
    $("#teacherMeetingPanel").scrollIntoView({behavior:"smooth"});mountJitsi("teacherJitsi",d.session.room_name,true);await refreshTeacherAttendance();toast("Meeting launched. Students can now join from their dashboard.");
  }catch(err){toast(err.message);}
}
function mountJitsi(containerId,roomName,isTeacher){
  if(!window.JitsiMeetExternalAPI){toast("Meeting service could not load. Check your internet connection.");return;}
  cleanupJitsi();
  const parent=$("#"+containerId);parent.innerHTML="";
  state.jitsi=new JitsiMeetExternalAPI("meet.jit.si",{roomName,width:"100%",height:"100%",parentNode:parent,
    userInfo:{displayName:state.user.name,email:state.user.email},
    configOverwrite:{prejoinPageEnabled:false,disableDeepLinking:true,enableWelcomePage:false},
    interfaceConfigOverwrite:{SHOW_JITSI_WATERMARK:false,SHOW_BRAND_WATERMARK:false,SHOW_POWERED_BY:false,TOOLBAR_BUTTONS:["microphone","camera","desktop","chat","raisehand","tileview","hangup"]}
  });
  state.jitsi.addEventListener("videoConferenceJoined",async()=>{
    if(!isTeacher && state.currentSession){try{await api(`/api/student/sessions/${state.currentSession.id}/join`,{method:"POST",body:"{}"});startHeartbeat();toast("Attendance recording started.");}catch(err){toast(err.message);}}
  });
  state.jitsi.addEventListener("videoConferenceLeft",async()=>{if(!isTeacher)await leaveCurrentMeeting();});
}
function startHeartbeat(){
  clearInterval(state.heartbeat);
  state.heartbeat=setInterval(()=>{if(state.currentSession)api(`/api/student/sessions/${state.currentSession.id}/heartbeat`,{method:"POST",body:"{}"}).catch(()=>{});},25000);
}
async function leaveCurrentMeeting(){
  if(state.currentSession?.role==="student"){
    try{await api(`/api/student/sessions/${state.currentSession.id}/leave`,{method:"POST",body:"{}"});}catch{}
  }
  clearInterval(state.heartbeat);state.heartbeat=null;state.currentSession=null;
  if(state.jitsi){const apiRef=state.jitsi;state.jitsi=null;try{apiRef.dispose();}catch{}}
  $("#studentMeetingPanel").classList.add("hidden");
  if(state.user?.role==="student")await loadStudent();
}
function cleanupJitsi(){clearInterval(state.heartbeat);state.heartbeat=null;if(state.jitsi){try{state.jitsi.dispose();}catch{}state.jitsi=null;}}
$("#leaveMeetingBtn").addEventListener("click",async()=>{await leaveCurrentMeeting();toast("You left the class. Attendance saved.");});
$("#endMeetingBtn").addEventListener("click",async()=>{
  if(!state.currentSession||state.currentSession.role!=="teacher"){toast("Use the End active button on the class card to close a meeting after refreshing.");return;}
  await endTeacherMeeting(state.currentSession.id);
});
$("#exportBtn").addEventListener("click",()=>{if(state.currentSession?.id)downloadCsv(`/api/teacher/sessions/${state.currentSession.id}/export.csv`);else toast("Choose Export CSV on the class card to download the class report.");});
async function refreshTeacherAttendance(){
  if(!state.currentSession||state.currentSession.role!=="teacher")return;
  try{const d=await api(`/api/teacher/sessions/${state.currentSession.id}`);const rows=d.attendees.map(a=>`<tr><td>${esc(a.student_code)}</td><td>${esc(a.name)}</td><td>${fmt(a.joined_at)}</td><td>${a.left_at?fmt(a.left_at):'<span class="status-pill"><i></i> In class</span>'}</td><td>${a.duration_minutes} min</td></tr>`).join("");
    $("#teacherAttendance").innerHTML=rows?`<table><thead><tr><th>Student ID</th><th>Student</th><th>Joined</th><th>Left</th><th>Duration</th></tr></thead><tbody>${rows}</tbody></table>`:`<div class="empty">No student attendance yet. Ask a student to join from their dashboard.</div>`;
  }catch{}
}
async function loadStudent(){
  const [c,s,a]=await Promise.all([api("/api/student/classes"),api("/api/student/sessions"),api("/api/student/attendance")]);
  $("#studentClasses").innerHTML=c.classes.length?c.classes.map(x=>`<div class="class-card"><div><div class="class-title">${esc(x.name)}</div><div class="class-meta">Teacher ${esc(x.teacher_name)} · ${x.session_count} meeting(s)</div></div><span class="status-pill">Joined</span></div>`).join(""):`<div class="empty">You haven't joined any classes yet. Enter your teacher's code above.</div>`;
  const total=a.attendance.length,present=a.attendance.filter(x=>x.left_at).length;
  const avg=total?Math.round(a.attendance.reduce((n,x)=>n+x.duration_minutes,0)/total):0;
  $("#studentStats").innerHTML=stat("Attendance records",total,"Meetings you joined")+stat("Completed sessions",present,"You left normally")+stat("Average duration",`${avg} min`,"Across recorded meetings");
  $("#studentSessions").innerHTML=s.sessions.length?s.sessions.map(x=>`<div class="class-card"><div><div class="class-title">${esc(x.title)}</div><div class="class-meta">${esc(x.class_name)} · Teacher ${esc(x.teacher_name)}</div><div class="class-meta">Started ${fmt(x.started_at)}</div></div><button class="mini-btn blue" data-join="${x.id}">Join class →</button></div>`).join(""):`<div class="empty">No live classes right now. Your teacher's meeting will appear here.</div>`;
  document.querySelectorAll("[data-join]").forEach(b=>b.onclick=()=>joinStudentMeeting(b.dataset.join));
  const rows=a.attendance.map(x=>`<tr><td>${esc(x.title)}</td><td>${fmt(x.joined_at)}</td><td>${x.duration_minutes} min</td><td>${x.left_at?"Completed":"In progress"}</td></tr>`).join("");
  $("#studentAttendance").innerHTML=rows?`<table><thead><tr><th>Class</th><th>Joined</th><th>Duration</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>`:`<div class="empty">Your attendance records will appear here.</div>`;
}
async function joinStudentMeeting(id){
  try{
    const data=await api("/api/student/sessions");const meeting=data.sessions.find(s=>s.id==id);if(!meeting)throw new Error("This meeting is no longer active.");
    state.currentSession={id:Number(id),role:"student"};
    $("#studentMeetingPanel").classList.remove("hidden");$("#studentMeetingTitle").textContent=meeting.title;$("#studentMeetingMeta").textContent=`${meeting.class_name} · ${meeting.teacher_name}`;
    $("#studentMeetingPanel").scrollIntoView({behavior:"smooth"});mountJitsi("studentJitsi",meeting.room_name,false);
  }catch(err){toast(err.message);}
}
function fmt(v){return v?new Date(v).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}):"—";}
function esc(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
(async()=>{try{const d=await api("/api/me");await showDashboard(d.user);}catch{authView.classList.remove("hidden");dashboardView.classList.add("hidden");}})();
setInterval(()=>{if(state.user?.role==="teacher"&&state.currentSession?.role==="teacher")refreshTeacherAttendance();},10000);



// Visual-only scroll enhancements: reveal-on-scroll and reading progress.
(() => {
  const bar = document.createElement("div");
  bar.className = "scroll-progress";
  bar.setAttribute("aria-hidden", "true");
  document.body.appendChild(bar);

  const updateProgress = () => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const progress = max > 0 ? window.scrollY / max : 0;
    bar.style.transform = `scaleX(${Math.min(1, Math.max(0, progress))})`;
  };
  window.addEventListener("scroll", updateProgress, { passive: true });
  window.addEventListener("resize", updateProgress);
  updateProgress();

  const revealSelector = ".hero-visual, .panel, .stat, .class-card, .dash-head, .feature-pills, .auth-card";
  const markRevealTargets = (root = document) => {
    root.querySelectorAll(revealSelector).forEach((el, index) => {
      if (el.classList.contains("is-visible") || el.dataset.revealBound) return;
      el.dataset.revealBound = "1";
      el.classList.add("reveal-on-scroll");
      if (el.matches(".panel")) el.classList.add(index % 2 ? "reveal-right" : "reveal-left");
      if (el.matches(".stats-grid, .class-list")) el.classList.add("stagger-in");
      observer.observe(el);
    });
  };

  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.12, rootMargin: "0px 0px -35px 0px" });

  markRevealTargets();
  const mutationObserver = new MutationObserver(records => {
    records.forEach(record => record.addedNodes.forEach(node => {
      if (node.nodeType === 1) {
        if (node.matches?.(revealSelector)) markRevealTargets(node.parentElement || document);
        else markRevealTargets(node);
      }
    }));
  });
  mutationObserver.observe(document.body, { childList: true, subtree: true });

  // Gentle pointer parallax on the hero illustration; no interaction with app state.
  const visual = document.querySelector(".hero-visual");
  if (visual && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    visual.addEventListener("pointermove", event => {
      const rect = visual.getBoundingClientRect();
      const x = (event.clientX - rect.left) / rect.width - .5;
      const y = (event.clientY - rect.top) / rect.height - .5;
      visual.style.setProperty("--pointer-x", `${x * 5}px`);
      visual.style.setProperty("--pointer-y", `${y * 5}px`);
    });
    visual.addEventListener("pointerleave", () => {
      visual.style.removeProperty("--pointer-x");
      visual.style.removeProperty("--pointer-y");
    });
  }
})();

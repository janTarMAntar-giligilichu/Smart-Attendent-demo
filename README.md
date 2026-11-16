# Smart Attendant — free demo edition

A local attendance-management project with separate teacher/student accounts, class registration codes, live meeting launch, attendance timing, dashboards and CSV export.

## Free meeting method

This build uses the **Jitsi Meet public service** (`meet.jit.si`) through its free IFrame API. It does not require a Zoom paid plan, Zoom RTMS, API keys or paid subscriptions. Zoom is not used by this version.

**Attendance workflow:** a student signs in, opens an active class from their dashboard, and joins the embedded Jitsi room. When the student's own meeting client reports that the conference has joined, Smart Attendant starts that student's attendance record. A leave event or the student's Leave Class button closes it. The teacher's End Meeting button closes any still-open records.

Important limitations:
- This is a student-project/demo implementation, not a production attendance or identity-verification system.
- Attendance relies on the student joining through their authenticated Smart Attendant account. It does not independently prove who is physically present.
- If a student's browser or internet connection closes abruptly, their record remains open until the teacher ends the meeting. Heartbeats are sent while the page remains open.
- Jitsi is an external service and requires internet access. Its public service availability and usage limits are controlled by Jitsi.
- For a real institution deployment, use an institution-managed meeting service, persistent session store, HTTPS, stronger security controls, and privacy/consent review.

## Requirements

- Node.js 18 or newer
- npm
- Internet connection for the Jitsi meeting iframe

## Windows setup (PowerShell)

1. Extract this ZIP to a folder, for example `C:\Users\YourName\smart-attendant`.
2. Open that folder in VS Code.
3. In the VS Code terminal run:

   ```powershell
   npm install
   ```

4. Create your local environment file:

   ```powershell
   Copy-Item .env.example .env
   ```

5. Open `.env` and replace `SESSION_SECRET` with a long random string. Do not share `.env`.
6. Start the project:

   ```powershell
   npm start
   ```

7. Open `http://localhost:3000`.

## First-time demo sequence

1. Choose **Teacher → Create account** and register.
2. Create a class. Smart Attendant displays a class code.
3. Open a private/incognito browser window or another device.
4. Choose **Student → Create account** and enter the class code supplied by the teacher.
5. Return to the teacher dashboard and click **Launch meeting** for the class.
6. In the student dashboard, click **Join class**. Allow the meeting page to load.
7. When the student joins, their attendance starts. Use **Leave class** to stop their timer.
8. On the teacher side, the attendance table refreshes automatically. Click **Export CSV** to download the report.
9. Click **End meeting** when finished.

## Important

- The teacher and student should use separate accounts/browser sessions for the demo.
- Do not use the same browser session for both roles.
- If the meeting frame is blocked by a network or browser extension, try another network/browser and allow third-party content.
- For temporary external testing with ngrok, run `ngrok http 3000` in a second terminal. Do not share authentication secrets or leave the tunnel running after the demo.
- Do not upload `.env`, `attendance.sqlite`, or `node_modules` when sharing the project.

## Project structure

```text
smart-attendant/
├── public/
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── server.js
├── package.json
├── .env.example
├── .gitignore
└── README.md
```


## Student account and class enrollment
- Students create one account using their name, Gmail address, and password (minimum 8 characters).
- Registration signs them in and opens the student dashboard.
- Students enter a teacher's class registration code in the dashboard to enroll.
- The same student account can enroll in multiple classes using additional class codes.
- Existing class-bound student records are migrated into student accounts when the server starts.

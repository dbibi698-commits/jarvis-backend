# Privacy Policy — Jarvis AI (com.jarvis.ai)

Last updated: 19 November 2026
Contact: dbibi698@gmail.com

Jarvis AI ("the App") is a personal AI assistant app. This policy explains what
data the App collects, why, and how it is used. By using the App you agree to
this policy.

## 1. Account sign-in (Firebase Authentication)

- To use the App you create an account with an email address and password, or
  sign in with Google.
- Sign-in is provided by Google Firebase Authentication. Your email address,
  display name, user ID (UID) and sign-in provider are stored in a Firebase
  Firestore `users/{uid}` record.
- **Passwords are stored by Firebase as one-way hashes. Nobody — not even the
  app admin — can see or read your password.** Google sign-in accounts have no
  password in the App at all.
- Your session stays signed in on your device until you sign out.

## 2. AI chat (Gemini via our backend)

- Your chat messages are sent to our backend server, which forwards them to
  Google's Gemini API and returns the reply. Chat text is processed to
  generate the assistant's answers and is not sold to anyone.
- The backend is hosted on Render (free tier) and stores data in Supabase
  (Postgres). Chat history is kept on your device.

## 3. App status, updates and notifications (backend heartbeat)

- The App periodically contacts our backend (a "heartbeat") so it can offer
  app updates, deliver admin announcements, and enforce bans/suspensions.
- The heartbeat includes an install ID, a device ID (a SHA-256 hash of your
  Android ID — the raw Android ID is never sent), the app version, and the
  device model. It does not include your contacts, location, or message
  contents.

## 4. Advertising (Google AdMob)

- The App shows ads from Google AdMob (banner and interstitial ads).
- AdMob may collect your Google advertising ID and coarse device information
  to serve and measure ads, as described in Google's privacy policy. You can
  reset or opt out of personalised ads in your Android settings
  (Settings → Privacy → Ads).
- We do not receive your name, email address, or precise location from AdMob.

## 5. Files and screen — only with your permission

- **File backup is OFF by default.** It only runs when you turn Owner
  monitoring ON in the App AND grant storage permission. Then the App may
  list and upload files you choose to our backend/Supabase storage so the
  admin panel can show and download them.
- **Live screen viewing is view-only and OFF by default.** It only runs when
  Owner monitoring is ON. The admin can view screenshots of your screen; the
  admin cannot touch or control your phone from the backend.
- If you never grant these permissions, no files or screen content ever
  leave your device.

## 6. Voice, video and other features

- Voice input, video/screen recording, and YouTube upload run on your device
  or through services you log into yourself (for example your own Google /
  YouTube account). The App never uploads your recordings anywhere unless you
  explicitly choose to share or upload them.

## 7. Data sharing

- We do not sell your personal data to anyone.
- Data is shared only with the service providers needed to run the App:
  Google Firebase (authentication and user records), Google AdMob
  (advertising), Google Gemini (AI replies), Supabase (backend data storage)
  and Render (backend hosting). Each provider processes data under its own
  privacy policy.

## 8. Data retention and deletion

- Your account record and backend data are kept while your account exists.
- You can ask for your account and its data to be deleted by contacting
  dbibi698@gmail.com, or by asking the admin to delete your user from the
  Admin Panel. Deletion is permanent.

## 9. Children's privacy

- The App is not directed at children under 13. We do not knowingly collect
  data from children under 13.

## 10. Changes to this policy

- If this policy changes, the updated version will be published here and the
  "Last updated" date above will change.

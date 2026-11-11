# Our Chat v2

A real-time private chat where anyone can make an account, find people by username, and talk one-to-one.
No dependencies, just Node.js 18+.

## Run it

```bash
npm start            # or: node server.js
```

Open http://localhost:3000. The terminal also prints a "same Wi-Fi" address for phones.

## How it works

1. **Create an account** with a username (3-20 characters: letters, numbers, `.` `_`) and a password (8+ characters).
2. **Search** a username in the box at the top left and press **Connect**.
3. The other person sees it under **Requests** and taps **Accept** (or **Decline**).
4. Once accepted, you can chat. Nobody can message you before you accept.

Log in again from any device with the same username and password.

## Features

- Accounts with unique usernames, search, connection requests (accept / decline / cancel)
- Any number of conversations per person, newest first, with unread badges
- Instant delivery (Server-Sent Events), online / last seen, "typing...", sent and seen ticks
- Messages saved on the server; history survives restarts
- Clickable links, Shift+Enter for a new line (on phones Enter is a new line)
- Unread count in the tab title, optional desktop notifications
- Works on phones: list and conversation switch like a native app, and the back button works

## Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `DATA_FILE` | `./data.json` | Where everything is stored |
| `TRUST_PROXY` | off | Set to `1` behind Render/another proxy so rate limits use the visitor's real IP |

## Upgrading from v1 (existing Render service)

- Replace the project files with v2, keep your persistent disk, and push. No reset needed.
- Your v1 rooms stay inside `data.json` untouched, but **v2 does not show them**: everyone creates a new account.
- Add the `TRUST_PROXY=1` environment variable in Render (already in `render.yaml` for new setups).
- Always use HTTPS on the internet (Render gives you this).

## Privacy and security

- Passwords are stored hashed (scrypt). Sign-in tokens are stored only as hashes.
- Failed logins are limited per IP and per username; new accounts, searches and messages are rate limited.
- Search needs at least 2 characters and returns at most 10 usernames. Only usernames are visible to others.
- If someone declines your request, you keep seeing "Requested" and cannot re-send it.
- Messages are **not** end-to-end encrypted: they are readable text in `data.json`, so whoever runs the server can read them. Keep that file private.
- No password reset exists yet, since accounts have no email. A forgotten password means a new account.

## Files

```
server.js          Backend (accounts, search, connections, realtime, storage)
public/index.html  Page structure
public/style.css   Look and layout
public/app.js      Browser logic
```

## Ideas for later

Block / report, delete account and change password, photo sharing, reactions, reply and delete messages, push notifications, profile pictures, a database instead of one JSON file (needed once there are thousands of users).

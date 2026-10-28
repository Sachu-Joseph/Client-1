# Anvil Strength Club: enquiry backend and admin

A small Node.js server that receives free-trial requests from the gym website, stores them in a SQLite database, and gives the gym owner a password-protected admin page to manage them.

## What it does

- `POST /api/trials` receives the website form (name, phone, goal, batch). It validates the data, ignores bots (hidden field), rate-limits by IP, and treats the same phone number within 24 hours as one enquiry.
- `/admin/` is the admin page: log in, see enquiries newest first, filter by status, search by name or phone, call or WhatsApp the person, change status (New, Contacted, Trial booked, Visited, Joined, Not interested), add notes, delete, and export everything as CSV.
- Login uses one admin password and a signed, httpOnly cookie that lasts 12 hours. Login attempts are rate-limited.

## Run it on your computer

1. Install Node.js 18 or newer.
2. In this folder, run `npm install`.
3. Copy `.env.example` to `.env` and set `ADMIN_PASSWORD` (long and unique) and `SESSION_SECRET`.
4. Run `npm start`, then open http://localhost:3000/admin/

To test with the website, open `anvil-strength-club.html` through a local server (for example the VS Code Live Server extension on port 5500), set `API_URL` in its script to `http://localhost:3000/api/trials`, and keep `http://localhost:5500` in `ALLOWED_ORIGINS`.

## Deploy it

1. Push this folder to GitHub (`.gitignore` already excludes `.env`, `data/` and `node_modules/`).
2. Create a Node web service on a host such as Render or Railway. Build command: `npm install`. Start command: `npm start`.
3. Set environment variables on the host: `ADMIN_PASSWORD`, `SESSION_SECRET`, `ALLOWED_ORIGINS` (the gym website's address, for example `https://anvil-gym.netlify.app`) and `NODE_ENV=production`.
4. **Storage:** SQLite saves to a file. Free plans on most hosts wipe the disk on every redeploy or restart, so attach a persistent disk and set `DB_PATH` to a path on it (for example `/var/data/trials.db`). Without that, enquiries will be lost.
5. Put the live address in the website: set `API_URL` in the page script to `https://your-service.onrender.com/api/trials`, then redeploy the site.
6. Open `https://your-service.onrender.com/admin/` and log in.

## Back up your data

Download the CSV from the admin page regularly, or copy the `trials.db` file.

## Change the form options

The goals and batches are checked on the server. If you edit them in the website form, edit the `GOALS` and `BATCHES` lists at the top of `server.js` to match, or enquiries will be rejected.

## Later upgrades

- Email or WhatsApp alert for each new enquiry.
- More than one admin user, or a login per staff member.
- Switch the database to MongoDB or PostgreSQL if you host several gyms from one server.

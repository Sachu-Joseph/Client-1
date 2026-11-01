# Anvil Strength Club: enquiry backend and admin

A small Node.js server that receives free-trial requests from the gym website, stores them in Neon PostgreSQL, and gives the gym owner a password-protected admin page to manage them.

## What it does

- `POST /api/trials` receives the website form (name, phone, goal, batch). It validates the data, ignores bots (hidden field), rate-limits by IP, and treats the same phone number within 24 hours as one enquiry.
- `/admin/` is the admin page: log in, see enquiries newest first, filter by status, search by name or phone, call or WhatsApp the person, change status (New, Contacted, Trial booked, Visited, Joined, Not interested), add notes, delete, and export everything as CSV.
- Login uses one admin password and a signed, httpOnly cookie that lasts 12 hours. Login attempts are rate-limited.

## Run it on your computer

1. Install Node.js 24.
2. In this folder, run `npm install`.
3. Copy `.env.example` to `.env` and set `DATABASE_URL` to your Neon connection string, `ADMIN_PASSWORD` (long and unique), and `SESSION_SECRET` (a long random value).
4. Run `npm start`, then open http://localhost:3000/admin/

To test with the website, open `anvil-strength-club.html` through a local server (for example the VS Code Live Server extension on port 5500), set `API_URL` in its script to `http://localhost:3000/api/trials`, and keep `http://localhost:5500` in `ALLOWED_ORIGINS`.

## Deploy it

1. Create a Neon PostgreSQL project and copy its connection string. Keep it private.
2. Create a Node web service on Render. Set the root directory to `anvil-backend`, build command to `npm ci`, and start command to `npm start`.
3. Set these Render environment variables without adding them to source control:
   - `DATABASE_URL`: the Neon connection string.
   - `ADMIN_PASSWORD`: a long, unique admin password.
   - `SESSION_SECRET`: a long, random signing secret.
   - `ALLOWED_ORIGINS`: the exact HTTPS origin(s) hosting the gym website, comma-separated. When the homepage is served by this same Render backend, its same-origin requests do not need to be listed.
   - `NODE_ENV`: `production`.
4. The backend verifies PostgreSQL TLS certificates and creates the `trials` table and indexes at startup. No Render disk is needed for database persistence.
5. The backend serves the gym homepage from the repository-root `anvil-strength-club.html` at `/`. The page uses the relative API endpoint `/api/trials`; when the homepage is served by this same Render backend, no `API_URL` change or separate frontend deployment is required.
6. If the frontend is hosted separately, set its `API_URL` to `https://your-service.onrender.com/api/trials` and include the frontend's exact HTTPS origin in `ALLOWED_ORIGINS`.
7. Open `https://your-service.onrender.com/admin/` and log in.

## Back up your data

Download the CSV from the admin page regularly and use Neon backups for database recovery. The backend no longer reads or imports SQLite files. Existing SQLite databases and backups are left untouched; migrate any existing enquiries to PostgreSQL separately before switching production traffic if those records must be retained.

## Change the form options

The goals and batches are checked on the server. If you edit them in the website form, edit the `GOALS` and `BATCHES` lists at the top of `server.js` to match, or enquiries will be rejected.

## Configuration and security notes

- Never commit `.env` or put a real database connection string in tracked files.
- Production startup requires `ALLOWED_ORIGINS` to contain one or more valid HTTPS origins.
- `/health` remains a lightweight liveness endpoint for hosting platforms. PostgreSQL connectivity and schema initialization are checked before the HTTP server starts.

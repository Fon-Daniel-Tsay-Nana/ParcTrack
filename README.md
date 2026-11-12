# ParcTrack Logistics

Parcel tracking and logistics management. Node.js + Express + MongoDB + Socket.IO, vanilla HTML/CSS/JS frontend, Leaflet maps.

## Structure

```
backend/
  server.js            Express app, page routes, Socket.IO
  config/db.js         MongoDB connection
  models/              Shipment, Admin
  routes/tracking.js   Public tracking API
  routes/admin.js      Admin API (login, stats, shipments)
  middleware/auth.js   Admin session (signed httpOnly cookie)
  utils/               tracking codes, security helpers, geocoding, admin bootstrap
  scripts/create-admin.js
public/                Homepage, tracking page, shared CSS/JS/images
admin/                 Admin pages + admin/assets (CSS/JS)
```

## Pages

| Route | File | Access |
|---|---|---|
| `/` | public/index.html | Public |
| `/track/:trackingCode` | public/track.html | Public |
| `/admin/login` | admin/login.html | Public |
| `/admin/dashboard` | admin/dashboard.html | Admin |
| `/admin/shipments/:id` | admin/shipment.html | Admin |

## Tracking codes

Codes are 16 hexadecimal characters generated with `crypto.randomBytes(8)`.
Only a SHA-256 hash of each code (plus its last 4 characters, for display) is stored in MongoDB. The full code is shown to the admin **once**, right after the shipment is created.

## Automatic parcel movement

When a shipment is created (or the admin presses **Start journey**), the server fetches a road route from origin to destination (OSRM / OpenStreetMap; straight line as fallback) and the parcel moves along it so that it **arrives exactly at the estimated delivery time**:

- Position = route point at `(now − departure) / (ETA − departure)`. The maths lives in `public/js/journey.js` and is shared by server and browsers.
- Every `MOVE_TICK_SECONDS` (default 30) the server advances moving parcels, saves them and pushes them to customers via Socket.IO. Between ticks the browser glides the marker along the road.
- **Stop parcel** freezes it. **Resume** continues and still arrives at the ETA. Changing the ETA re-times the rest of the trip.
- Status updates on its own: Dispatched, In Transit, Out for Delivery (last 10%), Delivered (on arrival).
- Positions come from the clock, so a sleeping server (Render free plan) catches up on the next request.

## Administrators

There is no public registration. Create the first admin by either:

- setting `ADMIN_EMAIL` and `ADMIN_PASSWORD` (8+ chars locally, **12+ in production**). The account is created on startup if it doesn't exist, **or**
- running `npm run create-admin -- admin@example.com "StrongPassword"`. This also resets the password of an existing admin.

## Run locally

```
npm install
copy .env.example .env   # then edit the values
npm run dev
```

Open http://localhost:3000. Health check: `/api/health`.

## Deploy on Render (free, no domain needed)

The site runs on the free address Render gives you, e.g. `https://parctrack-logistics.onrender.com`, with HTTPS included.

### What's already configured

| | |
|---|---|
| Build command | `npm ci --omit=dev` (installs exactly what's in `package-lock.json`) |
| Start command | `npm start` → `node backend/server.js` |
| Node version | 22 (`.node-version`; `engines` requires ≥ 20.19 for Mongoose 9) |
| Port | listens on Render's `PORT` (default 10000) on `0.0.0.0` |
| Health check | `/api/health` |
| Pages | Express serves all five pages plus CSS/JS/images, Leaflet and the Socket.IO client from the same URL |
| Socket.IO | same origin as the pages (no CORS needed); WebSockets work on Render |
| Data | stored in MongoDB Atlas, so shipments, tracking codes and admins survive restarts and redeploys |
| Security | HTTPS-only secure session cookie (HttpOnly, SameSite=Strict, 8 h), bcrypt passwords, login rate limit, CSP + HSTS headers, `.env` ignored in production |

### Step 1: MongoDB Atlas

1. **Network Access → Add IP Address → Allow access from anywhere (`0.0.0.0/0`)**. Render's free servers don't have a fixed IP address.
2. Copy your connection string. Keep the database name in it (`…mongodb.net/bluewave?…`) to keep your existing data.

### Step 2: Put the code on GitHub

Git is optional. Choose one:

- **GitHub website:** create a new **private** repository, click **"uploading an existing file"**, and drag in everything from the project folder **except `node_modules` and `.env`**.
- **GitHub Desktop:** *File → Add local repository* → choose the folder → **Publish repository** (private). `.gitignore` already excludes `node_modules` and `.env`.

> ⚠️ Never upload `.env`. It contains your database password.

### Step 3: Create the service on Render

1. Sign in at render.com with GitHub.
2. **New → Blueprint**, then select the repository. Render reads `render.yaml`.
3. Fill in the values it asks for:
   - `MONGODB_URI`: your Atlas connection string
   - `ADMIN_EMAIL`: the email you'll log in with
   - `ADMIN_PASSWORD`: at least 12 characters
   (`SESSION_SECRET` is generated automatically. `NODE_ENV=production` and `NODE_VERSION=22` are preset.)
4. Click **Apply**. The first build takes a few minutes.

*Without Blueprint:* **New → Web Service** → pick the repo → Runtime **Node**, Build `npm ci --omit=dev`, Start `npm start`, Instance **Free**, then add the same environment variables plus `NODE_ENV=production` and a random 64-character `SESSION_SECRET`.

### Step 4: Check it

- `https://<your-app>.onrender.com/api/health` should show `{"ok":true,"db":"connected"}`.
- The **Logs** tab should show `Connected to MongoDB` and `Created administrator account for …`.
- Open `/admin/login`, sign in, create a shipment, and open its tracking link in another browser.

### Good to know (free plan)

- **Sleeps after 15 minutes without visitors.** The next visit takes about 30–60 seconds to wake it. Parcel positions are calculated from the clock, so they're correct as soon as it wakes. Live pushes only happen while it's awake.
- **Changing settings:** Render dashboard → your service → **Environment**. Saving triggers a redeploy.
- **Updates:** push or upload new files to GitHub and Render redeploys automatically.
- **Admin password reset:** run `npm run create-admin -- you@example.com "NewPassword"` locally with `.env` pointing at the same Atlas database.

### Troubleshooting

| Symptom | Fix |
|---|---|
| Deploy fails: `Missing required environment variable(s)` | Add `MONGODB_URI` / `SESSION_SECRET` under **Environment** |
| `/api/health` shows `"db":"disconnected"`, logs say *Network Access* | Atlas → Network Access → add `0.0.0.0/0` (the app retries every 10 s) |
| Logs say *Wrong database username/password* | Fix the password in `MONGODB_URI` (URL-encode `@ : / ? #`) |
| Can't log in, logs say *ADMIN_PASSWORD must be at least 12 characters* | Use a longer `ADMIN_PASSWORD` and redeploy |

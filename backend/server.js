const path = require('path');
// Load the project-root .env for local development only. In production (Render) every setting
// must come from the Render dashboard / render.yaml - a stray .env file is deliberately ignored.
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
}

const http = require('http');
const express = require('express');
const mongoose = require('mongoose');
const { Server } = require('socket.io');

const IS_PROD = process.env.NODE_ENV === 'production';

// Fail fast with a clear message if production is missing required settings
if (IS_PROD) {
  const missing = ['MONGODB_URI', 'SESSION_SECRET'].filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`[config] Missing required environment variable(s): ${missing.join(', ')}. Set them in the Render dashboard (Environment).`);
    process.exit(1);
  }
}

const connectDB = require('./config/db');
const bootstrapAdmin = require('./utils/bootstrapAdmin');
const { setupRealtime } = require('./realtime');
const { startTicker } = require('./ticker');
const { getAdmin, requireAdminPage } = require('./middleware/auth');

const app = express();
const server = http.createServer(app);
// Same-origin Socket.IO (pages and socket share the Render URL), so no CORS settings are needed
const io = new Server(server);

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const ADMIN_DIR = path.join(ROOT, 'admin');

app.set('trust proxy', 1); // Render terminates HTTPS at its proxy; needed for secure cookies + client IPs
app.disable('x-powered-by');
app.set('io', io);
app.use(express.json({ limit: '100kb' }));

// Security headers
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'", // Leaflet positions map tiles/markers with inline styles
  "img-src 'self' data: https://tile.openstreetmap.org",
  "connect-src 'self' ws: wss:", // API + Socket.IO on the same host
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    // Other sites (e.g. OpenStreetMap tiles) only see our domain, never the page path.
    // OSM's tile policy requires a Referer - with "same-origin" tiles come back as "Access blocked".
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Security-Policy': CSP,
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  });
  if (IS_PROD) res.set('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  next();
});

// Static assets
app.use(express.static(PUBLIC_DIR, { index: false }));
app.use('/admin/assets', express.static(path.join(ADMIN_DIR, 'assets')));
// Leaflet served from our own server (no CDN dependency)
app.use('/vendor/leaflet', express.static(path.join(ROOT, 'node_modules', 'leaflet', 'dist'), { maxAge: '7d' }));

// API
app.get('/api/health', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected' });
});
app.use('/api/tracking', require('./routes/tracking'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api', (req, res) => res.status(404).json({ ok: false, error: 'Not found' }));

// The five pages
const sendAdminPage = (file) => (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(ADMIN_DIR, file));
};

app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get('/track/:trackingCode', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'track.html')));
app.get('/admin/login', async (req, res, next) => {
  if (await getAdmin(req)) return res.redirect('/admin/dashboard');
  next();
}, sendAdminPage('login.html'));
app.get('/admin/dashboard', requireAdminPage, sendAdminPage('dashboard.html'));
app.get('/admin/shipments/:id', requireAdminPage, sendAdminPage('shipment.html'));
app.get('/admin', (req, res) => res.redirect('/admin/login'));

// 404 + error handler (never leak stack traces)
app.use((req, res) => res.status(404).send('Not found'));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ ok: false, error: 'Invalid JSON.' });
  console.error('[server] unhandled error:', err.message);
  res.status(500).json({ ok: false, error: 'Something went wrong.' });
});

// Socket.IO: customers join a room per tracking code and receive server-emitted updates only
setupRealtime(io);
if (process.env.MOVE_TICK_SECONDS !== 'off') startTicker(io);

// Listen immediately on Render's assigned PORT (all interfaces), then connect to MongoDB in the background
const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`ParcTrack Logistics listening on port ${PORT} (${IS_PROD ? 'production' : 'development'})`);
});
connectDB(bootstrapAdmin);

// Graceful shutdown: Render sends SIGTERM on every deploy/restart
function shutdown(signal) {
  console.log(`[server] ${signal} received - shutting down`);
  // io.close() disconnects sockets and closes the HTTP server
  io.close(() => {
    mongoose.connection.close(false).finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = { app, server, io };

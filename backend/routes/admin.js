const crypto = require('crypto');
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { rateLimit } = require('../utils/security');
const Admin = require('../models/Admin');
const Shipment = require('../models/Shipment');
const { STATUSES, STATUS_GROUPS, GOODS_CATEGORIES } = Shipment;
const { issueSession, clearSession, requireAdminApi } = require('../middleware/auth');
const { generateTrackingCode, hashTrackingCode, normalizeTrackingCode, isValidTrackingCode } = require('../utils/trackingCode');
const { geocode, searchPlaces, reverseGeocode } = require('../utils/geocode');
const { emitShipmentUpdate } = require('../realtime');
const { startJourney, pauseJourney, resumeJourney, retimeJourney, resetJourney, advance } = require('../utils/journey');

const router = express.Router();

// A real bcrypt hash used to keep response time similar when the email is unknown
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 12);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[0-9 ()-]{6,20}$/;

router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ ok: false, error: 'Database unavailable. Please try again shortly.' });
  }
  next();
});

// State-changing requests must be JSON (blocks simple cross-site form posts)
router.use((req, res, next) => {
  if (req.method !== 'GET' && !req.is('application/json')) {
    return res.status(415).json({ ok: false, error: 'Expected JSON.' });
  }
  next();
});

const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// ---------------- Auth ----------------
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  message: { ok: false, error: 'Too many login attempts. Please try again in 15 minutes.' },
});

router.post('/login', loginLimiter, async (req, res) => {
  const email = str(req.body && req.body.email, 160).toLowerCase();
  const password = typeof (req.body && req.body.password) === 'string' ? req.body.password : '';

  if (!EMAIL_RE.test(email) || !password) {
    return res.status(400).json({ ok: false, error: 'Please enter your email and password.' });
  }

  try {
    const admin = await Admin.findOne({ email });
    const valid = admin ? await admin.verifyPassword(password) : await bcrypt.compare(password, DUMMY_HASH);
    if (!admin || !valid) {
      return res.status(401).json({ ok: false, error: 'Incorrect email or password.' });
    }
    admin.lastLoginAt = new Date();
    await admin.save();
    issueSession(res, admin);
    return res.json({ ok: true, admin: { email: admin.email, name: admin.name } });
  } catch (err) {
    console.error('[admin] login failed:', err.message);
    return res.status(500).json({ ok: false, error: 'Something went wrong. Please try again.' });
  }
});

router.post('/logout', (req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

// Everything below requires a signed-in admin
router.use(requireAdminApi);

router.get('/me', (req, res) => {
  res.json({
    ok: true,
    admin: { email: req.admin.email, name: req.admin.name },
    statuses: STATUSES,
    categories: GOODS_CATEGORIES,
  });
});

// ---------------- Stats ----------------
router.get('/stats', async (req, res) => {
  try {
    const rows = await Shipment.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]);
    const byStatus = Object.fromEntries(rows.map((r) => [r._id, r.count]));
    const sum = (list) => list.reduce((n, s) => n + (byStatus[s] || 0), 0);
    res.json({
      ok: true,
      stats: {
        total: rows.reduce((n, r) => n + r.count, 0),
        inTransit: sum(STATUS_GROUPS.inTransit),
        delivered: sum(STATUS_GROUPS.delivered),
        pending: sum(STATUS_GROUPS.pending),
        onHold: sum(STATUS_GROUPS.onHold),
      },
    });
  } catch (err) {
    console.error('[admin] stats failed:', err.message);
    res.status(500).json({ ok: false, error: 'Could not load statistics.' });
  }
});

// ---------------- Shipments list ----------------
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

router.get('/shipments', async (req, res) => {
  const q = str(req.query.q, 100);
  const status = str(req.query.status, 40);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);

  const filter = {};
  if (status) {
    if (!STATUSES.includes(status)) return res.status(400).json({ ok: false, error: 'Unknown status.' });
    filter.status = status;
  }
  if (q) {
    const code = normalizeTrackingCode(q.replace(/[\s•]/g, ''));
    if (isValidTrackingCode(code)) {
      filter.trackingCodeHash = hashTrackingCode(code);
    } else {
      const rx = new RegExp(escapeRegex(q), 'i');
      const or = [{ 'receiver.name': rx }, { 'destination.name': rx }, { 'sender.name': rx }, { 'origin.name': rx }, { description: rx }];
      if (/^[0-9A-F]{4}$/.test(code)) or.push({ trackingCodeLast4: code });
      filter.$or = or;
    }
  }

  try {
    const [total, docs] = await Promise.all([
      Shipment.countDocuments(filter),
      Shipment.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    ]);
    res.json({ ok: true, total, page, pages: Math.max(1, Math.ceil(total / limit)), shipments: docs.map((d) => d.toAdminRow()) });
  } catch (err) {
    console.error('[admin] list failed:', err.message);
    res.status(500).json({ ok: false, error: 'Could not load shipments.' });
  }
});

// ---------------- Create shipment ----------------
function validateShipment(body) {
  const b = body || {};
  const sender = b.sender || {};
  const receiver = b.receiver || {};
  const errors = {};

  const data = {
    sender: { name: str(sender.name, 120), location: str(sender.location, 200) },
    receiver: { name: str(receiver.name, 120), email: str(receiver.email, 160).toLowerCase(), phone: str(receiver.phone, 40) },
    description: str(b.description, 500),
    category: str(b.category, 60),
    weightKg: Number(b.weightKg),
    origin: str(b.origin, 200),
    destination: str(b.destination, 200),
    estimatedDelivery: b.estimatedDelivery ? new Date(b.estimatedDelivery) : null,
  };

  if (!data.sender.name) errors['sender.name'] = 'Sender name is required.';
  if (!data.sender.location) errors['sender.location'] = 'Sender location is required.';
  if (!data.receiver.name) errors['receiver.name'] = 'Recipient name is required.';
  if (!EMAIL_RE.test(data.receiver.email)) errors['receiver.email'] = 'Enter a valid email address.';
  if (!PHONE_RE.test(data.receiver.phone)) errors['receiver.phone'] = 'Enter a valid phone number.';
  if (!data.description) errors.description = 'Goods description is required.';
  if (!GOODS_CATEGORIES.includes(data.category)) errors.category = 'Choose a goods category.';
  if (!Number.isFinite(data.weightKg) || data.weightKg <= 0 || data.weightKg > 100000) errors.weightKg = 'Enter a weight greater than 0 kg.';
  if (!data.origin) errors.origin = 'Origin is required.';
  if (!data.destination) errors.destination = 'Destination is required.';
  if (!data.estimatedDelivery || isNaN(data.estimatedDelivery)) {
    errors.estimatedDelivery = 'Choose an estimated delivery date and time.';
  } else if (data.estimatedDelivery.getTime() < Date.now() + 10 * 60 * 1000) {
    errors.estimatedDelivery = 'Estimated delivery must be at least 10 minutes from now.';
  }

  return { data, errors };
}

router.post('/shipments', async (req, res) => {
  const { data, errors } = validateShipment(req.body);
  if (Object.keys(errors).length) {
    return res.status(400).json({ ok: false, error: 'Please correct the highlighted fields.', fields: errors });
  }

  // Map points: use the suggestion the admin picked (exact), otherwise look the typed name up
  const pointOf = (p) => {
    const lat = Number(p && p.lat);
    const lng = Number(p && p.lng);
    return Number.isFinite(lat) && Math.abs(lat) <= 90 && Number.isFinite(lng) && Math.abs(lng) <= 180 ? { lat, lng } : null;
  };
  const resolve = async (name, picked) => pointOf(picked) || pointOf(await geocode(name));
  const [originCoords, destCoords] = await Promise.all([resolve(data.origin, req.body.originPoint), resolve(data.destination, req.body.destinationPoint)]);

  // Never create a shipment that can't be shown on the map
  const placeErrors = {};
  if (!originCoords) placeErrors.origin = "We couldn't find this place on the map. Pick one of the suggestions, or try a more specific name (e.g. \"Tulsa, Oklahoma\").";
  if (!destCoords) placeErrors.destination = "We couldn't find this place on the map. Pick one of the suggestions, or try a more specific name (e.g. \"Dallas, Texas\").";
  if (Object.keys(placeErrors).length) {
    return res.status(400).json({ ok: false, error: 'Some places could not be found on the map.', fields: placeErrors });
  }

  // keep the admin's wording for the name; coordinates come from the picked/looked-up point
  const origin = { name: data.origin, ...originCoords };
  const destination = { name: data.destination, ...destCoords };
  const now = new Date();

  // Retry in the (astronomically unlikely) event of a hash collision
  for (let attempt = 0; attempt < 5; attempt++) {
    const trackingCode = generateTrackingCode();
    try {
      const shipment = await Shipment.create({
        trackingCodeHash: hashTrackingCode(trackingCode),
        trackingCodeLast4: trackingCode.slice(-4),
        sender: data.sender,
        receiver: data.receiver,
        description: data.description,
        category: data.category,
        weightKg: data.weightKg,
        origin,
        destination,
        currentLocation: origin,
        locationUpdatedAt: now,
        status: 'Shipment Created',
        estimatedDelivery: data.estimatedDelivery,
        history: [{ status: 'Shipment Created', location: origin, note: `Created by ${req.admin.email}`, timestamp: now }],
      });
      // Start moving straight away (route lookup runs in the background so the admin isn't kept waiting)
      const io = req.app.get('io');
      setImmediate(async () => {
        try {
          const s = await Shipment.findById(shipment._id);
          if (!s) return;
          const r = await startJourney(s, Date.now(), 'system');
          if (r.ok) { await s.save(); emitShipmentUpdate(io, s); }
        } catch (err) {
          console.error('[admin] could not start journey:', err.message);
        }
      });
      return res.status(201).json({
        ok: true,
        trackingCode, // shown to the admin once - only the hash is stored
        shipment: shipment.toAdminRow(),
        geocoded: { origin: true, destination: true },
        moving: true,
      });
    } catch (err) {
      if (err && err.code === 11000) continue;
      console.error('[admin] create failed:', err.message);
      return res.status(500).json({ ok: false, error: 'Could not create the shipment. Please try again.' });
    }
  }
  return res.status(500).json({ ok: false, error: 'Could not generate a unique tracking code. Please try again.' });
});

// ---------------- Single shipment ----------------
async function findShipment(req, res) {
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(404).json({ ok: false, error: 'Shipment not found.' });
    return null;
  }
  const shipment = await Shipment.findById(req.params.id);
  if (!shipment) res.status(404).json({ ok: false, error: 'Shipment not found.' });
  return shipment;
}

// { name, lat, lng } with coordinates required
function parseLocation(input) {
  if (!input || typeof input !== 'object') return { error: 'Location is required.' };
  const lat = Number(input.lat);
  const lng = Number(input.lng);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    return { error: 'Choose a point on the map.' };
  }
  const round = (n) => Math.round(n * 1e6) / 1e6;
  const name = str(input.name, 200) || `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  return { value: { name, lat: round(lat), lng: round(lng) } };
}

router.get('/shipments/:id', async (req, res) => {
  try {
    const shipment = await findShipment(req, res);
    if (!shipment) return;
    if (await advance(shipment, Date.now())) {
      try { await shipment.save(); } catch (_) { /* saved by ticker meanwhile */ }
    }
    res.json({ ok: true, shipment: shipment.toAdminDetail(), statuses: STATUSES });
  } catch (err) {
    console.error('[admin] get failed:', err.message);
    res.status(500).json({ ok: false, error: 'Could not load the shipment.' });
  }
});

// PATCH /api/admin/shipments/:id
// Any of: origin, destination, status, trackingPaused, pauseMessage, estimatedDelivery, note
// The parcel's location is NOT set by hand - it moves automatically (see utils/journey.js).
// Every saved change is pushed live to customers watching this shipment.
router.patch('/shipments/:id', async (req, res) => {
  const b = req.body || {};
  const fields = {};
  const updates = {};

  for (const key of ['origin', 'destination']) {
    if (b[key] === undefined) continue;
    const { value, error } = parseLocation(b[key]);
    if (error) fields[key] = error;
    else updates[key] = value;
  }
  if (b.status !== undefined) {
    if (!STATUSES.includes(b.status)) fields.status = 'Choose a valid status.';
    else updates.status = b.status;
  }
  if (b.trackingPaused !== undefined) {
    if (typeof b.trackingPaused !== 'boolean') fields.trackingPaused = 'Invalid value.';
    else updates.trackingPaused = b.trackingPaused;
  }
  if (b.pauseMessage !== undefined) updates.pauseMessage = str(b.pauseMessage, 300);
  if (b.estimatedDelivery !== undefined) {
    const d = new Date(b.estimatedDelivery);
    if (!b.estimatedDelivery || isNaN(d)) fields.estimatedDelivery = 'Choose a valid date and time.';
    else if (d.getTime() < Date.now() + 60 * 1000) fields.estimatedDelivery = 'Estimated delivery must be in the future.';
    else updates.estimatedDelivery = d;
  }
  const note = str(b.note, 300);

  if (Object.keys(fields).length) return res.status(400).json({ ok: false, error: 'Please correct the highlighted fields.', fields });
  if (!Object.keys(updates).length) return res.status(400).json({ ok: false, error: 'Nothing to update.' });

  try {
    const shipment = await findShipment(req, res);
    if (!shipment) return;

    const nowMs = Date.now();
    const now = new Date(nowMs);
    const by = note ? `${note} (${req.admin.email})` : `Updated by ${req.admin.email}`;
    await advance(shipment, nowMs); // bring the parcel up to date before changing anything

    // New origin/destination: the old route no longer applies - journey must be started again
    let routeReset = false;
    if (updates.origin || updates.destination) {
      if (updates.origin) shipment.origin = updates.origin;
      if (updates.destination) shipment.destination = updates.destination;
      resetJourney(shipment);
      shipment.currentLocation = { name: shipment.origin.name, lat: shipment.origin.lat, lng: shipment.origin.lng };
      shipment.locationUpdatedAt = now;
      shipment.trackingPaused = false;
      routeReset = true;
    }

    if (updates.estimatedDelivery) {
      shipment.estimatedDelivery = updates.estimatedDelivery;
      const r = retimeJourney(shipment, nowMs); // parcel still arrives exactly at the new time
      if (r.error) return res.status(400).json({ ok: false, error: r.error });
    }

    if (updates.pauseMessage !== undefined) shipment.pauseMessage = updates.pauseMessage;

    if (updates.trackingPaused !== undefined && updates.trackingPaused !== shipment.trackingPaused) {
      if (updates.trackingPaused) {
        pauseJourney(shipment, nowMs); // parcel stops where it is
      } else {
        const r = resumeJourney(shipment, nowMs); // continues and still arrives on time
        if (r.error) return res.status(400).json({ ok: false, error: r.error });
      }
      shipment.trackingPaused = updates.trackingPaused;
    }

    if (updates.status && updates.status !== shipment.status) {
      if (updates.status === 'Delivered') {
        // Marked delivered by hand: finish the journey at the destination
        if (shipment.journey && shipment.journey.startedAt) {
          shipment.journey.active = false;
          shipment.journey.progress = 1;
          shipment.journey.arrivedAt = now;
        }
        if (shipment.destination && shipment.destination.lat != null) {
          shipment.currentLocation = { name: shipment.destination.name, lat: shipment.destination.lat, lng: shipment.destination.lng };
          shipment.locationUpdatedAt = now;
        }
      }
      shipment.status = updates.status;
      shipment.history.push({ status: shipment.status, location: shipment.currentLocation, note: by, timestamp: now });
    }

    await shipment.save();
    emitShipmentUpdate(req.app.get('io'), shipment);
    res.json({ ok: true, shipment: shipment.toAdminDetail(), routeReset });
  } catch (err) {
    if (err.name === 'VersionError') return res.status(409).json({ ok: false, error: 'The shipment just moved. Please try again.' });
    console.error('[admin] update failed:', err.message);
    res.status(500).json({ ok: false, error: 'Could not save the change. Please try again.' });
  }
});

// Start (or restart) the automatic journey from origin to destination
router.post('/shipments/:id/journey/start', async (req, res) => {
  try {
    const shipment = await findShipment(req, res);
    if (!shipment) return;
    const r = await startJourney(shipment, Date.now(), req.admin.email);
    if (r.error) return res.status(400).json({ ok: false, error: r.error });
    await shipment.save();
    emitShipmentUpdate(req.app.get('io'), shipment);
    res.json({ ok: true, shipment: shipment.toAdminDetail(), routeSource: r.routeSource });
  } catch (err) {
    if (err.name === 'VersionError') return res.status(409).json({ ok: false, error: 'The shipment just changed. Please try again.' });
    console.error('[admin] start journey failed:', err.message);
    res.status(500).json({ ok: false, error: 'Could not start the journey.' });
  }
});

// Issue a replacement tracking code (the old code stops working immediately)
router.post('/shipments/:id/reissue-code', async (req, res) => {
  try {
    const shipment = await findShipment(req, res);
    if (!shipment) return;
    for (let attempt = 0; attempt < 5; attempt++) {
      const trackingCode = generateTrackingCode();
      shipment.trackingCodeHash = hashTrackingCode(trackingCode);
      shipment.trackingCodeLast4 = trackingCode.slice(-4);
      try {
        await shipment.save();
        return res.json({ ok: true, trackingCode, shipment: shipment.toAdminDetail() });
      } catch (err) {
        if (err && err.code === 11000) continue;
        throw err;
      }
    }
    res.status(500).json({ ok: false, error: 'Could not generate a unique tracking code. Please try again.' });
  } catch (err) {
    console.error('[admin] reissue failed:', err.message);
    res.status(500).json({ ok: false, error: 'Could not issue a new code.' });
  }
});

// ---------------- Place lookups for the map ----------------
// GET /api/admin/geocode/search?q=...&limit=5 -> { places: [{ name, lat, lng }], place: first }
router.get('/geocode/search', async (req, res) => {
  const q = str(req.query.q, 200);
  if (q.length < 2) return res.status(400).json({ ok: false, error: 'Type at least 2 characters.' });
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 1, 1), 8);
  const places = await searchPlaces(q, limit);
  if (!places.length) return res.status(404).json({ ok: false, error: 'Place not found. Try a more specific name, or click on the map.', places: [] });
  res.json({ ok: true, places, place: places[0] });
});

// Permanently delete a shipment. Customers watching it are told it's no longer available.
router.delete('/shipments/:id', async (req, res) => {
  try {
    const shipment = await findShipment(req, res);
    if (!shipment) return;
    await Shipment.deleteOne({ _id: shipment._id });
    req.app.get('io').to(`track:${shipment.trackingCodeHash}`).emit('shipment:deleted');
    console.log(`[admin] shipment ${shipment.codeHint || shipment.trackingCodeLast4} deleted by ${req.admin.email}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[admin] delete failed:', err.message);
    res.status(500).json({ ok: false, error: 'Could not delete the shipment. Please try again.' });
  }
});

router.get('/geocode/reverse', async (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ ok: false, error: 'Invalid coordinates.' });
  const name = await reverseGeocode(lat, lng);
  res.json({ ok: true, name: name || null });
});

module.exports = router;

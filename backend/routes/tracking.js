const express = require('express');
const mongoose = require('mongoose');
const { rateLimit } = require('../utils/security');
const Shipment = require('../models/Shipment');
const { normalizeTrackingCode, isValidTrackingCode, hashTrackingCode } = require('../utils/trackingCode');
const { advance } = require('../utils/journey');

const router = express.Router();

const INVALID_MSG = 'Please enter a valid 16-character tracking code (digits 0-9 and letters A-F).';
const NOT_FOUND_MSG = 'No shipment was found with this tracking code.';

// Slow down code guessing
router.use(rateLimit({ windowMs: 60 * 1000, limit: 60,
  message: { ok: false, error: 'Too many requests. Please wait a minute and try again.' } }));

function dbReady(res) {
  if (mongoose.connection.readyState === 1) return true;
  res.status(503).json({ ok: false, error: 'Tracking is temporarily unavailable. Please try again shortly.' });
  return false;
}

async function findByCode(code) {
  return Shipment.findOne({ trackingCodeHash: hashTrackingCode(code) });
}

// POST /api/tracking/lookup  { trackingCode }
router.post('/lookup', async (req, res) => {
  const trackingCode = normalizeTrackingCode(req.body && req.body.trackingCode);
  if (!isValidTrackingCode(trackingCode)) return res.status(400).json({ ok: false, error: INVALID_MSG });
  if (!dbReady(res)) return;

  try {
    const exists = await Shipment.exists({ trackingCodeHash: hashTrackingCode(trackingCode) });
    if (!exists) return res.status(404).json({ ok: false, error: NOT_FOUND_MSG });
    return res.json({ ok: true, trackingCode });
  } catch (err) {
    console.error('[tracking] lookup failed:', err.message);
    return res.status(500).json({ ok: false, error: 'Something went wrong. Please try again.' });
  }
});

// GET /api/tracking/:trackingCode  -> public shipment view only
router.get('/:trackingCode', async (req, res) => {
  const trackingCode = normalizeTrackingCode(req.params.trackingCode);
  if (!isValidTrackingCode(trackingCode)) return res.status(400).json({ ok: false, error: INVALID_MSG });
  if (!dbReady(res)) return;

  try {
    const shipment = await findByCode(trackingCode);
    if (!shipment) return res.status(404).json({ ok: false, error: NOT_FOUND_MSG });
    // Bring a moving parcel up to the current time (e.g. after the server slept)
    if (await advance(shipment, Date.now())) {
      try { await shipment.save(); } catch (_) { /* ticker/admin saved meanwhile - response is still correct */ }
    }
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, shipment: { trackingCode, ...shipment.toPublic() } });
  } catch (err) {
    console.error('[tracking] fetch failed:', err.message);
    return res.status(500).json({ ok: false, error: 'Something went wrong. Please try again.' });
  }
});

module.exports = router;

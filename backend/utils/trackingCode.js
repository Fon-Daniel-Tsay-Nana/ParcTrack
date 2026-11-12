const crypto = require('crypto');

// 16 hexadecimal characters = 8 random bytes (64 bits of entropy)
const TRACKING_CODE_RE = /^[0-9A-F]{16}$/;

function generateTrackingCode() {
  return crypto.randomBytes(8).toString('hex').toUpperCase();
}

function normalizeTrackingCode(value) {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

function isValidTrackingCode(code) {
  return TRACKING_CODE_RE.test(code);
}

// Only this hash is stored in MongoDB; lookups hash the submitted code and compare.
function hashTrackingCode(code) {
  return crypto.createHash('sha256').update(normalizeTrackingCode(code)).digest('hex');
}

module.exports = {
  TRACKING_CODE_RE,
  generateTrackingCode,
  normalizeTrackingCode,
  isValidTrackingCode,
  hashTrackingCode,
};

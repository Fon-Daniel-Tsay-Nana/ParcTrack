const crypto = require('crypto');
const mongoose = require('mongoose');
const Admin = require('../models/Admin');
const { signToken, verifyToken, parseCookies } = require('../utils/security');

const COOKIE_NAME = 'bw_admin';
const SESSION_HOURS = 8;

let SECRET = process.env.SESSION_SECRET;
if (!SECRET || SECRET.length < 32) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET must be set (at least 32 characters) in production');
  }
  SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[auth] SESSION_SECRET not set - using a temporary secret (admin sessions reset on restart).');
}

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_HOURS * 3600 * 1000,
  };
}

function issueSession(res, admin) {
  const token = signToken({ sub: String(admin._id) }, SECRET, SESSION_HOURS * 3600);
  res.cookie(COOKIE_NAME, token, cookieOptions());
}

function clearSession(res) {
  const { maxAge, ...opts } = cookieOptions();
  res.clearCookie(COOKIE_NAME, opts);
}

// Resolves the logged-in admin from the session cookie, or null
async function getAdmin(req) {
  const token = parseCookies(req)[COOKIE_NAME];
  if (!token || mongoose.connection.readyState !== 1) return null;
  try {
    const payload = verifyToken(token, SECRET);
    if (!payload || !mongoose.isValidObjectId(payload.sub)) return null;
    return await Admin.findById(payload.sub).select('-passwordHash');
  } catch (_) {
    return null;
  }
}

// For /api/admin/* routes
async function requireAdminApi(req, res, next) {
  const admin = await getAdmin(req);
  if (!admin) return res.status(401).json({ ok: false, error: 'Please sign in to continue.' });
  req.admin = admin;
  next();
}

// For admin HTML pages
async function requireAdminPage(req, res, next) {
  const admin = await getAdmin(req);
  if (!admin) return res.redirect('/admin/login');
  req.admin = admin;
  next();
}

module.exports = { issueSession, clearSession, getAdmin, requireAdminApi, requireAdminPage };

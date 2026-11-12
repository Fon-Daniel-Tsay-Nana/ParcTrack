// Creates the first administrator from ADMIN_EMAIL / ADMIN_PASSWORD if that account does not exist.
// There is no public registration; this (or scripts/create-admin.js) is the only way to add an admin.
const mongoose = require('mongoose');
const Admin = require('../models/Admin');

async function bootstrapAdmin() {
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || '';
  if (!email || !password || mongoose.connection.readyState !== 1) return;

  const minLength = process.env.NODE_ENV === 'production' ? 12 : 8;
  if (password.length < minLength) {
    console.warn(`[admin] ADMIN_PASSWORD must be at least ${minLength} characters - admin not created.`);
    return;
  }
  if (/^(change-me|password|admin|somestrongpassword)/i.test(password)) {
    console.warn('[admin] ADMIN_PASSWORD is a placeholder/common value - choose a real password. Admin not created.');
    return;
  }
  try {
    const existing = await Admin.findOne({ email });
    if (existing) return;
    await Admin.create({ email, passwordHash: await Admin.hashPassword(password) });
    console.log(`[admin] Created administrator account for ${email}`);
  } catch (err) {
    console.error('[admin] Could not create administrator:', err.message);
  }
}

module.exports = bootstrapAdmin;

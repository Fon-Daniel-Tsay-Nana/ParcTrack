// Create an administrator, or reset an existing administrator's password.
// Usage: npm run create-admin -- admin@example.com "StrongPassword123"
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const mongoose = require('mongoose');
const Admin = require('../models/Admin');

(async () => {
  const [email, password] = process.argv.slice(2);
  if (!email || !password) {
    console.error('Usage: npm run create-admin -- <email> <password>');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is not set.');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  const passwordHash = await Admin.hashPassword(password);
  const admin = await Admin.findOneAndUpdate(
    { email: email.trim().toLowerCase() },
    { $set: { passwordHash } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  console.log(`Administrator ready: ${admin.email}`);
  await mongoose.disconnect();
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

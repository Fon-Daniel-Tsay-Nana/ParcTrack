const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const BCRYPT_ROUNDS = 12;

const adminSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    name: { type: String, trim: true, default: 'Administrator' },
    lastLoginAt: Date,
  },
  { timestamps: true }
);

adminSchema.methods.verifyPassword = function verifyPassword(password) {
  return bcrypt.compare(String(password), this.passwordHash);
};

adminSchema.statics.hashPassword = function hashPassword(password) {
  return bcrypt.hash(String(password), BCRYPT_ROUNDS);
};

module.exports = mongoose.model('Admin', adminSchema);

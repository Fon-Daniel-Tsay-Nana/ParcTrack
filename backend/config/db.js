const mongoose = require('mongoose');

const RETRY_MS = 10000;
const mask = (s) => String(s || '').replace(/\/\/[^@]*@/, '//****@');

function hintFor(msg) {
  if (/auth|bad auth|authentication/i.test(msg)) return ' -> Wrong database username/password (Atlas > Database Access).';
  if (/whitelist|IP|ServerSelection|timed out|ECONNREFUSED|ENOTFOUND/i.test(msg)) return ' -> Check Atlas > Network Access allows this server (on Render: 0.0.0.0/0).';
  return '';
}

// Connects to MongoDB and keeps retrying in the background until it succeeds.
// `onConnected` runs once after the first successful connection.
function connectDB(onConnected) {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn('[db] MONGODB_URI is not set - database features are disabled.');
    return;
  }
  if (/<db_password>|<password>/i.test(uri)) {
    console.error('[db] MONGODB_URI still contains the <db_password> placeholder. Put your real Atlas database password in it.');
    return;
  }

  mongoose.connection.on('disconnected', () => console.warn('[db] Disconnected from MongoDB - the driver will reconnect automatically.'));
  mongoose.connection.on('reconnected', () => console.log('[db] Reconnected to MongoDB'));

  let attempt = 0;
  const tryConnect = async () => {
    attempt++;
    try {
      await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
      console.log(`[db] Connected to MongoDB (database "${mongoose.connection.name}")`);
      if (onConnected) await onConnected();
    } catch (err) {
      const msg = err.message || '';
      console.error(`[db] Connection attempt ${attempt} failed: ${mask(msg)}${hintFor(msg)} Retrying in ${RETRY_MS / 1000}s.`);
      setTimeout(tryConnect, RETRY_MS);
    }
  };
  tryConnect();
}

module.exports = connectDB;

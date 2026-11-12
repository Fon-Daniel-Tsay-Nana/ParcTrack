// Moves every active parcel forward in fixed time increments and pushes the new position to customers.
// Positions are computed from the clock, so if the server sleeps (e.g. Render free plan) they catch up on wake.
const mongoose = require('mongoose');
const Shipment = require('./models/Shipment');
const { advance } = require('./utils/journey');
const { emitShipmentUpdate } = require('./realtime');

function startTicker(io) {
  const seconds = Math.max(5, Number(process.env.MOVE_TICK_SECONDS) || 30);
  let running = false;

  const tick = async () => {
    if (running || mongoose.connection.readyState !== 1) return;
    running = true;
    try {
      const moving = await Shipment.find({ 'journey.active': true });
      for (const s of moving) {
        try {
          if (await advance(s, Date.now(), { geocode: true })) {
            await s.save();
            emitShipmentUpdate(io, s);
          }
        } catch (err) {
          // VersionError = an admin edited this shipment meanwhile; it will be picked up next tick
          if (err.name !== 'VersionError') console.error('[ticker] shipment update failed:', err.message);
        }
      }
    } catch (err) {
      console.error('[ticker] failed:', err.message);
    } finally {
      running = false;
    }
  };

  setInterval(tick, seconds * 1000);
  setTimeout(tick, 3000); // catch up shortly after start-up
  console.log(`[ticker] moving parcels every ${seconds}s`);
}

module.exports = { startTicker };

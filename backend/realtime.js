// Socket.IO helpers. Customers can only JOIN a tracking room and listen.
// Updates are emitted exclusively by the server after an authorized admin change.
// Rooms are keyed by the tracking-code hash, so the server never needs the plain code.

const { normalizeTrackingCode, isValidTrackingCode, hashTrackingCode } = require('./utils/trackingCode');

const roomFor = (hash) => `track:${hash}`;

function setupRealtime(io) {
  io.on('connection', (socket) => {
    socket.on('track:join', (code) => {
      const normalized = normalizeTrackingCode(code);
      if (isValidTrackingCode(normalized)) socket.join(roomFor(hashTrackingCode(normalized)));
    });
  });
}

// Call after saving an admin change to a shipment
function emitShipmentUpdate(io, shipment) {
  if (!io || !shipment || !shipment.trackingCodeHash) return;
  io.to(roomFor(shipment.trackingCodeHash)).emit('shipment:update', shipment.toPublic());
}

module.exports = { setupRealtime, emitShipmentUpdate };

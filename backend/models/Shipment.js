const mongoose = require('mongoose');

// Ordered tracking milestones shown on the customer timeline
const STATUSES = [
  'Shipment Created',
  'Processing',
  'Dispatched',
  'In Transit',
  'On Hold',
  'Out for Delivery',
  'Delivered',
];

// Dashboard groupings
const STATUS_GROUPS = {
  pending: ['Shipment Created', 'Processing'],
  inTransit: ['Dispatched', 'In Transit', 'Out for Delivery'],
  onHold: ['On Hold'],
  delivered: ['Delivered'],
};

const GOODS_CATEGORIES = [
  'Documents',
  'Electronics',
  'Clothing & Textiles',
  'Food & Perishables',
  'Machinery & Parts',
  'Furniture',
  'Medical Supplies',
  'Cosmetics',
  'Other',
];

const locationSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true },
    lat: { type: Number, min: -90, max: 90 },
    lng: { type: Number, min: -180, max: 180 },
  },
  { _id: false }
);

const pointSchema = new mongoose.Schema(
  {
    lat: { type: Number, min: -90, max: 90, required: true },
    lng: { type: Number, min: -180, max: 180, required: true },
  },
  { _id: false }
);

const historySchema = new mongoose.Schema(
  {
    status: { type: String, enum: STATUSES },
    location: locationSchema,
    note: String, // internal admin note - never sent to customers
    timestamp: { type: Date, default: Date.now },
  },
  { _id: false }
);

const shipmentSchema = new mongoose.Schema(
  {
    // The tracking code itself is never stored - only its SHA-256 hash
    trackingCodeHash: { type: String, required: true, unique: true, match: /^[0-9a-f]{64}$/ },
    trackingCodeLast4: { type: String, uppercase: true, match: /^[0-9A-F]{4}$/ }, // admin display hint

    // Private customer details - admin only
    sender: {
      name: { type: String, trim: true, required: true, maxlength: 120 },
      location: { type: String, trim: true, required: true, maxlength: 200 },
    },
    receiver: {
      name: { type: String, trim: true, required: true, maxlength: 120 },
      email: { type: String, trim: true, lowercase: true, maxlength: 160 },
      phone: { type: String, trim: true, maxlength: 40 },
    },

    // Parcel
    description: { type: String, trim: true, required: true, maxlength: 500 },
    category: { type: String, enum: GOODS_CATEGORIES, default: 'Other' },
    weightKg: { type: Number, min: 0, max: 100000 },

    // Public shipment details
    origin: locationSchema,
    destination: locationSchema,
    currentLocation: locationSchema,
    locationUpdatedAt: Date,
    route: [pointSchema], // optional planned route between origin and destination
    status: { type: String, enum: STATUSES, default: 'Shipment Created', index: true },
    estimatedDelivery: Date,
    trackingPaused: { type: Boolean, default: false },
    pauseMessage: { type: String, maxlength: 300 }, // optional customer-facing message while paused

    history: [historySchema],

    // Automatic movement along `route`, arriving at `arriveAt` (see public/js/journey.js)
    journey: {
      active: { type: Boolean, default: false },
      startedAt: Date,
      startProgress: { type: Number, default: 0 },
      arriveAt: Date,
      progress: { type: Number, default: 0 },
      arrivedAt: Date,
      namedAt: Date,
    },
  },
  // optimisticConcurrency: the movement ticker and admin edits never silently overwrite each other
  { timestamps: true, optimisticConcurrency: true }
);

function publicJourney(j) {
  if (!j || !j.startedAt) return { started: false, active: false, progress: 0 };
  return {
    started: true,
    active: !!j.active,
    startedAt: j.startedAt,
    startProgress: j.startProgress || 0,
    arriveAt: j.arriveAt || null,
    progress: j.progress || 0,
    arrivedAt: j.arrivedAt || null,
  };
}

shipmentSchema.index({ createdAt: -1 });

function publicLocation(loc) {
  if (!loc || (!loc.name && loc.lat == null)) return null;
  const out = { name: loc.name || '' };
  if (typeof loc.lat === 'number' && typeof loc.lng === 'number') {
    out.lat = loc.lat;
    out.lng = loc.lng;
  }
  return out;
}

// The ONLY shape that is ever sent to customers (API + Socket.IO).
// Excludes sender/receiver details, weight, category, internal notes and admin metadata.
shipmentSchema.methods.toPublic = function toPublic() {
  return {
    status: this.status,
    origin: publicLocation(this.origin),
    destination: publicLocation(this.destination),
    currentLocation: publicLocation(this.currentLocation),
    locationUpdatedAt: this.locationUpdatedAt || null,
    description: this.description || '',
    estimatedDelivery: this.estimatedDelivery || null,
    trackingPaused: !!this.trackingPaused,
    pauseMessage: this.trackingPaused ? this.pauseMessage || '' : '',
    route: (this.route || []).map((p) => ({ lat: p.lat, lng: p.lng })),
    journey: publicJourney(this.journey),
    history: (this.history || []).map((h) => ({
      status: h.status,
      location: publicLocation(h.location),
      timestamp: h.timestamp,
    })),
    updatedAt: this.updatedAt,
  };
};

// Compact row for the admin shipments table
shipmentSchema.methods.toAdminRow = function toAdminRow() {
  return {
    id: this._id,
    codeHint: this.trackingCodeLast4 ? '••••' + this.trackingCodeLast4 : '—',
    recipient: this.receiver && this.receiver.name,
    destination: this.destination && this.destination.name,
    status: this.status,
    createdAt: this.createdAt,
  };
};

// Full record for the admin shipment page (everything except the code hash)
shipmentSchema.methods.toAdminDetail = function toAdminDetail() {
  const loc = (l) => (l && (l.name || l.lat != null) ? { name: l.name || '', lat: l.lat, lng: l.lng } : null);
  return {
    id: this._id,
    codeHint: this.trackingCodeLast4 ? '••••' + this.trackingCodeLast4 : '—',
    sender: { name: this.sender && this.sender.name, location: this.sender && this.sender.location },
    receiver: { name: this.receiver && this.receiver.name, email: this.receiver && this.receiver.email, phone: this.receiver && this.receiver.phone },
    description: this.description,
    category: this.category,
    weightKg: this.weightKg,
    origin: loc(this.origin),
    destination: loc(this.destination),
    currentLocation: loc(this.currentLocation),
    locationUpdatedAt: this.locationUpdatedAt || null,
    status: this.status,
    estimatedDelivery: this.estimatedDelivery || null,
    trackingPaused: !!this.trackingPaused,
    pauseMessage: this.pauseMessage || '',
    route: (this.route || []).map((p) => ({ lat: p.lat, lng: p.lng })),
    journey: publicJourney(this.journey),
    history: (this.history || []).map((h) => ({ status: h.status, location: loc(h.location), note: h.note || '', timestamp: h.timestamp })),
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

module.exports = mongoose.model('Shipment', shipmentSchema);
module.exports.STATUSES = STATUSES;
module.exports.STATUS_GROUPS = STATUS_GROUPS;
module.exports.GOODS_CATEGORIES = GOODS_CATEGORIES;

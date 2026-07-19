const path = require('path');
const express = require('express');
const {
  connect,
  getDb,
  ObjectId,
  normalizeMunicipality,
  normalizeVolunteer,
  bodyToMongoUpdate,
} = require('./db');

const PORT = process.env.PORT || 3000;
const app = express();
app.use(express.json());

const EDITABLE_MUNI_FIELDS = [
  'municipality', 'state', 'state_abbr', 'legal_designation',
  'assigned_researcher', 'priority', 'contact_method', 'follow_up_date',
  'survey_sent', 'date_sent', 'response_received', 'response_date', 'responded',
  'note', 'primary_contact', 'contact_email', 'contact_phone', 'research_notes',
  'official_website', 'enrichment_status',
];

const SORTABLE_COLUMNS = {
  sovtown_id: 'sovtown_id',
  municipality: 'municipality',
  state: 'state',
  population_2025: 'population_2025',
  population_band: 'population_band',
  assigned_researcher: 'assignedResearcher',
  survey_sent: 'survey_sent',
  responded: 'responded',
  enrichment_status: 'enrichment_status',
  priority: 'priority',
  follow_up_date: 'follow_up_date',
};

function buildMongoFilter(query) {
  const filter = {};

  if (query.search) {
    const re = new RegExp(query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [
      { municipality: re },
      { sovtown_id: re },
      { primary_contact: re },
      { contact_email: re },
      { state: re },
      { state_abbr: re },
      { enrichment_status: re },
      { population_band: re },
      { note: re },
      { research_notes: re },
      { legal_designation: re },
    ];
  }
  if (query.state) filter.state = query.state;
  if (query.population_band) filter.population_band = query.population_band;
  if (query.under_10000) filter.under_10000 = query.under_10000;
  if (query.assigned_researcher) {
    if (query.assigned_researcher === '__unassigned__') {
      filter.$and = filter.$and || [];
      filter.$and.push({
        $or: [
          { assignedResearcher: null },
          { assignedResearcher: '' },
          { assignedResearcher: { $exists: false } },
        ],
      });
    } else {
      filter.assignedResearcher = query.assigned_researcher;
    }
  }
  if (query.survey_sent) filter.survey_sent = query.survey_sent;
  if (query.responded === 'yes') {
    filter.$and = filter.$and || [];
    filter.$and.push({
      $or: [
        { responded: 'Yes' },
        { response_date: { $nin: [null, ''] } },
        { responded: { $nin: [null, '', 'No'] } },
      ],
    });
  } else if (query.responded === 'no') {
    filter.$and = filter.$and || [];
    filter.$and.push({
      $and: [
        { $or: [{ responded: null }, { responded: '' }, { responded: 'No' }] },
        { $or: [{ response_date: null }, { response_date: '' }] },
      ],
    });
  } else if (query.responded) {
    filter.responded = query.responded;
  }
  if (query.enrichment_status) filter.enrichment_status = query.enrichment_status;

  return filter;
}

function escapeCsv(val) {
  if (val == null) return '';
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

async function generateSovtownId(municipalities) {
  const rows = await municipalities
    .find({ sovtown_id: /^SOV-/ })
    .project({ sovtown_id: 1 })
    .toArray();
  let max = 0;
  for (const row of rows) {
    const n = parseInt(String(row.sovtown_id).slice(4), 10);
    if (!isNaN(n) && n > max) max = n;
  }
  return `SOV-${String(max + 1).padStart(6, '0')}`;
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// --- Municipalities ---

app.get('/api/municipalities', asyncHandler(async (req, res) => {
  const db = getDb();
  const municipalities = db.collection('municipalities');
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 50));
  const skip = (page - 1) * pageSize;
  const filter = buildMongoFilter(req.query);
  const sortField = SORTABLE_COLUMNS[req.query.sort] || 'municipality';
  const sortDir = req.query.order === 'desc' ? -1 : 1;

  const [total, docs] = await Promise.all([
    municipalities.countDocuments(filter),
    municipalities
      .find(filter)
      .sort({ [sortField]: sortDir })
      .skip(skip)
      .limit(pageSize)
      .toArray(),
  ]);

  res.json({
    rows: docs.map(normalizeMunicipality),
    total,
    page,
    pageSize,
  });
}));

app.post('/api/municipalities', asyncHandler(async (req, res) => {
  const db = getDb();
  const municipalities = db.collection('municipalities');
  const body = req.body || {};
  const sovtown_id = await generateSovtownId(municipalities);
  const doc = bodyToMongoUpdate({
    sovtown_id,
    municipality: body.municipality || null,
    state: body.state || null,
    state_abbr: body.state_abbr || null,
    legal_designation: body.legal_designation || null,
    primary_contact: body.primary_contact || null,
    contact_email: body.contact_email || null,
    contact_phone: body.contact_phone || null,
    official_website: body.official_website || null,
    research_notes: body.research_notes || null,
    note: body.note || null,
    assigned_researcher: body.assigned_researcher || null,
    priority: body.priority || 'Medium',
    contact_method: body.contact_method || null,
    enrichment_status: body.enrichment_status || 'Not Started',
    survey_sent: body.survey_sent || 'No',
    date_sent: body.date_sent || null,
    response_received: body.response_received || 'No',
    response_date: body.response_date || null,
    responded: body.responded || 'No',
    follow_up_date: body.follow_up_date || null,
  });

  await municipalities.insertOne(doc);
  res.status(201).json(normalizeMunicipality(doc));
}));

app.patch('/api/municipalities/:sovtown_id', asyncHandler(async (req, res) => {
  const db = getDb();
  const municipalities = db.collection('municipalities');
  const { sovtown_id } = req.params;
  const existing = await municipalities.findOne({ sovtown_id });
  if (!existing) return res.status(404).json({ error: 'Municipality not found' });

  const patch = {};
  for (const field of EDITABLE_MUNI_FIELDS) {
    if (field in req.body) patch[field] = req.body[field];
  }
  if (!Object.keys(patch).length) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }

  const update = bodyToMongoUpdate(patch);
  await municipalities.updateOne({ sovtown_id }, { $set: update });
  const row = await municipalities.findOne({ sovtown_id });
  res.json(normalizeMunicipality(row));
}));

app.delete('/api/municipalities/:sovtown_id', asyncHandler(async (req, res) => {
  const db = getDb();
  const result = await db.collection('municipalities').deleteOne({ sovtown_id: req.params.sovtown_id });
  if (result.deletedCount === 0) return res.status(404).json({ error: 'Municipality not found' });
  res.json({ ok: true });
}));

// --- Stats ---

app.get('/api/stats', asyncHandler(async (req, res) => {
  const db = getDb();
  const municipalities = db.collection('municipalities');
  const volunteersCol = db.collection('volunteers');

  const totalsArr = await municipalities.aggregate([
    {
      $group: {
        _id: null,
        total_contacts: { $sum: 1 },
        survey_sent: {
          $sum: { $cond: [{ $eq: ['$survey_sent', 'Yes'] }, 1, 0] },
        },
        responded: {
          $sum: {
            $cond: [{
              $or: [
                { $eq: ['$responded', 'Yes'] },
                { $and: [{ $ne: ['$response_date', null] }, { $ne: ['$response_date', ''] }] },
                { $and: [{ $ne: ['$responded', null] }, { $ne: ['$responded', ''] }, { $ne: ['$responded', 'No'] }] },
              ],
            }, 1, 0],
          },
        },
        not_yet_contacted: {
          $sum: { $cond: [{ $ne: ['$survey_sent', 'Yes'] }, 1, 0] },
        },
      },
    },
  ]).toArray();

  const totals = totalsArr[0] || {
    total_contacts: 0,
    survey_sent: 0,
    responded: 0,
    not_yet_contacted: 0,
  };

  const activeVolunteers = await volunteersCol
    .find({ active: { $ne: false } })
    .sort({ name: 1 })
    .toArray();

  const volunteerStats = await Promise.all(activeVolunteers.map(async (v) => {
    const statsArr = await municipalities.aggregate([
      { $match: { assignedResearcher: v.name } },
      {
        $group: {
          _id: null,
          assigned: { $sum: 1 },
          contacted: { $sum: { $cond: [{ $eq: ['$survey_sent', 'Yes'] }, 1, 0] } },
          responded: { $sum: { $cond: [{ $eq: ['$responded', 'Yes'] }, 1, 0] } },
        },
      },
    ]).toArray();
    const stats = statsArr[0] || { assigned: 0, contacted: 0, responded: 0 };
    return { id: v._id.toString(), name: v.name, ...stats };
  }));

  res.json({
    total_contacts: totals.total_contacts,
    survey_sent: totals.survey_sent,
    responded: totals.responded,
    not_yet_contacted: totals.not_yet_contacted,
    volunteers: volunteerStats,
  });
}));

// --- Volunteers ---

app.get('/api/volunteers', asyncHandler(async (req, res) => {
  const rows = await getDb().collection('volunteers').find().sort({ name: 1 }).toArray();
  res.json(rows.map(normalizeVolunteer));
}));

app.post('/api/volunteers', asyncHandler(async (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name is required' });

  const volunteers = getDb().collection('volunteers');
  try {
    const result = await volunteers.insertOne({ name, active: true, dateAdded: new Date() });
    const row = await volunteers.findOne({ _id: result.insertedId });
    res.status(201).json(normalizeVolunteer(row));
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'Volunteer already exists' });
    throw err;
  }
}));

app.patch('/api/volunteers/:id', asyncHandler(async (req, res) => {
  const municipalities = getDb().collection('municipalities');
  let oid;
  try {
    oid = new ObjectId(req.params.id);
  } catch {
    return res.status(400).json({ error: 'Invalid volunteer id' });
  }

  const existing = await getDb().collection('volunteers').findOne({ _id: oid });
  if (!existing) return res.status(404).json({ error: 'Volunteer not found' });

  const update = {};
  if ('name' in req.body) update.name = String(req.body.name).trim();
  if ('active' in req.body) update.active = !!req.body.active;
  if (!Object.keys(update).length) return res.status(400).json({ error: 'No valid fields to update' });

  if (update.name && update.name !== existing.name) {
    await municipalities.updateMany(
      { assignedResearcher: existing.name },
      { $set: { assignedResearcher: update.name } }
    );
  }

  await getDb().collection('volunteers').updateOne({ _id: oid }, { $set: update });
  const row = await getDb().collection('volunteers').findOne({ _id: oid });
  res.json(normalizeVolunteer(row));
}));

app.delete('/api/volunteers/:id', asyncHandler(async (req, res) => {
  let oid;
  try {
    oid = new ObjectId(req.params.id);
  } catch {
    return res.status(400).json({ error: 'Invalid volunteer id' });
  }

  const volunteers = getDb().collection('volunteers');
  const existing = await volunteers.findOne({ _id: oid });
  if (!existing) return res.status(404).json({ error: 'Volunteer not found' });

  await getDb().collection('municipalities').updateMany(
    { assignedResearcher: existing.name },
    { $set: { assignedResearcher: null } }
  );
  await volunteers.deleteOne({ _id: oid });
  res.json({ ok: true });
}));

// --- Auto-assign ---

app.post('/api/auto-assign', asyncHandler(async (req, res) => {
  const db = getDb();
  const municipalities = db.collection('municipalities');
  const batchSize = Math.max(1, parseInt(req.body?.batchSize, 10) || 60);
  const bodyFilter = req.body?.filter || {};

  const activeVolunteers = await db.collection('volunteers')
    .find({ active: { $ne: false } })
    .sort({ name: 1 })
    .toArray();

  if (!activeVolunteers.length) {
    return res.status(400).json({ error: 'No active volunteers' });
  }

  const filter = {
    $or: [
      { assignedResearcher: null },
      { assignedResearcher: '' },
      { assignedResearcher: { $exists: false } },
    ],
  };
  if (bodyFilter.under_10000 === true) filter.under_10000 = 'Yes';
  else if (bodyFilter.under_10000 === false) filter.under_10000 = 'No';
  if (bodyFilter.population_band?.length) {
    filter.population_band = { $in: bodyFilter.population_band };
  }

  const unassigned = await municipalities
    .find(filter)
    .sort({ municipality: 1 })
    .limit(batchSize * activeVolunteers.length)
    .project({ sovtown_id: 1 })
    .toArray();

  let assigned = 0;
  for (let i = 0; i < unassigned.length; i++) {
    const volunteer = activeVolunteers[i % activeVolunteers.length];
    await municipalities.updateOne(
      { sovtown_id: unassigned[i].sovtown_id },
      { $set: { assignedResearcher: volunteer.name } }
    );
    assigned++;
  }

  res.json({
    assigned,
    batchSize,
    volunteers: activeVolunteers.length,
    municipalities_considered: unassigned.length,
  });
}));

// --- Export ---

app.get('/api/export', asyncHandler(async (req, res) => {
  const municipalities = getDb().collection('municipalities');
  const filter = buildMongoFilter(req.query);
  const rows = await municipalities.find(filter).sort({ municipality: 1 }).toArray();

  const headers = [
    'SOVTOWN ID', 'Municipality', 'State', 'State Abbr.', 'Population 2025',
    'Population Band', 'Under 10,000?', 'Enrichment Status', 'Assigned Researcher',
    'Primary Contact', 'Contact Email', 'Contact Phone', 'Official Website',
    'Priority', 'Contact Method', 'Follow Up Date', 'Survey Sent', 'Date Sent',
    'Response Received', 'Response Date', 'Responded', 'Note', 'Research Notes',
  ];

  const csvRows = [headers.join(',')];
  for (const raw of rows) {
    const r = normalizeMunicipality(raw);
    csvRows.push([
      r.sovtown_id, r.municipality, r.state, r.state_abbr, r.population_2025,
      r.population_band, r.under_10000, r.enrichment_status, r.assigned_researcher,
      r.primary_contact, r.contact_email, r.contact_phone, r.official_website,
      r.priority, r.contact_method, r.follow_up_date, r.survey_sent, r.date_sent,
      r.response_received, r.response_date, r.responded, r.note, r.research_notes,
    ].map(escapeCsv).join(','));
  }

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="sovereign-town-export.csv"');
  res.send(csvRows.join('\n'));
}));

// --- Filter options ---

app.get('/api/filter-options', asyncHandler(async (req, res) => {
  const municipalities = getDb().collection('municipalities');
  const [states, bands, enrichment] = await Promise.all([
    municipalities.distinct('state', { state: { $nin: [null, ''] } }),
    municipalities.distinct('population_band', { population_band: { $nin: [null, ''] } }),
    municipalities.distinct('enrichment_status', { enrichment_status: { $nin: [null, ''] } }),
  ]);
  res.json({
    states: states.sort(),
    population_bands: bands.sort(),
    enrichment_statuses: enrichment.sort(),
  });
}));

// --- Static frontend ---

app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

connect()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Sovereign Town tracker running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to start:', err.message);
    process.exit(1);
  });

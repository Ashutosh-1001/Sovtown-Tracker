require('dotenv').config();
const path = require('path');
const express = require('express');
const ExcelJS = require('exceljs');
const {
  connect,
  getDb,
  ObjectId,
  normalizeMunicipality,
  normalizeVolunteer,
  normalizeResearcher,
  bodyToMongoUpdate,
} = require('./db');

const PORT = process.env.PORT || 3000;
const app = express();
app.use(express.json());

const EDITABLE_MUNI_FIELDS = [
  'municipality', 'state', 'state_abbr', 'legal_designation', 'official_census_name',
  'state_fips', 'place_fips', 'census_geoid', 'population_2025', 'under_10000',
  'population_band', 'enrichment_status', 'assigned_researcher', 'official_website',
  'primary_contact', 'contact_email', 'contact_phone', 'research_notes',
  'census_functional_status', 'source_url',
  'priority', 'contact_method', 'follow_up_date',
  'survey_sent', 'date_sent', 'response_received', 'response_date', 'responded', 'note',
];

function parsePopulationValue(value) {
  if (value == null || value === '') return null;
  const n = parseInt(String(value).replace(/,/g, ''), 10);
  return Number.isNaN(n) ? null : n;
}

function trimOrNull(value) {
  if (value == null) return null;
  const s = String(value).trim();
  return s || null;
}

function buildMunicipalityBody(body, sovtown_id) {
  return bodyToMongoUpdate({
    sovtown_id,
    municipality: trimOrNull(body.municipality),
    legal_designation: trimOrNull(body.legal_designation),
    official_census_name: trimOrNull(body.official_census_name),
    state: trimOrNull(body.state),
    state_abbr: trimOrNull(body.state_abbr),
    state_fips: trimOrNull(body.state_fips),
    place_fips: trimOrNull(body.place_fips),
    census_geoid: trimOrNull(body.census_geoid),
    population_2025: parsePopulationValue(body.population_2025),
    under_10000: trimOrNull(body.under_10000),
    population_band: trimOrNull(body.population_band),
    enrichment_status: trimOrNull(body.enrichment_status) || 'Not Started',
    assigned_researcher: trimOrNull(body.assigned_researcher),
    official_website: trimOrNull(body.official_website),
    primary_contact: trimOrNull(body.primary_contact),
    contact_email: trimOrNull(body.contact_email),
    contact_phone: trimOrNull(body.contact_phone),
    research_notes: trimOrNull(body.research_notes),
    census_functional_status: trimOrNull(body.census_functional_status),
    source_url: trimOrNull(body.source_url),
    priority: body.priority || 'Medium',
    contact_method: body.contact_method || 'Email',
    follow_up_date: trimOrNull(body.follow_up_date),
    survey_sent: body.survey_sent || 'No',
    date_sent: trimOrNull(body.date_sent),
    response_received: body.response_received || 'No',
    response_date: trimOrNull(body.response_date),
    responded: body.responded || 'No',
    note: trimOrNull(body.note),
  });
}

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

function unassignedClause() {
  return {
    $or: [
      { assignedResearcher: null },
      { assignedResearcher: '' },
      { assignedResearcher: { $exists: false } },
    ],
  };
}

function withUnassignedOnly(filter = {}) {
  const hasKeys = Object.keys(filter).length > 0;
  if (!hasKeys) return unassignedClause();
  return { $and: [filter, unassignedClause()] };
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

app.get('/api/municipalities/:sovtown_id', asyncHandler(async (req, res) => {
  const doc = await getDb().collection('municipalities').findOne({
    sovtown_id: req.params.sovtown_id,
  });
  if (!doc) return res.status(404).json({ error: 'Municipality not found' });
  res.json(normalizeMunicipality(doc));
}));

app.post('/api/municipalities', asyncHandler(async (req, res) => {
  const db = getDb();
  const municipalities = db.collection('municipalities');
  const body = req.body || {};
  const sovtown_id = trimOrNull(body.sovtown_id);

  if (!sovtown_id) {
    return res.status(400).json({ error: 'SOVTOWN ID is required' });
  }

  const existing = await municipalities.findOne({ sovtown_id });
  if (existing) {
    return res.status(409).json({ error: 'SOVTOWN ID already exists' });
  }

  const doc = buildMunicipalityBody(body, sovtown_id);
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
    if (field in req.body) {
      let value = req.body[field];
      if (typeof value === 'string') {
        value = value.trim();
        if (field === 'assigned_researcher' || field === 'population_2025') {
          value = field === 'population_2025'
            ? parsePopulationValue(value)
            : (value || null);
        } else if (value === '') {
          value = null;
        }
      }
      patch[field] = value;
    }
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

// --- Researchers (manageable directory) ---

app.get('/api/researchers', asyncHandler(async (req, res) => {
  const rows = await getDb().collection('researchers').find().sort({ name: 1 }).toArray();
  res.json(rows.map(normalizeResearcher));
}));

app.post('/api/researchers', asyncHandler(async (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name is required' });

  const researchers = getDb().collection('researchers');
  try {
    const result = await researchers.insertOne({ name, dateAdded: new Date() });
    const row = await researchers.findOne({ _id: result.insertedId });
    res.status(201).json(normalizeResearcher(row));
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'Researcher already exists' });
    throw err;
  }
}));

/** @deprecated Prefer GET /api/researchers — kept for compatibility; lists researcher names. */
app.get('/api/researcher-names', asyncHandler(async (req, res) => {
  const rows = await getDb().collection('researchers').find({}, { projection: { name: 1 } }).sort({ name: 1 }).toArray();
  res.json(rows.map((r) => r.name));
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

app.post('/api/bulk-assign-researchers', asyncHandler(async (req, res) => {
  const municipalities = getDb().collection('municipalities');
  const researchers = (req.body?.researchers || [])
    .map((name) => String(name).trim())
    .filter(Boolean);
  const townsPerResearcher = Math.max(1, parseInt(req.body?.townsPerResearcher, 10) || 60);
  const scope = req.body?.scope === 'filtered' ? 'filtered' : 'all';
  const dryRun = req.body?.dryRun === true;

  if (!researchers.length) {
    return res.status(400).json({ error: 'At least one researcher name is required' });
  }

  const baseFilter = scope === 'filtered' ? buildMongoFilter(req.body?.filter || {}) : {};
  const filter = withUnassignedOnly(baseFilter);
  const maxToAssign = researchers.length * townsPerResearcher;

  const pool = await municipalities
    .find(filter)
    .sort({ sovtown_id: 1 })
    .limit(maxToAssign)
    .project({ _id: 1, sovtown_id: 1 })
    .toArray();

  const byResearcher = Object.fromEntries(researchers.map((name) => [name, 0]));
  const assignments = [];

  for (let i = 0; i < pool.length; i++) {
    const researcherIndex = Math.floor(i / townsPerResearcher);
    if (researcherIndex >= researchers.length) break;
    const name = researchers[researcherIndex];
    assignments.push({ _id: pool[i]._id, name });
    byResearcher[name]++;
  }

  if (!dryRun) {
    for (const { _id, name } of assignments) {
      await municipalities.updateOne({ _id }, { $set: { assignedResearcher: name } });
    }
  }

  const remainingUnassigned = await municipalities.countDocuments(filter);
  const unassignedTotal = await municipalities.countDocuments(unassignedClause());

  res.json({
    dry_run: dryRun,
    scope,
    researchers: researchers.length,
    towns_per_researcher: townsPerResearcher,
    assigned: assignments.length,
    by_researcher: byResearcher,
    pool_available: pool.length,
    remaining_unassigned_in_scope: remainingUnassigned,
    remaining_unassigned_total: unassignedTotal,
  });
}));

// --- Export (full municipalities collection as .xlsx) ---

const EXPORT_COLUMNS = [
  { header: 'SOVTOWN ID', key: 'sovtown_id' },
  { header: 'Municipality', key: 'municipality' },
  { header: 'Legal Designation', key: 'legal_designation' },
  { header: 'Official Census Name', key: 'official_census_name' },
  { header: 'State', key: 'state' },
  { header: 'State Abbr.', key: 'state_abbr' },
  { header: 'State FIPS', key: 'state_fips' },
  { header: 'Place FIPS', key: 'place_fips' },
  { header: 'Census GEOID', key: 'census_geoid' },
  { header: '2025 Population', key: 'population_2025' },
  { header: 'Under 10,000?', key: 'under_10000' },
  { header: 'Population Band', key: 'population_band' },
  { header: 'Enrichment Status', key: 'enrichment_status' },
  { header: 'Assigned Researcher', key: 'assigned_researcher' },
  { header: 'Official Website', key: 'official_website' },
  { header: 'Primary Contact', key: 'primary_contact' },
  { header: 'Contact Email', key: 'contact_email' },
  { header: 'Contact Phone', key: 'contact_phone' },
  { header: 'Research Notes', key: 'research_notes' },
  { header: 'Census Functional Status', key: 'census_functional_status' },
  { header: 'Source URL', key: 'source_url' },
  { header: 'Priority', key: 'priority' },
  { header: 'Contact Method', key: 'contact_method' },
  { header: 'Follow-up', key: 'follow_up_date' },
  { header: 'Survey Sent', key: 'survey_sent' },
  { header: 'Date Sent', key: 'date_sent' },
  { header: 'Response Received', key: 'response_received' },
];

app.get('/api/export', asyncHandler(async (req, res) => {
  const municipalities = getDb().collection('municipalities');

  // Stream the workbook to the response. Building ~19.5k rows with ExcelJS's
  // in-memory Workbook + writeBuffer() peaks around ~500MB RSS and can OOM
  // (process killed → browser shows "Failed to fetch" / Excel download failed).
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  res.setHeader(
    'Content-Disposition',
    'attachment; filename="sovereign-town-municipalities.xlsx"'
  );

  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream: res,
    useStyles: true,
    useSharedStrings: false,
  });
  workbook.creator = 'Project Sovereign Town';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Municipalities');
  sheet.columns = EXPORT_COLUMNS.map((col) => ({
    header: col.header,
    key: col.key,
    width: Math.min(28, Math.max(12, col.header.length + 2)),
  }));

  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true };
  headerRow.commit();

  let count = 0;
  const cursor = municipalities.find({}).sort({ sovtown_id: 1 });
  for await (const raw of cursor) {
    const r = normalizeMunicipality(raw);
    const row = {};
    for (const col of EXPORT_COLUMNS) {
      const v = r[col.key];
      row[col.key] = v == null ? '' : v;
    }
    sheet.addRow(row).commit();
    count += 1;
  }

  console.log(`[export] wrote ${count} municipality rows to xlsx`);
  await workbook.commit();
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

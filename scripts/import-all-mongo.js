// scripts/import-all-mongo.js
// Loads BOTH source files into MongoDB in one run:
//   1. data/registry.xlsx  -> `municipalities` collection
//   2. data/Volunteers_Tracker.xlsx -> `volunteers` collection + assignedResearcher

const path = require('path');
const XLSX = require('xlsx');
const { MongoClient } = require('mongodb');

const REGISTRY_PATH = path.join(__dirname, '..', 'data', 'registry.xlsx');
const VOLUNTEERS_PATH = path.join(__dirname, '..', 'data', 'Volunteers_Tracker.xlsx');
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB_NAME = process.env.MONGODB_DB || 'sovereign_town';

function parsePopulation(v) {
  if (!v) return null;
  const n = parseInt(String(v).replace(/,/g, ''), 10);
  return isNaN(n) ? null : n;
}

async function importRegistry(municipalities) {
  const wb = XLSX.readFile(REGISTRY_PATH);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: null });

  const ops = rows.map(r => ({
    updateOne: {
      filter: { sovtown_id: r['SOVTOWN ID'] },
      update: {
        $setOnInsert: {
          sovtown_id: r['SOVTOWN ID'],
          municipality: r['Municipality'] || null,
          legal_designation: r['Legal Designation'] || null,
          official_census_name: r['Official Census Name'] || null,
          state: r['State'] || null,
          state_abbr: r['State Abbr.'] || null,
          state_fips: r['State FIPS'] || null,
          place_fips: r['Place FIPS'] || null,
          census_geoid: r['Census GEOID'] || null,
          population_2025: parsePopulation(r['2025 Population']),
          under_10000: r['Under 10,000?'] || null,
          population_band: r['Population Band'] || null,
          enrichment_status: r['Enrichment Status'] || 'Not Started',
          official_website: r['Official Website'] || null,
          primary_contact: r['Primary Contact'] || null,
          contact_email: r['Contact Email'] || null,
          contact_phone: r['Contact Phone'] || null,
          research_notes: r['Research Notes'] || null,
          census_functional_status: r['Census Functional Status'] || null,
          source_url: r['Source URL'] || null,
          assignedResearcher: null,
          priority: 'Medium',
          contact_method: 'Email',
          survey_sent: 'No',
          response_received: 'No',
          responded: 'No',
        }
      },
      upsert: true,
    }
  }));

  const CHUNK = 1000;
  let inserted = 0;
  for (let i = 0; i < ops.length; i += CHUNK) {
    const chunk = ops.slice(i, i + CHUNK);
    const result = await municipalities.bulkWrite(chunk, { ordered: false });
    inserted += result.upsertedCount;
  }
  return { total: rows.length, inserted };
}

async function importVolunteers(volunteers, municipalities) {
  const wb = XLSX.readFile(VOLUNTEERS_PATH);
  const sheetName = wb.SheetNames.find(n => /volunteer/i.test(n)) || wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  const nameRow = rows[1] || [];

  let volunteerCount = 0;
  let assignmentCount = 0;

  for (let col = 1; col < nameRow.length; col++) {
    const rawName = nameRow[col];
    if (!rawName) continue;
    const name = String(rawName).trim();

    await volunteers.updateOne(
      { name },
      { $setOnInsert: { name, active: true, dateAdded: new Date() } },
      { upsert: true }
    );
    volunteerCount++;

    const assignedIds = [];
    for (let r = 2; r < rows.length; r++) {
      const sid = rows[r][col];
      if (sid) assignedIds.push(String(sid).trim());
    }
    if (assignedIds.length) {
      const result = await municipalities.updateMany(
        { sovtown_id: { $in: assignedIds } },
        { $set: { assignedResearcher: name } }
      );
      assignmentCount += result.modifiedCount;
    }
  }
  return { volunteers: volunteerCount, assignments: assignmentCount };
}

async function main() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db(DB_NAME);
  const municipalities = db.collection('municipalities');
  const volunteers = db.collection('volunteers');

  await municipalities.createIndex({ sovtown_id: 1 }, { unique: true });
  await volunteers.createIndex({ name: 1 }, { unique: true });

  const reg = await importRegistry(municipalities);
  console.log(`Registry: ${reg.total} rows read, ${reg.inserted} newly inserted (rest already existed).`);

  const vol = await importVolunteers(volunteers, municipalities);
  console.log(`Volunteers: ${vol.volunteers} upserted, ${vol.assignments} assignments applied.`);

  const dupCheck = await municipalities.aggregate([
    { $group: { _id: '$sovtown_id', count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } }
  ]).toArray();
  console.log(`Duplicate sovtown_id check: ${dupCheck.length} duplicates found.`);

  await client.close();
}

main().catch(err => {
  console.error('Import failed:', err);
  process.exit(1);
});
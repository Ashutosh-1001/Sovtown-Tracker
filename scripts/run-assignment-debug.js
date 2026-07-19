/**
 * Executes Steps 1–5 of assignment migration debug in one run.
 * Requires MONGODB_URI in environment or .env (not placeholder).
 */
const path = require('path');
const { MongoClient } = require('mongodb');
const { parseVolunteerTracker, detectFields } = require('./import-volunteer-assignments');

const envPath = path.join(__dirname, '..', '.env');
const fs = require('fs');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (!m || process.env[m[1].trim()]) continue;
    const val = m[2].trim();
    if (val.includes('USER:PASSWORD')) continue;
    process.env[m[1].trim()] = val;
  }
}

const URI = process.env.MONGODB_URI;
const DB = process.env.MONGODB_DB || 'sovereign_town';
const TEST_ID = 'SOV-011120';
const TEST_VOLUNTEER = 'Aaron Zulu';

function detectFieldsLocal(sample) {
  return detectFields(sample);
}

async function main() {
  if (!URI || URI.includes('USER:PASSWORD')) {
    throw new Error('Set real MONGODB_URI in .env or environment (current: ' + (URI ? 'placeholder' : 'unset') + ')');
  }

  const client = new MongoClient(URI);
  await client.connect();
  const col = client.db(DB).collection('municipalities');

  console.log('=== STEP 1: One full raw document ===\n');
  const sample = await col.findOne({});
  console.log(JSON.stringify(sample, null, 2));

  const { idField, researcherField } = detectFields(sample);
  console.log('\n=== STEP 2: Field names & query comparison ===');
  console.log('Real ID field:', idField);
  console.log('Real researcher field:', researcherField);
  console.log('\nBROKEN migration script used:');
  console.log('  filter: { "SOVTOWN ID": "' + TEST_ID + '" }');
  console.log('  $set:   { "Assigned Researcher": "..." }');
  const brokenMatch = await col.findOne({ 'SOVTOWN ID': TEST_ID });
  console.log('Broken filter matches:', brokenMatch ? 'YES' : 'NO');
  console.log('\nFIXED query:');
  console.log('  filter: { ' + idField + ': "' + TEST_ID + '" }');
  console.log('  $set:   { ' + researcherField + ': "..." }');
  const fixedMatch = await col.findOne({ [idField]: TEST_ID });
  console.log('Fixed filter matches:', fixedMatch ? 'YES' : 'NO');

  console.log('\n=== STEP 4: End-to-end on', TEST_ID, '→', TEST_VOLUNTEER, '===\n');
  await col.updateOne({ [idField]: TEST_ID }, { $set: { [researcherField]: null } });
  const before = await col.findOne({ [idField]: TEST_ID });
  console.log('BEFORE (cleared for test):');
  console.log(JSON.stringify(before, null, 2));

  const filter = { [idField]: TEST_ID };
  const update = { $set: { [researcherField]: TEST_VOLUNTEER } };
  const result = await col.updateOne(filter, update);
  console.log('\nupdateOne(', JSON.stringify(filter), ',', JSON.stringify(update), ')');
  console.log('Result:', JSON.stringify(result));

  const after = await col.findOne({ [idField]: TEST_ID });
  console.log('\nAFTER:');
  console.log(JSON.stringify(after, null, 2));
  console.log('\nResearcher value now:', after[researcherField]);

  console.log('\n=== STEP 5: Full assignment run ===\n');
  const mapping = parseVolunteerTracker();
  let attempted = 0, matched = 0, modified = 0;
  const unmatched = [];

  for (const { name, sovtownIds } of mapping) {
    for (const sovtownId of sovtownIds) {
      attempted++;
      const r = await col.updateOne(
        { [idField]: sovtownId },
        { $set: { [researcherField]: name } }
      );
      if (r.matchedCount === 0) unmatched.push({ sovtownId, volunteer: name });
      else {
        matched++;
        if (r.modifiedCount > 0) modified++;
      }
    }
  }

  console.log('Volunteers parsed:', mapping.length);
  console.log('Assignments attempted:', attempted);
  console.log('Documents matched:', matched);
  console.log('Documents modified:', modified);
  console.log('Unmatched SOVTOWN IDs:', unmatched.length);
  if (unmatched.length) {
    unmatched.slice(0, 20).forEach((u) => console.log(' ', u.sovtownId, u.volunteer));
  }

  await client.close();
}

// export parser for require
if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

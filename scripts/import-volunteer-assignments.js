#!/usr/bin/env node
/**
 * Import volunteer → municipality assignments from Volunteers_Tracker.xlsx.
 *
 * IMPORTANT: Documents in this project use snake_case/camelCase keys from
 * import-all-mongo.js (sovtown_id, assignedResearcher), NOT spaced registry
 * headers. Field names are auto-detected from a sample document.
 *
 * Usage:
 *   node scripts/import-volunteer-assignments.js              # preview all + confirm
 *   node scripts/import-volunteer-assignments.js --yes        # apply all columns
 *   node scripts/import-volunteer-assignments.js --blanks-only           # preview blank overrides only
 *   node scripts/import-volunteer-assignments.js --blanks-only --yes     # apply blank overrides only
 *   node scripts/import-volunteer-assignments.js --yes --test-id SOV-011120
 *
 * Blank volunteer name overrides (row 2 empty, keyed by S.No in row 1):
 *   S.No 18 → Ashutosh  (first IDs: SOV-013890, SOV-004877, …)
 *   S.No 19 → Yash      (first IDs: SOV-005869, SOV-002038, …)
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const XLSX = require('xlsx');
const { MongoClient } = require('mongodb');

const VOLUNTEERS_PATH = path.join(__dirname, '..', 'data', 'Volunteers_Tracker.xlsx');
const SHEET_NAME = 'Volunteer Tracker';

/** S.No (row 1) → volunteer name when row 2 (Volunteer Name) is blank */
const BLANK_NAME_OVERRIDES_BY_SNO = {
  18: 'Ashutosh',
  19: 'Yash',
};

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) {
      const val = m[2].trim();
      if (val.includes('USER:PASSWORD')) continue;
      process.env[m[1].trim()] = val;
    }
  }
}

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB || 'sovereign_town';
const autoYes = process.argv.includes('--yes');
const blanksOnly = process.argv.includes('--blanks-only');
const testIdArg = process.argv.find((a) => a.startsWith('--test-id='))
  || (process.argv.includes('--test-id') ? process.argv[process.argv.indexOf('--test-id') + 1] : null);

function readVolunteerRows(filePath = VOLUNTEERS_PATH) {
  const wb = XLSX.readFile(filePath);
  if (!wb.Sheets[SHEET_NAME]) {
    throw new Error(`Sheet "${SHEET_NAME}" not found in ${filePath}`);
  }
  return XLSX.utils.sheet_to_json(wb.Sheets[SHEET_NAME], { header: 1, defval: null });
}

function parseSovtownIdsForColumn(rows, col) {
  const sovtownIds = [];
  for (let row = 2; row < rows.length; row++) {
    const cell = rows[row]?.[col];
    if (cell == null || String(cell).trim() === '') break;
    sovtownIds.push(String(cell).trim());
  }
  return sovtownIds;
}

function parseVolunteerTracker(options = {}) {
  const { blanksOnly: onlyBlanks = false } = options;
  const rows = readVolunteerRows(options.filePath);
  const colCount = rows.reduce((max, row) => Math.max(max, row?.length || 0), 0);
  const mapping = [];

  for (let col = 1; col < colCount; col++) {
    const snoRaw = rows[0]?.[col];
    const sno = snoRaw != null && String(snoRaw).trim() !== '' ? Number(snoRaw) : null;
    const rawName = rows[1]?.[col];
    const rowNameBlank = rawName == null || String(rawName).trim() === '';
    let name = rowNameBlank ? null : String(rawName).trim();

    if (!name && sno != null && !Number.isNaN(sno) && BLANK_NAME_OVERRIDES_BY_SNO[sno]) {
      name = BLANK_NAME_OVERRIDES_BY_SNO[sno];
    }

    if (!name) continue;

    if (onlyBlanks) {
      if (!rowNameBlank || sno == null || Number.isNaN(sno) || !BLANK_NAME_OVERRIDES_BY_SNO[sno]) {
        continue;
      }
    }

    const sovtownIds = parseSovtownIdsForColumn(rows, col);
    if (sovtownIds.length) {
      mapping.push({ name, sovtownIds, col, sno, rowNameBlank });
    }
  }
  return mapping;
}

/** Detect real MongoDB key names from one stored document. */
function detectFields(sample) {
  if (!sample) throw new Error('Cannot detect fields — municipalities collection is empty.');

  const idCandidates = ['sovtown_id', 'SOVTOWN ID', 'SOVTOWN_ID'];
  const researcherCandidates = ['assignedResearcher', 'assigned_researcher', 'Assigned Researcher'];

  const idField = idCandidates.find((k) => k in sample);
  const researcherField = researcherCandidates.find((k) => k in sample);

  if (!idField) {
    throw new Error(`No SOVTOWN ID field found. Document keys: ${Object.keys(sample).join(', ')}`);
  }
  if (!researcherField) {
    throw new Error(`No Assigned Researcher field found. Document keys: ${Object.keys(sample).join(', ')}`);
  }
  return { idField, researcherField };
}

function volunteerForId(mapping, sovtownId) {
  for (const { name, sovtownIds } of mapping) {
    if (sovtownIds.includes(sovtownId)) return name;
  }
  return null;
}

function printMappingPreview(mapping, count = 2) {
  console.log('\n=== Preview: first volunteer column mappings (read from file) ===\n');
  for (let i = 0; i < Math.min(count, mapping.length); i++) {
    const { name, sovtownIds, sno } = mapping[i];
    console.log(`Volunteer column S.No ${sno}: ${name}`);
    console.log(`  SOVTOWN ID count: ${sovtownIds.length}`);
    console.log(`  First 5 IDs: ${sovtownIds.slice(0, 5).join(', ')}`);
    console.log(`  Last 3 IDs:  ${sovtownIds.slice(-3).join(', ')}\n`);
  }
}

function printBlankOverridePreview(mapping) {
  console.log('\n=== Blank-name volunteer columns (override map, additive only) ===');
  console.log('Only these columns will be written — named volunteer columns are skipped.\n');

  for (const { name, sovtownIds, sno, col } of mapping) {
    console.log(`--- S.No ${sno} (sheet column index ${col}) → "${name}" ---`);
    console.log(`  Count: ${sovtownIds.length}`);
    console.log(`  First 4 IDs: ${sovtownIds.slice(0, 4).join(', ')}`);
    console.log(`  Full SOVTOWN ID list:\n    ${sovtownIds.join(', ')}\n`);
  }
}

function askConfirmation(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

async function applyAssignments(municipalities, mapping, idField, researcherField) {
  let attempted = 0;
  let matched = 0;
  let modified = 0;
  const unmatched = [];
  const byVolunteer = {};
  let firstResultLogged = false;

  for (const { name, sovtownIds } of mapping) {
    byVolunteer[name] = { attempted: 0, matched: 0, modified: 0, unmatched: [] };

    for (const sovtownId of sovtownIds) {
      attempted++;
      byVolunteer[name].attempted++;
      const filter = { [idField]: sovtownId };
      const update = { $set: { [researcherField]: name } };
      const result = await municipalities.updateOne(filter, update);

      if (!firstResultLogged) {
        console.log('\n=== First updateOne call (sample) ===');
        console.log('filter:', JSON.stringify(filter));
        console.log('update:', JSON.stringify(update));
        console.log('result:', JSON.stringify({
          matchedCount: result.matchedCount,
          modifiedCount: result.modifiedCount,
          acknowledged: result.acknowledged,
        }));
        firstResultLogged = true;
      }

      if (result.matchedCount === 0) {
        unmatched.push({ sovtownId, volunteer: name });
        byVolunteer[name].unmatched.push(sovtownId);
      } else {
        matched++;
        byVolunteer[name].matched++;
        if (result.modifiedCount > 0) {
          modified++;
          byVolunteer[name].modified++;
        }
      }
    }
  }

  return { attempted, matched, modified, unmatched, byVolunteer };
}

async function runTestUpdate(municipalities, mapping, idField, researcherField, testId) {
  const expectedVolunteer = volunteerForId(mapping, testId);
  if (!expectedVolunteer) {
    throw new Error(`${testId} not found in Volunteers_Tracker.xlsx`);
  }

  console.log(`\n=== End-to-end test for ${testId} → "${expectedVolunteer}" ===\n`);

  const before = await municipalities.findOne({ [idField]: testId });
  console.log('BEFORE:', JSON.stringify(before, null, 2));

  const filter = { [idField]: testId };
  const update = { $set: { [researcherField]: expectedVolunteer } };
  const result = await municipalities.updateOne(filter, update);
  console.log('\nupdateOne filter:', JSON.stringify(filter));
  console.log('updateOne $set:', JSON.stringify(update));
  console.log('result:', JSON.stringify(result, null, 2));

  const after = await municipalities.findOne({ [idField]: testId });
  console.log('\nAFTER:', JSON.stringify(after, null, 2));
  console.log(`\n${researcherField} after update:`, after?.[researcherField]);
}

async function main() {
  if (!fs.existsSync(VOLUNTEERS_PATH)) {
    throw new Error(`File not found: ${VOLUNTEERS_PATH}`);
  }

  const mapping = parseVolunteerTracker({ blanksOnly });
  const totalIds = mapping.reduce((n, v) => n + v.sovtownIds.length, 0);

  if (blanksOnly) {
    console.log(`Parsed ${mapping.length} blank-name override column(s), ${totalIds} SOVTOWN IDs.`);
    printBlankOverridePreview(mapping);

    if (!autoYes) {
      const answer = await askConfirmation(
        'Review the lists above. Type "yes" to connect and apply ONLY these blank-column assignments (or Ctrl+C to abort): '
      );
      if (answer !== 'yes') {
        console.log('Aborted — no database connection opened.');
        return;
      }
    }
  } else {
    console.log(`Parsed ${mapping.length} volunteer columns, ${totalIds} SOVTOWN IDs.`);
    printMappingPreview(mapping, 2);

    if (!autoYes) {
      const answer = await askConfirmation(
        'Type "yes" to connect and apply assignments (or Ctrl+C to abort): '
      );
      if (answer !== 'yes') {
        console.log('Aborted — no database connection opened.');
        return;
      }
    }
  }

  if (!MONGODB_URI || MONGODB_URI.includes('USER:PASSWORD')) {
    throw new Error('Set a valid MONGODB_URI in .env before running this script.');
  }

  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const municipalities = client.db(DB_NAME).collection('municipalities');

  const sample = await municipalities.findOne({});
  const { idField, researcherField } = detectFields(sample);
  console.log('\n=== Detected field names ===');
  console.log(`  SOVTOWN ID key:          "${idField}"`);
  console.log(`  Assigned Researcher key: "${researcherField}"`);

  if (testIdArg) {
    const fullMapping = parseVolunteerTracker();
    await runTestUpdate(municipalities, fullMapping, idField, researcherField, testIdArg);
    if (!autoYes || process.argv.includes('--test-only')) {
      await client.close();
      return;
    }
  }

  const { attempted, matched, modified, unmatched, byVolunteer } = await applyAssignments(
    municipalities, mapping, idField, researcherField
  );
  await client.close();

  console.log('\n=== Summary ===');
  if (blanksOnly) {
    console.log('Mode: additive blank-column overrides only (other volunteers untouched).');
    for (const volunteer of ['Ashutosh', 'Yash']) {
      const stats = byVolunteer[volunteer];
      if (stats) {
        console.log(`  ${volunteer}: ${stats.matched} matched, ${stats.modified} modified, ${stats.unmatched.length} unmatched`);
      }
    }
  } else {
    console.log(`Volunteers parsed:              ${mapping.length}`);
  }
  console.log(`Assignments attempted:          ${attempted}`);
  console.log(`Documents matched:              ${matched}`);
  console.log(`Documents modified (changed):   ${modified}`);
  console.log(`Unmatched SOVTOWN IDs:          ${unmatched.length}`);

  if (unmatched.length) {
    console.log('\nUnmatched SOVTOWN IDs:');
    for (const { sovtownId, volunteer } of unmatched.slice(0, 50)) {
      console.log(`  ${sovtownId}  (volunteer: ${volunteer})`);
    }
    if (unmatched.length > 50) console.log(`  ... and ${unmatched.length - 50} more`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Import failed:', err.message);
    process.exit(1);
  });
}

module.exports = {
  parseVolunteerTracker,
  detectFields,
  BLANK_NAME_OVERRIDES_BY_SNO,
};

#!/usr/bin/env node
/**
 * Import volunteer → municipality assignments from Volunteers_Tracker_2.xlsx
 * (second batch — row-oriented: SOVTOWN ID | Assigned Researcher).
 *
 * Does NOT overwrite existing assignments for other volunteers.
 * Conflicts (existing different name) are skipped and logged for manual review.
 *
 * MongoDB field: assignedResearcher only (API: assigned_researcher).
 *
 * Usage:
 *   node scripts/import-volunteer-assignments-2.js        # preview + confirm
 *   node scripts/import-volunteer-assignments-2.js --yes  # apply without prompt
 */

require('dotenv').config();
const readline = require('readline');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const { connect, getDb, close } = require('../db');

const VOLUNTEERS_PATH = path.join(__dirname, '..', 'data', 'Volunteers_Tracker_2.xlsx');
const SHEET_NAME = 'Volunteers_Tracker_2';

const autoYes = process.argv.includes('--yes');

function askConfirmation(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

function isBlank(v) {
  return v == null || String(v).trim() === '';
}

/**
 * Read row-oriented sheet starting at row 2 (row 1 = headers).
 * Deduplicates SOVTOWN IDs within the file (first occurrence wins).
 */
function parseVolunteerTracker2(filePath = VOLUNTEERS_PATH) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const wb = XLSX.readFile(filePath);
  if (!wb.Sheets[SHEET_NAME]) {
    throw new Error(`Sheet "${SHEET_NAME}" not found. Available: ${wb.SheetNames.join(', ')}`);
  }

  const rows = XLSX.utils.sheet_to_json(wb.Sheets[SHEET_NAME], { defval: null });

  const seen = new Map(); // sovtownId -> first row index (1-based data row among sheet_to_json)
  const inFileDuplicates = [];
  const needsReview = []; // blank Assigned Researcher
  const candidates = []; // { sovtownId, researcher, sourceRow }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rawId = row['SOVTOWN ID'];
    const rawName = row['Assigned Researcher'];
    const sourceRow = i + 2; // Excel row (header is 1)

    if (isBlank(rawId)) continue;

    const sovtownId = String(rawId).trim();
    const researcher = isBlank(rawName) ? null : String(rawName).trim();

    if (!researcher) {
      needsReview.push({ sovtownId, sourceRow });
      continue;
    }

    if (seen.has(sovtownId)) {
      inFileDuplicates.push({
        sovtownId,
        firstRow: seen.get(sovtownId),
        duplicateRow: sourceRow,
        researcher,
      });
      continue; // first occurrence only
    }

    seen.set(sovtownId, sourceRow);
    candidates.push({ sovtownId, researcher, sourceRow });
  }

  return {
    totalRowsRead: rows.length,
    candidates,
    needsReview,
    inFileDuplicates,
  };
}

/**
 * Classify candidates against existing MongoDB assignedResearcher values.
 * Only municipality.assignedResearcher is ever written — no other fields.
 */
async function classifyAgainstDb(municipalities, candidates) {
  const toAssign = []; // new or currently null/empty
  const alreadyCorrect = []; // same name already set
  const conflicts = []; // different non-null name already set
  const unmatched = []; // no municipality document

  for (const { sovtownId, researcher, sourceRow } of candidates) {
    const doc = await municipalities.findOne(
      { sovtown_id: sovtownId },
      { projection: { sovtown_id: 1, assignedResearcher: 1 } }
    );

    if (!doc) {
      unmatched.push({ sovtownId, researcher, sourceRow });
      continue;
    }

    const existing = doc.assignedResearcher;
    const hasExisting = existing != null && String(existing).trim() !== '';

    if (!hasExisting) {
      toAssign.push({ sovtownId, researcher, sourceRow });
      continue;
    }

    if (String(existing).trim() === researcher) {
      alreadyCorrect.push({ sovtownId, researcher, sourceRow });
      continue;
    }

    conflicts.push({
      sovtownId,
      existingName: String(existing).trim(),
      newName: researcher,
      sourceRow,
    });
  }

  return { toAssign, alreadyCorrect, conflicts, unmatched };
}

async function upsertVolunteerNames(volunteersCol, names) {
  for (const name of names) {
    await volunteersCol.updateOne(
      { name },
      { $setOnInsert: { name, active: true, dateAdded: new Date() } },
      { upsert: true }
    );
  }
}

/**
 * Apply only $set: { assignedResearcher } — no other municipality fields.
 */
async function applyAssignments(municipalities, toAssign) {
  let newAssignments = 0;
  const byResearcher = {};

  for (const { sovtownId, researcher } of toAssign) {
    if (!byResearcher[researcher]) byResearcher[researcher] = 0;

    const result = await municipalities.updateOne(
      { sovtown_id: sovtownId },
      { $set: { assignedResearcher: researcher } }
    );

    if (result.modifiedCount > 0) {
      newAssignments++;
      byResearcher[researcher]++;
    }
  }

  return { newAssignments, byResearcher };
}

function printPreview(parsed, classified) {
  const { totalRowsRead, candidates, needsReview, inFileDuplicates } = parsed;
  const { toAssign, alreadyCorrect, conflicts, unmatched } = classified;

  console.log('\n=== Preview (no writes yet) ===\n');
  console.log(`Total rows read:              ${totalRowsRead}`);
  console.log(`Valid name rows (unique IDs): ${candidates.length}`);
  console.log(`Blank researcher (needs-review): ${needsReview.length}`);
  console.log(`In-file duplicates (skipped): ${inFileDuplicates.length}`);
  console.log(`Would assign (new/empty):     ${toAssign.length}`);
  console.log(`Already correct (no-op):      ${alreadyCorrect.length}`);
  console.log(`Conflicts (will skip):        ${conflicts.length}`);
  console.log(`Unmatched SOVTOWN IDs:        ${unmatched.length}`);

  if (inFileDuplicates.length) {
    console.log('\nIn-file duplicates (first occurrence kept):');
    for (const d of inFileDuplicates) {
      console.log(
        `  ${d.sovtownId}  (first row ${d.firstRow}, duplicate row ${d.duplicateRow}, name "${d.researcher}")`
      );
    }
  }

  if (conflicts.length) {
    console.log('\nConflicts (existing ≠ new — will NOT overwrite):');
    for (const c of conflicts) {
      console.log(`  ${c.sovtownId}: existing="${c.existingName}" vs new="${c.newName}"`);
    }
  }

  if (needsReview.length) {
    console.log('\nNeeds-review (blank Assigned Researcher):');
    for (const r of needsReview) {
      console.log(`  ${r.sovtownId}  (Excel row ${r.sourceRow})`);
    }
  }

  if (unmatched.length) {
    console.log('\nUnmatched SOVTOWN IDs (no municipality document):');
    for (const u of unmatched.slice(0, 30)) {
      console.log(`  ${u.sovtownId}  (researcher: ${u.researcher})`);
    }
    if (unmatched.length > 30) {
      console.log(`  ... and ${unmatched.length - 30} more`);
    }
  }

  console.log('\nOnly field that will be written: assignedResearcher (API: assigned_researcher).');
  console.log('Volunteers not in this file are never cleared or overwritten.');
}

function printFinalSummary(parsed, classified, applyResult) {
  const { needsReview, inFileDuplicates } = parsed;
  const { conflicts, unmatched, alreadyCorrect } = classified;
  const { newAssignments, byResearcher } = applyResult;

  // Expected 15 researchers from this file — include zeros for any that only no-opped
  const allNames = new Set([
    ...Object.keys(byResearcher),
    ...classified.toAssign.map((a) => a.researcher),
    ...alreadyCorrect.map((a) => a.researcher),
  ]);

  console.log('\n=== Final summary ===\n');
  console.log(`Total new assignments made:   ${newAssignments}`);
  console.log(`Already correct (skipped):    ${alreadyCorrect.length}`);
  console.log(`Conflicts skipped:            ${conflicts.length}`);
  console.log(`Unmatched SOVTOWN IDs:        ${unmatched.length}`);
  console.log(`Needs-review (blank name):    ${needsReview.length}`);
  console.log(`In-file duplicates:           ${inFileDuplicates.length}`);

  console.log('\nCount per researcher (new assignments this run):');
  const sortedNames = [...allNames].sort((a, b) => a.localeCompare(b));
  for (const name of sortedNames) {
    const n = byResearcher[name] || 0;
    const already = alreadyCorrect.filter((a) => a.researcher === name).length;
    console.log(`  ${name}: ${n} new${already ? ` (${already} already correct)` : ''}`);
  }

  console.log('\nFull list — needs-review (blank researcher):');
  if (!needsReview.length) {
    console.log('  (none)');
  } else {
    for (const r of needsReview) {
      console.log(`  ${r.sovtownId}`);
    }
  }

  console.log('\nFull list — in-file duplicates:');
  if (!inFileDuplicates.length) {
    console.log('  (none)');
  } else {
    for (const d of inFileDuplicates) {
      console.log(`  ${d.sovtownId}  (kept row ${d.firstRow}, skipped row ${d.duplicateRow})`);
    }
  }

  console.log('\nFull list — conflicts (skipped, needs manual review):');
  if (!conflicts.length) {
    console.log('  (none)');
  } else {
    for (const c of conflicts) {
      console.log(`  ${c.sovtownId}: existing="${c.existingName}" vs new="${c.newName}"`);
    }
  }

  if (unmatched.length) {
    console.log('\nFull list — unmatched SOVTOWN IDs:');
    for (const u of unmatched) {
      console.log(`  ${u.sovtownId}  (researcher: ${u.researcher})`);
    }
  }

  console.log(
    '\nConfirmed: only assignedResearcher was updated on municipalities; no other fields were touched.'
  );
}

async function main() {
  const parsed = parseVolunteerTracker2();
  const uniqueResearchers = [...new Set(parsed.candidates.map((c) => c.researcher))];

  console.log(`Read ${parsed.totalRowsRead} data rows from ${VOLUNTEERS_PATH}`);
  console.log(`Unique researchers in file: ${uniqueResearchers.length}`);

  await connect();
  const db = getDb();
  const municipalities = db.collection('municipalities');
  const volunteers = db.collection('volunteers');

  const classified = await classifyAgainstDb(municipalities, parsed.candidates);
  printPreview(parsed, classified);

  if (!autoYes) {
    const answer = await askConfirmation(
      '\nType "yes" to apply the new assignments listed above (or Ctrl+C to abort): '
    );
    if (answer !== 'yes') {
      console.log('Aborted — no database changes made.');
      await close();
      return;
    }
  }

  // Upsert volunteer directory entries for this batch (separate collection).
  await upsertVolunteerNames(volunteers, uniqueResearchers);
  console.log(`\nUpserted ${uniqueResearchers.length} volunteer name(s) into volunteers collection.`);

  const applyResult = await applyAssignments(municipalities, classified.toAssign);
  await close();

  printFinalSummary(parsed, classified, applyResult);
}

if (require.main === module) {
  main().catch(async (err) => {
    console.error('Import failed:', err.message);
    try {
      await close();
    } catch {
      // ignore
    }
    process.exit(1);
  });
}

module.exports = {
  parseVolunteerTracker2,
  classifyAgainstDb,
  SHEET_NAME,
  VOLUNTEERS_PATH,
};

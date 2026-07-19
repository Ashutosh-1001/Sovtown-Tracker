#!/usr/bin/env node
/**
 * Import volunteer → municipality assignments from Volunteers_Tracker.xlsx.
 *
 * Sheet "Volunteer Tracker": column A = labels; columns B+ = one volunteer
 * per column (row 2 = name, rows 3+ = SOVTOWN IDs).
 *
 * MongoDB fields: sovtown_id, assignedResearcher (API: assigned_researcher).
 *
 * Usage:
 *   node scripts/import-volunteer-assignments.js        # preview 2 columns + confirm
 *   node scripts/import-volunteer-assignments.js --yes  # apply all 20 columns
 */

require('dotenv').config();
const readline = require('readline');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const { connect, getDb, close } = require('../db');

const VOLUNTEERS_PATH = path.join(__dirname, '..', 'data', 'Volunteers_Tracker.xlsx');
const SHEET_NAME = 'Volunteer Tracker';

/** S.No (row 1) → name when row 2 (Volunteer Name) is blank */
const BLANK_NAME_OVERRIDES_BY_SNO = {};

const autoYes = process.argv.includes('--yes');

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
  const rows = readVolunteerRows(options.filePath);
  const colCount = rows.reduce((max, row) => Math.max(max, row?.length || 0), 0);
  const mapping = [];

  for (let col = 1; col < colCount; col++) {
    const snoRaw = rows[0]?.[col];
    const sno = snoRaw != null && String(snoRaw).trim() !== '' ? Number(snoRaw) : col;
    const rawName = rows[1]?.[col];
    const rowNameBlank = rawName == null || String(rawName).trim() === '';
    let name = rowNameBlank ? null : String(rawName).trim();

    if (!name && !Number.isNaN(sno) && BLANK_NAME_OVERRIDES_BY_SNO[sno]) {
      name = BLANK_NAME_OVERRIDES_BY_SNO[sno];
    }

    if (!name) continue;

    const sovtownIds = parseSovtownIdsForColumn(rows, col);
    if (sovtownIds.length) {
      mapping.push({ name, sovtownIds, col, sno, rowNameBlank });
    }
  }
  return mapping;
}

function printMappingPreview(mapping, count = 2) {
  console.log('\n=== Preview: volunteer column mappings (from file) ===\n');
  for (let i = 0; i < Math.min(count, mapping.length); i++) {
    const { name, sovtownIds, sno, rowNameBlank } = mapping[i];
    const nameSource = rowNameBlank ? `(blank row 2 → override)` : '(row 2 name)';
    console.log(`S.No ${sno}: ${name} ${nameSource}`);
    console.log(`  SOVTOWN ID count: ${sovtownIds.length}`);
    console.log(`  First 5 IDs: ${sovtownIds.slice(0, 5).join(', ')}`);
    console.log(`  Last 3 IDs:  ${sovtownIds.slice(-3).join(', ')}\n`);
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

async function upsertVolunteerNames(volunteersCol, mapping) {
  for (const { name } of mapping) {
    await volunteersCol.updateOne(
      { name },
      { $setOnInsert: { name, active: true, dateAdded: new Date() } },
      { upsert: true }
    );
  }
}

async function applyAssignments(municipalities, mapping) {
  let attempted = 0;
  let matched = 0;
  let modified = 0;
  const unmatched = [];
  const byVolunteer = {};

  for (const { name, sovtownIds } of mapping) {
    byVolunteer[name] = { matched: 0, modified: 0, unmatched: [] };

    for (const sovtownId of sovtownIds) {
      attempted++;
      const result = await municipalities.updateOne(
        { sovtown_id: sovtownId },
        { $set: { assignedResearcher: name } }
      );

      if (result.matchedCount === 0) {
        unmatched.push({ sovtownId, volunteer: name });
        byVolunteer[name].unmatched.push(sovtownId);
      } else {
        matched++;
        byVolunteer[name].matched++;
        if (result.modifiedCount > 0) modified++;
      }
    }
  }

  return { attempted, matched, modified, unmatched, byVolunteer };
}

async function main() {
  if (!fs.existsSync(VOLUNTEERS_PATH)) {
    throw new Error(`File not found: ${VOLUNTEERS_PATH}`);
  }

  const mapping = parseVolunteerTracker();
  const totalIds = mapping.reduce((n, v) => n + v.sovtownIds.length, 0);

  console.log(`Parsed ${mapping.length} volunteer columns, ${totalIds} SOVTOWN IDs total.`);
  printMappingPreview(mapping, 2);

  if (!autoYes) {
    const answer = await askConfirmation(
      'Type "yes" to apply assignments for all volunteer columns (or Ctrl+C to abort): '
    );
    if (answer !== 'yes') {
      console.log('Aborted — no database changes made.');
      return;
    }
  }

  await connect();
  const db = getDb();
  const municipalities = db.collection('municipalities');
  const volunteers = db.collection('volunteers');

  await upsertVolunteerNames(volunteers, mapping);
  console.log(`\nUpserted ${mapping.length} volunteer name(s) into volunteers collection.`);

  const { attempted, matched, modified, unmatched, byVolunteer } =
    await applyAssignments(municipalities, mapping);

  await close();

  console.log('\n=== Summary ===');
  console.log(`Volunteers:                     ${mapping.length}`);
  console.log(`Assignments attempted:          ${attempted}`);
  console.log(`Documents matched:              ${matched}`);
  console.log(`Documents modified (changed):   ${modified}`);
  console.log(`Unmatched SOVTOWN IDs:          ${unmatched.length}`);

  console.log('\nPer volunteer:');
  for (const { name } of mapping) {
    const stats = byVolunteer[name];
    console.log(`  ${name}: ${stats.matched} matched, ${stats.unmatched.length} unmatched`);
  }

  if (unmatched.length) {
    console.log('\nUnmatched SOVTOWN IDs:');
    for (const { sovtownId, volunteer } of unmatched.slice(0, 50)) {
      console.log(`  ${sovtownId}  (volunteer: ${volunteer})`);
    }
    if (unmatched.length > 50) console.log(`  ... and ${unmatched.length - 50} more`);
  }
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
  parseVolunteerTracker,
  BLANK_NAME_OVERRIDES_BY_SNO,
};

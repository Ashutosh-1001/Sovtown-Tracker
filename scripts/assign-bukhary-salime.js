#!/usr/bin/env node
/**
 * Assign 60 SOVTOWN IDs to Bukhary Salime (conflict-safe).
 *
 * Usage:
 *   node scripts/assign-bukhary-salime.js        # preview + confirm
 *   node scripts/assign-bukhary-salime.js --yes  # apply without prompt
 */
require('dotenv').config();
const readline = require('readline');
const { connect, getDb, close } = require('../db');

const RESEARCHER = 'Bukhary Salime';

const SOVTOWN_IDS = [
  'SOV-005869', 'SOV-002038', 'SOV-008367', 'SOV-004008', 'SOV-006796',
  'SOV-014109', 'SOV-018391', 'SOV-018086', 'SOV-003629', 'SOV-013941',
  'SOV-005781', 'SOV-002465', 'SOV-007063', 'SOV-002833', 'SOV-005956',
  'SOV-015327', 'SOV-001065', 'SOV-008334', 'SOV-018043', 'SOV-002909',
  'SOV-019452', 'SOV-005841', 'SOV-011002', 'SOV-002450', 'SOV-002905',
  'SOV-015725', 'SOV-011036', 'SOV-019021', 'SOV-007011', 'SOV-007375',
  'SOV-000685', 'SOV-015176', 'SOV-018943', 'SOV-000323', 'SOV-013553',
  'SOV-016487', 'SOV-018847', 'SOV-001087', 'SOV-018297', 'SOV-008203',
  'SOV-011950', 'SOV-000444', 'SOV-016944', 'SOV-007676', 'SOV-013102',
  'SOV-002807', 'SOV-015236', 'SOV-003771', 'SOV-010306', 'SOV-019263',
  'SOV-011616', 'SOV-018080', 'SOV-012054', 'SOV-008508', 'SOV-015861',
  'SOV-017077', 'SOV-013254', 'SOV-016769', 'SOV-006707', 'SOV-007172',
];

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

async function classify(municipalities, ids) {
  const toAssign = [];
  const alreadyCorrect = [];
  const conflicts = [];
  const unmatched = [];

  for (const sovtownId of ids) {
    const doc = await municipalities.findOne(
      { sovtown_id: sovtownId },
      { projection: { sovtown_id: 1, assignedResearcher: 1 } }
    );
    if (!doc) {
      unmatched.push(sovtownId);
      continue;
    }
    const existing = doc.assignedResearcher;
    const hasExisting = existing != null && String(existing).trim() !== '';
    if (!hasExisting) {
      toAssign.push(sovtownId);
    } else if (String(existing).trim() === RESEARCHER) {
      alreadyCorrect.push(sovtownId);
    } else {
      conflicts.push({ sovtownId, existingName: String(existing).trim() });
    }
  }

  return { toAssign, alreadyCorrect, conflicts, unmatched };
}

async function main() {
  if (SOVTOWN_IDS.length !== 60) {
    throw new Error(`Expected 60 IDs, got ${SOVTOWN_IDS.length}`);
  }

  await connect();
  const db = getDb();
  const municipalities = db.collection('municipalities');
  const researchers = db.collection('researchers');

  await researchers.createIndex({ name: 1 }, { unique: true });
  await researchers.updateOne(
    { name: RESEARCHER },
    { $setOnInsert: { name: RESEARCHER, dateAdded: new Date() } },
    { upsert: true }
  );

  const classified = await classify(municipalities, SOVTOWN_IDS);

  console.log('\n=== Preview: assign to Bukhary Salime (no writes to municipalities yet) ===\n');
  console.log(`Total IDs:              ${SOVTOWN_IDS.length}`);
  console.log(`Found & assignable:     ${classified.toAssign.length}`);
  console.log(`Already Bukhary Salime: ${classified.alreadyCorrect.length}`);
  console.log(`Conflicts (skip):       ${classified.conflicts.length}`);
  console.log(`Not found:              ${classified.unmatched.length}`);

  if (classified.unmatched.length) {
    console.log('\nNot found:');
    classified.unmatched.forEach((id) => console.log(`  ${id}`));
  }
  if (classified.conflicts.length) {
    console.log('\nConflicts (will NOT overwrite):');
    classified.conflicts.forEach((c) =>
      console.log(`  ${c.sovtownId}: existing="${c.existingName}" vs new="${RESEARCHER}"`)
    );
  }
  if (classified.toAssign.length) {
    console.log('\nWill assign:');
    classified.toAssign.forEach((id) => console.log(`  ${id}`));
  }

  console.log(`\nResearcher "${RESEARCHER}" upserted into researchers collection.`);

  if (!autoYes) {
    const answer = await askConfirmation(
      '\nType "yes" to apply these assignments (or Ctrl+C to abort): '
    );
    if (answer !== 'yes') {
      console.log('Aborted — no municipality assignments changed.');
      await close();
      return;
    }
  }

  let assigned = 0;
  for (const sovtownId of classified.toAssign) {
    const result = await municipalities.updateOne(
      { sovtown_id: sovtownId },
      { $set: { assignedResearcher: RESEARCHER } }
    );
    if (result.modifiedCount > 0) assigned++;
  }

  const finalCount = await municipalities.countDocuments({ assignedResearcher: RESEARCHER });
  console.log('\n=== Final summary ===');
  console.log(`Newly assigned this run: ${assigned}`);
  console.log(`Already correct:         ${classified.alreadyCorrect.length}`);
  console.log(`Conflicts skipped:       ${classified.conflicts.length}`);
  console.log(`Not found:               ${classified.unmatched.length}`);
  console.log(`Total municipalities with assigned_researcher = "${RESEARCHER}": ${finalCount}`);

  await close();
}

main().catch(async (err) => {
  console.error('Assign failed:', err.message);
  try {
    await close();
  } catch {
    /* ignore */
  }
  process.exit(1);
});

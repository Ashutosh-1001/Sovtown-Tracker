#!/usr/bin/env node
/**
 * Fix known assignedResearcher name typos in municipalities + volunteers.
 *
 * Usage: node scripts/fix-researcher-names.js
 */
require('dotenv').config();
const { connect, getDb, close } = require('../db');

const CORRECTIONS = [
  ['sam obila', 'Sam Obila'],
  ['Acquah Ama Besiwaah Claudia ', 'Acquah Ama Besiwaah Claudia'],
  ['Akebu Simasiku ', 'Akebu Simasiku'],
  ['Atta Senior Poku ', 'Atta Senior Poku'],
  ['Naomi Musalaba ', 'Naomi Musalaba'],
  ['Sriya Godavarthi ', 'Sriya Godavarthi'],
];

async function main() {
  await connect();
  const db = getDb();
  const municipalities = db.collection('municipalities');
  const volunteers = db.collection('volunteers');

  console.log('=== Fix assigned researcher names ===\n');

  for (const [wrong, correct] of CORRECTIONS) {
    const before = await municipalities.countDocuments({ assignedResearcher: wrong });
    console.log(`"${wrong}" → "${correct}"`);
    console.log(`  municipalities before: ${before}`);

    if (before > 0) {
      const result = await municipalities.updateMany(
        { assignedResearcher: wrong },
        { $set: { assignedResearcher: correct } }
      );
      console.log(`  municipalities updated: ${result.modifiedCount}`);
    }

    const after = await municipalities.countDocuments({ assignedResearcher: wrong });
    console.log(`  municipalities after (wrong value): ${after}`);

    const volBefore = await volunteers.countDocuments({ name: wrong });
    if (volBefore > 0) {
      await volunteers.updateOne({ name: wrong }, { $set: { name: correct } });
      console.log(`  volunteers collection: renamed 1 record`);
    }
    console.log('');
  }

  console.log('Note: Researcher filter dropdown uses /api/volunteers (volunteers collection),');
  console.log('not distinct assigned_researcher values from municipalities.');

  await close();
}

if (require.main === module) {
  main().catch(async (err) => {
    console.error('Fix failed:', err.message);
    try { await close(); } catch { /* ignore */ }
    process.exit(1);
  });
}

module.exports = { CORRECTIONS };

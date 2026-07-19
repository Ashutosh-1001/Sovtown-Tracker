#!/usr/bin/env node
/**
 * One-time reset: set assignedResearcher to null on every municipality document.
 *
 * Usage:
 *   node scripts/reset-assigned-researcher.js
 */

require('dotenv').config();
const { connect, getDb, close } = require('../db');

/** Non-null assigned researcher (stored as assignedResearcher in MongoDB). */
const HAS_RESEARCHER_FILTER = {
  assignedResearcher: { $nin: [null, ''], $exists: true },
};

async function main() {
  await connect();
  const municipalities = getDb().collection('municipalities');

  const beforeCount = await municipalities.countDocuments(HAS_RESEARCHER_FILTER);
  console.log(`Before: ${beforeCount} document(s) with non-null assigned_researcher`);

  const result = await municipalities.updateMany(
    {},
    { $set: { assignedResearcher: null } }
  );

  const afterCount = await municipalities.countDocuments(HAS_RESEARCHER_FILTER);
  console.log(`After:  ${afterCount} document(s) with non-null assigned_researcher`);
  console.log(`updateMany matched ${result.matchedCount}, modified ${result.modifiedCount}`);
  console.log('Only assignedResearcher was set to null; no other fields changed.');

  await close();
}

if (require.main === module) {
  main().catch(async (err) => {
    console.error('Reset failed:', err.message);
    try {
      await close();
    } catch {
      // ignore close errors after failure
    }
    process.exit(1);
  });
}

module.exports = { HAS_RESEARCHER_FILTER };

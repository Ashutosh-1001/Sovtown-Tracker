#!/usr/bin/env node
/**
 * One-time backfill: insert distinct assignedResearcher values from
 * municipalities into the researchers collection (skip if already present).
 *
 * Usage: node scripts/backfill-researchers.js
 */
require('dotenv').config();
const { connect, getDb, close } = require('../db');

async function main() {
  await connect();
  const db = getDb();
  const municipalities = db.collection('municipalities');
  const researchers = db.collection('researchers');

  await researchers.createIndex({ name: 1 }, { unique: true });

  const names = await municipalities.distinct('assignedResearcher', {
    assignedResearcher: { $nin: [null, ''] },
  });
  const cleaned = [...new Set(names.map((n) => String(n).trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b)
  );

  console.log(`Distinct assigned_researcher values: ${cleaned.length}`);

  let inserted = 0;
  let already = 0;
  for (const name of cleaned) {
    const result = await researchers.updateOne(
      { name },
      { $setOnInsert: { name, dateAdded: new Date() } },
      { upsert: true }
    );
    if (result.upsertedCount > 0) inserted++;
    else already++;
  }

  const total = await researchers.countDocuments();
  console.log(`Inserted: ${inserted}`);
  console.log(`Already present: ${already}`);
  console.log(`researchers collection total: ${total}`);

  await close();
}

main().catch(async (err) => {
  console.error('Backfill failed:', err.message);
  try {
    await close();
  } catch {
    /* ignore */
  }
  process.exit(1);
});

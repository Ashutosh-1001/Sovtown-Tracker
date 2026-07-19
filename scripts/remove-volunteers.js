#!/usr/bin/env node
/** Remove named volunteers and clear their municipality assignments. */
require('dotenv').config();
const { connect, getDb, close } = require('../db');

const NAMES = ['Ashutosh', 'Yash'];

async function main() {
  await connect();
  const db = getDb();
  const municipalities = db.collection('municipalities');
  const volunteers = db.collection('volunteers');

  for (const name of NAMES) {
    const clear = await municipalities.updateMany(
      { assignedResearcher: name },
      { $set: { assignedResearcher: null } }
    );
    const del = await volunteers.deleteOne({ name });
    console.log(`${name}: cleared ${clear.modifiedCount} assignment(s), volunteer deleted: ${del.deletedCount}`);
  }

  await close();
}

main().catch(async (err) => {
  console.error(err.message);
  try { await close(); } catch { /* ignore */ }
  process.exit(1);
});

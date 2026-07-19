/**
 * One-off debug: inspect MongoDB field names and test assignment queries.
 * Usage: node scripts/debug-mongo-fields.js
 */
require('../db').connect().then(async (db) => {
  const col = db.collection('municipalities');
  const testId = 'SOV-011120';

  console.log('=== STEP 1: One full raw document (first in collection) ===\n');
  const any = await col.findOne({});
  console.log(JSON.stringify(any, null, 2));

  console.log('\n=== STEP 2: Field name probe on SOV-011120 ===');
  const probes = [
    { 'SOVTOWN ID': testId },
    { sovtown_id: testId },
    { SOVTOWN_ID: testId },
  ];
  for (const q of probes) {
    const hit = await col.findOne(q);
    console.log(`findOne(${JSON.stringify(q)}) => ${hit ? 'MATCH' : 'no match'}`);
  }

  console.log('\nResearcher fields on matched doc (sovtown_id):');
  const doc = await col.findOne({ sovtown_id: testId });
  if (doc) {
    console.log('  assignedResearcher:', doc.assignedResearcher);
    console.log('  assigned_researcher:', doc.assigned_researcher);
    console.log('  "Assigned Researcher":', doc['Assigned Researcher']);
  }

  process.exit(0);
}).catch((e) => {
  console.error(e.message);
  process.exit(1);
});

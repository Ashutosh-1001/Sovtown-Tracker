require('dotenv').config();
const { connect, getDb, close } = require('../db');
(async () => {
  await connect();
  const volunteers = await getDb().collection('volunteers')
    .find({ name: /ashutosh/i }).toArray();
  console.log('volunteers:', volunteers.map((v) => v.name));
  const assignments = await getDb().collection('municipalities').aggregate([
    { $match: { assignedResearcher: /ashutosh/i } },
    { $group: { _id: '$assignedResearcher', count: { $sum: 1 } } },
  ]).toArray();
  console.log('assignments:', assignments);
  await close();
})();

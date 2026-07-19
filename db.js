const fs = require('fs');
const path = require('path');
const { MongoClient, ObjectId } = require('mongodb');

// Load .env for local dev (Render injects env vars directly)
const envPath = path.join(__dirname, '.env');
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

let client;
let db;

async function connect() {
  if (db) return db;
  if (!MONGODB_URI) {
    throw new Error('MONGODB_URI environment variable is required');
  }
  client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db(DB_NAME);
  await db.collection('municipalities').createIndex({ sovtown_id: 1 }, { unique: true });
  await db.collection('volunteers').createIndex({ name: 1 }, { unique: true });
  console.log(`Connected to MongoDB database: ${DB_NAME}`);
  return db;
}

function getDb() {
  if (!db) throw new Error('Database not connected. Call connect() first.');
  return db;
}

function normalizeMunicipality(doc) {
  if (!doc) return null;
  const { _id, assignedResearcher, ...rest } = doc;
  return {
    ...rest,
    assigned_researcher: assignedResearcher ?? rest.assigned_researcher ?? null,
  };
}

function normalizeVolunteer(doc) {
  if (!doc) return null;
  return {
    id: doc._id.toString(),
    name: doc.name,
    active: doc.active !== false ? 1 : 0,
    date_added: doc.dateAdded ? doc.dateAdded.toISOString() : null,
  };
}

function bodyToMongoUpdate(body) {
  const update = {};
  const fieldMap = {
    assigned_researcher: 'assignedResearcher',
  };
  for (const [key, value] of Object.entries(body)) {
    update[fieldMap[key] || key] = value;
  }
  return update;
}

module.exports = {
  connect,
  getDb,
  ObjectId,
  normalizeMunicipality,
  normalizeVolunteer,
  bodyToMongoUpdate,
};

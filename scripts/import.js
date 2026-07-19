const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const XLSX = require('xlsx');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data', 'sovereign_town.db');
const CSV_PATH = path.join(__dirname, '..', 'data', 'registry.csv');
const XLSX_PATH = path.join(__dirname, '..', 'data', 'volunteers.xlsx');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

function parsePopulation(v) {
  if (!v) return null;
  const n = parseInt(String(v).replace(/,/g, ''), 10);
  return isNaN(n) ? null : n;
}

function importRegistry() {
  if (!fs.existsSync(CSV_PATH)) return { inserted: 0, skipped: 0, total: 0 };
  const raw = fs.readFileSync(CSV_PATH, 'utf8').replace(/^\uFEFF/, '');
  const rows = parse(raw, { columns: true, skip_empty_lines: true });

  const insert = db.prepare(`
    INSERT INTO municipalities (
      sovtown_id, municipality, legal_designation, official_census_name,
      state, state_abbr, state_fips, place_fips, census_geoid,
      population_2025, under_10000, population_band, enrichment_status,
      assigned_researcher, official_website, primary_contact, contact_email,
      contact_phone, research_notes, census_functional_status, source_url
    ) VALUES (
      @sovtown_id, @municipality, @legal_designation, @official_census_name,
      @state, @state_abbr, @state_fips, @place_fips, @census_geoid,
      @population_2025, @under_10000, @population_band, @enrichment_status,
      @assigned_researcher, @official_website, @primary_contact, @contact_email,
      @contact_phone, @research_notes, @census_functional_status, @source_url
    )
    ON CONFLICT(sovtown_id) DO NOTHING
  `);

  let inserted = 0, skipped = 0;
  const tx = db.transaction((rows) => {
    for (const r of rows) {
      const info = insert.run({
        sovtown_id: r['SOVTOWN ID'],
        municipality: r['Municipality'] || null,
        legal_designation: r['Legal Designation'] || null,
        official_census_name: r['Official Census Name'] || null,
        state: r['State'] || null,
        state_abbr: r['State Abbr.'] || null,
        state_fips: r['State FIPS'] || null,
        place_fips: r['Place FIPS'] || null,
        census_geoid: r['Census GEOID'] || null,
        population_2025: parsePopulation(r['2025 Population']),
        under_10000: r['Under 10,000?'] || null,
        population_band: r['Population Band'] || null,
        enrichment_status: r['Enrichment Status'] || 'Not Started',
        assigned_researcher: r['Assigned Researcher'] || null,
        official_website: r['Official Website'] || null,
        primary_contact: r['Primary Contact'] || null,
        contact_email: r['Contact Email'] || null,
        contact_phone: r['Contact Phone'] || null,
        research_notes: r['Research Notes'] || null,
        census_functional_status: r['Census Functional Status'] || null,
        source_url: r['Source URL'] || null,
      });
      if (info.changes > 0) inserted++; else skipped++;
    }
  });
  tx(rows);
  return { inserted, skipped, total: rows.length };
}

function importVolunteers() {
  if (!fs.existsSync(XLSX_PATH)) return { volunteers: 0, assignments: 0 };
  const wb = XLSX.readFile(XLSX_PATH);
  const sheetName = wb.SheetNames.find(n => /volunteer/i.test(n)) || wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  const nameRow = rows[1] || [];

  const insertVolunteer = db.prepare(`INSERT INTO volunteers (name) VALUES (?) ON CONFLICT(name) DO NOTHING`);
  const updateAssignment = db.prepare(`UPDATE municipalities SET assigned_researcher = ? WHERE sovtown_id = ?`);

  let volunteerCount = 0, assignmentCount = 0;
  const tx = db.transaction(() => {
    for (let col = 1; col < nameRow.length; col++) {
      const name = nameRow[col];
      if (!name) continue;
      insertVolunteer.run(String(name).trim());
      volunteerCount++;
      for (let r = 2; r < rows.length; r++) {
        const sid = rows[r][col];
        if (!sid) continue;
        const info = updateAssignment.run(String(name).trim(), String(sid).trim());
        if (info.changes > 0) assignmentCount++;
      }
    }
  });
  tx();
  return { volunteers: volunteerCount, assignments: assignmentCount };
}

const reg = importRegistry();
console.log(`Registry import: ${reg.inserted} inserted, ${reg.skipped} already existed, ${reg.total} total rows.`);
const vol = importVolunteers();
console.log(`Volunteer import: ${vol.volunteers} volunteers, ${vol.assignments} assignments applied.`);
const dups = db.prepare(`SELECT sovtown_id, COUNT(*) c FROM municipalities GROUP BY sovtown_id HAVING c > 1`).all();
console.log(`Duplicate check: ${dups.length} duplicates found.`);
db.close();

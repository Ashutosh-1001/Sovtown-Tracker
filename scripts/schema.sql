CREATE TABLE IF NOT EXISTS volunteers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  date_added TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS municipalities (
  sovtown_id TEXT PRIMARY KEY,
  municipality TEXT,
  legal_designation TEXT,
  official_census_name TEXT,
  state TEXT,
  state_abbr TEXT,
  state_fips TEXT,
  place_fips TEXT,
  census_geoid TEXT,
  population_2025 INTEGER,
  under_10000 TEXT,
  population_band TEXT,
  enrichment_status TEXT DEFAULT 'Not Started',
  assigned_researcher TEXT,
  official_website TEXT,
  primary_contact TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  research_notes TEXT,
  census_functional_status TEXT,
  source_url TEXT,
  priority TEXT,
  contact_method TEXT,
  follow_up_date TEXT,
  survey_sent TEXT DEFAULT 'No',
  date_sent TEXT,
  response_received TEXT DEFAULT 'No',
  response_date TEXT,
  responded TEXT DEFAULT 'No',
  note TEXT
);

CREATE INDEX IF NOT EXISTS idx_state ON municipalities(state);
CREATE INDEX IF NOT EXISTS idx_pop_band ON municipalities(population_band);
CREATE INDEX IF NOT EXISTS idx_assigned ON municipalities(assigned_researcher);
CREATE INDEX IF NOT EXISTS idx_survey_sent ON municipalities(survey_sent);
CREATE INDEX IF NOT EXISTS idx_responded ON municipalities(responded);
CREATE INDEX IF NOT EXISTS idx_under_10000 ON municipalities(under_10000);

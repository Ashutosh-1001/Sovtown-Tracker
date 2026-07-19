# Project Sovereign Town — Outreach Tracker v2

Outreach tracker for **VOX Felix Laboratory Corporation** (501(c)(3)), managing municipal contact outreach across ~19,500 U.S. municipalities and a volunteer research team.

**Stack:** Node.js, Express, MongoDB Atlas, vanilla HTML/CSS/JS frontend.

Live site: [sovereign-town.onrender.com](https://sovereign-town.onrender.com/)

## Quick start (local)

1. Place source data in `data/`:
   - `data/registry.xlsx` — municipality registry
   - `data/Volunteers_Tracker.xlsx` — volunteer roster with SOVTOWN ID assignments

2. Set your MongoDB connection string:

```powershell
$env:MONGODB_URI="mongodb+srv://USER:PASSWORD@cluster.mongodb.net/?appName=Cluster0"
$env:MONGODB_DB="sovereign_town"
```

3. Import data (one-time or when source files change):

```powershell
npm install
npm run import:mongo
```

4. Start the app:

```powershell
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

Expected import output:

```
Registry: 19483 rows read, 19483 newly inserted (rest already existed).
Volunteers: 17 upserted, 1020 assignments applied.
Duplicate sovtown_id check: 0 duplicates found.
```

## MongoDB import

`npm run import:mongo` runs `scripts/import-all-mongo.js`, which:

| Step | Action |
|------|--------|
| Registry | Upserts municipalities from `registry.xlsx` (`$setOnInsert` — existing outreach data is preserved) |
| Volunteers | Upserts volunteer names and sets `assignedResearcher` on matching `sovtown_id`s |

Re-running is safe. Only **new** municipalities are inserted; volunteer assignments are re-applied from the spreadsheet.

## Deploy on Render

1. Push this repo to GitHub (connected to Render).
2. In Render dashboard → **Environment**, set:
   - `MONGODB_URI` — your Atlas connection string
   - `MONGODB_DB` — `sovereign_town` (optional, this is the default)
3. **Start command:** `npm start` (no import step on deploy — data lives in Atlas).
4. Run `npm run import:mongo` locally whenever source files change.

Alternatively, use the included `render.yaml` blueprint.

## Legacy SQLite import

`npm run import` still runs the original SQLite importer (`scripts/import.js`) for local/offline use. The web app now reads from **MongoDB only** and requires `MONGODB_URI`.

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/municipalities` | Paginated, filterable list |
| POST | `/api/municipalities` | Add new contact (auto `SOV-######` ID) |
| PATCH | `/api/municipalities/:sovtown_id` | Update outreach fields |
| DELETE | `/api/municipalities/:sovtown_id` | Remove a record |
| GET | `/api/stats` | Dashboard statistics |
| GET | `/api/volunteers` | List volunteers |
| POST | `/api/volunteers` | Add volunteer |
| PATCH | `/api/volunteers/:id` | Rename or activate/deactivate |
| DELETE | `/api/volunteers/:id` | Remove volunteer (unassigns municipalities) |
| POST | `/api/auto-assign` | Batch auto-assign unassigned municipalities |
| GET | `/api/export` | CSV export |

## Project structure

```
sovereign-town/
├── data/
│   ├── registry.xlsx
│   └── Volunteers_Tracker.xlsx
├── public/           # Frontend (matches live site UI)
├── scripts/
│   ├── import-all-mongo.js
│   ├── import.js     # Legacy SQLite import
│   └── schema.sql
├── db.js             # MongoDB connection
├── server.js
├── render.yaml
└── package.json
```

VOX Felix Laboratory Corporation · Project Sovereign Town · 501(c)(3)

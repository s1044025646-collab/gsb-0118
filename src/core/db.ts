import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  migrate(db);
  return db;
}

export function migrate(db: DatabaseSync): void {
  const current = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  if (current >= 1) return;
  db.exec(`
  CREATE TABLE IF NOT EXISTS schema_lock(locked INTEGER NOT NULL CHECK(locked = 1));
  CREATE TABLE IF NOT EXISTS pollutants(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    unit TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS stations(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    x_m REAL NOT NULL,
    y_m REAL NOT NULL
  );
  CREATE TABLE IF NOT EXISTS emission_sources(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    x_m REAL NOT NULL,
    y_m REAL NOT NULL
  );
  CREATE TABLE IF NOT EXISTS fingerprint_versions(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version TEXT NOT NULL UNIQUE,
    effective_start TEXT NOT NULL,
    effective_end TEXT,
    note TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS fingerprint_values(
    version_id INTEGER NOT NULL REFERENCES fingerprint_versions(id) ON DELETE CASCADE,
    source_id INTEGER NOT NULL REFERENCES emission_sources(id) ON DELETE CASCADE,
    pollutant_id INTEGER NOT NULL REFERENCES pollutants(id) ON DELETE CASCADE,
    value REAL NOT NULL CHECK(value >= 0),
    uncertainty REAL NOT NULL CHECK(uncertainty >= 0),
    PRIMARY KEY(version_id, source_id, pollutant_id)
  );
  CREATE TABLE IF NOT EXISTS wind_observations(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    station_id INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
    observed_at TEXT NOT NULL,
    wind_from_deg REAL NOT NULL CHECK(wind_from_deg >= 0 AND wind_from_deg < 360),
    speed_m_s REAL NOT NULL CHECK(speed_m_s >= 0),
    supersedes_id INTEGER REFERENCES wind_observations(id)
  );
  CREATE INDEX IF NOT EXISTS idx_wind_station_time ON wind_observations(station_id, observed_at);
  CREATE TABLE IF NOT EXISTS background_concentrations(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    station_id INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
    pollutant_id INTEGER NOT NULL REFERENCES pollutants(id) ON DELETE CASCADE,
    valid_from TEXT NOT NULL,
    valid_to TEXT,
    value REAL NOT NULL CHECK(value >= 0)
  );
  CREATE INDEX IF NOT EXISTS idx_background_lookup ON background_concentrations(station_id, pollutant_id, valid_from);
  CREATE TABLE IF NOT EXISTS emission_periods(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER NOT NULL REFERENCES emission_sources(id) ON DELETE CASCADE,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    relative_rate REAL NOT NULL CHECK(relative_rate >= 0),
    note TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS observations(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    station_id INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
    pollutant_id INTEGER NOT NULL REFERENCES pollutants(id) ON DELETE CASCADE,
    observed_at TEXT NOT NULL,
    raw_value REAL,
    corrected_value REAL,
    quality_flag TEXT NOT NULL CHECK(quality_flag IN ('ok','suspect','bad','missing')),
    quality_note TEXT NOT NULL DEFAULT '',
    correction_of_id INTEGER REFERENCES observations(id)
  );
  CREATE INDEX IF NOT EXISTS idx_observation_lookup ON observations(station_id, observed_at, pollutant_id);
  CREATE TABLE IF NOT EXISTS analysis_batches(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    station_id INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
    window_start TEXT NOT NULL,
    window_end TEXT NOT NULL,
    fingerprint_version_id INTEGER NOT NULL REFERENCES fingerprint_versions(id),
    status TEXT NOT NULL CHECK(status IN ('rejected','estimated')),
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_batch_window ON analysis_batches(station_id, window_start, window_end);
  CREATE TABLE IF NOT EXISTS source_contributions(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id INTEGER NOT NULL REFERENCES analysis_batches(id) ON DELETE CASCADE,
    source_id INTEGER NOT NULL REFERENCES emission_sources(id) ON DELETE CASCADE,
    contribution REAL NOT NULL CHECK(contribution >= 0),
    lower_ci REAL,
    upper_ci REAL,
    UNIQUE(batch_id, source_id)
  );
  CREATE TABLE IF NOT EXISTS batch_residuals(
    batch_id INTEGER NOT NULL REFERENCES analysis_batches(id) ON DELETE CASCADE,
    pollutant_id INTEGER NOT NULL REFERENCES pollutants(id) ON DELETE CASCADE,
    observed REAL NOT NULL,
    predicted REAL NOT NULL,
    residual REAL NOT NULL,
    PRIMARY KEY(batch_id, pollutant_id)
  );
  CREATE TABLE IF NOT EXISTS batch_candidate_sources(
    batch_id INTEGER NOT NULL REFERENCES analysis_batches(id) ON DELETE CASCADE,
    source_id INTEGER NOT NULL REFERENCES emission_sources(id) ON DELETE CASCADE,
    accepted INTEGER NOT NULL,
    reason TEXT NOT NULL,
    PRIMARY KEY(batch_id, source_id)
  );
  CREATE TABLE IF NOT EXISTS manual_reviews(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id INTEGER NOT NULL REFERENCES analysis_batches(id) ON DELETE CASCADE,
    reviewer TEXT NOT NULL,
    decision TEXT NOT NULL CHECK(decision IN ('confirmed','dismissed','needs_data')),
    note TEXT NOT NULL DEFAULT '',
    reviewed_at TEXT NOT NULL
  );
  PRAGMA user_version = 1;
  `);
}

export function withTransaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

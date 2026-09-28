import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

export function withTransaction<T>(db: Db, work: () => T): T {
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

export function openDatabase(path = ':memory:'): Db {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pollutants (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      unit TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      x REAL NOT NULL,
      y REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS emission_sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      x REAL NOT NULL,
      y REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS fingerprints (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES emission_sources(id),
      version INTEGER NOT NULL,
      effective_from TEXT NOT NULL,
      supersedes TEXT REFERENCES fingerprints(id),
      profile_json TEXT NOT NULL,
      UNIQUE(source_id, version)
    );

    CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      station_id TEXT NOT NULL REFERENCES stations(id),
      pollutant TEXT NOT NULL REFERENCES pollutants(code),
      observed_at TEXT NOT NULL,
      original_value REAL NOT NULL,
      corrected_value REAL,
      quality TEXT NOT NULL DEFAULT 'ok' CHECK(quality IN ('ok','suspect','missing','drift','excluded')),
      quality_note TEXT NOT NULL DEFAULT '',
      revision INTEGER NOT NULL DEFAULT 1,
      UNIQUE(station_id, pollutant, observed_at)
    );

    CREATE TABLE IF NOT EXISTS weather (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      station_id TEXT NOT NULL REFERENCES stations(id),
      observed_at TEXT NOT NULL,
      wind_direction_deg REAL NOT NULL CHECK(wind_direction_deg >= 0 AND wind_direction_deg < 360),
      wind_speed_mps REAL NOT NULL CHECK(wind_speed_mps >= 0),
      revision INTEGER NOT NULL DEFAULT 1,
      UNIQUE(station_id, observed_at)
    );

    CREATE TABLE IF NOT EXISTS background_concentrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      station_id TEXT NOT NULL REFERENCES stations(id),
      pollutant TEXT NOT NULL REFERENCES pollutants(code),
      starts_at TEXT NOT NULL,
      value REAL NOT NULL CHECK(value >= 0),
      revision INTEGER NOT NULL DEFAULT 1,
      UNIQUE(station_id, pollutant, starts_at)
    );

    CREATE TABLE IF NOT EXISTS emission_windows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT NOT NULL REFERENCES emission_sources(id),
      starts_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      relative_rate REAL NOT NULL CHECK(relative_rate >= 0),
      fingerprint_id TEXT NOT NULL REFERENCES fingerprints(id),
      CHECK(ends_at > starts_at)
    );

    CREATE TABLE IF NOT EXISTS analysis_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      station_id TEXT NOT NULL REFERENCES stations(id),
      window_start TEXT NOT NULL,
      window_end TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('estimated','rejected','reviewed')),
      reason TEXT,
      identifiability TEXT NOT NULL CHECK(identifiability IN ('identifiable','weak','unidentifiable')),
      algorithm TEXT NOT NULL,
      created_at TEXT NOT NULL,
      data_revision INTEGER NOT NULL DEFAULT 1,
      CHECK(window_end > window_start)
    );

    CREATE TABLE IF NOT EXISTS run_sources (
      run_id INTEGER NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL REFERENCES emission_sources(id),
      fingerprint_id TEXT NOT NULL REFERENCES fingerprints(id),
      contribution REAL NOT NULL CHECK(contribution >= 0),
      share REAL CHECK(share IS NULL OR (share >= 0 AND share <= 1)),
      eligible INTEGER NOT NULL CHECK(eligible IN (0,1)),
      screening_detail TEXT NOT NULL,
      PRIMARY KEY(run_id, source_id)
    );

    CREATE TABLE IF NOT EXISTS run_residuals (
      run_id INTEGER NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
      pollutant TEXT NOT NULL REFERENCES pollutants(code),
      observed REAL NOT NULL,
      modeled REAL NOT NULL,
      residual REAL NOT NULL,
      PRIMARY KEY(run_id, pollutant)
    );

    CREATE TABLE IF NOT EXISTS reviews (
      run_id INTEGER PRIMARY KEY REFERENCES analysis_runs(id) ON DELETE CASCADE,
      reviewer TEXT NOT NULL,
      decision TEXT NOT NULL CHECK(decision IN ('confirmed','rejected','needs_data')),
      note TEXT NOT NULL,
      reviewed_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_observations_query ON observations(station_id, observed_at, pollutant);
    CREATE INDEX IF NOT EXISTS idx_weather_query ON weather(station_id, observed_at);
    CREATE INDEX IF NOT EXISTS idx_background_query ON background_concentrations(station_id, pollutant, starts_at);
    CREATE INDEX IF NOT EXISTS idx_windows_time ON emission_windows(starts_at, ends_at);
  `);

  const applied = db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)');
  applied.run(1, new Date(0).toISOString());
}

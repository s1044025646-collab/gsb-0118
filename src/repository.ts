import type { Db } from './db.js';
import type {
  BackgroundRecord,
  EmissionSource,
  EmissionWindow,
  Fingerprint,
  Observation,
  Paginated,
  Pollutant,
  QualityFlag,
  Station,
  WeatherRecord
} from './types.js';
import { ApiError } from './errors.js';
import { withTransaction } from './db.js';

function jsonProfile(value: string): Record<string, number> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid fingerprint profile');
  return parsed as Record<string, number>;
}

export class Repository {
  constructor(private readonly db: Db) {}

  transaction<T>(work: () => T): T {
    return withTransaction(this.db, work);
  }

  upsertPollutant(input: Pollutant): void {
    this.db.prepare(`
      INSERT INTO pollutants(code,name,unit) VALUES (?,?,?)
      ON CONFLICT(code) DO UPDATE SET name=excluded.name, unit=excluded.unit
    `).run(input.code, input.name, input.unit);
  }

  upsertStation(input: Station): void {
    this.db.prepare(`
      INSERT INTO stations(id,name,x,y) VALUES (?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, x=excluded.x, y=excluded.y
    `).run(input.id, input.name, input.x, input.y);
  }

  upsertSource(input: EmissionSource): void {
    this.db.prepare(`
      INSERT INTO emission_sources(id,name,x,y) VALUES (?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, x=excluded.x, y=excluded.y
    `).run(input.id, input.name, input.x, input.y);
  }

  addFingerprint(input: Fingerprint): void {
    this.db.prepare(`
      INSERT INTO fingerprints(id,source_id,version,effective_from,supersedes,profile_json)
      VALUES (?,?,?,?,?,?)
    `).run(input.id, input.source_id, input.version, input.effective_from, input.supersedes, JSON.stringify(input.profile));
  }

  insertObservation(input: { station_id: string; pollutant: string; observed_at: string; value: number }): number {
    const result = this.db.prepare(`
      INSERT INTO observations(station_id,pollutant,observed_at,original_value,corrected_value)
      VALUES (?,?,?,?,?)
      ON CONFLICT(station_id,pollutant,observed_at) DO UPDATE SET
        original_value=excluded.original_value,
        corrected_value=NULL,
        quality='ok',
        quality_note='',
        revision=observations.revision+1
    `).run(input.station_id, input.pollutant, input.observed_at, input.value, input.value);
    return Number(result.lastInsertRowid);
  }

  markObservation(id: number, quality: QualityFlag, note: string, correctedValue: number | null): Observation {
    const update = this.db.prepare(`
      UPDATE observations
      SET quality=?, quality_note=?, corrected_value=?, revision=revision+1
      WHERE id=?
    `);
    const changed = update.run(quality, note, correctedValue, id).changes;
    if (changed !== 1) throw new ApiError('OBSERVATION_NOT_FOUND', 404, `observation ${id} not found`);
    return this.getObservation(id);
  }

  getObservation(id: number): Observation {
    const row = this.db.prepare('SELECT * FROM observations WHERE id=?').get(id) as Observation | undefined;
    if (!row) throw new ApiError('OBSERVATION_NOT_FOUND', 404, `observation ${id} not found`);
    return row;
  }

  listObservations(stationId: string, start: string, end: string, limit: number, offset: number): Paginated<Observation> {
    const where = 'station_id=? AND observed_at>=? AND observed_at<?';
    const params = [stationId, start, end];
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS n FROM observations WHERE ${where}`).get(...params) as { n: number }).n);
    const items = this.db.prepare(`SELECT * FROM observations WHERE ${where} ORDER BY observed_at,pollutant LIMIT ? OFFSET ?`).all(...params, limit, offset) as unknown as Observation[];
    return { items, limit, offset, total };
  }

  upsertWeather(input: Omit<WeatherRecord, 'id' | 'revision'>): void {
    this.db.prepare(`
      INSERT INTO weather(station_id,observed_at,wind_direction_deg,wind_speed_mps,revision)
      VALUES (?,?,?,?,1)
      ON CONFLICT(station_id,observed_at) DO UPDATE SET
        wind_direction_deg=excluded.wind_direction_deg,
        wind_speed_mps=excluded.wind_speed_mps,
        revision=weather.revision+1
    `).run(input.station_id, input.observed_at, input.wind_direction_deg, input.wind_speed_mps);
  }

  upsertBackground(input: Omit<BackgroundRecord, 'id' | 'revision'>): void {
    this.db.prepare(`
      INSERT INTO background_concentrations(station_id,pollutant,starts_at,value,revision)
      VALUES (?,?,?,?,1)
      ON CONFLICT(station_id,pollutant,starts_at) DO UPDATE SET
        value=excluded.value,
        revision=background_concentrations.revision+1
    `).run(input.station_id, input.pollutant, input.starts_at, input.value);
  }

  addEmissionWindow(input: Omit<EmissionWindow, 'id'>): void {
    this.db.prepare(`
      INSERT INTO emission_windows(source_id,starts_at,ends_at,relative_rate,fingerprint_id)
      VALUES (?,?,?,?,?)
    `).run(input.source_id, input.starts_at, input.ends_at, input.relative_rate, input.fingerprint_id);
  }

  getStation(id: string): Station {
    const row = this.db.prepare('SELECT * FROM stations WHERE id=?').get(id) as Station | undefined;
    if (!row) throw new ApiError('STATION_NOT_FOUND', 404, `station ${id} not found`);
    return row;
  }

  listStations(): Station[] {
    return this.db.prepare('SELECT * FROM stations ORDER BY id').all() as unknown as Station[];
  }

  listPollutants(): Pollutant[] {
    return this.db.prepare('SELECT * FROM pollutants ORDER BY code').all() as unknown as Pollutant[];
  }

  listSources(): EmissionSource[] {
    return this.db.prepare('SELECT * FROM emission_sources ORDER BY id').all() as unknown as EmissionSource[];
  }

  getFingerprintAt(sourceId: string, at: string): Fingerprint | null {
    const row = this.db.prepare(`
      SELECT * FROM fingerprints
      WHERE source_id=? AND effective_from<=?
      ORDER BY version DESC LIMIT 1
    `).get(sourceId, at) as Omit<Fingerprint, 'profile'> & { profile_json: string } | undefined;
    return row ? { ...row, profile: jsonProfile(row.profile_json) } : null;
  }

  getFingerprint(id: string): Fingerprint {
    const row = this.db.prepare('SELECT * FROM fingerprints WHERE id=?').get(id) as Omit<Fingerprint, 'profile'> & { profile_json: string } | undefined;
    if (!row) throw new ApiError('FINGERPRINT_NOT_FOUND', 404, `fingerprint ${id} not found`);
    return { ...row, profile: jsonProfile(row.profile_json) };
  }

  observationsFor(stationId: string, start: string, end: string): Observation[] {
    return this.db.prepare(`
      SELECT * FROM observations WHERE station_id=? AND observed_at>=? AND observed_at<?
      ORDER BY observed_at,pollutant
    `).all(stationId, start, end) as unknown as Observation[];
  }

  weatherFor(stationId: string, start: string, end: string): WeatherRecord[] {
    return this.db.prepare(`
      SELECT * FROM weather WHERE station_id=? AND observed_at>=? AND observed_at<?
      ORDER BY observed_at
    `).all(stationId, start, end) as unknown as WeatherRecord[];
  }

  backgroundAt(stationId: string, pollutant: string, at: string): number {
    const row = this.db.prepare(`
      SELECT value FROM background_concentrations
      WHERE station_id=? AND pollutant=? AND starts_at<=?
      ORDER BY starts_at DESC LIMIT 1
    `).get(stationId, pollutant, at) as { value: number } | undefined;
    return row?.value ?? 0;
  }

  hasBackgroundStepChange(stationId: string, start: string, end: string): boolean {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS n FROM (
        SELECT pollutant, COUNT(DISTINCT value) AS variants
        FROM background_concentrations
        WHERE station_id=? AND starts_at>=? AND starts_at<?
        GROUP BY pollutant
        HAVING variants > 1
      )
    `).get(stationId, start, end) as { n: number } | undefined;
    return Number(row?.n ?? 0) > 0;
  }

  overlappingWindows(start: string, end: string): EmissionWindow[] {
    return this.db.prepare(`
      SELECT * FROM emission_windows WHERE starts_at<? AND ends_at>?
      ORDER BY starts_at
    `).all(end, start) as unknown as EmissionWindow[];
  }

  insertRun(input: Omit<import('./types.ts').AnalysisRun, 'id'>): number {
    const result = this.db.prepare(`
      INSERT INTO analysis_runs(station_id,window_start,window_end,status,reason,identifiability,algorithm,created_at,data_revision)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(input.station_id, input.window_start, input.window_end, input.status, input.reason, input.identifiability, input.algorithm, input.created_at, input.data_revision);
    return Number(result.lastInsertRowid);
  }

  insertContribution(input: import('./types.ts').RunContribution): void {
    this.db.prepare(`
      INSERT INTO run_sources(run_id,source_id,fingerprint_id,contribution,share,eligible,screening_detail)
      VALUES (?,?,?,?,?,?,?)
    `).run(input.run_id, input.source_id, input.fingerprint_id, input.contribution, input.share, input.eligible, input.screening_detail);
  }

  insertResidual(input: import('./types.ts').RunResidual): void {
    this.db.prepare(`
      INSERT INTO run_residuals(run_id,pollutant,observed,modeled,residual)
      VALUES (?,?,?,?,?)
    `).run(input.run_id, input.pollutant, input.observed, input.modeled, input.residual);
  }

  getRun(id: number): import('./types.ts').AnalysisRun {
    const row = this.db.prepare('SELECT * FROM analysis_runs WHERE id=?').get(id) as unknown as import('./types.js').AnalysisRun | undefined;
    if (!row) throw new ApiError('RUN_NOT_FOUND', 404, `analysis run ${id} not found`);
    return row;
  }

  runContributions(id: number): import('./types.ts').RunContribution[] {
    return this.db.prepare('SELECT * FROM run_sources WHERE run_id=? ORDER BY contribution DESC,source_id').all(id) as unknown as import('./types.js').RunContribution[];
  }

  runResiduals(id: number): import('./types.ts').RunResidual[] {
    return this.db.prepare('SELECT * FROM run_residuals WHERE run_id=? ORDER BY pollutant').all(id) as unknown as import('./types.js').RunResidual[];
  }

  listRuns(stationId: string | undefined, limit: number, offset: number): Paginated<import('./types.ts').AnalysisRun> {
    const where = stationId ? 'WHERE station_id=?' : '';
    const params = stationId ? [stationId] : [];
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS n FROM analysis_runs ${where}`).get(...params) as { n: number }).n);
    const items = this.db.prepare(`SELECT * FROM analysis_runs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as unknown as import('./types.js').AnalysisRun[];
    return { items, limit, offset, total };
  }

  reviewRun(id: number, reviewer: string, decision: 'confirmed' | 'rejected' | 'needs_data', note: string, at: string): void {
    this.db.prepare(`
      INSERT INTO reviews(run_id,reviewer,decision,note,reviewed_at)
      VALUES (?,?,?,?,?)
      ON CONFLICT(run_id) DO UPDATE SET reviewer=excluded.reviewer, decision=excluded.decision, note=excluded.note, reviewed_at=excluded.reviewed_at
    `).run(id, reviewer, decision, note, at);
    this.db.prepare(`UPDATE analysis_runs SET status=CASE WHEN ?='rejected' THEN 'rejected' ELSE 'reviewed' END WHERE id=?`).run(decision, id);
  }
}


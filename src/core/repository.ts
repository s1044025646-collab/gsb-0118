import type { DatabaseSync } from 'node:sqlite';
import { AppError, optionalIso, requiredNumber, requiredString } from './errors.js';
import { parseIso, type Clock } from './time.js';
import type { QualityFlag } from './types.js';
import { withTransaction } from './db.js';

export class Repository {
  constructor(readonly db: DatabaseSync, private readonly clock: Clock = () => new Date()) {}

  private returning(sql: string, values: unknown[]) {
    const statement = this.db.prepare(sql) as unknown as { get(...args: unknown[]): unknown };
    return statement.get(...values);
  }

  addPollutant(input: { code: unknown; name: unknown; unit: unknown }) {
    const code = requiredString(input.code, 'code', 32);
    const name = requiredString(input.name, 'name');
    const unit = requiredString(input.unit, 'unit', 16);
    try {
      return this.db.prepare('INSERT INTO pollutants(code,name,unit) VALUES(?,?,?) RETURNING *').get(code, name, unit);
    } catch (error) {
      throw this.mapUnique(error, 'pollutant');
    }
  }

  addStation(input: { code: unknown; name: unknown; x_m: unknown; y_m: unknown }) {
    const code = requiredString(input.code, 'code', 32);
    const name = requiredString(input.name, 'name');
    const x = requiredNumber(input.x_m, 'x_m');
    const y = requiredNumber(input.y_m, 'y_m');
    try {
      return this.db.prepare('INSERT INTO stations(code,name,x_m,y_m) VALUES(?,?,?,?) RETURNING *').get(code, name, x, y);
    } catch (error) {
      throw this.mapUnique(error, 'station');
    }
  }

  addSource(input: { code: unknown; name: unknown; x_m: unknown; y_m: unknown }) {
    const code = requiredString(input.code, 'code', 32);
    const name = requiredString(input.name, 'name');
    const x = requiredNumber(input.x_m, 'x_m');
    const y = requiredNumber(input.y_m, 'y_m');
    try {
      return this.db.prepare('INSERT INTO emission_sources(code,name,x_m,y_m) VALUES(?,?,?,?) RETURNING *')
        .get(code, name, x, y);
    } catch (error) {
      throw this.mapUnique(error, 'emission source');
    }
  }

  addFingerprintVersion(input: { version: unknown; effective_start: unknown; note?: unknown }) {
    const version = requiredString(input.version, 'version', 32);
    const effectiveStart = requiredString(input.effective_start, 'effective_start');
    parseIso(effectiveStart);
    const note = input.note === undefined ? '' : requiredString(input.note, 'note');
    try {
      return this.db.prepare('INSERT INTO fingerprint_versions(version,effective_start,note) VALUES(?,?,?) RETURNING *')
        .get(version, effectiveStart, note);
    } catch (error) {
      throw this.mapUnique(error, 'fingerprint version');
    }
  }

  setFingerprintValue(versionId: number, sourceId: number, pollutantId: number, value: number, uncertainty: number) {
    const numericValue = requiredNumber(value, 'value', 0);
    const numericUncertainty = requiredNumber(uncertainty, 'uncertainty', 0);
    return this.returning(`INSERT INTO fingerprint_values(version_id,source_id,pollutant_id,value,uncertainty)
      VALUES(?,?,?,?,?) ON CONFLICT(version_id,source_id,pollutant_id)
      DO UPDATE SET value=excluded.value, uncertainty=excluded.uncertainty RETURNING *`,
      [versionId, sourceId, pollutantId, numericValue, numericUncertainty]);
  }

  addWind(input: { station_id: unknown; observed_at: unknown; wind_from_deg: unknown; speed_m_s: unknown; supersedes_id?: unknown }) {
    const stationId = this.id(input.station_id, 'station_id');
    const at = requiredString(input.observed_at, 'observed_at');
    parseIso(at);
    const from = requiredNumber(input.wind_from_deg, 'wind_from_deg', 0, 359.999999);
    const speed = requiredNumber(input.speed_m_s, 'speed_m_s', 0, 100);
    const supersedes = input.supersedes_id === undefined ? null : this.id(input.supersedes_id, 'supersedes_id');
    const statement = this.db.prepare(`INSERT INTO wind_observations(station_id,observed_at,wind_from_deg,speed_m_s,supersedes_id)
      VALUES(?,?,?,?,?) RETURNING *`) as unknown as { get(...values: unknown[]): unknown };
    return statement.get(stationId, at, from, speed, supersedes);
  }

  setBackground(input: { station_id: unknown; pollutant_id: unknown; valid_from: unknown; valid_to?: unknown; value: unknown }) {
    const stationId = this.id(input.station_id, 'station_id');
    const pollutantId = this.id(input.pollutant_id, 'pollutant_id');
    const from = requiredString(input.valid_from, 'valid_from');
    parseIso(from);
    const to = optionalIso(input.valid_to, 'valid_to');
    if (to && parseIso(to) <= parseIso(from)) throw new AppError('VALIDATION_ERROR', 'valid_to must be later than valid_from');
    const value = requiredNumber(input.value, 'value', 0);
    const statement = this.db.prepare(`INSERT INTO background_concentrations(station_id,pollutant_id,valid_from,valid_to,value)
      VALUES(?,?,?,?,?) RETURNING *`) as unknown as { get(...values: unknown[]): unknown };
    return statement.get(stationId, pollutantId, from, to, value);
  }

  addEmissionPeriod(input: { source_id: unknown; started_at: unknown; ended_at?: unknown; relative_rate: unknown; note?: unknown }) {
    const sourceId = this.id(input.source_id, 'source_id');
    const start = requiredString(input.started_at, 'started_at');
    parseIso(start);
    const end = optionalIso(input.ended_at, 'ended_at');
    const rate = requiredNumber(input.relative_rate, 'relative_rate', 0, 100);
    return this.returning(`INSERT INTO emission_periods(source_id,started_at,ended_at,relative_rate,note)
      VALUES(?,?,?,?,?) RETURNING *`, [sourceId, start, end, rate, input.note ?? '']);
  }

  addObservation(input: { station_id: unknown; pollutant_id: unknown; observed_at: unknown; raw_value: unknown; quality_flag?: unknown; quality_note?: unknown }) {
    const stationId = this.id(input.station_id, 'station_id');
    const pollutantId = this.id(input.pollutant_id, 'pollutant_id');
    const at = requiredString(input.observed_at, 'observed_at');
    parseIso(at);
    if (input.raw_value !== null && (typeof input.raw_value !== 'number' || !Number.isFinite(input.raw_value) || input.raw_value < 0)) {
      throw new AppError('VALIDATION_ERROR', 'raw_value must be null or a non-negative finite number');
    }
    const flag = (input.quality_flag ?? (input.raw_value === null ? 'missing' : 'ok')) as QualityFlag;
    if (!['ok', 'suspect', 'bad', 'missing'].includes(flag)) throw new AppError('VALIDATION_ERROR', 'invalid quality flag');
    return this.returning(`INSERT INTO observations(station_id,pollutant_id,observed_at,raw_value,corrected_value,quality_flag,quality_note)
      VALUES(?,?,?,?,?,?,?) RETURNING *`, [stationId, pollutantId, at, input.raw_value, input.raw_value, flag, input.quality_note ?? '']);
  }

  correctObservation(observationId: number, correctedValue: number | null, flag: QualityFlag, note: string) {
    return withTransaction(this.db, () => {
      const original = this.db.prepare('SELECT * FROM observations WHERE id=?').get(observationId);
      if (!original) throw new AppError('NOT_FOUND', 'observation not found', 404);
      if (correctedValue !== null && (!Number.isFinite(correctedValue) || correctedValue < 0)) {
        throw new AppError('VALIDATION_ERROR', 'corrected value must be null or non-negative');
      }
      const record = original as { station_id: number; pollutant_id: number; observed_at: string; raw_value: number | null };
      return this.returning(`INSERT INTO observations(station_id,pollutant_id,observed_at,raw_value,corrected_value,quality_flag,quality_note,correction_of_id)
        VALUES(?,?,?,?,?,?,?,?) RETURNING *`, [record.station_id, record.pollutant_id, record.observed_at, record.raw_value, correctedValue, flag, note, observationId]);
    });
  }

  markQuality(observationId: number, flag: QualityFlag, note: string) {
    if (!['ok', 'suspect', 'bad', 'missing'].includes(flag)) throw new AppError('VALIDATION_ERROR', 'invalid quality flag');
    const result = this.db.prepare('UPDATE observations SET quality_flag=?, quality_note=? WHERE id=?').run(flag, note, observationId);
    if (result.changes === 0) throw new AppError('NOT_FOUND', 'observation not found', 404);
    return this.db.prepare('SELECT * FROM observations WHERE id=?').get(observationId);
  }

  addManualReview(batchId: number, reviewer: string, decision: 'confirmed'|'dismissed'|'needs_data', note: string) {
    if (!this.db.prepare('SELECT id FROM analysis_batches WHERE id=?').get(batchId)) {
      throw new AppError('NOT_FOUND', 'analysis batch not found', 404);
    }
    return this.db.prepare('INSERT INTO manual_reviews(batch_id,reviewer,decision,note,reviewed_at) VALUES(?,?,?,?,?) RETURNING *')
      .get(batchId, reviewer, decision, note, this.clock().toISOString());
  }

  list<T>(table: string, limit: number, offset: number): { items: T[]; total: number } {
    if (!/^[a-z_]+$/.test(table)) throw new AppError('VALIDATION_ERROR', 'invalid table');
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c);
    const items = this.db.prepare(`SELECT * FROM ${table} ORDER BY id LIMIT ? OFFSET ?`).all(limit, offset) as T[];
    return { items, total };
  }

  private id(value: unknown, field: string): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      throw new AppError('VALIDATION_ERROR', `${field} must be a positive integer id`);
    }
    return value;
  }

  private mapUnique(error: unknown, label: string) {
    if (error instanceof Error && error.message.includes('UNIQUE')) {
      return new AppError('CONFLICT', `${label} already exists`, 409);
    }
    throw error;
  }
}

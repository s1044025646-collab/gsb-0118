import type { DatabaseSync } from 'node:sqlite';
import { AppError } from './errors.js';
import { parseIso, type Clock } from './time.js';
import { withTransaction } from './db.js';

interface SourceRow { id: number; code: string; x_m: number; y_m: number }
interface PollutantRow { id: number; code: string }
interface ObservationRow {
  id: number;
  pollutant_id: number;
  observed_at: string;
  corrected_value: number | null;
  quality_flag: string;
  correction_of_id: number | null;
}

export interface RunOptions {
  stationId: number;
  windowStart: string;
  windowEnd: string;
  fingerprintVersionId: number;
  maxTravelSeconds?: number;
  windToleranceDeg?: number;
}

const MAX_WIND_AGE_SECONDS = 1800;

export function runAnalysis(db: DatabaseSync, options: RunOptions, clock: Clock = () => new Date()) {
  const start = parseIso(options.windowStart);
  const end = parseIso(options.windowEnd);
  if (end <= start) throw new AppError('VALIDATION_ERROR', 'window_end must be later than window_start');

  return withTransaction(db, () => {
    const station = db.prepare('SELECT * FROM stations WHERE id=?').get(options.stationId) as { id: number } | undefined;
    if (!station) throw new AppError('NOT_FOUND', 'station not found', 404);
    const version = db.prepare('SELECT * FROM fingerprint_versions WHERE id=?').get(options.fingerprintVersionId);
    if (!version) throw new AppError('NOT_FOUND', 'fingerprint version not found', 404);

    const sources = db.prepare('SELECT * FROM emission_sources ORDER BY id').all() as unknown as SourceRow[];
    const pollutants = db.prepare('SELECT * FROM pollutants ORDER BY id').all() as unknown as PollutantRow[];
    const observations = db.prepare(`SELECT * FROM observations
      WHERE station_id=? AND observed_at>=? AND observed_at<? AND quality_flag IN ('ok','suspect')
      ORDER BY observed_at, pollutant_id`).all(options.stationId, options.windowStart, options.windowEnd) as unknown as ObservationRow[];

    const candidates = sources.map((source) => assessCandidate(db, options.stationId, source, options.windowStart, options.windowEnd, options.maxTravelSeconds ?? 1200, options.windToleranceDeg ?? 45));
    const accepted = candidates.filter((candidate) => candidate.accepted);
    const grouped = groupObservations(observations, pollutants);

    let reason = 'estimated';
    let coefficients = new Array(accepted.length).fill(0);
    let residuals: Array<{ pollutantId: number; observed: number; predicted: number; residual: number }> = [];

    if (observations.length < pollutants.length * 2 || grouped.length < 2) reason = 'INSUFFICIENT_SAMPLES';
    else if (accepted.length === 0) reason = 'NO_UPWIND_CANDIDATE';
    else {
      const matrix = buildMatrix(db, options.fingerprintVersionId, accepted.map((candidate) => candidate.source), pollutants);
      const y = averagedExcess(db, options.stationId, pollutants, grouped, options.windowEnd);
      if (y.validPollutants < 2) reason = 'INSUFFICIENT_POLLUTANTS';
      else {
        const collinear = isCollinear(matrix);
        coefficients = nonnegativeLeastSquares(matrix, y.values);
        residuals = pollutants.map((pollutant, row) => {
          const predicted = matrix[row]!.reduce((sum, coefficient, column) => sum + coefficient * coefficients[column]!, 0);
          return { pollutantId: pollutant.id, observed: y.values[row]!, predicted, residual: y.values[row]! - predicted };
        });
        const norm = Math.sqrt(y.values.reduce((sum, value) => sum + value * value, 0));
        const errorNorm = Math.sqrt(residuals.reduce((sum, item) => sum + item.residual * item.residual, 0));
        if (collinear && accepted.length > 1) reason = 'COLLINEAR_FINGERPRINTS';
        else if (norm > 0 && errorNorm / norm > 0.35) reason = 'POOR_IDENTIFIABILITY';
      }
    }

    const batch = db.prepare(`INSERT INTO analysis_batches(station_id,window_start,window_end,fingerprint_version_id,status,reason,created_at)
      VALUES(?,?,?,?,?,?,?) RETURNING *`).get(
      options.stationId,
      options.windowStart,
      options.windowEnd,
      options.fingerprintVersionId,
      reason === 'estimated' ? 'estimated' : 'rejected',
      reason,
      clock().toISOString(),
    ) as { id: number };

    const insertCandidate = db.prepare('INSERT INTO batch_candidate_sources(batch_id,source_id,accepted,reason) VALUES(?,?,?,?)');
    for (const candidate of candidates) insertCandidate.run(batch.id, candidate.source.id, candidate.accepted ? 1 : 0, candidate.reason);

    if (reason === 'estimated') {
      accepted.forEach((candidate, index) => {
        const value = coefficients[index]!;
        db.prepare('INSERT INTO source_contributions(batch_id,source_id,contribution,lower_ci,upper_ci) VALUES(?,?,?,?,?)')
          .run(batch.id, candidate.source.id, value, null, null);
      });
      for (const residual of residuals) {
        db.prepare('INSERT INTO batch_residuals(batch_id,pollutant_id,observed,predicted,residual) VALUES(?,?,?,?,?)')
          .run(batch.id, residual.pollutantId, residual.observed, residual.predicted, residual.residual);
      }
    }
    return getBatch(db, batch.id);
  });
}

function assessCandidate(db: DatabaseSync, stationId: number, source: SourceRow, windowStart: string, windowEnd: string, maxTravelSeconds: number, toleranceDeg: number) {
  const station = db.prepare('SELECT * FROM stations WHERE id=?').get(stationId) as { x_m: number; y_m: number };
  const dx = source.x_m - station.x_m;
  const dy = source.y_m - station.y_m;
  const bearingToSource = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
  const distance = Math.hypot(dx, dy);
  const windRows = db.prepare('SELECT * FROM wind_observations WHERE station_id=? AND observed_at>=? AND observed_at<? ORDER BY observed_at').all(
    stationId,
    new Date(parseIso(windowStart).getTime() - MAX_WIND_AGE_SECONDS * 1000).toISOString(),
    windowEnd,
  ) as Array<{ observed_at: string; wind_from_deg: number; speed_m_s: number }>;
  if (windRows.length === 0) return { source, accepted: false, reason: 'NO_WIND_DATA' };

  const active = db.prepare('SELECT COUNT(*) AS c FROM emission_periods WHERE source_id=? AND started_at<? AND (ended_at IS NULL OR ended_at>?)')
    .get(source.id, windowEnd, windowStart) as { c: number };
  if (active.c === 0) return { source, accepted: false, reason: 'NO_ACTIVE_EMISSION_PERIOD' };

  let aligned = 0;
  for (const wind of windRows) {
    let travelSeconds = Number.POSITIVE_INFINITY;
    if (wind.speed_m_s > 0.1) travelSeconds = distance / wind.speed_m_s;
    if (travelSeconds > maxTravelSeconds) continue;
    const arrival = parseIso(wind.observed_at).getTime() + travelSeconds * 1000;
    if (arrival < parseIso(windowStart).getTime() - MAX_WIND_AGE_SECONDS * 1000 || arrival > parseIso(windowEnd).getTime()) continue;
    const delta = Math.abs(angleDelta(wind.wind_from_deg, bearingToSource));
    if (delta <= toleranceDeg) aligned += 1;
  }
  return aligned === 0
    ? { source, accepted: false, reason: 'DOWNWIND_OR_TRAVEL_DELAY_MISMATCH' }
    : { source, accepted: true, reason: `UPWIND_ALIGNED_${aligned}` };
}

function angleDelta(a: number, b: number): number {
  return ((a - b + 540) % 360) - 180;
}

function groupObservations(rows: ObservationRow[], pollutants: PollutantRow[]) {
  const groups = new Map<string, Map<number, number>>();
  const latest = new Map<string, ObservationRow>();
  for (const row of rows) {
    const key = `${row.observed_at}:${row.pollutant_id}`;
    const previous = latest.get(key);
    if (!previous || row.id > previous.id) latest.set(key, row);
  }
  const effectiveRows = [...latest.values()];
  for (const row of effectiveRows) {
    if (row.corrected_value === null) continue;
    const bucket = groups.get(row.observed_at) ?? new Map<number, number>();
    bucket.set(row.pollutant_id, row.corrected_value);
    groups.set(row.observed_at, bucket);
  }
  return [...groups.values()].filter((group) => group.size === pollutants.length);
}

function averagedExcess(db: DatabaseSync, stationId: number, pollutants: PollutantRow[], groups: Map<number, number>[], windowEnd: string) {
  const values = pollutants.map((pollutant, index) => {
    const samples = groups.map((group) => group.get(pollutant.id)).filter((value): value is number => typeof value === 'number');
    const observed = samples.reduce((sum, value) => sum + value, 0) / Math.max(1, samples.length);
    const background = latestBackground(db, stationId, pollutant.id, windowEnd)?.value ?? 0;
    return Math.max(0, observed - background);
  });
  return { values, validPollutants: values.filter((value) => value > 0.5).length };
}

function latestBackground(db: DatabaseSync, stationId: number, pollutantId: number, windowEnd: string) {
  return db.prepare(`SELECT * FROM background_concentrations WHERE station_id=? AND pollutant_id=?
    AND valid_from<=? AND (valid_to IS NULL OR valid_to>?) ORDER BY valid_from DESC LIMIT 1`)
    .get(stationId, pollutantId, windowEnd, windowEnd) as { value: number } | undefined;
}

function buildMatrix(db: DatabaseSync, versionId: number, sources: SourceRow[], pollutants: PollutantRow[]): number[][] {
  return pollutants.map((pollutant) => sources.map((source) => {
    const row = db.prepare('SELECT value FROM fingerprint_values WHERE version_id=? AND source_id=? AND pollutant_id=?')
      .get(versionId, source.id, pollutant.id) as { value: number } | undefined;
    if (!row) throw new AppError('INCOMPLETE_FINGERPRINT', `missing fingerprint for source ${source.code} pollutant ${pollutant.code}`, 422);
    return row.value;
  }));
}

function isCollinear(matrix: number[][]): boolean {
  const columns = matrix[0]?.length ?? 0;
  for (let i = 0; i < columns; i += 1) {
    for (let j = i + 1; j < columns; j += 1) {
      const left = matrix.map((row) => row[i] ?? 0);
      const right = matrix.map((row) => row[j] ?? 0);
      const dot = left.reduce((sum, value, index) => sum + value * right[index]!, 0);
      const leftNorm = Math.sqrt(left.reduce((sum, value) => sum + value * value, 0));
      const rightNorm = Math.sqrt(right.reduce((sum, value) => sum + value * value, 0));
      if (dot / (leftNorm * rightNorm + Number.EPSILON) > 0.985) return true;
    }
  }
  return false;
}

function nonnegativeLeastSquares(matrix: number[][], y: number[]): number[] {
  const columns = matrix[0]?.length ?? 0;
  let active = new Array(columns).fill(true);
  for (let iteration = 0; iteration < 24; iteration += 1) {
    const coefficients = constrainedNormalEquation(matrix, y, active);
    let changed = false;
    coefficients.forEach((value, index) => {
      if (value < 1e-7 && active[index]) {
        active[index] = false;
        changed = true;
      }
    });
    if (!changed) return coefficients;
  }
  return constrainedNormalEquation(matrix, y, active);
}

function constrainedNormalEquation(matrix: number[][], y: number[], active: boolean[]): number[] {
  const columns = active.length;
  const result = new Array(columns).fill(0);
  const indices = active.map((value, index) => value ? index : -1).filter((index) => index >= 0);
  if (indices.length === 1) {
    const index = indices[0]!;
    const column = matrix.map((row) => row[index] ?? 0);
    const denominator = column.reduce((sum, value) => sum + value * value, 0);
    result[index] = Math.max(0, column.reduce((sum, value, row) => sum + value * y[row]!, 0) / (denominator || 1));
    return result;
  }
  const ata = indices.map((i) => indices.map((j) => matrix.reduce((sum, row) => sum + (row[i] ?? 0) * (row[j] ?? 0), 0)));
  const aty = indices.map((i) => matrix.reduce((sum, row, rowIndex) => sum + (row[i] ?? 0) * y[rowIndex]!, 0));
  const solved = solveSymmetric(ata, aty).map((value) => Math.max(0, value));
  indices.forEach((index, position) => { result[index] = solved[position]!; });
  return result;
}

function solveSymmetric(a: number[][], b: number[]): number[] {
  const n = b.length;
  const matrix = a.map((row, i) => [...row, b[i]!]);
  for (let column = 0; column < n; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < n; row += 1) {
      if (Math.abs(matrix[row]![column]!) > Math.abs(matrix[pivot]![column]!)) pivot = row;
    }
    if (Math.abs(matrix[pivot]![column]!) < 1e-8) return new Array(n).fill(0);
    [matrix[column], matrix[pivot]] = [matrix[pivot]!, matrix[column]!];
    for (let row = 0; row < n; row += 1) {
      if (row === column) continue;
      const factor = matrix[row]![column]! / matrix[column]![column]!;
      for (let k = column; k <= n; k += 1) matrix[row]![k] = matrix[row]![k]! - factor * matrix[column]![k]!;
    }
  }
  return matrix.map((row, i) => row[n]! / row[i]!);
}

export function getBatch(db: DatabaseSync, batchId: number): any {
  const batch = db.prepare('SELECT * FROM analysis_batches WHERE id=?').get(batchId);
  if (!batch) throw new AppError('NOT_FOUND', 'analysis batch not found', 404);
  const contributions = db.prepare(`SELECT sc.*, es.code AS source_code, es.name AS source_name
    FROM source_contributions sc JOIN emission_sources es ON es.id=sc.source_id WHERE batch_id=? ORDER BY sc.id`).all(batchId);
  const residuals = db.prepare(`SELECT br.*, p.code AS pollutant_code, p.unit
    FROM batch_residuals br JOIN pollutants p ON p.id=br.pollutant_id WHERE batch_id=? ORDER BY p.code`).all(batchId);
  const candidates = db.prepare(`SELECT bcs.*, es.code AS source_code FROM batch_candidate_sources bcs
    JOIN emission_sources es ON es.id=bcs.source_id WHERE batch_id=? ORDER BY es.code`).all(batchId);
  const reviews = db.prepare('SELECT * FROM manual_reviews WHERE batch_id=? ORDER BY id').all(batchId);
  return { ...batch, candidates, contributions, residuals, reviews };
}

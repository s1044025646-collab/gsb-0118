import type { Clock, EmissionWindow, Fingerprint, Observation, WeatherRecord } from './types.js';
import type { Repository } from './repository.js';
import { ApiError } from './errors.js';

const MAX_WIND_ANGLE = 45;

interface Point {
  x: number;
  y: number;
}

interface Candidate {
  sourceId: string;
  fingerprint: Fingerprint;
  rate: number;
  eligible: boolean;
  detail: string;
  support: boolean[];
  supportedFingerprints: string[];
}

function angleDelta(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180);
}

function bearing(from: Point, to: Point): number {
  return (Math.atan2(to.x - from.x, to.y - from.y) * 180) / Math.PI;
}

function distance(from: Point, to: Point): number {
  return Math.hypot(to.x - from.x, to.y - from.y);
}

function norm(values: number[]): number {
  return Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += (a[i] ?? 0) * (b[i] ?? 0);
  const denominator = norm(a) * norm(b);
  return denominator === 0 ? 0 : dot / denominator;
}

function nonNegativeLeastSquares(matrix: number[][], y: number[]): number[] {
  const columns = matrix[0]?.length ?? 0;
  const rows = y.length;
  const x = new Array(columns).fill(0);
  const stepSizes = Array.from({ length: columns }, (_, column) => {
    const denominator = matrix.reduce((sum, row) => sum + (row[column] ?? 0) ** 2, 0);
    return denominator > 0 ? 1 / (2 * denominator) : 0;
  });

  for (let iteration = 0; iteration < 1000; iteration += 1) {
    let moved = 0;
    for (let column = 0; column < columns; column += 1) {
      let gradient = 0;
      for (let row = 0; row < rows; row += 1) {
        let prediction = 0;
        for (let source = 0; source < columns; source += 1) prediction += matrix[row]![source]! * x[source]!;
        gradient += matrix[row]![column]! * (y[row]! - prediction);
      }
      const next = Math.max(0, x[column]! + gradient * stepSizes[column]!);
      moved = Math.max(moved, Math.abs(next - x[column]!));
      x[column] = next;
    }
    if (moved < 1e-9) break;
  }
  return x;
}

function effectiveObservation(observation: Observation): number | null {
  if (observation.quality === 'missing' || observation.quality === 'excluded') return null;
  if (observation.corrected_value !== null) return observation.corrected_value;
  return observation.quality === 'drift' ? null : observation.original_value;
}

export interface RunAnalysisInput {
  stationId: string;
  windowStart: string;
  windowEnd: string;
  clock?: Clock;
}

export interface RunAnalysisResult {
  id: number;
}

export function runAnalysis(repo: Repository, input: RunAnalysisInput): RunAnalysisResult {
  const windowStart = new Date(input.windowStart).toISOString();
  const windowEnd = new Date(input.windowEnd).toISOString();
  if (windowEnd <= windowStart) throw new ApiError('INVALID_WINDOW', 400, 'windowEnd must be after windowStart');
  const station = repo.getStation(input.stationId);
  const sources = repo.listSources();
  const pollutants = repo.listPollutants().map((item) => item.code);
  const rawObservations = repo.observationsFor(input.stationId, windowStart, windowEnd);
  const weather = repo.weatherFor(input.stationId, windowStart, windowEnd);
  const windows = repo.overlappingWindows(windowStart, windowEnd);
  const expectedSlots = new Set(weather.map((item) => item.observed_at)).size;

  const byTime = new Map<string, Observation[]>();
  for (const observation of rawObservations) {
    const list = byTime.get(observation.observed_at) ?? [];
    list.push(observation);
    byTime.set(observation.observed_at, list);
  }

  const samples: { at: string; y: number[]; weather: WeatherRecord | undefined }[] = [];
  for (const [at, observations] of byTime) {
    const values = pollutants.map((pollutant) => {
      const match = observations.find((item) => item.pollutant === pollutant);
      const effective = match ? effectiveObservation(match) : null;
      if (effective === null) return null;
      return Math.max(0, effective - repo.backgroundAt(input.stationId, pollutant, at));
    });
    if (values.every((value) => value !== null)) samples.push({ at, y: values as number[], weather: weather.find((item) => item.observed_at === at) });
  }

  const candidates: Candidate[] = sources.map((source) => {
    const sourceWindows = windows.filter((item) => item.source_id === source.id);
    const fallbackFingerprint = repo.getFingerprintAt(source.id, windowStart);
    if (!fallbackFingerprint || sourceWindows.length === 0) {
      return { sourceId: source.id, fingerprint: fallbackFingerprint ?? missingFingerprint(source.id), rate: 0, eligible: false, detail: 'no active emission window or fingerprint', support: samples.map(() => false), supportedFingerprints: [] };
    }

    const support = samples.map(() => false);
    let checked = 0;
    let maxRate = 0;
    const supportedFingerprints: string[] = [];
    for (const sample of samples) {
      if (!sample.weather || sample.weather.wind_speed_mps <= 0) continue;
      checked += 1;
      const sourceBearing = bearing(station, source);
      const angularError = angleDelta(sourceBearing, sample.weather.wind_direction_deg);
      const lagSeconds = distance(station, source) / sample.weather.wind_speed_mps;
      const arrival = Date.parse(sample.at);
      const emissionTime = new Date(arrival - lagSeconds * 1000).toISOString();
      const activeWindow = sourceWindows.find((window) => emissionTime >= window.starts_at && emissionTime <= window.ends_at);
      const active = Boolean(activeWindow);
      if (angularError <= MAX_WIND_ANGLE && active) {
        support[samples.indexOf(sample)] = true;
        maxRate = Math.max(maxRate, activeWindow!.relative_rate);
        if (!supportedFingerprints.includes(activeWindow!.fingerprint_id)) supportedFingerprints.push(activeWindow!.fingerprint_id);
      }
    }
    const supported = support.filter(Boolean).length;
    const eligible = checked > 0 && supported / checked >= 0.2;
    const latestFingerprintId = supportedFingerprints.at(-1);
    const fingerprint = latestFingerprintId ? repo.getFingerprint(latestFingerprintId) : fallbackFingerprint;
    return {
      sourceId: source.id,
      fingerprint,
      rate: eligible ? maxRate : 0,
      eligible,
      detail: eligible ? `${supported}/${checked} samples upwind with active lagged emissions; fingerprint ${fingerprint.id}` : `only ${supported}/${checked} samples satisfy bearing, travel lag, and active emission`,
      support,
      supportedFingerprints
    };
  });

  const eligible = candidates.filter((candidate) => candidate.eligible);
  let reason: string | null = null;
  let identifiability: 'identifiable' | 'weak' | 'unidentifiable' = 'identifiable';
  if (samples.length === 0) {
    reason = 'no complete multi-pollutant samples after quality and missing-data screening';
    identifiability = 'unidentifiable';
  } else if (expectedSlots > 0 && samples.length / expectedSlots < 0.9) {
    reason = 'sampling is insufficient because drift, exclusions, or missing data remove a required pollutant at one or more times';
    identifiability = 'unidentifiable';
  } else if (repo.hasBackgroundStepChange(input.stationId, windowStart, windowEnd)) {
    reason = 'background concentration changes within the window, so a single stationary source split is rejected';
    identifiability = 'unidentifiable';
  } else if (norm(samples.flatMap((sample) => sample.y)) / Math.max(1, samples.length * pollutants.length) < 0.05) {
    reason = 'no excess concentration remains after background subtraction';
    identifiability = 'weak';
  } else if (eligible.length === 0) {
    reason = 'no source passes wind direction, travel lag, and active-emission screening';
    identifiability = 'unidentifiable';
  } else if (pollutants.length < eligible.length + 1) {
    reason = 'sampled pollutants are insufficient to separate eligible sources';
    identifiability = 'unidentifiable';
  } else {
    const vectors = eligible.map((candidate) => pollutants.map((pollutant) => candidate.rate * (candidate.fingerprint.profile[pollutant] ?? 0)));
    for (let i = 0; i < vectors.length; i += 1) {
      for (let j = i + 1; j < vectors.length; j += 1) {
        if (cosine(vectors[i]!, vectors[j]!) > 0.975) {
          reason = 'eligible source fingerprints are too collinear to report a precise single-source split';
          identifiability = 'unidentifiable';
        }
      }
    }
  }

  const dataRevision = rawObservations.reduce((sum, item) => sum + item.revision, 0)
    + weather.reduce((sum, item) => sum + item.revision, 0)
    + candidates.reduce((sum, item) => sum + item.fingerprint.version, 0);
  const createdAt = (input.clock?.now() ?? new Date()).toISOString();

  return repo.transaction(() => {
    const runId = repo.insertRun({
      station_id: input.stationId,
      window_start: windowStart,
      window_end: windowEnd,
      status: reason ? 'rejected' : 'estimated',
      reason,
      identifiability,
      algorithm: 'non-negative projected least-squares with meteorological candidate screening',
      created_at: createdAt,
      data_revision: dataRevision
    });

    const yRows = samples.flatMap((sample) => sample.y);
    const designMatrix = samples.flatMap((sample, sampleIndex) => pollutants.map((_, pollutantIndex) => eligible.map((candidate, sourceIndex) => {
      const supported = candidate.support[sampleIndex] === true;
      return supported ? candidate.rate * (candidate.fingerprint.profile[pollutants[pollutantIndex]!] ?? 0) : 0;
    })));
    const estimated = reason || yRows.length === 0 ? new Array(eligible.length).fill(0) : nonNegativeLeastSquares(designMatrix, yRows);
    const totalContribution = estimated.reduce((sum, value) => sum + value, 0);

    for (const candidate of candidates) {
      if (candidate.fingerprint.id.startsWith('missing:')) continue;
      const index = eligible.findIndex((item) => item.sourceId === candidate.sourceId);
      const contribution = index >= 0 ? estimated[index]! : 0;
      repo.insertContribution({
        run_id: runId,
        source_id: candidate.sourceId,
        fingerprint_id: candidate.fingerprint.id,
        contribution,
        share: reason ? null : totalContribution > 0 ? contribution / totalContribution : null,
        eligible: candidate.eligible ? 1 : 0,
        screening_detail: candidate.detail
      });
    }

      for (let column = 0; column < pollutants.length; column += 1) {
      const observed = samples.reduce((sum, sample) => sum + sample.y[column]!, 0) / Math.max(1, samples.length);
      const modeled = reason ? 0 : samples.reduce((sampleSum, sample, sampleIndex) => sampleSum + eligible.reduce((sum, candidate, sourceIndex) => sum + (candidate.support[sampleIndex] ? estimated[sourceIndex]! * candidate.rate * (candidate.fingerprint.profile[pollutants[column]!] ?? 0) : 0), 0), 0) / Math.max(1, samples.length);
      repo.insertResidual({
        run_id: runId,
        pollutant: pollutants[column]!,
        observed,
        modeled,
        residual: observed - modeled
      });
    }
    return { id: runId };
  });
}

function missingFingerprint(sourceId: string): Fingerprint {
  return { id: `missing:${sourceId}`, source_id: sourceId, version: 0, effective_from: '', supersedes: null, profile: {} };
}

export function activeWindowIncludes(window: EmissionWindow, at: string): boolean {
  return at >= window.starts_at && at <= window.ends_at;
}

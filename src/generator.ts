import type { Db } from './db.js';
import { Repository } from './repository.js';
import type { QualityFlag } from './types.js';

export type Scenario = 'double-source' | 'background-jump' | 'wind-reversal' | 'sensor-drift' | 'missing' | 'collinear' | 'false-alarm';

const pollutants = [
  { code: 'PM25', name: 'Fine particles', unit: 'ug/m3' },
  { code: 'SO2', name: 'Sulfur dioxide', unit: 'ug/m3' },
  { code: 'NOX', name: 'Nitrogen oxides', unit: 'ug/m3' },
  { code: 'VOC', name: 'Volatile organic compounds', unit: 'ug/m3' }
];

export interface ScenarioHandle {
  stationId: string;
  windowStart: string;
  windowEnd: string;
  sourceIds: Record<string, string>;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedScenario(db: Db, scenario: Scenario, seed = 42): ScenarioHandle {
  const repo = new Repository(db);
  const random = mulberry32(seed + scenario.length * 101);
  db.exec('DELETE FROM reviews; DELETE FROM run_residuals; DELETE FROM run_sources; DELETE FROM analysis_runs; DELETE FROM emission_windows; DELETE FROM observations; DELETE FROM weather; DELETE FROM background_concentrations; DELETE FROM fingerprints; DELETE FROM emission_sources; DELETE FROM stations; DELETE FROM pollutants;');

  for (const pollutant of pollutants) repo.upsertPollutant(pollutant);
  repo.upsertStation({ id: 'S1', name: 'Fictional Central Monitor', x: 0, y: 0 });
  repo.upsertSource({ id: 'A', name: 'North Boiler Works', x: 0, y: 1000 });
  repo.upsertSource({ id: 'B', name: 'East Refinery', x: 1000, y: 0 });
  repo.upsertSource({ id: 'C', name: 'North Kiln Twin', x: 0, y: 2000 });

  const start = new Date('2026-01-01T00:00:00.000Z');
  const end = new Date('2026-01-01T04:00:00.000Z');
  const times = Array.from({ length: 4 }, (_, index) => new Date(start.getTime() + index * 3600_000).toISOString());
  const profiles = {
    A: { PM25: 1, SO2: 0.8, NOX: 0.2, VOC: 0.1 },
    B: { PM25: 1, SO2: 0.1, NOX: 0.8, VOC: 0.5 },
    C: { PM25: 1, SO2: 0.8, NOX: 0.2, VOC: 0.1 }
  };

  repo.addFingerprint({ id: 'FP-A1', source_id: 'A', version: 1, effective_from: '2025-01-01T00:00:00.000Z', supersedes: null, profile: profiles.A });
  repo.addFingerprint({ id: 'FP-B1', source_id: 'B', version: 1, effective_from: '2025-01-01T00:00:00.000Z', supersedes: null, profile: profiles.B });
  repo.addFingerprint({ id: 'FP-C1', source_id: 'C', version: 1, effective_from: '2025-01-01T00:00:00.000Z', supersedes: null, profile: profiles.C });
  repo.addFingerprint({ id: 'FP-A2', source_id: 'A', version: 2, effective_from: '2026-01-01T02:00:00.000Z', supersedes: 'FP-A1', profile: { PM25: 1, SO2: 0.35, NOX: 0.55, VOC: 0.15 } });

  for (const time of times) {
    const wind = scenario === 'double-source' && time >= times[2]!
      ? 90
      : scenario === 'wind-reversal' && time >= times[2]!
        ? 180
        : scenario === 'false-alarm'
          ? 180
          : 0;
    repo.upsertWeather({ station_id: 'S1', observed_at: time, wind_direction_deg: wind, wind_speed_mps: 10 });
    const base = scenario === 'background-jump' && time >= times[2]!
      ? { PM25: 10, SO2: 8, NOX: 7, VOC: 4 }
      : { PM25: 2, SO2: 1, NOX: 1, VOC: 0.3 };
    for (const pollutant of pollutants) repo.upsertBackground({ station_id: 'S1', pollutant: pollutant.code, starts_at: time, value: base[pollutant.code as keyof typeof base]! });
  }

  const activeA = scenario !== 'false-alarm';
  const activeB = scenario === 'double-source';
  const activeC = scenario === 'collinear';
  if (activeA) repo.addEmissionWindow({ source_id: 'A', starts_at: '2025-12-31T23:30:00.000Z', ends_at: '2026-01-01T04:30:00.000Z', relative_rate: 5, fingerprint_id: 'FP-A1' });
  if (activeB) repo.addEmissionWindow({ source_id: 'B', starts_at: '2025-12-31T23:30:00.000Z', ends_at: '2026-01-01T04:30:00.000Z', relative_rate: 4, fingerprint_id: 'FP-B1' });
  if (activeC) repo.addEmissionWindow({ source_id: 'C', starts_at: '2025-12-31T23:30:00.000Z', ends_at: '2026-01-01T04:30:00.000Z', relative_rate: 3, fingerprint_id: 'FP-C1' });

  for (const time of times) {
    const backgroundJump = scenario === 'background-jump' && time >= times[2]!;
      const factor = scenario === 'wind-reversal' && time >= times[2]! ? 0 : scenario === 'false-alarm' ? 0 : 1;
    const sourceMix = scenario === 'double-source' && time >= times[2]!
      ? { PM25: 4, SO2: 0.4, NOX: 3.2, VOC: 2 }
      : activeA && activeB ? { PM25: 5, SO2: 4, NOX: 1, VOC: 0.5 }
      : activeA && activeC ? { PM25: 8, SO2: 6.4, NOX: 1.6, VOC: 0.8 }
      : activeA ? profiles.A
      : { PM25: 0, SO2: 0, NOX: 0, VOC: 0 };
    const scale = 1;

    for (const pollutant of pollutants) {
      const code = pollutant.code as keyof typeof sourceMix;
      const background = repo.backgroundAt('S1', pollutant.code, time);
      const noise = (random() - 0.5) * 0.04;
      const value = Math.max(0, background + factor * scale * sourceMix[code]! + noise);
      let quality: QualityFlag = 'ok';
      let note = '';
      let corrected: number | null = value;
      if (scenario === 'sensor-drift' && pollutant.code === 'SO2' && time >= times[1]!) {
        quality = 'drift';
        note = 'implausible calibration ramp';
        corrected = null;
      }
      if (scenario === 'missing' && pollutant.code === 'NOX' && time === times[2]!) {
        quality = 'missing';
        note = 'scheduled sampler gap';
        corrected = null;
      }
      if (scenario === 'background-jump' && backgroundJump) corrected = background;
      const id = repo.insertObservation({ station_id: 'S1', pollutant: pollutant.code, observed_at: time, value: quality === 'missing' ? 0 : value });
      if (quality !== 'ok') repo.markObservation(id, quality, note, corrected);
    }
  }

  return { stationId: 'S1', windowStart: start.toISOString(), windowEnd: end.toISOString(), sourceIds: { A: 'A', B: 'B', C: 'C' } };
}

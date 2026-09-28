import type { DatabaseSync } from 'node:sqlite';
import { Repository } from './repository.js';
import { seededRandom, type RandomSource } from './random.js';

export interface GeneratedScenario {
  stationId: number;
  pollutantIds: Record<string, number>;
  sourceIds: Record<string, number>;
  versionId: number;
  windowStart: string;
  windowEnd: string;
  truth: Array<{ sourceCode: string; contribution: Record<string, number> }>;
}

export function generateScenario(db: DatabaseSync, seed = 20260118, start = '2026-01-18T00:00:00.000Z'): GeneratedScenario {
  const repo = new Repository(db);
  const random = seededRandom(seed);
  const pollutants = ['PM25', 'SO2', 'NOx'].map((code) => repo.addPollutant({ code, name: code, unit: 'ugm3' }) as { id: number; code: string });
  const station = repo.addStation({ code: 'S01', name: '虚构中央站', x_m: 0, y_m: 0 }) as { id: number };
  const sourceA = repo.addSource({ code: 'A_FURNACE', name: '虚构熔炉', x_m: -1000, y_m: -1000 }) as { id: number };
  const sourceB = repo.addSource({ code: 'B_BOILER', name: '虚构锅炉', x_m: -1000, y_m: 1000 }) as { id: number };
  const version = repo.addFingerprintVersion({ version: 'FP-2026-01', effective_start: start, note: '虚构基线指纹' }) as { id: number };

  const profiles = [
    { source: sourceA.id, values: [1.0, 0.2, 0.35] },
    { source: sourceB.id, values: [0.65, 0.9, 0.25] },
  ];
  for (const profile of profiles) {
    pollutants.forEach((pollutant, index) => {
      const profileValue = profile.values[index];
      if (profileValue !== undefined) repo.setFingerprintValue(version.id, profile.source, pollutant.id, profileValue, 0.03);
    });
  }

  repo.addEmissionPeriod({ source_id: sourceA.id, started_at: start, ended_at: null, relative_rate: 1, note: '稳定生产' });
  repo.addEmissionPeriod({ source_id: sourceB.id, started_at: start, ended_at: null, relative_rate: 1, note: '稳定生产' });

  for (let minute = 0; minute < 180; minute += 10) {
    const at = new Date(new Date(start).getTime() + minute * 60_000).toISOString();
    const reversal = minute >= 90;
    const windFrom = reversal ? 90 + random.gaussian() * 4 : (minute % 20 === 0 ? 225 : 315) + random.gaussian() * 3;
    repo.addWind({
      station_id: station.id,
      observed_at: at,
      wind_from_deg: (windFrom + 360) % 360,
      speed_m_s: 4 + random.gaussian() * 0.4,
    });
  }

  const backgroundChange = '2026-01-18T01:30:00.000Z';
  pollutants.forEach((pollutant, pIndex) => {
    repo.setBackground({ station_id: station.id, pollutant_id: pollutant.id, valid_from: start, valid_to: backgroundChange, value: 8 + pIndex * 1.5 });
    repo.setBackground({ station_id: station.id, pollutant_id: pollutant.id, valid_from: backgroundChange, valid_to: null, value: 18 + pIndex * 2 });
  });

  const ids = Object.fromEntries(pollutants.map((p) => [p.code, p.id]));
  for (let minute = 0; minute < 120; minute += 10) {
    const at = new Date(new Date(start).getTime() + minute * 60_000).toISOString();
    const a = minute < 60 ? 18 : 11;
    const b = minute < 60 ? 9 : 16;
    pollutants.forEach((pollutant, index) => {
      const profile = [(profiles[0]?.values[index] ?? 0) * a, (profiles[1]?.values[index] ?? 0) * b];
      const background = minute < 90 ? 8 + index * 1.5 : 18 + index * 2;
      let value: number | null = background + profile[0]! + profile[1]! + random.gaussian() * 0.35;
      let flag: 'ok' | 'suspect' | 'bad' | 'missing' = 'ok';
      let note = '';
      if (minute === 50 && pollutant.code === 'SO2') value = null;
      if (minute === 50 && pollutant.code === 'NOx' && value !== null) {
        value += 7;
        flag = 'suspect';
        note = '虚构传感器阶跃漂移';
      }
      const rawValue: number | null = value === null ? null : Math.max(0, value);
      repo.addObservation({ station_id: station.id, pollutant_id: pollutant.id, observed_at: at, raw_value: rawValue, quality_flag: rawValue === null ? 'missing' : flag, quality_note: note });
    });
  }

  return {
    stationId: station.id,
    pollutantIds: ids,
    sourceIds: { A_FURNACE: sourceA.id, B_BOILER: sourceB.id },
    versionId: version.id,
    windowStart: start,
    windowEnd: '2026-01-18T01:00:00.000Z',
    truth: [
      { sourceCode: 'A_FURNACE', contribution: { PM25: 18, SO2: 3.6, NOx: 6.3 } },
      { sourceCode: 'B_BOILER', contribution: { PM25: 5.85, SO2: 8.1, NOx: 2.25 } },
    ],
  };
}

export function jitter(random: RandomSource, amount: number): number {
  return random.gaussian() * amount;
}

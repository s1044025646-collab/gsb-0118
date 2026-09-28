export type IsoDateTime = string;

export type QualityFlag = 'ok' | 'suspect' | 'missing' | 'drift' | 'excluded';

export interface Pollutant {
  code: string;
  name: string;
  unit: string;
}

export interface Station {
  id: string;
  name: string;
  x: number;
  y: number;
}

export interface EmissionSource {
  id: string;
  name: string;
  x: number;
  y: number;
}

export interface Fingerprint {
  id: string;
  source_id: string;
  version: number;
  effective_from: IsoDateTime;
  supersedes: string | null;
  profile: Record<string, number>;
}

export interface ObservationInput {
  station_id: string;
  pollutant: string;
  observed_at: IsoDateTime;
  value: number;
}

export interface Observation extends ObservationInput {
  id: number;
  original_value: number;
  quality: QualityFlag;
  quality_note: string;
  corrected_value: number | null;
  revision: number;
}

export interface WeatherRecord {
  id: number;
  station_id: string;
  observed_at: IsoDateTime;
  wind_direction_deg: number;
  wind_speed_mps: number;
  revision: number;
}

export interface BackgroundRecord {
  id: number;
  station_id: string;
  pollutant: string;
  starts_at: IsoDateTime;
  value: number;
  revision: number;
}

export interface EmissionWindow {
  id: number;
  source_id: string;
  starts_at: IsoDateTime;
  ends_at: IsoDateTime;
  relative_rate: number;
  fingerprint_id: string;
}

export interface AnalysisRun {
  id: number;
  station_id: string;
  window_start: IsoDateTime;
  window_end: IsoDateTime;
  status: 'estimated' | 'rejected' | 'reviewed';
  reason: string | null;
  identifiability: 'identifiable' | 'weak' | 'unidentifiable';
  algorithm: string;
  created_at: IsoDateTime;
  data_revision: number;
}

export interface RunContribution {
  run_id: number;
  source_id: string;
  fingerprint_id: string;
  contribution: number;
  share: number | null;
  eligible: 0 | 1;
  screening_detail: string;
}

export interface RunResidual {
  run_id: number;
  pollutant: string;
  observed: number;
  modeled: number;
  residual: number;
}

export interface Paginated<T> {
  items: T[];
  limit: number;
  offset: number;
  total: number;
}

export interface Clock {
  now(): Date;
  random(): number;
}

export const systemClock: Clock = {
  now: () => new Date(),
  random: Math.random
};

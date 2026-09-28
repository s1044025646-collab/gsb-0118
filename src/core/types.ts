export type ISODateTime = string;

export interface PageQuery {
  limit: number;
  offset: number;
}

export interface PageResult<T> {
  items: T[];
  limit: number;
  offset: number;
  total: number;
}

export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export type QualityFlag = 'ok' | 'suspect' | 'bad' | 'missing';

export interface Pollutant {
  id: number;
  code: string;
  name: string;
  unit: string;
}

export interface Station {
  id: number;
  code: string;
  name: string;
  x_m: number;
  y_m: number;
}

export interface EmissionSource {
  id: number;
  code: string;
  name: string;
  x_m: number;
  y_m: number;
}

export interface FingerprintVersion {
  id: number;
  version: string;
  effective_start: ISODateTime;
  effective_end: ISODateTime | null;
  note: string;
}

export interface FingerprintValue {
  source_id: number;
  pollutant_id: number;
  value: number;
  uncertainty: number;
}

export interface WindObservation {
  id: number;
  station_id: number;
  observed_at: ISODateTime;
  wind_from_deg: number;
  speed_m_s: number;
  supersedes_id: number | null;
}

export interface Observation {
  id: number;
  station_id: number;
  pollutant_id: number;
  observed_at: ISODateTime;
  raw_value: number | null;
  corrected_value: number | null;
  quality_flag: QualityFlag;
  quality_note: string;
  correction_of_id: number | null;
}

export interface BackgroundConcentration {
  id: number;
  station_id: number;
  pollutant_id: number;
  valid_from: ISODateTime;
  valid_to: ISODateTime | null;
  value: number;
}

export interface EmissionPeriod {
  id: number;
  source_id: number;
  started_at: ISODateTime;
  ended_at: ISODateTime | null;
  relative_rate: number;
  note: string;
}

export interface AnalysisBatch {
  id: number;
  station_id: number;
  window_start: ISODateTime;
  window_end: ISODateTime;
  fingerprint_version_id: number;
  status: 'rejected' | 'estimated';
  reason: string;
  created_at: ISODateTime;
}

export interface SourceContribution {
  id: number;
  batch_id: number;
  source_id: number;
  contribution: number;
  lower_ci: number | null;
  upper_ci: number | null;
}

export interface ResidualItem {
  pollutant_code: string;
  observed: number;
  predicted: number;
  residual: number;
}

export interface ManualReview {
  id: number;
  batch_id: number;
  reviewer: string;
  decision: 'confirmed' | 'dismissed' | 'needs_data';
  note: string;
  reviewed_at: ISODateTime;
}

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { URL } from 'node:url';
import { Repository } from '../core/repository.js';
import { AppError } from '../core/errors.js';
import { runAnalysis, getBatch } from '../core/solver.js';
import { generateScenario } from '../core/generator.js';

export function createApiServer(db: DatabaseSync): Server {
  const repo = new Repository(db);
  return createServer(async (request, response) => {
    try {
      await route(db, repo, request, response);
    } catch (error) {
      sendError(response, error);
    }
  });
}

export async function startApiServer(db: DatabaseSync, port = 0, host = '127.0.0.1'): Promise<{ server: Server; port: number; close: () => Promise<void> }> {
  const server = createApiServer(db);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new AppError('SERVER_ERROR', 'failed to bind API port', 500);
  return {
    server,
    port: address.port,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function route(db: DatabaseSync, repo: Repository, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const method = request.method ?? 'GET';
  const path = url.pathname.replace(/\/+$/, '') || '/health';

  if (method === 'GET' && path === '/health') return sendJson(response, { ok: true });

  if (method === 'POST' && path === '/v1/generate-fixture') {
    const body = await readJson(request);
    const payload = asObject(body);
    return sendJson(response, generateScenario(db, Number(payload.seed ?? 20260118), typeof payload.start === 'string' ? payload.start : undefined), 201);
  }

  const postCollections: Record<string, (body: unknown) => unknown> = {
    '/v1/pollutants': (body) => repo.addPollutant(asObject(body) as any),
    '/v1/stations': (body) => repo.addStation(asObject(body) as any),
    '/v1/sources': (body) => repo.addSource(asObject(body) as any),
    '/v1/fingerprint-versions': (body) => repo.addFingerprintVersion(asObject(body) as any),
    '/v1/fingerprint-values': (body) => {
      const value = asObject(body);
      return repo.setFingerprintValue(positive(value.version_id, 'version_id'), positive(value.source_id, 'source_id'), positive(value.pollutant_id, 'pollutant_id'), finite(value.value, 'value', 0), finite(value.uncertainty ?? 0, 'uncertainty', 0));
    },
    '/v1/wind': (body) => repo.addWind(asObject(body) as any),
    '/v1/backgrounds': (body) => repo.setBackground(asObject(body) as any),
    '/v1/emission-periods': (body) => repo.addEmissionPeriod(asObject(body) as any),
    '/v1/observations': (body) => repo.addObservation(asObject(body) as any),
  };
  if (method === 'POST' && postCollections[path]) return sendJson(response, postCollections[path]!(await readJson(request)), 201);

  if (method === 'POST' && path === '/v1/analyses') {
    const body = asObject(await readJson(request));
    const batch = runAnalysis(db, {
      stationId: positive(body.station_id, 'station_id'),
      windowStart: isoString(body.window_start, 'window_start'),
      windowEnd: isoString(body.window_end, 'window_end'),
      fingerprintVersionId: positive(body.fingerprint_version_id, 'fingerprint_version_id'),
      maxTravelSeconds: body.max_travel_seconds === undefined ? undefined : positive(body.max_travel_seconds, 'max_travel_seconds'),
      windToleranceDeg: body.wind_tolerance_deg === undefined ? undefined : finite(body.wind_tolerance_deg, 'wind_tolerance_deg', 0, 180),
    });
    return sendJson(response, batch, batch.status === 'estimated' ? 201 : 200);
  }

  let match = path.match(/^\/v1\/observations\/(\d+)\/quality$/);
  if (method === 'POST' && match) {
    const body = asObject(await readJson(request));
    const flag = body.quality_flag;
    if (flag !== 'ok' && flag !== 'suspect' && flag !== 'bad' && flag !== 'missing') throw new AppError('VALIDATION_ERROR', 'invalid quality_flag');
    return sendJson(response, repo.markQuality(Number(match[1]), flag, typeof body.note === 'string' ? body.note : ''));
  }

  match = path.match(/^\/v1\/observations\/(\d+)\/correction$/);
  if (method === 'POST' && match) {
    const body = asObject(await readJson(request));
    const flag = body.quality_flag ?? 'suspect';
    if (flag !== 'ok' && flag !== 'suspect' && flag !== 'bad' && flag !== 'missing') throw new AppError('VALIDATION_ERROR', 'invalid quality_flag');
    return sendJson(response, repo.correctObservation(Number(match[1]), body.corrected_value === null ? null : finite(body.corrected_value, 'corrected_value', 0), flag, typeof body.note === 'string' ? body.note : ''), 201);
  }

  match = path.match(/^\/v1\/analyses\/(\d+)\/reviews$/);
  if (method === 'POST' && match) {
    const body = asObject(await readJson(request));
    if (body.decision !== 'confirmed' && body.decision !== 'dismissed' && body.decision !== 'needs_data') throw new AppError('VALIDATION_ERROR', 'invalid decision');
    return sendJson(response, repo.addManualReview(Number(match[1]), String(body.reviewer ?? 'operator'), body.decision, String(body.note ?? '')), 201);
  }

  const getCollections: Record<string, string> = {
    '/v1/pollutants': 'pollutants',
    '/v1/stations': 'stations',
    '/v1/sources': 'emission_sources',
    '/v1/fingerprint-versions': 'fingerprint_versions',
    '/v1/fingerprint-values': 'fingerprint_values',
    '/v1/wind': 'wind_observations',
    '/v1/backgrounds': 'background_concentrations',
    '/v1/emission-periods': 'emission_periods',
    '/v1/observations': 'observations',
    '/v1/reviews': 'manual_reviews',
  };
  if (method === 'GET' && getCollections[path]) {
    const limit = pagination(url.searchParams.get('limit') ?? '50', 'limit', 1, 200, 50);
    const page = pagination(url.searchParams.get('page') ?? '1', 'page', 1, 1_000_000, 1);
    const result = repo.list(getCollections[path]!, limit, (page - 1) * limit);
    return sendJson(response, { ...result, limit, offset: (page - 1) * limit, page });
  }

  match = path.match(/^\/v1\/analyses\/(\d+)$/);
  if (method === 'GET' && match) return sendJson(response, getBatch(db, Number(match[1])));

  throw new AppError('NOT_FOUND', 'route not found', 404);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_048_576) throw new AppError('PAYLOAD_TOO_LARGE', 'request body exceeds 1 MiB', 413);
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AppError('INVALID_JSON', 'request body must be valid JSON');
  }
}

function asObject(value: unknown): any {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('VALIDATION_ERROR', 'request body must be a JSON object');
  return value;
}

function positive(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) throw new AppError('VALIDATION_ERROR', `${field} must be positive integer`);
  return value;
}

function finite(value: unknown, field: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new AppError('VALIDATION_ERROR', `${field} is out of range`);
  return value;
}

function isoString(value: unknown, field: string): string {
  if (typeof value !== 'string' || Number.isNaN(new Date(value).getTime())) throw new AppError('VALIDATION_ERROR', `${field} must be ISO timestamp`);
  return value;
}

function pagination(value: string, field: string, min: number, max: number, fallback: number): number {
  if (value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new AppError('VALIDATION_ERROR', `${field} is invalid`);
  return number;
}

function sendJson(response: ServerResponse, value: unknown, status = 200): void {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(body);
}

function sendError(response: ServerResponse, error: unknown): void {
  const appError = error instanceof AppError ? error : new AppError('INTERNAL_ERROR', 'internal server error', 500);
  if (!(error instanceof AppError)) console.error(error);
  sendJson(response, { error: { code: appError.code, message: appError.message, details: appError.details } }, appError.status);
}

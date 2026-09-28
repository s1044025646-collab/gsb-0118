import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Db } from './db.js';
import { Repository } from './repository.js';
import { ApiError, parsePagination, requireIsoDateTime, requireNumber, requireString } from './errors.js';
import { runAnalysis } from './analysis.js';
import { seedScenario, type Scenario } from './generator.js';

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const body = Buffer.concat(chunks).toString('utf8');
  if (!body) return {};
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new ApiError('INVALID_JSON', 400, 'request body must be a JSON object');
  }
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

export function createApiServer(db: Db): Server {
  const repo = new Repository(db);

  return createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const method = req.method ?? 'GET';
        const parts = url.pathname.split('/').filter(Boolean);
        const body = method === 'POST' || method === 'PUT' ? await readJson(req) : {};

        if (method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });

        if (method === 'GET' && url.pathname === '/pollutants') return send(res, 200, { items: repo.listPollutants() });
        if (method === 'GET' && url.pathname === '/stations') return send(res, 200, { items: repo.listStations() });
        if (method === 'GET' && url.pathname === '/sources') return send(res, 200, { items: repo.listSources() });

        if (method === 'POST' && url.pathname === '/observations') {
          const stationId = requireString(body.station_id, 'station_id');
          const pollutant = requireString(body.pollutant, 'pollutant');
          const observedAt = requireIsoDateTime(body.observed_at, 'observed_at');
          const value = requireNumber(body.value, 'value', { min: 0 });
          repo.getStation(stationId);
          const id = repo.transaction(() => repo.insertObservation({ station_id: stationId, pollutant, observed_at: observedAt, value }));
          return send(res, 201, repo.getObservation(id));
        }

        if (method === 'POST' && parts[0] === 'observations' && parts[2] === 'quality') {
          const id = requireNumber(parts[1], 'id', { min: 1 });
          const quality = requireString(body.quality, 'quality');
          if (!['ok', 'suspect', 'missing', 'drift', 'excluded'].includes(quality)) throw new ApiError('INVALID_QUALITY', 400, 'unsupported quality flag');
          const note = typeof body.note === 'string' ? body.note : '';
          const corrected = body.corrected_value === null || body.corrected_value === undefined ? null : requireNumber(body.corrected_value, 'corrected_value', { min: 0 });
          return send(res, 200, repo.markObservation(id, quality as never, note, corrected));
        }

        if (method === 'GET' && parts[0] === 'stations' && parts[2] === 'observations') {
          const { limit, offset } = parsePagination(url.searchParams);
          const start = requireIsoDateTime(url.searchParams.get('start'), 'start');
          const end = requireIsoDateTime(url.searchParams.get('end'), 'end');
          return send(res, 200, repo.listObservations(parts[1]!, start, end, limit, offset));
        }

        if (method === 'POST' && url.pathname === '/weather') {
          const stationId = requireString(body.station_id, 'station_id');
          const observedAt = requireIsoDateTime(body.observed_at, 'observed_at');
          const direction = requireNumber(body.wind_direction_deg, 'wind_direction_deg', { min: 0, max: 359.999999 });
          const speed = requireNumber(body.wind_speed_mps, 'wind_speed_mps', { min: 0 });
          repo.getStation(stationId);
          repo.transaction(() => repo.upsertWeather({ station_id: stationId, observed_at: observedAt, wind_direction_deg: direction, wind_speed_mps: speed }));
          return send(res, 204, {});
        }

        if (method === 'POST' && url.pathname === '/backgrounds') {
          const stationId = requireString(body.station_id, 'station_id');
          const pollutant = requireString(body.pollutant, 'pollutant');
          const startsAt = requireIsoDateTime(body.starts_at, 'starts_at');
          const value = requireNumber(body.value, 'value', { min: 0 });
          repo.getStation(stationId);
          repo.transaction(() => repo.upsertBackground({ station_id: stationId, pollutant, starts_at: startsAt, value }));
          return send(res, 204, {});
        }

        if (method === 'POST' && url.pathname === '/emission-windows') {
          const sourceId = requireString(body.source_id, 'source_id');
          const startsAt = requireIsoDateTime(body.starts_at, 'starts_at');
          const endsAt = requireIsoDateTime(body.ends_at, 'ends_at');
          if (endsAt <= startsAt) throw new ApiError('INVALID_WINDOW', 400, 'ends_at must be after starts_at');
          const rate = requireNumber(body.relative_rate, 'relative_rate', { min: 0 });
          const fingerprintId = requireString(body.fingerprint_id, 'fingerprint_id');
          repo.transaction(() => repo.addEmissionWindow({ source_id: sourceId, starts_at: startsAt, ends_at: endsAt, relative_rate: rate, fingerprint_id: fingerprintId }));
          return send(res, 204, {});
        }

        if (method === 'POST' && url.pathname === '/fingerprints') {
          const id = requireString(body.id, 'id');
          const sourceId = requireString(body.source_id, 'source_id');
          const version = requireNumber(body.version, 'version', { min: 1 });
          const effectiveFrom = requireIsoDateTime(body.effective_from, 'effective_from');
          const profile = body.profile;
          if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new ApiError('INVALID_FINGERPRINT', 400, 'profile must be an object');
          const values = Object.values(profile as Record<string, unknown>);
          if (!values.some((value) => typeof value === 'number' && value > 0)) throw new ApiError('INVALID_FINGERPRINT', 400, 'profile needs a positive value');
          repo.transaction(() => repo.addFingerprint({
            id,
            source_id: sourceId,
            version,
            effective_from: effectiveFrom,
            supersedes: typeof body.supersedes === 'string' ? body.supersedes : null,
            profile: profile as Record<string, number>
          }));
          return send(res, 201, { id });
        }

        if (method === 'POST' && url.pathname === '/analysis/runs') {
          const stationId = requireString(body.station_id, 'station_id');
          const start = requireIsoDateTime(body.window_start, 'window_start');
          const end = requireIsoDateTime(body.window_end, 'window_end');
          return send(res, 201, runAnalysis(repo, { stationId, windowStart: start, windowEnd: end }));
        }

        if (method === 'GET' && parts[0] === 'analysis' && parts[1] === 'runs' && parts[2]) {
          const id = requireNumber(parts[2], 'id', { min: 1 });
          const run = repo.getRun(id);
          if (parts[3] === 'contributions') return send(res, 200, { items: repo.runContributions(id) });
          if (parts[3] === 'residuals') return send(res, 200, { items: repo.runResiduals(id) });
          if (!parts[3]) return send(res, 200, { run, contributions: repo.runContributions(id), residuals: repo.runResiduals(id) });
        }

        if (method === 'GET' && parts[0] === 'analysis' && parts[1] === 'runs') {
          const { limit, offset } = parsePagination(url.searchParams);
          return send(res, 200, repo.listRuns(url.searchParams.get('station_id') ?? undefined, limit, offset));
        }

        if (method === 'POST' && parts[0] === 'analysis' && parts[1] === 'runs' && parts[3] === 'review') {
          const id = requireNumber(parts[2], 'id', { min: 1 });
          const reviewer = requireString(body.reviewer, 'reviewer');
          const decision = requireString(body.decision, 'decision');
          if (!['confirmed', 'rejected', 'needs_data'].includes(decision)) throw new ApiError('INVALID_REVIEW', 400, 'unsupported review decision');
          const note = typeof body.note === 'string' ? body.note : '';
          repo.getRun(id);
          repo.transaction(() => repo.reviewRun(id, reviewer, decision as never, note, new Date().toISOString()));
          return send(res, 200, repo.getRun(id));
        }

        if (method === 'GET' && parts[0] === 'analysis' && parts[1] === 'compare' && parts[2] && parts[3]) {
          const leftId = requireNumber(parts[2], 'left', { min: 1 });
          const rightId = requireNumber(parts[3], 'right', { min: 1 });
          return send(res, 200, {
            left: { run: repo.getRun(leftId), contributions: repo.runContributions(leftId), residuals: repo.runResiduals(leftId) },
            right: { run: repo.getRun(rightId), contributions: repo.runContributions(rightId), residuals: repo.runResiduals(rightId) }
          });
        }

        if (method === 'POST' && url.pathname === '/demo/seed') {
          const scenario = (body.scenario ?? 'double-source') as Scenario;
          if (!['double-source', 'background-jump', 'wind-reversal', 'sensor-drift', 'missing', 'collinear', 'false-alarm'].includes(scenario)) {
            throw new ApiError('INVALID_SCENARIO', 400, 'unsupported fictional scenario');
          }
          return send(res, 201, seedScenario(db, scenario));
        }

        throw new ApiError('ROUTE_NOT_FOUND', 404, 'route not found');
      } catch (error) {
        if (error instanceof ApiError) return send(res, error.status, { error: { code: error.code, message: error.message } });
        const message = error instanceof Error ? error.message : 'unknown error';
        return send(res, 500, { error: { code: 'INTERNAL_ERROR', message } });
      }
    })();
  });
}

export function listen(server: Server, port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

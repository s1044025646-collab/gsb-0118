import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { openDatabase } from '../src/db.js';
import { createApiServer, listen } from '../src/api.js';

describe('HTTP API', () => {
  let server: Server | null = null;
  let port = 0;
  let db: import('../src/db.js').Db | null = null;
  let databasePath = '';

  afterEach(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    db?.close();
    server = null;
    db = null;
    await rm(databasePath ? join(databasePath, '..') : tmpdir(), { recursive: true, force: true });
  });

  async function request(path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
      body: init.body ? init.body : undefined
    });
    return { status: response.status, body: await response.json() };
  }

  it('validates parameters, paginates runs, and reports explicit errors', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'air-api-'));
    databasePath = join(directory, 'api.sqlite');
    db = openDatabase(databasePath);
    server = createApiServer(db);
    port = await listen(server, 0);

    const bad = await request('/observations', { method: 'POST', body: JSON.stringify({ station_id: '', pollutant: 'X', observed_at: 'bad', value: -1 }) });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_PARAMETER');

    const seeded = await request('/demo/seed', { method: 'POST', body: JSON.stringify({ scenario: 'double-source' }) });
    expect(seeded.status).toBe(201);
    const run = await request('/analysis/runs', {
      method: 'POST',
      body: JSON.stringify({ station_id: 'S1', window_start: '2026-01-01T00:00:00.000Z', window_end: '2026-01-01T04:00:00.000Z' })
    });
    expect(run.status).toBe(201);
    const paged = await request('/analysis/runs?limit=1&page=1');
    expect(paged.status).toBe(200);
    expect(paged.body.limit).toBe(1);
    expect(paged.body.total).toBe(1);
  });
});

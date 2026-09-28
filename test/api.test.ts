import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { openDatabase } from '../src/core/db.ts';
import { startApiServer } from '../src/api/server.ts';

test('API validates input, returns error code, and paginates', async () => {
  const db = openDatabase(':memory:');
  const runtime = await startApiServer(db, 0);
  after(async () => runtime.close());

  const bad = await fetch(`http://127.0.0.1:${runtime.port}/v1/pollutants`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: '', name: '', unit: '' }),
  });
  assert.equal(bad.status, 400);
  const badBody = await bad.json() as { error: { code: string } };
  assert.equal(badBody.error.code, 'VALIDATION_ERROR');

  for (let index = 0; index < 3; index += 1) {
    const response = await fetch(`http://127.0.0.1:${runtime.port}/v1/pollutants`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: `P${index}`, name: `P${index}`, unit: 'ugm3' }),
    });
    assert.equal(response.status, 201);
  }
  const page = await (await fetch(`http://127.0.0.1:${runtime.port}/v1/pollutants?page=2&limit=2`)).json() as { items: unknown[]; total: number; page: number; offset: number };
  assert.equal(page.items.length, 1);
  assert.equal(page.total, 3);
  assert.equal(page.page, 2);
  assert.equal(page.offset, 2);
});

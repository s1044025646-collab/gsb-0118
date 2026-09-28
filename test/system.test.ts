import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { openDatabase } from '../src/core/db.ts';
import { generateScenario } from '../src/core/generator.ts';
import { Repository } from '../src/core/repository.ts';
import { getBatch, runAnalysis } from '../src/core/solver.ts';

test('dual-source overlay gives non-negative contributions and small residuals', () => {
  const db = openDatabase(':memory:');
  const scenario = generateScenario(db);
  const batch = runAnalysis(db, {
    stationId: scenario.stationId,
    windowStart: scenario.windowStart,
    windowEnd: scenario.windowEnd,
    fingerprintVersionId: scenario.versionId,
  });
  assert.equal(batch.status, 'estimated', batch.reason);
  for (const contribution of batch.contributions as Array<{ contribution: number }>) {
    assert.ok(contribution.contribution >= 0);
  }
  const bySource = Object.fromEntries((batch.contributions as Array<{ source_code: string; contribution: number }>).map((row) => [row.source_code, row.contribution]));
  assert.ok(Math.abs(bySource.A_FURNACE - 18) < 2.5, bySource.A_FURNACE);
  assert.ok(Math.abs(bySource.B_BOILER - 9) < 2.5, bySource.B_BOILER);
  for (const residual of batch.residuals as Array<{ residual: number }>) assert.ok(Math.abs(residual.residual) < 2.5);
});

test('wind reversal and travel delay reject a source that is downwind in the window', () => {
  const db = openDatabase(':memory:');
  const scenario = generateScenario(db);
  const batch = runAnalysis(db, {
    stationId: scenario.stationId,
    windowStart: '2026-01-18T01:30:00.000Z',
    windowEnd: '2026-01-18T02:30:00.000Z',
    fingerprintVersionId: scenario.versionId,
    maxTravelSeconds: 300,
  });
  for (const candidate of batch.candidates as Array<{ source_code: string; accepted: number; reason: string }>) {
    assert.equal(candidate.accepted, 0, candidate.source_code);
  }
  assert.equal(batch.status, 'rejected');
  assert.equal(batch.reason, 'NO_UPWIND_CANDIDATE');
});

test('collinear fingerprints do not produce precise single-source shares', () => {
  const db = openDatabase(':memory:');
  const scenario = generateScenario(db);
  const sourceC = new Repository(db).addSource({ code: 'C_DUP', name: '虚构共线源', x_m: -700, y_m: -700 }) as { id: number };
  new Repository(db).addEmissionPeriod({ source_id: sourceC.id, started_at: scenario.windowStart, ended_at: null, relative_rate: 1, note: '共线' });
  for (const pollutant of Object.values(scenario.pollutantIds)) {
    const existing = db.prepare('SELECT value FROM fingerprint_values WHERE version_id=? AND source_id=? AND pollutant_id=?').get(scenario.versionId, scenario.sourceIds.A_FURNACE, pollutant) as { value: number };
    new Repository(db).setFingerprintValue(scenario.versionId, sourceC.id, pollutant, existing.value * 1.01, 0.03);
  }
  const batch = runAnalysis(db, {
    stationId: scenario.stationId,
    windowStart: scenario.windowStart,
    windowEnd: scenario.windowEnd,
    fingerprintVersionId: scenario.versionId,
  });
  assert.equal(batch.status, 'rejected');
  assert.equal(batch.reason, 'COLLINEAR_FINGERPRINTS');
  assert.deepEqual(batch.contributions, []);
});

test('missing and bad measurements can cause insufficient sample rejection without replacing raw observations', () => {
  const db = openDatabase(':memory:');
  const scenario = generateScenario(db);
  const rows = db.prepare("SELECT id FROM observations WHERE observed_at<'2026-01-18T01:00:00.000Z' AND pollutant_id=?").all(scenario.pollutantIds.SO2) as Array<{ id: number }>;
  const repo = new Repository(db);
  for (const row of rows) repo.markQuality(row.id, 'bad', '测试剔除');
  const batch = runAnalysis(db, {
    stationId: scenario.stationId,
    windowStart: scenario.windowStart,
    windowEnd: scenario.windowEnd,
    fingerprintVersionId: scenario.versionId,
  });
  assert.equal(batch.status, 'rejected');
  assert.equal(batch.reason, 'INSUFFICIENT_SAMPLES');
  const rawCount = db.prepare('SELECT COUNT(*) AS c FROM observations WHERE raw_value IS NOT NULL').get() as { c: number };
  assert.ok(rawCount.c > 0);
});

test('correction creates a new assessment and preserves historical batch for recomputation', () => {
  const db = openDatabase(':memory:');
  const scenario = generateScenario(db);
  const first = runAnalysis(db, { stationId: scenario.stationId, windowStart: scenario.windowStart, windowEnd: scenario.windowEnd, fingerprintVersionId: scenario.versionId });
  const drift = db.prepare("SELECT id FROM observations WHERE quality_note LIKE '%漂移%' LIMIT 1").get() as { id: number };
  new Repository(db).correctObservation(drift.id, 18, 'ok', '漂移更正');
  const second = runAnalysis(db, { stationId: scenario.stationId, windowStart: scenario.windowStart, windowEnd: scenario.windowEnd, fingerprintVersionId: scenario.versionId });
  assert.notEqual(first.id, second.id);
  assert.deepEqual(getBatch(db, first.id).id, first.id);
  assert.ok(getBatch(db, second.id).created_at >= first.created_at);
});

test('UTC timestamp boundary is parsed exactly', () => {
  const db = openDatabase(':memory:');
  const scenario = generateScenario(db);
  const batch = runAnalysis(db, {
    stationId: scenario.stationId,
    windowStart: '2026-01-18T00:10:00.000Z',
    windowEnd: '2026-01-18T00:20:00.000Z',
    fingerprintVersionId: scenario.versionId,
  });
  assert.equal(batch.status, 'rejected');
  assert.equal(batch.reason, 'INSUFFICIENT_SAMPLES');
});

test('fingerprint revision creates a new estimate while retaining the old batch', () => {
  const db = openDatabase(':memory:');
  const scenario = generateScenario(db);
  const options = {
    stationId: scenario.stationId,
    windowStart: scenario.windowStart,
    windowEnd: scenario.windowEnd,
    fingerprintVersionId: scenario.versionId,
  };
  const first = runAnalysis(db, options);
  const revised = new Repository(db).addFingerprintVersion({ version: 'FP-2026-02', effective_start: scenario.windowStart, note: '虚构修订指纹' }) as { id: number };
  for (const [pollutantCode, pollutantId] of Object.entries(scenario.pollutantIds)) {
    for (const [sourceCode, sourceId] of Object.entries(scenario.sourceIds)) {
      const current = db.prepare('SELECT value FROM fingerprint_values WHERE version_id=? AND source_id=? AND pollutant_id=?')
        .get(scenario.versionId, sourceId, pollutantId) as { value: number };
      const adjustment = sourceCode === 'A_FURNACE' && pollutantCode === 'SO2' ? 1.15 : 1;
      new Repository(db).setFingerprintValue(revised.id, sourceId, pollutantId, current.value * adjustment, 0.04);
    }
  }
  const second = runAnalysis(db, { ...options, fingerprintVersionId: revised.id });
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.fingerprint_version_id, second.fingerprint_version_id);
  assert.equal(getBatch(db, first.id).fingerprint_version_id, scenario.versionId);
  assert.equal(getBatch(db, second.id).fingerprint_version_id, revised.id);
});

test('analysis survives process-equivalent database restart and migrations are repeatable', () => {
  const directory = mkdtempSync(join(tmpdir(), 'airqs-'));
  after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'restart.db');
  {
    const db = openDatabase(path);
    const scenario = generateScenario(db);
    const batch = runAnalysis(db, { stationId: scenario.stationId, windowStart: scenario.windowStart, windowEnd: scenario.windowEnd, fingerprintVersionId: scenario.versionId });
    assert.ok(batch.id > 0);
    db.close();
  }
  {
    const db = openDatabase(path);
    openDatabase(path).close();
    const restored = db.prepare('SELECT COUNT(*) AS c FROM analysis_batches').get() as { c: number };
    assert.equal(restored.c, 1);
    db.close();
  }
});

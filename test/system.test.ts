import { describe, expect, it } from 'vitest';
import { migrate, openDatabase } from '../src/db.js';
import { Repository } from '../src/repository.js';
import { runAnalysis } from '../src/analysis.js';
import { seedScenario } from '../src/generator.js';
import { createTestContext, type TestContext } from './helpers.js';

describe('system invariants', () => {
  it('accepts an offset timestamp as the same UTC instant', async () => {
    const context: TestContext = await createTestContext();
    const seeded = seedScenario(context.db, 'double-source');
    const run = runAnalysis(context.repo, {
      stationId: seeded.stationId,
      windowStart: '2026-01-01T08:00:00+08:00',
      windowEnd: '2026-01-01T12:00:00+08:00'
    });
    expect(context.repo.getRun(run.id).window_start).toBe('2026-01-01T00:00:00.000Z');
    context.db.close();
  });

  it('runs migrations repeatedly without changing existing data', async () => {
    const context = await createTestContext();
    seedScenario(context.db, 'double-source');
    const firstCount = context.repo.listPollutants().length;
    migrate(context.db);
    migrate(context.db);
    expect(context.repo.listPollutants()).toHaveLength(firstCount);
  });

  it('creates a separately reproducible run after fingerprint revision', async () => {
    const context = await createTestContext();
    const seeded = seedScenario(context.db, 'double-source');
    const first = runAnalysis(context.repo, { stationId: seeded.stationId, windowStart: '2026-01-01T00:00:00.000Z', windowEnd: '2026-01-01T02:00:00.000Z' }).id;
    context.repo.addFingerprint({
      id: 'FP-A3',
      source_id: 'A',
      version: 3,
      effective_from: '2025-12-31T00:00:00.000Z',
      supersedes: 'FP-A2',
      profile: { PM25: 1, SO2: 0.35, NOX: 0.55, VOC: 0.15 }
    });
    context.repo.addEmissionWindow({
      source_id: 'A',
      starts_at: '2026-01-01T03:58:00.000Z',
      ends_at: '2026-01-01T04:00:00.000Z',
      relative_rate: 5,
      fingerprint_id: 'FP-A3'
    });
    const second = runAnalysis(context.repo, { stationId: seeded.stationId, windowStart: '2026-01-01T02:00:00.000Z', windowEnd: '2026-01-01T04:00:00.000Z' }).id;
    expect(second).not.toBe(first);
    expect(context.repo.runContributions(first).find((item) => item.source_id === 'A')?.fingerprint_id).toBe('FP-A1');
    expect(context.repo.runContributions(second).find((item) => item.source_id === 'A')?.fingerprint_id).toBe('FP-A3');
  });

  it('serializes concurrent writes in explicit transactions without losing revision increments', async () => {
    const context = await createTestContext();
    seedScenario(context.db, 'double-source');
    const observationId = context.repo.observationsFor('S1', '2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z')[0]!.id;
    await Promise.all([1, 2, 3].map(async () => {
      context.repo.transaction(() => {
        const current = context.repo.getObservation(observationId);
        context.repo.markObservation(observationId, 'suspect', `note ${current.revision}`, current.original_value);
      });
    }));
    expect(context.repo.getObservation(observationId).revision).toBeGreaterThanOrEqual(4);
  });
});

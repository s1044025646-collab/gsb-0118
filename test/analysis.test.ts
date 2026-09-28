import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { Repository } from '../src/repository.js';
import { runAnalysis } from '../src/analysis.js';
import { seedScenario } from '../src/generator.js';
import { createTestContext, registerCleanup, type TestContext } from './helpers.js';

describe('source analysis scenarios', () => {
  const contexts: TestContext[] = [];
  registerCleanup(contexts);

  it('estimates a non-negative two-source mixture with small residual error', async () => {
    const context = await createTestContext();
    contexts.push(context);
    const runId = context.runScenario('double-source');
    const run = context.repo.getRun(runId);
    const contributions = context.repo.runContributions(runId);
    const residuals = context.repo.runResiduals(runId);
    expect(run.status).toBe('estimated');
    expect(contributions.map((item) => item.contribution).every((value) => value >= -1e-9)).toBe(true);
    expect(contributions.find((item) => item.source_id === 'A')?.eligible).toBe(1);
    expect(contributions.find((item) => item.source_id === 'B')?.eligible).toBe(1);
    expect(contributions.find((item) => item.source_id === 'A')?.contribution).toBeGreaterThan(0.5);
    expect(contributions.find((item) => item.source_id === 'B')?.contribution).toBeGreaterThan(0.5);
    expect(residuals.map((item) => item.residual ** 2).reduce((sum, value) => sum + value, 0)).toBeLessThan(3);
  });

  it('rejects a background jump rather than assigning it to a source', async () => {
    const context = await createTestContext();
    contexts.push(context);
    const runId = context.runScenario('background-jump');
    const run = context.repo.getRun(runId);
    expect(run.status).toBe('rejected');
    expect(run.reason).toContain('background');
  });

  it('does not credit a source after wind reverses away from it', async () => {
    const context = await createTestContext();
    contexts.push(context);
    const runId = context.runScenario('wind-reversal');
    const source = context.repo.runContributions(runId).find((item) => item.source_id === 'A')!;
    expect(source.screening_detail).toMatch(/^2\/4/);
    expect(source.contribution).toBeGreaterThan(0);
    expect(context.repo.runContributions(runId).filter((item) => item.eligible === 1)).toHaveLength(1);
  });

  it('rejects when drift makes a required pollutant unusable', async () => {
    const context = await createTestContext();
    contexts.push(context);
    const runId = context.runScenario('sensor-drift');
    expect(context.repo.getRun(runId).reason).toContain('drift');
  });

  it('rejects incomplete multi-pollutant samples caused by missing data', async () => {
    const context = await createTestContext();
    contexts.push(context);
    const runId = context.runScenario('missing');
    expect(context.repo.getRun(runId).reason).toContain('missing');
  });

  it('refuses a precise split for collinear fingerprints', async () => {
    const context = await createTestContext();
    contexts.push(context);
    const runId = context.runScenario('collinear');
    const run = context.repo.getRun(runId);
    expect(run.status).toBe('rejected');
    expect(run.identifiability).toBe('unidentifiable');
    for (const item of context.repo.runContributions(runId)) expect(item.share).toBeNull();
  });

  it('rejects a false alarm when the source is downwind', async () => {
    const context = await createTestContext();
    contexts.push(context);
    const runId = context.runScenario('false-alarm');
    expect(context.repo.getRun(runId).reason).toMatch(/wind direction|background/);
  });

  it('preserves original observations when a correction is made', async () => {
    const context = await createTestContext();
    contexts.push(context);
    seedScenario(context.db, 'sensor-drift');
    const before = context.repo.observationsFor('S1', '2026-01-01T01:00:00.000Z', '2026-01-01T02:00:00.000Z').find((item) => item.pollutant === 'SO2')!;
    const corrected = context.repo.markObservation(before.id, 'ok', 'manual correction', before.original_value + 2);
    expect(corrected.original_value).toBe(before.original_value);
    expect(corrected.corrected_value).toBe(before.original_value + 2);
    expect(corrected.revision).toBe(before.revision + 1);
  });
});

describe('restart and history', () => {
  it('persists runs across process-style reopen and creates a new run after data revision', async () => {
    const context = await createTestContext();
    const seeded = seedScenario(context.db, 'double-source');
    const first = runAnalysis(context.repo, { stationId: seeded.stationId, windowStart: seeded.windowStart, windowEnd: seeded.windowEnd }).id;
    context.db.close();

    const reopened = openDatabase(context.path);
    const repo = new Repository(reopened);
    const original = repo.getRun(first);
    repo.upsertWeather({ station_id: 'S1', observed_at: '2026-01-01T01:00:00.000Z', wind_direction_deg: 90, wind_speed_mps: 10 });
    const second = runAnalysis(repo, { stationId: seeded.stationId, windowStart: seeded.windowStart, windowEnd: seeded.windowEnd }).id;
    expect(second).not.toBe(first);
    expect(repo.getRun(first).data_revision).not.toBe(repo.getRun(second).data_revision);
    expect(repo.getRun(first).window_start).toBe(original.window_start);
    reopened.close();
  });
});

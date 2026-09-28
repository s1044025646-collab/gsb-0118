import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { openDatabase, type Db } from '../src/db.js';
import { Repository } from '../src/repository.js';
import { runAnalysis } from '../src/analysis.js';
import { seedScenario, type Scenario } from '../src/generator.js';

export interface TestContext {
  path: string;
  db: Db;
  repo: Repository;
  runScenario: (scenario?: Scenario) => number;
}

export async function createTestContext(): Promise<TestContext> {
  const directory = await mkdtemp(join(tmpdir(), 'air-attribution-'));
  const path = join(directory, 'test.sqlite');
  const db = openDatabase(path);
  const repo = new Repository(db);
  return {
    path,
    db,
    repo,
    runScenario: (scenario = 'double-source') => {
      const seeded = seedScenario(db, scenario);
      return runAnalysis(repo, { stationId: seeded.stationId, windowStart: seeded.windowStart, windowEnd: seeded.windowEnd }).id;
    }
  };
}

export function closeTestContext(context: TestContext): void {
  context.db.close();
}

export async function removeTestContext(context: TestContext): Promise<void> {
  closeTestContext(context);
  await rm(context.path, { force: true });
  await rm(`${context.path}-wal`, { force: true });
  await rm(`${context.path}-shm`, { force: true });
}

export function registerCleanup(contexts: TestContext[]): void {
  afterEach(async () => {
    for (const context of contexts.splice(0)) await removeTestContext(context);
  });
}

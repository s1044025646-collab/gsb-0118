import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = process.cwd();
const db = join(root, 'data', 'demo.db');
rmSync(db, { force: true });
rmSync(`${db}-wal`, { force: true });
rmSync(`${db}-shm`, { force: true });

function run(args) {
  const result = spawnSync(process.execPath, ['dist/src/cli/main.js', ...args], {
    cwd: root,
    env: { ...process.env, AIRQS_DB: db },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    console.error(result.stdout);
    console.error(result.stderr);
    process.exit(result.status ?? 1);
  }
  return JSON.parse(result.stdout);
}

const dbHandle = new DatabaseSync(db);

console.log('# 1. Generate deterministic fictional fixture');
const fixture = run(['generate-fixture', '--seed', '20260118']);
console.log(JSON.stringify({ observationsBefore: fixture.before.observations, observationsAfter: fixture.after.observations }));

console.log('# 2. Run non-negative multi-pollutant source apportionment');
const analysis = run([
  'run',
  '--station-id', String(fixture.scenario.stationId),
  '--start', fixture.scenario.windowStart,
  '--end', fixture.scenario.windowEnd,
  '--fingerprint-version-id', String(fixture.scenario.versionId),
]);
console.log(JSON.stringify({ batchId: analysis.id, status: analysis.status, reason: analysis.reason, contributions: analysis.contributions }));

console.log('# 3. Inspect residuals and wind-screened candidates');
const detail = run(['show', '--id', String(analysis.id)]);
console.log(JSON.stringify({ residuals: detail.residuals, candidates: detail.candidates }));

console.log('# 4. Re-run after data correction; history remains separately reproducible');
const driftRow = dbHandle.prepare("SELECT id FROM observations WHERE quality_note LIKE '%漂移%' ORDER BY id LIMIT 1").get();
const correction = run(['correct-observation', '--id', String(driftRow.id), '--value', '18', '--flag', 'ok', '--note', '演示漂移更正']);
console.log(JSON.stringify({ correctionBefore: correction.before, correctionAfter: { id: correction.after.id, corrected_value: correction.after.corrected_value } }));
const corrected = run([
  'run',
  '--station-id', String(fixture.scenario.stationId),
  '--start', fixture.scenario.windowStart,
  '--end', fixture.scenario.windowEnd,
  '--fingerprint-version-id', String(fixture.scenario.versionId),
]);
console.log(JSON.stringify({ historicalBatch: analysis.id, newBatch: corrected.id, status: corrected.status }));

console.log('# 5. Export local fictional event report');
const report = run(['export-event', '--id', String(corrected.id), '--out', 'data/demo-event-report.json']);
console.log(JSON.stringify({ report: report.event, interpretation: report.interpretation }));

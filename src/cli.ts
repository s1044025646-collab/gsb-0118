import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDatabase } from './db.js';
import { Repository } from './repository.js';
import { runAnalysis } from './analysis.js';
import { seedScenario, type Scenario } from './generator.js';
import { eventReport } from './report.js';

interface ObservationRow {
  station_id: string;
  pollutant: string;
  observed_at: string;
  value: number;
}

const args = process.argv.slice(2);
const command = args[0];
const dbPath = process.env.AIR_DB ?? 'air-local.sqlite';

function parseFlags(names: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg.startsWith('--')) flags[arg.slice(2)] = args[index + 1] ?? '';
  }
  for (const name of names) if (!(name in flags)) throw new Error(`missing --${name}`);
  return flags;
}

function printRun(repo: Repository, id: number): void {
  const run = repo.getRun(id);
  console.log(`run ${id}: ${run.status}/${run.identifiability}${run.reason ? ` (${run.reason})` : ''}`);
  for (const item of repo.runContributions(id)) {
    console.log(`  ${item.eligible ? '+' : '-'} ${item.source_id} c=${item.contribution.toFixed(4)} share=${item.share === null ? 'n/a' : item.share.toFixed(4)} fp=${item.fingerprint_id} :: ${item.screening_detail}`);
  }
  for (const item of repo.runResiduals(id)) {
    console.log(`  r ${item.pollutant}: ${item.observed.toFixed(4)} - ${item.modeled.toFixed(4)} = ${item.residual.toFixed(4)}`);
  }
}

const db = openDatabase(dbPath);
const repo = new Repository(db);

try {
  if (command === 'seed') {
    const scenario = (args[1] ?? 'double-source') as Scenario;
    console.log(`before: ${repo.listStations().length} stations, ${repo.listRuns(undefined, 1, 0).total} runs`);
    const result = seedScenario(db, scenario);
    console.log(`after: seeded ${scenario} station=${result.stationId} window=${result.windowStart}/${result.windowEnd}`);
  } else if (command === 'import-observations') {
    const flags = parseFlags(['file']);
    const rows = JSON.parse(readFileSync(resolve(flags.file!), 'utf8')) as ObservationRow[];
    console.log(`before: ${repo.listRuns(undefined, 1, 0).total} analysis runs; importing ${rows.length} rows`);
    let id = 0;
    repo.transaction(() => {
      for (const row of rows) id = repo.insertObservation(row);
    });
    console.log(`after: last observation id=${id}; original values retained separately from corrections`);
  } else if (command === 'mark-quality') {
    const flags = parseFlags(['id', 'quality']);
    const before = repo.getObservation(Number(flags.id));
    const after = repo.markObservation(Number(flags.id), flags.quality as never, flags.note ?? '', flags.corrected ? Number(flags.corrected) : null);
    console.log(`before: ${before.quality} rev=${before.revision}; after: ${after.quality} rev=${after.revision}`);
  } else if (command === 'analyze') {
    const flags = parseFlags(['station', 'start', 'end']);
    const before = repo.listRuns(flags.station, 100, 0).total;
    const result = runAnalysis(repo, { stationId: flags.station!, windowStart: new Date(flags.start!).toISOString(), windowEnd: new Date(flags.end!).toISOString() });
    const after = repo.listRuns(flags.station, 100, 0).total;
    console.log(`before: ${before} runs for station; after: ${after}`);
    printRun(repo, result.id);
  } else if (command === 'show-run') {
    const flags = parseFlags(['id']);
    printRun(repo, Number(flags.id));
  } else if (command === 'compare') {
    const flags = parseFlags(['left', 'right']);
    const left = Number(flags.left);
    const right = Number(flags.right);
    console.log(`left ${left} (${repo.getRun(left).data_revision}) vs right ${right} (${repo.getRun(right).data_revision})`);
    console.log('--- left'); printRun(repo, left);
    console.log('--- right'); printRun(repo, right);
  } else if (command === 'export-event') {
    const flags = parseFlags(['id']);
    const report = eventReport(repo, Number(flags.id));
    if (flags.out) writeFileSync(resolve(flags.out), report, 'utf8');
    else console.log(report);
  } else if (command === 'review') {
    const flags = parseFlags(['id', 'reviewer', 'decision']);
    const before = repo.getRun(Number(flags.id));
    repo.transaction(() => repo.reviewRun(Number(flags.id), flags.reviewer!, flags.decision as 'confirmed' | 'rejected' | 'needs_data', flags.note ?? '', new Date().toISOString()));
    const after = repo.getRun(Number(flags.id));
    console.log(`before: ${before.status}; after: ${after.status}`);
  } else if (command === 'demo') {
    console.log(`database: ${dbPath}`);
    const seeded = seedScenario(db, 'double-source', 7);
    const run = runAnalysis(repo, { stationId: seeded.stationId, windowStart: seeded.windowStart, windowEnd: seeded.windowEnd });
    console.log(eventReport(repo, run.id));
  } else {
    console.log('commands: seed, import-observations, mark-quality, analyze, show-run, compare, review, export-event, demo');
    process.exitCode = 2;
  }
} finally {
  db.close();
}

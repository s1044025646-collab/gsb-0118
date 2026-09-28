import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDatabase } from '../core/db.js';
import { Repository } from '../core/repository.js';
import { generateScenario } from '../core/generator.js';
import { getBatch, runAnalysis } from '../core/solver.js';

interface CliContext {
  db: ReturnType<typeof openDatabase>;
  repo: Repository;
  args: string[];
}

const command = process.argv[2] ?? 'help';
const dbPath = process.env.AIRQS_DB ?? 'data/airqs.db';
const db = openDatabase(dbPath);
const context: CliContext = { db, repo: new Repository(db), args: process.argv.slice(3) };

try {
  if (command === 'init') json({ ok: true, dbPath, migrated: true });
  else if (command === 'generate-fixture') generateFixture(context);
  else if (command === 'import-observations') importObservations(context);
  else if (command === 'mark-quality') markQuality(context);
  else if (command === 'correct-observation') correctObservation(context);
  else if (command === 'run') run(context);
  else if (command === 'show') show(context);
  else if (command === 'compare') compare(context);
  else if (command === 'export-event') exportEvent(context);
  else if (command === 'review') review(context);
  else help();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ ok: false, error: message }));
  process.exitCode = 1;
} finally {
  db.close();
}

function generateFixture({ db, args }: CliContext) {
  const before = count(db, 'observations');
  const scenario = generateScenario(db, optionNumber(args, '--seed') ?? 20260118, option(args, '--start') ?? undefined);
  const after = count(db, 'observations');
  json({ before: { observations: before }, after: { observations: after }, scenario });
}

function importObservations({ repo, db, args }: CliContext) {
  const path = requiredOption(args, '--file');
  const raw = readFileSync(resolve(path), 'utf8');
  const records = path.toLowerCase().endsWith('.csv') ? parseCsv(raw) : JSON.parse(raw) as unknown[];
  if (!Array.isArray(records)) throw new Error('import file must contain an array or CSV rows');
  const before = count(db, 'observations');
  const imported = records.map((record) => repo.addObservation(record as any));
  json({ before: { observations: before }, after: { observations: count(db, 'observations') }, imported: imported.length });
}

function markQuality({ repo, db, args }: CliContext) {
  const id = requiredNumberOption(args, '--id');
  const flag = requiredOption(args, '--flag');
  const note = option(args, '--note') ?? '';
  const before = db.prepare('SELECT id,quality_flag,quality_note FROM observations WHERE id=?').get(id);
  const updated = repo.markQuality(id, flag as 'ok'|'suspect'|'bad'|'missing', note);
  json({ before, after: updated });
}

function correctObservation({ repo, db, args }: CliContext) {
  const id = requiredNumberOption(args, '--id');
  const value = requiredNumberOption(args, '--value');
  const flag = option(args, '--flag') ?? 'suspect';
  const note = option(args, '--note') ?? '人工更正';
  const before = db.prepare('SELECT id,raw_value,corrected_value,quality_flag FROM observations WHERE id=?').get(id);
  const after = repo.correctObservation(id, value, flag as 'ok'|'suspect'|'bad'|'missing', note);
  json({ before, after });
}

function run({ db, args }: CliContext) {
  const batch = runAnalysis(db, {
    stationId: requiredNumberOption(args, '--station-id'),
    windowStart: requiredOption(args, '--start'),
    windowEnd: requiredOption(args, '--end'),
    fingerprintVersionId: requiredNumberOption(args, '--fingerprint-version-id'),
    maxTravelSeconds: optionNumber(args, '--max-travel-seconds') ?? undefined,
  });
  json(batch);
}

function show({ db, args }: CliContext) {
  json(getBatch(db, requiredNumberOption(args, '--id')));
}

function compare({ db, args }: CliContext) {
  const a = getBatch(db, requiredNumberOption(args, '--a'));
  const b = getBatch(db, requiredNumberOption(args, '--b'));
  const contributionsById = new Map((b.contributions as Array<{ source_id: number; contribution: number }>).map((row) => [row.source_id, row.contribution]));
  const contributionDiff = (a.contributions as Array<{ source_id: number; source_code: string; contribution: number }>).map((row) => ({
    source_id: row.source_id,
    source_code: row.source_code,
    from: row.contribution,
    to: contributionsById.get(row.source_id) ?? 0,
    delta: (contributionsById.get(row.source_id) ?? 0) - row.contribution,
  }));
  json({ a: summarizeBatch(a), b: summarizeBatch(b), contributionDiff });
}

function exportEvent({ db, args }: CliContext) {
  const batch = getBatch(db, requiredNumberOption(args, '--id'));
  const report = {
    generated_at: new Date().toISOString(),
    event: summarizeBatch(batch),
    interpretation: batch.status === 'rejected'
      ? `拒绝给出单源比例：${batch.reason}。原始观测保留，候选源筛选、残差和指纹版本已记录。`
      : '非负多源贡献估计；报告不使用模型估计替换原始观测。',
    wind_rule: '候选源必须在传播时滞到达时间窗内处于上风向；下风向源仅记录拒绝原因。',
    batch,
  };
  const out = option(args, '--out');
  if (out) writeFileSync(resolve(out), JSON.stringify(report, null, 2), 'utf8');
  json(report);
}

function review({ repo, db, args }: CliContext) {
  const batchId = requiredNumberOption(args, '--batch-id');
  const decision = requiredOption(args, '--decision');
  if (!['confirmed', 'dismissed', 'needs_data'].includes(decision)) throw new Error('invalid decision');
  const reviewer = option(args, '--reviewer') ?? 'operator';
  const note = option(args, '--note') ?? '';
  const before = db.prepare('SELECT COUNT(*) AS c FROM manual_reviews WHERE batch_id=?').get(batchId);
  const after = repo.addManualReview(batchId, reviewer, decision as 'confirmed'|'dismissed'|'needs_data', note);
  json({ before, after });
}

function help() {
  console.log([
    'air-source-tracker CLI',
    'init',
    'generate-fixture [--seed 20260118] [--start ISO]',
    'import-observations --file data.json|data.csv',
    'mark-quality --id N --flag ok|suspect|bad|missing [--note TEXT]',
    'correct-observation --id N --value NUMBER [--flag ok|suspect|bad|missing] [--note TEXT]',
    'run --station-id N --start ISO --end ISO --fingerprint-version-id N',
    'show --id N',
    'compare --a N --b N',
    'export-event --id N [--out report.json]',
    'review --batch-id N --decision confirmed|dismissed|needs_data [--reviewer NAME] [--note TEXT]',
  ].join('\n'));
}

function summarizeBatch(batch: ReturnType<typeof getBatch>) {
  return {
    id: batch.id,
    status: batch.status,
    reason: batch.reason,
    window: [batch.window_start, batch.window_end],
    fingerprint_version_id: batch.fingerprint_version_id,
    created_at: batch.created_at,
  };
}

function count(db: CliContext['db'], table: string): number {
  if (!/^[a-z_]+$/.test(table)) throw new Error('invalid table');
  return Number((db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c);
}

function option(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? null : null;
}

function requiredOption(args: string[], name: string): string {
  const value = option(args, name);
  if (value === null) throw new Error(`${name} is required`);
  return value;
}

function optionNumber(args: string[], name: string): number | null {
  const value = option(args, name);
  if (value === null) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${name} must be a number`);
  return number;
}

function requiredNumberOption(args: string[], name: string): number {
  const value = optionNumber(args, name);
  if (value === null) throw new Error(`${name} is required`);
  return value;
}

function parseCsv(raw: string): Array<Record<string, string | number | null>> {
  const lines = raw.trim().split(/\r?\n/).filter(Boolean);
  const headers = lines[0]!.split(',');
  return lines.slice(1).map((line) => {
    const values = line.split(',');
    return Object.fromEntries(headers.map((header, index) => {
      const key = header.trim();
      const value = values[index]?.trim() ?? '';
      if (['station_id', 'pollutant_id'].includes(key)) return [key, Number(value)];
      if (value === '' || value.toLowerCase() === 'null') return [key, null];
      return [key, value];
    }));
  });
}

function json(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

import { Repository } from './repository.js';

export function eventReport(repo: Repository, runId: number): string {
  const run = repo.getRun(runId);
  const contributions = repo.runContributions(runId);
  const residuals = repo.runResiduals(runId);
  const lines = [
    `EVENT REPORT ${runId}`,
    `station: ${run.station_id}`,
    `window: ${run.window_start} .. ${run.window_end}`,
    `status: ${run.status}`,
    `identifiability: ${run.identifiability}`,
    `algorithm: ${run.algorithm}`,
    run.reason ? `reason: ${run.reason}` : 'reason: estimated',
    '',
    'contributions:'
  ];
  for (const item of contributions) {
    lines.push(`- ${item.source_id} fingerprint=${item.fingerprint_id} contribution=${item.contribution.toFixed(4)} share=${item.share === null ? 'n/a' : item.share.toFixed(4)} eligible=${item.eligible} :: ${item.screening_detail}`);
  }
  lines.push('', 'residuals:');
  for (const item of residuals) lines.push(`- ${item.pollutant}: observed=${item.observed.toFixed(4)} modeled=${item.modeled.toFixed(4)} residual=${item.residual.toFixed(4)}`);
  return lines.join('\n');
}

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const manifest = JSON.parse(readFileSync(new URL('../infra/config/regional-cells.json', import.meta.url)));
const environment = process.env.ENVIRONMENT || 'production';
for (const cell of manifest.cells) {
  const stack = `${cell.product}-${environment}-${cell.region}`;
  const run = (args) => spawnSync('aws', ['cloudformation', ...args, '--stack-name', stack, '--region', cell.region, '--output', 'json'], { encoding: 'utf8' });
  const started = run(['detect-stack-drift']); if (started.status !== 0) throw new Error(`${stack}: ${started.stderr.trim()}`);
  const id = JSON.parse(started.stdout).StackDriftDetectionId;
  let status;
  for (let attempt = 0; attempt < 60; attempt++) {
    const result = spawnSync('aws', ['cloudformation', 'describe-stack-drift-detection-status', '--stack-drift-detection-id', id, '--region', cell.region, '--output', 'json'], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`${stack}: ${result.stderr.trim()}`);
    status = JSON.parse(result.stdout); if (status.DetectionStatus !== 'DETECTION_IN_PROGRESS') break;
    spawnSync('sleep', ['5']);
  }
  if (status?.DetectionStatus !== 'DETECTION_COMPLETE' || status.StackDriftStatus !== 'IN_SYNC') throw new Error(`${stack} drift status: ${JSON.stringify(status)}`);
  console.log(`${stack}: IN_SYNC`);
}

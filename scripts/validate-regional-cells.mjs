import { readFileSync } from 'node:fs';
const manifest = JSON.parse(readFileSync(new URL('../infra/config/regional-cells.json', import.meta.url)));
const launchRegions = ['us-east-2', 'eu-central-1', 'ap-south-1', 'ap-southeast-1', 'ap-southeast-2'];
const products = ['eversally', 'nightframe'];
if (manifest.schemaVersion !== 1 || !/^regional-\d{4}-\d{2}-\d{2}-v\d+$/.test(manifest.configurationVersion)) throw new Error('Manifest schema or immutable configurationVersion is invalid');
const keys = new Set();
for (const cell of manifest.cells) {
  if (!products.includes(cell.product) || !launchRegions.includes(cell.region) || !Number.isInteger(cell.wave) || cell.wave < 1) throw new Error(`Invalid cell ${JSON.stringify(cell)}`);
  const key = `${cell.product}:${cell.region}`; if (keys.has(key)) throw new Error(`Duplicate cell ${key}`); keys.add(key);
}
for (const product of products) for (const region of launchRegions) if (!keys.has(`${product}:${region}`)) throw new Error(`Missing cell ${product}:${region}`);
if (process.argv.includes('--production-preflight')) {
  const layers = JSON.parse(process.env.FFMPEG_LAYER_ARNS_JSON || '{}'); const endpoints = JSON.parse(process.env.REGIONAL_ENDPOINTS_JSON || '{}');
  for (const cell of manifest.cells) {
    if (!String(layers[cell.region] || '').startsWith(`arn:aws:lambda:${cell.region}:`)) throw new Error(`Missing region-local FFmpeg layer for ${cell.region}`);
    if (!String(endpoints[`${cell.product}:${cell.region}`] || '').startsWith('https://')) throw new Error(`Missing HTTPS endpoint for ${cell.product}:${cell.region}`);
  }
  for (const name of ['GLOBAL_USER_POOL_ARN', 'GLOBAL_ROUTING_TABLE', 'OPERATIONS_ALARM_EMAIL']) if (!process.env[name]) throw new Error(`${name} is required`);
}
console.log(`Validated ${manifest.cells.length} regional cells; configuration=${manifest.configurationVersion}; waves=${Math.max(...manifest.cells.map(({ wave }) => wave))}`);
if (process.argv.includes('--aws-preflight')) {
  const { spawnSync } = await import('node:child_process');
  for (const region of launchRegions) {
    const invoke = (args) => spawnSync('aws', [...args, '--region', region, '--output', 'json'], { encoding: 'utf8' });
    const lambdaQuota = invoke(['service-quotas', 'get-service-quota', '--service-code', 'lambda', '--quota-code', 'L-B99A9384']);
    if (lambdaQuota.status !== 0) throw new Error(`Cannot read Lambda quota in ${region}: ${lambdaQuota.stderr.trim()}`);
    if (Number(JSON.parse(lambdaQuota.stdout).Quota?.Value || 0) < manifest.minimumQuotas.lambdaConcurrentExecutions) throw new Error(`Lambda concurrency quota is below minimum in ${region}`);
    const rekognition = invoke(['rekognition', 'list-collections', '--max-results', '1']);
    if (rekognition.status !== 0) throw new Error(`Rekognition preflight failed in ${region}: ${rekognition.stderr.trim()}`);
  }
}

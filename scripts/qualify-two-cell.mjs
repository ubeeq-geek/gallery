import { execFileSync } from 'node:child_process';
const required = ['ROUTING_API_URL', 'CELL_A_API_URL', 'CELL_B_API_URL', 'TEST_ID_TOKEN', 'QUALIFY_UPLOAD_PUBLICATION_COMMAND', 'QUALIFY_MIGRATION_RESUME_COMMAND', 'QUALIFY_OUTAGE_COMMAND', 'QUALIFY_RESIDENCY_DENIAL_COMMAND'];
const missing = required.filter(name => !process.env[name]);
if (missing.length) throw new Error(`Two-cell qualification requires deployed AWS resources: ${missing.join(', ')}`);
const headers = { authorization: `Bearer ${process.env.TEST_ID_TOKEN}`, 'content-type': 'application/json' };
const request = async (base, path, init = {}) => { const response = await fetch(`${base.replace(/\/$/, '')}${path}`, { ...init, headers: { ...headers, ...init.headers } }); return { response, body: await response.json().catch(() => ({})) }; };
const product = process.env.TEST_PRODUCT || 'eversally';
const assigned = await request(process.env.ROUTING_API_URL, `/routing/${product}`, { method: 'POST', body: JSON.stringify({ dataHomeLabel: process.env.TEST_DATA_HOME_LABEL || 'United States' }) });
if (![200, 201].includes(assigned.response.status)) throw new Error(`Assignment failed: ${assigned.response.status}`);
const spaceId = `qualification-${Date.now()}`;
const home = assigned.body.regionalApiUrl;
const provisioned = await request(home, '/spaces', { method: 'POST', body: JSON.stringify({ spaceId }) });
if (provisioned.response.status !== 201) throw new Error(`Provisioning failed: ${provisioned.response.status}`);
const other = home.includes(process.env.CELL_A_API_URL) ? process.env.CELL_B_API_URL : process.env.CELL_A_API_URL;
const denied = await request(other, '/assets', { method: 'POST', body: JSON.stringify({ spaceId, assetId: 'cross-cell-probe' }) });
if (![400, 403, 404, 409].includes(denied.response.status)) throw new Error(`Cross-cell request was not denied: ${denied.response.status}`);
const runGate = (name, command) => {
  execFileSync('/bin/bash', ['-euo', 'pipefail', '-c', command], { stdio: 'inherit', env: { ...process.env, QUALIFICATION_SPACE_ID: spaceId, QUALIFICATION_HOME_API_URL: home, QUALIFICATION_OTHER_API_URL: other } });
  return name;
};
const gates = [
  runGate('upload-scan-review-publication', process.env.QUALIFY_UPLOAD_PUBLICATION_COMMAND),
  runGate('migration-interruption-resume', process.env.QUALIFY_MIGRATION_RESUME_COMMAND),
  runGate('outage-routing-refresh', process.env.QUALIFY_OUTAGE_COMMAND),
  runGate('aws-residency-denial', process.env.QUALIFY_RESIDENCY_DENIAL_COMMAND)
];
console.log(JSON.stringify({ status: 'PASS', assignment: assigned.response.status, provisioning: provisioned.response.status, crossCellDenial: denied.response.status, gates, spaceId }));

import type { Handler } from 'aws-lambda';

export const handler: Handler = async () => {
  const endpoint = process.env.CELL_HEALTH_URL;
  if (!endpoint) throw new Error('CELL_HEALTH_URL is required');
  const response = await fetch(endpoint, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`Regional health endpoint returned ${response.status}`);
  const body = await response.json() as { status?: string };
  if (body.status !== 'ok') throw new Error('Regional health response is invalid');
  return { region: process.env.DATA_HOME_REGION, healthy: true };
};

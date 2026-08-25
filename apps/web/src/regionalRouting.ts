import { getValidIdToken } from './cognitoAuth';

export interface RegionalRoute { opaqueSpaceId: string; product: 'eversally' | 'nightframe'; homeRegion: string; status: string; regionalApiUrl: string; }
const cacheKey = (product: string) => `regional-route:${product}`;

export const resolveRegionalRoute = async (product: RegionalRoute['product'], dataHomeLabel?: string): Promise<RegionalRoute> => {
  const routingApi = String(import.meta.env.VITE_ROUTING_API_URL || '').replace(/\/$/, '');
  if (!routingApi) throw new Error('Missing VITE_ROUTING_API_URL');
  const token = await getValidIdToken(); if (!token) throw new Error('Authentication is required for regional routing');
  const response = await fetch(`${routingApi}/routing/${product}`, { method: dataHomeLabel ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(dataHomeLabel ? { body: JSON.stringify({ dataHomeLabel }) } : {}) });
  if (!response.ok) throw new Error(response.status === 404 ? 'Data home is not assigned' : 'Regional routing failed');
  const route = await response.json() as RegionalRoute;
  sessionStorage.setItem(cacheKey(product), JSON.stringify(route));
  return route;
};

export const cachedRegionalRoute = (product: RegionalRoute['product']): RegionalRoute | undefined => {
  const value = sessionStorage.getItem(cacheKey(product));
  if (!value) return undefined;
  try { const route = JSON.parse(value) as RegionalRoute; if (route.status !== 'ACTIVE') { sessionStorage.removeItem(cacheKey(product)); return undefined; } return route; } catch { sessionStorage.removeItem(cacheKey(product)); return undefined; }
};

export const regionalRequest = async (product: RegionalRoute['product'], path: string, init: RequestInit = {}): Promise<Response> => {
  const route = cachedRegionalRoute(product) || await resolveRegionalRoute(product);
  const token = await getValidIdToken();
  const request = (target: RegionalRoute) => fetch(`${target.regionalApiUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`, { ...init, headers: { ...(init.headers || {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  const result = await request(route);
  if (![409, 421, 503].includes(result.status)) return result;
  sessionStorage.removeItem(cacheKey(product));
  return request(await resolveRegionalRoute(product));
};

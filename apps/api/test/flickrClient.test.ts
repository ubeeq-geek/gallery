import { FlickrClient } from '../src/flickrClient';

const response = (body: string, contentType = 'text/plain') => new Response(body, { status: 200, headers: { 'content-type': contentType } });

describe('Flickr OAuth and API client', () => {
  it('performs request-token and access-token exchanges without exposing the consumer secret', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return calls.length === 1
        ? response('oauth_token=request-token&oauth_token_secret=request-secret&oauth_callback_confirmed=true')
        : response('oauth_token=access-token&oauth_token_secret=access-secret&user_nsid=owner%40N01&username=Creator');
    }) as unknown as typeof fetch;
    const client = new FlickrClient('api-key', 'consumer-secret', fetcher);
    const requestToken = await client.requestToken('https://example.test/api/integrations/flickr/oauth/callback?state=signed');
    const accessToken = await client.accessToken(requestToken.get('oauth_token')!, requestToken.get('oauth_token_secret')!, 'verifier');
    expect(accessToken.get('user_nsid')).toBe('owner@N01');
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => !call.url.includes('consumer-secret') && !String(call.init?.body).includes('consumer-secret'))).toBe(true);
    expect(String(calls[0].init?.body)).toContain('oauth_signature=');
    expect(String(calls[1].init?.body)).toContain('oauth_verifier=verifier');
  });

  it('requests only the authenticated creator inventory with migration metadata extras', async () => {
    const fetchMock = jest.fn(async (_url: string | URL | Request, _init?: RequestInit) => response(JSON.stringify({ stat: 'ok', photos: { page: 1, pages: 2, photo: [{ id: 'photo-1' }] } }), 'application/json'));
    const page = await new FlickrClient('api-key', 'consumer-secret', fetchMock as unknown as typeof fetch).inventoryPage({ token: 'token', tokenSecret: 'secret' }, 1);
    expect(page).toMatchObject({ page: 1, pages: 2, photos: [{ id: 'photo-1' }] });
    const requestedUrl = String(fetchMock.mock.calls[0][0]);
    expect(requestedUrl).toContain('method=flickr.people.getPhotos');
    expect(requestedUrl).toContain('user_id=me');
    expect(requestedUrl).toContain('original_format');
  });

  it('retries throttled reads and exhausts every album page in provider order', async () => {
    const payloads = [
      new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } }),
      response(JSON.stringify({ stat: 'ok', photosets: { page: 1, pages: 2, photoset: [{ id: 'album-1' }] } }), 'application/json'),
      response(JSON.stringify({ stat: 'ok', photosets: { page: 2, pages: 2, photoset: [{ id: 'album-2' }] } }), 'application/json')
    ];
    const fetchMock = jest.fn(async (_url: string | URL | Request, _init?: RequestInit) => payloads.shift()!);
    const albums = await new FlickrClient('api-key', 'consumer-secret', fetchMock as unknown as typeof fetch).albums({ token: 'token', tokenSecret: 'secret' });
    expect(albums.map((album) => album.id)).toEqual(['album-1', 'album-2']);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[2][0])).toContain('page=2');
  });
});

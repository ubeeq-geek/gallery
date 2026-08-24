import { SmugMugHttpGateway, type SmugMugCredentialVault } from '../src/smugMugGateway';

class Vault implements SmugMugCredentialVault {
  values = new Map<string, { token: string; tokenSecret: string }>();
  async put(value: { token: string; tokenSecret: string }) { this.values.set('credential-1', value); return 'credential-1'; }
  async get(reference: string) { return this.values.get(reference); }
  async replace(reference: string, value: { token: string; tokenSecret: string }) { this.values.set(reference, value); return reference; }
  async delete(reference: string) { this.values.delete(reference); }
}

describe('SmugMug OAuth 1.0a gateway', () => {
  it('uses read-only authorization and maps API inventory without leaking tokens', async () => {
    const vault = new Vault();
    const responses = [
      new Response('oauth_token=request-token&oauth_token_secret=request-secret'),
      new Response('oauth_token=access-token&oauth_token_secret=access-secret'),
      Response.json({ Response: { User: { UserID: 'user-1', NickName: 'Creator' } } }),
      Response.json({ Response: { User: { Uris: { Node: { Uri: '/api/v2/node/root' } } } } }),
      Response.json({ Response: {
        Node: [{ NodeID: 'folder-1', Type: 'Folder', Name: 'Archive', SortIndex: 2, Uris: { ChildNodes: { Uri: '/api/v2/node/folder-1' } } }],
        AlbumImage: [{ ImageKey: 'image-1', AlbumKey: 'album-1', WebUri: 'https://photos.test/image-1', OriginalImageUrl: 'https://photos.test/image-1/original.jpg', FileName: 'source.jpg', Format: 'JPEG', CanDownload: true, Keywords: 'one; two', OriginalSize: 100 }],
        Pages: { NextPage: '/api/v2/node!children?start=2' }
      } })
    ];
    const request = jest.fn<Promise<Response>, [string | URL | Request, RequestInit?]>(async () => responses.shift()!);
    const gateway = new SmugMugHttpGateway({ apiKey: 'key', apiSecret: 'secret', callbackUrl: 'https://app.test/api/integrations/smugmug/oauth/callback', vault, fetch: request as typeof fetch });

    const started = await gateway.startAuthorization('state-1');
    expect(started.authorizationUrl).toContain('Access=Full&Permissions=Read');
    expect(started.authorizationUrl).not.toContain('request-secret');
    expect(request.mock.calls[0][1]?.headers).toMatchObject({ Authorization: expect.stringContaining('oauth_callback=') });

    const connected = await gateway.completeAuthorization(started.credentialRef, 'verifier');
    expect(connected).toMatchObject({ accountId: 'user-1', accountName: 'Creator' });
    expect(JSON.stringify(connected)).not.toContain('access-token');

    const inventory = await gateway.inventory(started.credentialRef);
    expect(inventory.collections[0]).toMatchObject({ remoteId: 'folder-1', kind: 'FOLDER', title: 'Archive', position: 2 });
    expect(inventory.images[0]).toMatchObject({ remoteId: 'image-1', galleryId: 'album-1', originalAvailable: true, keywords: ['one', 'two'], byteSize: 100 });
    expect(inventory.nextCursor).toMatch(/^smugmug:v1:/);
    expect(request.mock.calls.every((call) => String(call[1]?.headers && (call[1].headers as Record<string, string>).Authorization).startsWith('OAuth '))).toBe(true);
  });

  it('rejects partial source downloads', async () => {
    const vault = new Vault();
    await vault.put({ token: 'token', tokenSecret: 'secret' });
    const gateway = new SmugMugHttpGateway({
      apiKey: 'key', apiSecret: 'secret', callbackUrl: 'https://app.test/callback', vault,
      fetch: jest.fn(async () => new Response('short', { headers: { 'content-type': 'image/jpeg', 'content-length': '5' } })) as typeof fetch
    });
    await expect(gateway.download('credential-1', {
      remoteId: 'image-1', galleryId: 'album-1', url: 'https://photos.test/image-1', keywords: [], position: 0,
      byteSize: 100, mimeType: 'image/jpeg', originalAvailable: true, sourceUrl: 'https://photos.test/original.jpg', privacy: {}, licence: {}
    })).rejects.toThrow('partial');
  });

  it('uploads only through an explicit signed gallery request', async () => {
    const vault = new Vault();
    await vault.put({ token: 'token', tokenSecret: 'secret' });
    const request = jest.fn<Promise<Response>, [string | URL | Request, RequestInit?]>(async () => Response.json({ Response: { Image: { ImageKey: 'remote-1', WebUri: 'https://photos.test/remote-1', Uri: '/api/v2/image/remote-1' } } }));
    const gateway = new SmugMugHttpGateway({ apiKey: 'key', apiSecret: 'secret', callbackUrl: 'https://app.test/callback', vault, fetch: request as typeof fetch });
    const published = await gateway.publish('credential-1', { galleryUri: '/api/v2/album/gallery-1', body: Buffer.from('image'), filename: 'image.jpg', mimeType: 'image/jpeg', title: 'Title', caption: 'Caption', keywords: ['one'] });
    expect(published).toMatchObject({ remoteId: 'remote-1', remoteUrl: 'https://photos.test/remote-1' });
    expect(request).toHaveBeenCalledWith('https://upload.smugmug.com/', expect.objectContaining({
      method: 'PUT', body: expect.any(ArrayBuffer), headers: expect.objectContaining({ Authorization: expect.stringMatching(/^OAuth /), 'X-Smug-AlbumUri': '/api/v2/album/gallery-1', 'X-Smug-FileName': 'image.jpg' })
    }));
  });
});

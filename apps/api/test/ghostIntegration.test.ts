import { createHmac } from 'crypto';
import express from 'express';
import request from 'supertest';
import { GhostIntegrationService, GHOST_ACCEPT_VERSION, ghostAdminToken, normalizeGhostAdminUrl, registerGhostRoutes, renderGhostLexical } from '../src/ghostIntegration';

describe('Ghost integration security boundaries', () => {
  it('requires HTTPS and normalizes the Admin API path', () => {
    expect(normalizeGhostAdminUrl('https://writer.example/')).toBe('https://writer.example/ghost/api/admin');
    expect(normalizeGhostAdminUrl('https://writer.example/ghost/api/admin')).toBe('https://writer.example/ghost/api/admin');
    expect(() => normalizeGhostAdminUrl('http://writer.example')).toThrow('HTTPS');
    expect(() => normalizeGhostAdminUrl('https://user:password@writer.example')).toThrow('credentials');
    expect(() => normalizeGhostAdminUrl('https://127.0.0.1')).toThrow('private');
    expect(() => normalizeGhostAdminUrl('https://192.168.1.5')).toThrow('private');
  });

  it('creates a short-lived Ghost Admin JWT with the integration id', () => {
    const key = `integration-id:${'ab'.repeat(32)}`;
    const token = ghostAdminToken(key, 1000);
    const [header, payload, signature] = token.split('.');
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toMatchObject({ alg: 'HS256', kid: 'integration-id' });
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toEqual({ iat: 1000, exp: 1300, aud: '/admin/' });
    expect(signature).toBe(createHmac('sha256', Buffer.from('ab'.repeat(32), 'hex')).update(`${header}.${payload}`).digest('base64url'));
  });

  it('renders only allowlisted Lexical nodes and rejects script-capable URLs', () => {
    const lexical = JSON.parse(renderGhostLexical([{ type: 'heading', text: 'A safe story', level: 2 }, { type: 'image', src: 'https://cdn.example/image.jpg', alt: 'Example' }], 'https://ubeeq.example/works/story'));
    expect(lexical.root.children.map((node: { type: string }) => node.type)).toEqual(['heading', 'image', 'paragraph']);
    expect(JSON.stringify(lexical)).not.toContain('<script');
    expect(() => renderGhostLexical([{ type: 'image', src: 'javascript:alert(1)' }], 'https://ubeeq.example/work')).toThrow('safe HTTP');
  });

  it('validates a site without returning or storing a plaintext key in public records', async () => {
    const request = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ site: { uuid: 'site-1', url: 'https://writer.example' } }) });
    const service = new GhostIntegrationService('test-encryption-key', request as unknown as typeof fetch);
    const result = await service.connect({ creatorId: 'creator-1', adminUrl: 'https://writer.example', apiKey: `key-id:${'cd'.repeat(32)}` });
    expect(result).not.toHaveProperty('encryptedKey');
    expect(result).not.toHaveProperty('webhookSecretHash');
    expect(result.webhookSecret).toHaveLength(43);
    expect(JSON.stringify(result)).not.toContain('cdcdcd');
    expect(request).toHaveBeenCalledWith('https://writer.example/ghost/api/admin/site/', expect.objectContaining({ headers: expect.objectContaining({ 'Accept-Version': GHOST_ACCEPT_VERSION }) }));
  });

  it('requires platform approval before creating a managed-site connection', async () => {
    const request = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ site: { uuid: 'managed-site-1' } }) });
    const service = new GhostIntegrationService('test-encryption-key', request as unknown as typeof fetch);
    const input = { creatorId: 'creator-1', adminUrl: 'https://managed.writer.example', apiKey: `key-id:${'66'.repeat(32)}`, mode: 'MANAGED_SITE' as const };

    await expect(service.connect(input, 'user-1')).rejects.toThrow('platform approval');
    expect(request).not.toHaveBeenCalled();

    const connection = await service.connect(input, 'admin-1', true);
    expect(connection).toMatchObject({ mode: 'MANAGED_SITE', eligibility: 'ALLOWED_MANAGED' });
  });

  it('validates replacement keys against the connected site identity', async () => {
    const request = jest.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ site: { uuid: 'site-1' } }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ site: { uuid: 'other-site' } }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ site: { uuid: 'site-1' } }) });
    const service = new GhostIntegrationService('test-encryption-key', request as unknown as typeof fetch);
    const connection = await service.connect({ creatorId: 'creator-1', adminUrl: 'https://writer.example', apiKey: `old-id:${'77'.repeat(32)}` });

    await expect(service.replaceKey(connection.connectionId, `wrong-id:${'88'.repeat(32)}`, 'user-1')).rejects.toThrow('different Ghost site');
    const replaced = await service.replaceKey(connection.connectionId, `new-id:${'99'.repeat(32)}`, 'user-1');

    expect(replaced).not.toHaveProperty('encryptedKey');
    expect(JSON.stringify(replaced)).not.toContain('99999999');
    expect(service.audit.at(-1)).toMatchObject({ action: 'key_replace', actorId: 'user-1' });
  });

  it('authenticates and deduplicates outgoing Ghost webhooks', async () => {
    const request = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ site: { uuid: 'site-1' } }) });
    const service = new GhostIntegrationService('test-encryption-key', request as unknown as typeof fetch);
    const connection = await service.connect({ creatorId: 'creator-1', adminUrl: 'https://writer.example', apiKey: `key-id:${'44'.repeat(32)}` });

    await expect(service.handleWebhook({ connectionId: connection.connectionId, secret: 'wrong', eventId: 'event-1' })).rejects.toThrow('authentication');
    const first = await service.handleWebhook({ connectionId: connection.connectionId, secret: connection.webhookSecret, eventId: 'event-1', remoteId: 'remote-1', type: 'post' });
    const duplicate = await service.handleWebhook({ connectionId: connection.connectionId, secret: connection.webhookSecret, eventId: 'event-1', remoteId: 'remote-1', type: 'post' });

    expect(first).toEqual({ accepted: true, duplicate: false, reconciled: 0 });
    expect(duplicate).toEqual({ accepted: true, duplicate: true });
    expect(service.listConnections('creator-1')[0]).toMatchObject({ lastWebhookAt: expect.any(String) });
    expect(service.listConnections('creator-1')[0]).not.toHaveProperty('webhookSecretHash');
  });

  it('requires explicit confirmation before any remote publish', async () => {
    const request = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ site: { uuid: 'site-1' } }) });
    const service = new GhostIntegrationService('test-encryption-key', request as unknown as typeof fetch);
    const connection = await service.connect({ creatorId: 'creator-1', adminUrl: 'https://writer.example', apiKey: `key-id:${'ef'.repeat(32)}` });
    const draft = service.createDraft({ connectionId: connection.connectionId, creatorId: 'creator-1', workId: 'work-1', type: 'post', title: 'Draft', lexical: renderGhostLexical([], 'https://ubeeq.example/work-1'), visibility: 'public', tags: [] });
    request.mockClear();
    await expect(service.publish(draft.publicationId, 'user-1', false)).rejects.toThrow('confirmation');
    expect(request).not.toHaveBeenCalled();
  });

  it('applies creator-approved tag and author mappings when publishing', async () => {
    const request = jest.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ site: { uuid: 'site-1' } }) })
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ posts: [{ id: 'remote-1' }] }) });
    const service = new GhostIntegrationService('test-encryption-key', request as unknown as typeof fetch);
    const connection = await service.connect({ creatorId: 'creator-1', adminUrl: 'https://writer.example', apiKey: `key-id:${'55'.repeat(32)}` });
    service.configure(connection.connectionId, { permittedTypes: ['post'], tagMappings: { Essay: 'Longform' }, authorMappings: { 'creator-1': 'ghost-author-1' } }, 'user-1');
    const draft = service.createDraft({ connectionId: connection.connectionId, creatorId: 'creator-1', workId: 'work-1', type: 'post', title: 'Mapped', lexical: renderGhostLexical([], 'https://ubeeq.example/work-1'), visibility: 'public', tags: ['Essay'] });

    await service.publish(draft.publicationId, 'user-1', true);

    const publishRequest = request.mock.calls[1][1] as RequestInit;
    expect(JSON.parse(String(publishRequest.body))).toMatchObject({ posts: [{ tags: [{ name: 'Longform' }], authors: [{ id: 'ghost-author-1' }] }] });
    expect(() => service.createDraft({ connectionId: connection.connectionId, creatorId: 'creator-1', workId: 'work-2', type: 'page', title: 'Disabled page', lexical: renderGhostLexical([], 'https://ubeeq.example/work-2'), visibility: 'public', tags: [] })).toThrow('not enabled');
  });

  it('rejects arbitrary Lexical payloads even when a client bypasses the renderer', async () => {
    const request = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ site: { uuid: 'site-1' } }) });
    const service = new GhostIntegrationService('test-encryption-key', request as unknown as typeof fetch);
    const connection = await service.connect({ creatorId: 'creator-1', adminUrl: 'https://writer.example', apiKey: `key-id:${'11'.repeat(32)}` });
    const base = { connectionId: connection.connectionId, creatorId: 'creator-1', workId: 'work-1', type: 'post' as const, title: 'Unsafe', visibility: 'public' as const, tags: [] };

    expect(() => service.createDraft({ ...base, lexical: JSON.stringify({ root: { type: 'root', children: [{ type: 'html', html: '<script>alert(1)</script>' }] } }) })).toThrow('Unsupported');
    expect(() => service.createDraft({ ...base, lexical: JSON.stringify({ root: { type: 'root', children: [{ type: 'image', src: 'javascript:alert(1)' }] } }) })).toThrow('safe HTTP');
  });

  it('keeps local publication data when reconciliation reports remote deletion', async () => {
    const request = jest.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ site: { uuid: 'site-1' } }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ posts: [{ id: 'remote-1', url: 'https://writer.example/post', updated_at: '2026-08-23T00:00:00Z' }] }) })
      .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) });
    const service = new GhostIntegrationService('test-encryption-key', request as unknown as typeof fetch);
    const connection = await service.connect({ creatorId: 'creator-1', adminUrl: 'https://writer.example', apiKey: `key-id:${'22'.repeat(32)}` });
    const draft = service.createDraft({ connectionId: connection.connectionId, creatorId: 'creator-1', workId: 'work-1', type: 'post', title: 'Canonical local title', lexical: renderGhostLexical([], 'https://ubeeq.example/work-1'), visibility: 'public', tags: [] });
    await service.publish(draft.publicationId, 'user-1', true);

    const reconciled = await service.reconcile(draft.publicationId, 'user-1');

    expect(reconciled.publication).toMatchObject({ status: 'missing', title: 'Canonical local title', workId: 'work-1' });
    expect(service.getPublication(draft.publicationId)).not.toBeUndefined();
  });

  it('shows field-level remote diffs and accepts remote content only after confirmation', async () => {
    const localLexical = renderGhostLexical([{ type: 'paragraph', text: 'Local copy' }], 'https://ubeeq.example/work-1');
    const remoteLexical = renderGhostLexical([{ type: 'paragraph', text: 'Remote copy' }], 'https://ubeeq.example/work-1');
    const request = jest.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ site: { uuid: 'site-1' } }) })
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ posts: [{ id: 'remote-1', updated_at: '2026-08-23T10:00:00Z' }] }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ posts: [{ id: 'remote-1', title: 'Remote title', lexical: remoteLexical, visibility: 'members', status: 'published', updated_at: '2026-08-23T11:00:00Z' }] }) });
    const service = new GhostIntegrationService('test-encryption-key', request as unknown as typeof fetch);
    const connection = await service.connect({ creatorId: 'creator-1', adminUrl: 'https://writer.example', apiKey: `key-id:${'12'.repeat(32)}` });
    const draft = service.createDraft({ connectionId: connection.connectionId, creatorId: 'creator-1', workId: 'work-1', type: 'post', title: 'Local title', lexical: localLexical, visibility: 'public', tags: [] });
    await service.publish(draft.publicationId, 'user-1', true);

    const reconciliation = await service.reconcile(draft.publicationId, 'user-1');
    expect(reconciliation.diff).toMatchObject({
      resolutionRequired: true,
      fields: expect.arrayContaining([
        { field: 'title', local: 'Local title', remote: 'Remote title' },
        { field: 'visibility', local: 'public', remote: 'members' }
      ])
    });
    expect(() => service.resolveConflict(draft.publicationId, 'accept_remote', 'user-1', false)).toThrow('confirmation');

    const resolved = service.resolveConflict(draft.publicationId, 'accept_remote', 'user-1', true);
    expect(resolved.publication).toMatchObject({ title: 'Remote title', lexical: remoteLexical, visibility: 'members', status: 'published', conflictResolution: 'accept_remote' });
    expect(service.diff(draft.publicationId)).toMatchObject({ changed: false, resolutionRequired: false, fields: [] });
  });

  it('creates a detached draft when resolving a conflict as a new Ghost post', async () => {
    const request = jest.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ site: { uuid: 'site-1' } }) })
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ posts: [{ id: 'remote-1', updated_at: '2026-08-23T10:00:00Z' }] }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ posts: [{ id: 'remote-1', title: 'Changed remotely', lexical: renderGhostLexical([], 'https://ubeeq.example/work-1'), status: 'published', updated_at: '2026-08-23T11:00:00Z' }] }) });
    const service = new GhostIntegrationService('test-encryption-key', request as unknown as typeof fetch);
    const connection = await service.connect({ creatorId: 'creator-1', adminUrl: 'https://writer.example', apiKey: `key-id:${'13'.repeat(32)}` });
    const draft = service.createDraft({ connectionId: connection.connectionId, creatorId: 'creator-1', workId: 'work-1', type: 'post', title: 'Local title', lexical: renderGhostLexical([], 'https://ubeeq.example/work-1'), visibility: 'public', tags: [] });
    await service.publish(draft.publicationId, 'user-1', true);
    await service.reconcile(draft.publicationId, 'user-1');

    const result = service.resolveConflict(draft.publicationId, 'create_new_post', 'user-1', true);
    expect(result.newPublication).toMatchObject({ status: 'draft', title: 'Local title', workId: 'work-1' });
    expect(result.newPublication?.publicationId).not.toBe(draft.publicationId);
    expect(result.newPublication?.remoteId).toBeUndefined();
    expect(service.getPublication(draft.publicationId)).toMatchObject({ remoteId: 'remote-1', conflictResolution: 'create_new_post' });
  });

  it('uploads approved image bytes once and reuses the checksum mapping', async () => {
    const request = jest.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ site: { uuid: 'site-1' } }) })
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ images: [{ url: 'https://writer.example/content/images/approved.png' }] }) });
    const service = new GhostIntegrationService('test-encryption-key', request as unknown as typeof fetch);
    const connection = await service.connect({ creatorId: 'creator-1', adminUrl: 'https://writer.example', apiKey: `key-id:${'33'.repeat(32)}` });
    const input = { connectionId: connection.connectionId, creatorId: 'creator-1', derivativeAssetId: 'derivative-1', bytes: Buffer.from('approved-image'), filename: 'approved.png', contentType: 'image/png' };

    const first = await service.uploadImage(input, 'user-1');
    const second = await service.uploadImage(input, 'user-1');

    expect(first).toEqual(second);
    expect(first).toMatchObject({ derivativeAssetId: 'derivative-1', ghostImageUrl: 'https://writer.example/content/images/approved.png' });
    expect(request).toHaveBeenCalledTimes(2);
    const uploadRequest = request.mock.calls[1][1] as RequestInit;
    expect(uploadRequest.body).toBeInstanceOf(FormData);
    expect(uploadRequest.headers).not.toHaveProperty('Content-Type');
  });

  it('publishes an uploaded feature derivative and per-Work canonical URL policy', async () => {
    const request = jest.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ site: { uuid: 'site-1' } }) })
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ images: [{ url: 'https://writer.example/content/images/feature.png' }] }) })
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ posts: [{ id: 'post-1' }] }) });
    const service = new GhostIntegrationService('test-encryption-key', request as unknown as typeof fetch);
    const connection = await service.connect({ creatorId: 'creator-1', adminUrl: 'https://writer.example', apiKey: `key-id:${'ab'.repeat(32)}` });
    await service.uploadImage({ connectionId: connection.connectionId, creatorId: 'creator-1', derivativeAssetId: 'feature-asset', bytes: Buffer.from('feature'), filename: 'feature.png', contentType: 'image/png', alt: 'Feature alt', caption: 'Feature caption' }, 'user-1');
    const draft = service.createDraft({ connectionId: connection.connectionId, creatorId: 'creator-1', workId: 'work-1', type: 'post', title: 'Feature', lexical: renderGhostLexical([], 'https://ubeeq.example/works/work-1'), visibility: 'public', tags: [], featureImageAssetId: 'feature-asset', canonicalUrlPolicy: 'ubeeq', canonicalUrl: 'https://ubeeq.example/works/work-1' });

    await service.publish(draft.publicationId, 'user-1', true);

    expect(JSON.parse(String(request.mock.calls[2][1]?.body))).toMatchObject({ posts: [{ feature_image: 'https://writer.example/content/images/feature.png', feature_image_alt: 'Feature alt', feature_image_caption: 'Feature caption', canonical_url: 'https://ubeeq.example/works/work-1' }] });
  });

  it('imports posts and pages as metadata-only staged references', async () => {
    const responses = [
      { site: { uuid: 'site-1' } },
      {
        posts: [{ id: 'post-1', title: 'Remote story', slug: 'remote-story', html: '<p>Remote</p>', visibility: 'members', status: 'published', url: 'https://writer.example/remote-story/', tags: [{ name: 'Essay' }], authors: [{ name: 'Creator' }] }],
        meta: { pagination: { next: null } }
      },
      { pages: [], meta: { pagination: { next: null } } }
    ];
    const request = jest.fn().mockImplementation(async () => ({ ok: true, status: 200, json: async () => responses.shift() }));
    const service = new GhostIntegrationService('test-encryption-key', request as unknown as typeof fetch);
    const connection = await service.connect({ creatorId: 'creator-1', adminUrl: 'https://writer.example', apiKey: `key-id:${'aa'.repeat(32)}` }, 'user-1');

    const result = await service.sync(connection.connectionId, 'user-1');

    expect(result).toMatchObject({ imported: 1, changed: 0, missing: 0 });
    expect(result.references[0]).toMatchObject({
      type: 'post',
      title: 'Remote story',
      sourceAvailability: 'metadata_only',
      mappingState: 'staged',
      syncState: 'in_sync',
      discoveryEnabled: false,
      visibility: 'members'
    });
    expect(result.references[0].notice).toContain('does not back up the original');
    expect(JSON.stringify(result.references[0])).not.toContain('<p>Remote</p>');
    expect(request).not.toHaveBeenCalledWith(expect.stringContaining('/members'), expect.anything());
  });

  it('marks remote changes and deletion without deleting a staged reference', async () => {
    const payloads: unknown[] = [
      { site: { uuid: 'site-1' } },
      { posts: [{ id: 'post-1', title: 'Version one', html: '<p>One</p>' }], meta: { pagination: {} } },
      { pages: [], meta: { pagination: {} } },
      { posts: [{ id: 'post-1', title: 'Version two', html: '<p>Two</p>' }], meta: { pagination: {} } },
      { pages: [], meta: { pagination: {} } },
      { posts: [], meta: { pagination: {} } },
      { pages: [], meta: { pagination: {} } }
    ];
    const request = jest.fn().mockImplementation(async () => ({ ok: true, status: 200, json: async () => payloads.shift() }));
    const service = new GhostIntegrationService('test-encryption-key', request as unknown as typeof fetch);
    const connection = await service.connect({ creatorId: 'creator-1', adminUrl: 'https://writer.example', apiKey: `key-id:${'bb'.repeat(32)}` });
    await service.sync(connection.connectionId, 'user-1');

    const changed = await service.sync(connection.connectionId, 'user-1');
    expect(changed).toMatchObject({ imported: 0, changed: 1, missing: 0 });
    expect(changed.references[0].syncState).toBe('remote_changed');

    const removed = await service.sync(connection.connectionId, 'user-1');
    expect(removed).toMatchObject({ imported: 0, changed: 0, missing: 1 });
    expect(removed.references).toHaveLength(1);
    expect(removed.references[0].syncState).toBe('missing');
  });

  it('retries transient read failures but never automatically retries publishes', async () => {
    const pauses: number[] = [];
    const responses = [
      { ok: true, status: 200, json: async () => ({ site: { uuid: 'site-1' } }) },
      { ok: false, status: 429, headers: { get: () => '0.01' }, json: async () => ({}) },
      { ok: true, status: 200, json: async () => ({ posts: [], meta: { pagination: {} } }) },
      { ok: true, status: 200, json: async () => ({ pages: [], meta: { pagination: {} } }) },
      { ok: false, status: 503, headers: { get: () => null }, json: async () => ({}) }
    ];
    const request = jest.fn().mockImplementation(async () => responses.shift());
    const service = new GhostIntegrationService('test-encryption-key', request as unknown as typeof fetch, async (milliseconds) => { pauses.push(milliseconds); });
    const connection = await service.connect({ creatorId: 'creator-1', adminUrl: 'https://writer.example', apiKey: `key-id:${'aa'.repeat(32)}` });
    await service.sync(connection.connectionId, 'user-1');
    expect(pauses).toEqual([10]);

    const draft = service.createDraft({ connectionId: connection.connectionId, creatorId: 'creator-1', workId: 'work-1', type: 'post', title: 'No duplicate', lexical: renderGhostLexical([], 'https://ubeeq.example/work-1'), visibility: 'public', tags: [] });
    await expect(service.publish(draft.publicationId, 'user-1', true)).rejects.toThrow('503');
    expect(request).toHaveBeenCalledTimes(5);
  });
});

describe('Ghost publication route eligibility', () => {
  it('blocks draft creation before mutation when a Work is ineligible', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.authUser = { userId: 'user-1', displayName: 'Creator', groups: ['Creators'] };
      next();
    });
    const service = new GhostIntegrationService('test-encryption-key', jest.fn() as unknown as typeof fetch);
    registerGhostRoutes(
      app,
      service,
      async () => true,
      async (workId, connectionId) => ({
        eligible: false, workId, creatorId: 'creator-1', connectionId,
        reasons: ['A safety hold blocks Ghost publishing'],
        checks: { workOwned: true, workPublishable: true, connectionHealthy: true, canonicalAssetReady: true, rendererSupported: true, safetyClear: false }
      }),
      async () => true,
      () => false
    );

    const response = await request(app)
      .post('/api/works/work-1/ghost/publications')
      .send({ creatorId: 'creator-1', connectionId: 'connection-1', type: 'post', title: 'Blocked', lexical: renderGhostLexical([], 'https://ubeeq.example/work-1'), visibility: 'public', tags: [] });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ message: 'Work is not eligible for Ghost publishing', eligibility: { reasons: ['A safety hold blocks Ghost publishing'] } });
  });
});

import { assignDataHome, opaqueRoutingId } from '../src/globalRouting';

describe('global data-home routing', () => {
  it('creates an opaque assignment and returns idempotently', async () => {
    const entry = { opaqueSpaceId: 'opaque', product: 'eversally' as const, homeRegion: 'eu-central-1' as const, status: 'ACTIVE' as const };
    const repository = { get: jest.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(entry), create: jest.fn().mockResolvedValue(entry) };
    await expect(assignDataHome({ subject: 'private-subject', product: 'eversally', label: 'EUROPE' }, repository)).resolves.toEqual(entry);
    await expect(assignDataHome({ subject: 'private-subject', product: 'eversally', label: 'EUROPE' }, repository)).resolves.toEqual(entry);
    expect(opaqueRoutingId('private-subject', 'eversally')).not.toContain('private-subject');
  });

  it('requires migration rather than silently changing a home', async () => {
    const repository = { get: jest.fn().mockResolvedValue({ opaqueSpaceId: 'x', product: 'eversally', homeRegion: 'us-east-2', status: 'ACTIVE' }), create: jest.fn() } as any;
    await expect(assignDataHome({ subject: 's', product: 'eversally', label: 'EUROPE' }, repository)).rejects.toThrow('migration workflow');
  });
});

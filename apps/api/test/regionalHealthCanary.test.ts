describe('regional health canary', () => {
  beforeEach(() => { jest.resetModules(); process.env.CELL_HEALTH_URL = 'https://cell.example/health'; process.env.DATA_HOME_REGION = 'eu-central-1'; });
  it('fails when the regional endpoint is unhealthy', async () => { global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 }) as any; const { handler } = await import('../src/regionalHealthCanary'); await expect(handler({} as any, {} as any, jest.fn())).rejects.toThrow('503'); });
});

import { loadConfig } from '../src/config';

const productionVariables = [
  'DEPLOYMENT_STAGE',
  'COGNITO_USER_POOL_ID',
  'COGNITO_CLIENT_ID',
  'CONTENT_CORE_TABLE',
  'COMMERCIAL_BILLING_TABLE',
  'USE_CONTENT_CORE_TABLE',
  'MEDIA_BUCKET',
  'APP_ORIGIN',
  'EXTERNAL_TOKEN_ENCRYPTION_KEY',
  'UNLOCK_JWT_SECRET',
  'LOCAL_AUTH_USER_ID',
  'EXTERNAL_SCHEDULED_SCANS_ENABLED',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET'
];

describe('production API configuration', () => {
  const originalValues = new Map<string, string | undefined>();

  beforeAll(() => productionVariables.forEach((name) => originalValues.set(name, process.env[name])));
  beforeEach(() => productionVariables.forEach((name) => delete process.env[name]));
  afterAll(() => productionVariables.forEach((name) => {
    const original = originalValues.get(name);
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }));

  it('keeps local development defaults available', () => {
    expect(loadConfig()).toMatchObject({
      deploymentStage: 'development',
      unlockJwtSecret: 'dev-secret',
      deviantArtMinimumRequestIntervalMs: 2_000,
      externalScheduledScansEnabled: false,
      flickrMinimumRequestIntervalMs: 1_000
    });
  });

  it('requires Stripe API and webhook secrets as a pair', () => { process.env.STRIPE_SECRET_KEY = 'sk_test'; expect(() => loadConfig()).toThrow('configured together'); process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test'; expect(loadConfig()).toMatchObject({ stripeSecretKey: 'sk_test', stripeWebhookSecret: 'whsec_test' }); });

  it('rejects incomplete or insecure production configuration', () => {
    process.env.DEPLOYMENT_STAGE = 'production';
    expect(() => loadConfig()).toThrow('Production API configuration is incomplete');
    Object.assign(process.env, {
      COGNITO_USER_POOL_ID: 'pool',
      COGNITO_CLIENT_ID: 'client',
      CONTENT_CORE_TABLE: 'content-core',
      COMMERCIAL_BILLING_TABLE: 'commercial-billing',
      USE_CONTENT_CORE_TABLE: 'true',
      MEDIA_BUCKET: 'media',
      APP_ORIGIN: 'http://eversally.test',
      EXTERNAL_TOKEN_ENCRYPTION_KEY: 'external-key',
      UNLOCK_JWT_SECRET: 'unlock-key'
    });
    expect(() => loadConfig()).toThrow('APP_ORIGIN must use HTTPS');
    process.env.APP_ORIGIN = 'https://eversally.test';
    process.env.LOCAL_AUTH_USER_ID = 'local-user';
    expect(() => loadConfig()).toThrow('LOCAL_AUTH_USER_ID');
    delete process.env.LOCAL_AUTH_USER_ID;
    expect(loadConfig()).toMatchObject({ deploymentStage: 'production', appOrigin: 'https://eversally.test', externalScheduledScansEnabled: true });
    process.env.EXTERNAL_SCHEDULED_SCANS_ENABLED = 'false';
    expect(loadConfig().externalScheduledScansEnabled).toBe(false);
  });
});

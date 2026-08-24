import { instagramDeploymentStatus, createManagedInstagramProvider } from '../src/instagramConfiguration';
import { loadConfig } from '../src/config';

describe('Instagram deployment gate', () => {
  const original = process.env;
  afterEach(() => { process.env = original; });
  it('keeps creator onboarding disabled until configuration and App Review are complete', () => {
    process.env = { ...original, INSTAGRAM_APP_ID: 'app', INSTAGRAM_APP_SECRET: 'secret', INSTAGRAM_OAUTH_REDIRECT_URI: 'https://example.test/callback', INSTAGRAM_DELIVERY_SECRET: 'delivery', INSTAGRAM_DELIVERY_BASE_URL: 'https://media.example.test' };
    const config = loadConfig();
    expect(instagramDeploymentStatus(config).state).toBe('APP_REVIEW_REQUIRED');
    expect(createManagedInstagramProvider(config)).toBeUndefined();
  });
  it('enables only the controlled image/carousel pilot after review', async () => {
    process.env = { ...original, INSTAGRAM_APP_ID: 'app', INSTAGRAM_APP_SECRET: 'secret', INSTAGRAM_OAUTH_REDIRECT_URI: 'https://example.test/callback', INSTAGRAM_DELIVERY_SECRET: 'delivery', INSTAGRAM_DELIVERY_BASE_URL: 'https://media.example.test', INSTAGRAM_APP_REVIEW_COMPLETE: 'true' };
    const config = loadConfig();
    expect(instagramDeploymentStatus(config)).toMatchObject({ state: 'READY', onboardingEnabled: true });
    expect(createManagedInstagramProvider(config)).toBeDefined();
  });
});

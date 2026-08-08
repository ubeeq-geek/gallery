import { profileDisclosurePolicy } from '../src/disclosures';
import type { UserProfile } from '../src/domain';

const profile = (overrides: Partial<UserProfile> = {}): UserProfile => ({
  userId: 'viewer-1',
  username: 'viewer-one',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides
});

describe('profileDisclosurePolicy', () => {
  it('hides all heavy topics when a viewer has no saved preference', () => {
    expect(profileDisclosurePolicy(profile())).toMatchObject({
      hideHeavyTopics: true,
      hidePoliticsPublicAffairs: true,
      hideCrimeDisastersTragedy: true
    });
  });

  it('preserves an explicit preference to show heavy topics', () => {
    expect(profileDisclosurePolicy(profile({
      hideHeavyTopics: false,
      hidePoliticsPublicAffairs: false,
      hideCrimeDisastersTragedy: false
    }))).toMatchObject({
      hideHeavyTopics: false,
      hidePoliticsPublicAffairs: false,
      hideCrimeDisastersTragedy: false
    });
  });
});

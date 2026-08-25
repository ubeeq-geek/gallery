import { BillingScope } from '../src/billing';
import { ProcessingCreditNotifier } from '../src/billingNotifications';

const scope: BillingScope = { product: 'EVERSALLY', environment: 'test', spaceId: 'space-1', dataHomeRegion: 'ca-central-1' };

describe('processing credit notifications', () => {
  test('creates in-app and preference-aware email notices at 80% and 100% consumption', () => {
    const notifier = new ProcessingCreditNotifier();
    expect(notifier.evaluate(scope, { previousAvailable: 21, currentAvailable: 19, referenceCredits: 100, notificationCycleId: 'period-1', emailPreference: true, observedAt: '2026-08-25T00:00:00.000Z' })).toMatchObject([{ threshold: 80, availableCredits: 19, consumedCredits: 81, inApp: true, emailRequested: true }]);
    expect(notifier.evaluate(scope, { previousAvailable: 1, currentAvailable: 0, referenceCredits: 100, notificationCycleId: 'period-1', emailPreference: false, observedAt: '2026-08-26T00:00:00.000Z' })).toMatchObject([{ threshold: 100, inApp: true, emailRequested: false }]);
    expect(notifier.list(scope).map(item => item.threshold)).toEqual([80, 100]);
  });

  test('is idempotent for a repeated threshold crossing and isolated by Space', () => {
    const notifier = new ProcessingCreditNotifier();
    const input = { previousAvailable: 25, currentAvailable: 20, referenceCredits: 100, notificationCycleId: 'period-1', emailPreference: true, observedAt: '2026-08-25T00:00:00.000Z' };
    const first = notifier.evaluate(scope, input);
    expect(notifier.evaluate(scope, input)).toEqual(first);
    expect(notifier.list({ ...scope, spaceId: 'other' })).toEqual([]);
  });

  test('does not notify when no threshold is crossed', () => {
    expect(new ProcessingCreditNotifier().evaluate(scope, { previousAvailable: 100, currentAvailable: 50, referenceCredits: 100, notificationCycleId: 'period-1', emailPreference: true, observedAt: '2026-08-25T00:00:00.000Z' })).toEqual([]);
  });
});

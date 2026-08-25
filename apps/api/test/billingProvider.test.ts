import { AuthoritativeSubscription, BillingLedger, BillingScope, PaymentAdapter, PlanVersion, VerifiedProviderEvent } from '../src/billing';
import { InMemoryProviderEventStore, ProviderWebhookProcessor } from '../src/billingProvider';

const scope: BillingScope = { product: 'EVERSALLY', environment: 'test', spaceId: 'space-1', dataHomeRegion: 'ca-central-1' };
const plan: PlanVersion = { ...scope, planVersionId: 'es-creator-v1', code: 'creator', version: 1, priceMinor: 1600, currency: 'USD', period: 'MONTH', storageBytes: 150, deliveryBytes: 35, processingCredits: 1500, transcodeMinutes: 0, features: {}, effectiveFrom: '2026-01-01T00:00:00.000Z' };
const subscription: AuthoritativeSubscription = { subscriptionId: 'sub-1', customerId: 'cus-1', priceId: 'price-creator', status: 'ACTIVE', currency: 'USD', interval: 'MONTH', livemode: false, periodStart: '2026-08-01T00:00:00.000Z', periodEnd: '2026-09-01T00:00:00.000Z' };

const adapter = (event: VerifiedProviderEvent, state = subscription): PaymentAdapter => ({
  createCheckout: jest.fn(), createCustomerPortal: jest.fn(), requestCancel: jest.fn(), createOneTimeCreditCheckout: jest.fn(),
  parseAndVerifyWebhook: jest.fn().mockResolvedValue(event),
  fetchAuthoritativeSubscription: jest.fn().mockResolvedValue(state)
});

describe('provider webhook processing', () => {
  test('activates only from a verified event plus matching authoritative state and deduplicates replay', async () => {
    const stripe = adapter({ eventId: 'evt-1', subscriptionId: 'sub-1', occurredAt: '2026-08-01T00:00:00.000Z' });
    const store = new InMemoryProviderEventStore();
    const processor = new ProviderWebhookProcessor(new BillingLedger(), store, { STRIPE: stripe, PAYPAL: stripe }, [{ provider: 'STRIPE', externalPriceId: 'price-creator', plan, livemode: false }], 'account-1');
    const first = await processor.process('STRIPE', {}, Buffer.from('{}'));
    const replay = await processor.process('STRIPE', {}, Buffer.from('{}'));
    expect(first.record.state).toBe('APPLIED');
    expect(first.entitlement).toMatchObject({ source: 'PROVIDER', planVersionId: plan.planVersionId, providerEventId: 'evt-1' });
    expect(replay.record.state).toBe('APPLIED');
    expect(stripe.fetchAuthoritativeSubscription).toHaveBeenCalledTimes(1);
  });

  test('does not activate pending payments and sends mapping mismatches to review', async () => {
    const pending = adapter({ eventId: 'evt-pending', subscriptionId: 'sub-1', occurredAt: '2026-08-01T00:00:00.000Z' }, { ...subscription, status: 'PENDING' });
    const mismatch = adapter({ eventId: 'evt-wrong', subscriptionId: 'sub-1', occurredAt: '2026-08-01T00:00:00.000Z' }, { ...subscription, currency: 'CAD' });
    const store = new InMemoryProviderEventStore();
    const processor = new ProviderWebhookProcessor(new BillingLedger(), store, { STRIPE: pending, PAYPAL: mismatch }, [
      { provider: 'STRIPE', externalPriceId: 'price-creator', plan, livemode: false },
      { provider: 'PAYPAL', externalPriceId: 'price-creator', plan, livemode: false }
    ], 'account-1');
    expect((await processor.process('STRIPE', {}, Buffer.from('{}'))).record).toMatchObject({ state: 'IGNORED', detail: 'Payment pending' });
    expect((await processor.process('PAYPAL', {}, Buffer.from('{}'))).record.state).toBe('REVIEW');
    expect(store.reviewTasks).toHaveLength(1);
  });

  test('rejects invalid signatures before creating an inbox record', async () => {
    const invalid = adapter({ eventId: 'unused', subscriptionId: 'sub-1', occurredAt: '2026-08-01T00:00:00.000Z' });
    (invalid.parseAndVerifyWebhook as jest.Mock).mockRejectedValue(new Error('invalid signature'));
    const store = new InMemoryProviderEventStore();
    const processor = new ProviderWebhookProcessor(new BillingLedger(), store, { STRIPE: invalid, PAYPAL: invalid }, [], 'account-1');
    await expect(processor.process('STRIPE', {}, Buffer.from('{}'))).rejects.toThrow('invalid signature');
    expect(store.reviewTasks).toHaveLength(0);
  });
});

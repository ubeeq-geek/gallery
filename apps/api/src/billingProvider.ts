import { AuthoritativeSubscription, BillingLedger, PaymentAdapter, PlanVersion, ServiceEntitlement } from './billing';

export type BillingProvider = 'STRIPE' | 'PAYPAL';

export interface ProviderPlanMapping {
  provider: BillingProvider;
  externalPriceId: string;
  plan: PlanVersion;
  livemode: boolean;
}

export interface ProviderInboxRecord {
  provider: BillingProvider;
  eventId: string;
  subscriptionId: string;
  occurredAt: string;
  receivedAt: string;
  state: 'RECEIVED' | 'APPLIED' | 'IGNORED' | 'REVIEW';
  detail?: string;
}

export interface BillingReviewTask {
  provider: BillingProvider;
  eventId: string;
  subscriptionId: string;
  reason: string;
  createdAt: string;
}

/** Durable-store shape. Production implementations must transact inbox insertion and entitlement application. */
export interface ProviderEventStore {
  get(provider: BillingProvider, eventId: string): ProviderInboxRecord | undefined;
  put(record: ProviderInboxRecord): void;
  update(record: ProviderInboxRecord): void;
  addReviewTask(task: BillingReviewTask): void;
}

export class InMemoryProviderEventStore implements ProviderEventStore {
  private readonly records = new Map<string, ProviderInboxRecord>();
  readonly reviewTasks: BillingReviewTask[] = [];
  get(provider: BillingProvider, eventId: string): ProviderInboxRecord | undefined { return this.records.get(`${provider}|${eventId}`); }
  put(record: ProviderInboxRecord): void {
    const key = `${record.provider}|${record.eventId}`;
    if (this.records.has(key)) throw new Error('Duplicate provider event');
    this.records.set(key, { ...record });
  }
  update(record: ProviderInboxRecord): void { this.records.set(`${record.provider}|${record.eventId}`, { ...record }); }
  addReviewTask(task: BillingReviewTask): void { this.reviewTasks.push({ ...task }); }
}

export type ProviderEventResult = { record: ProviderInboxRecord; entitlement?: ServiceEntitlement };

export class ProviderWebhookProcessor {
  constructor(
    private readonly ledger: BillingLedger,
    private readonly store: ProviderEventStore,
    private readonly adapters: Readonly<Record<BillingProvider, PaymentAdapter>>,
    private readonly mappings: readonly ProviderPlanMapping[],
    private readonly billingAccountId: string,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  async process(provider: BillingProvider, headers: Record<string, string>, body: Buffer): Promise<ProviderEventResult> {
    // The adapter must reject before returning when signature verification fails.
    const verified = await this.adapters[provider].parseAndVerifyWebhook(headers, body);
    const duplicate = this.store.get(provider, verified.eventId);
    if (duplicate) return { record: duplicate };
    const record: ProviderInboxRecord = { provider, ...verified, receivedAt: this.now(), state: 'RECEIVED' };
    this.store.put(record);

    let authoritative: AuthoritativeSubscription;
    try {
      authoritative = await this.adapters[provider].fetchAuthoritativeSubscription(verified.subscriptionId);
    } catch (error) {
      return this.review(record, `Authoritative subscription fetch failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
    if (authoritative.subscriptionId !== verified.subscriptionId) return this.review(record, 'Subscription identity mismatch');

    const mapping = this.mappings.find(candidate => candidate.provider === provider && candidate.externalPriceId === authoritative.priceId);
    if (!mapping) return this.review(record, 'No immutable plan mapping for provider price');
    const expectedCurrency = mapping.plan.currency.toUpperCase();
    if (mapping.plan.product !== 'EVERSALLY' || authoritative.currency.toUpperCase() !== expectedCurrency || authoritative.interval !== mapping.plan.period || authoritative.livemode !== mapping.livemode) {
      return this.review(record, 'Provider product, currency, interval, or livemode mismatch');
    }
    if (authoritative.status === 'PENDING') return this.finish(record, 'IGNORED', 'Payment pending');
    if (authoritative.status !== 'ACTIVE' && authoritative.status !== 'PAID') return this.finish(record, 'IGNORED', `No paid activation for ${authoritative.status}`);
    if (authoritative.periodEnd <= authoritative.periodStart) return this.review(record, 'Invalid authoritative entitlement period');

    const entitlement = this.ledger.recordVerifiedProviderEntitlement(mapping.plan, {
      billingAccountId: this.billingAccountId,
      periodStart: authoritative.periodStart,
      periodEnd: authoritative.periodEnd,
      providerEventId: verified.eventId
    });
    return { record: this.finish(record, 'APPLIED').record, entitlement };
  }

  private finish(record: ProviderInboxRecord, state: ProviderInboxRecord['state'], detail?: string): ProviderEventResult {
    const next = { ...record, state, detail };
    this.store.update(next);
    return { record: next };
  }

  private review(record: ProviderInboxRecord, reason: string): ProviderEventResult {
    this.store.addReviewTask({ provider: record.provider, eventId: record.eventId, subscriptionId: record.subscriptionId, reason, createdAt: this.now() });
    return this.finish(record, 'REVIEW', reason);
  }
}

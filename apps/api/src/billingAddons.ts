import { randomUUID } from 'crypto';
import { BillingLedger, BillingScope, PaymentAdapter, ProcessingCreditLot } from './billing';

export interface CreditProductVersion {
  creditProductVersionId: string; product: 'EVERSALLY' | 'NIGHTFRAME'; credits: number;
  priceMinor: number; currency: string; effectiveFrom: string; effectiveTo?: string; enabled: boolean;
}
export interface CreditOrder {
  orderId: string; scope: BillingScope; billingAccountId: string; provider: string;
  productSnapshot: Readonly<CreditProductVersion>; status: 'PENDING' | 'PAID' | 'REFUND_REVIEW' | 'REFUNDED' | 'CHARGEBACK_REVIEW'; createdAt: string;
  providerPaymentId?: string; lotId?: string;
}
export interface VerifiedCreditPaymentEvent { eventId: string; paymentId: string; orderId: string; occurredAt: string }
export interface AuthoritativeCreditPayment {
  paymentId: string; orderId: string; status: 'PAID' | 'PENDING' | 'FAILED' | 'REFUNDED' | 'CHARGEBACK';
  amountMinor: number; currency: string; creditProductVersionId: string;
}
export interface CreditPaymentAdapter {
  parseAndVerifyCreditWebhook(headers: Record<string, string>, body: Buffer): Promise<VerifiedCreditPaymentEvent>;
  fetchAuthoritativeCreditPayment(paymentId: string): Promise<AuthoritativeCreditPayment>;
}
export interface CreditPaymentInboxRecord extends VerifiedCreditPaymentEvent { provider: string; receivedAt: string; state: 'RECEIVED' | 'APPLIED' | 'IGNORED' | 'REVIEW'; detail?: string }
export interface CreditPaymentReview { provider: string; eventId: string; orderId: string; paymentId: string; reason: string; createdAt: string }
export interface CreditPaymentEventStore {
  get(provider: string, eventId: string): CreditPaymentInboxRecord | undefined; put(record: CreditPaymentInboxRecord): void;
  update(record: CreditPaymentInboxRecord): void; addReview(review: CreditPaymentReview): void;
}

export class InMemoryCreditPaymentEventStore implements CreditPaymentEventStore {
  private readonly records = new Map<string, CreditPaymentInboxRecord>();
  readonly reviews: CreditPaymentReview[] = [];
  get(provider: string, eventId: string): CreditPaymentInboxRecord | undefined { const value = this.records.get(`${provider}|${eventId}`); return value && structuredClone(value); }
  put(record: CreditPaymentInboxRecord): void { const key = `${record.provider}|${record.eventId}`; if (this.records.has(key)) throw new Error('Duplicate credit payment event'); this.records.set(key, structuredClone(record)); }
  update(record: CreditPaymentInboxRecord): void { this.records.set(`${record.provider}|${record.eventId}`, structuredClone(record)); }
  addReview(review: CreditPaymentReview): void { this.reviews.push(structuredClone(review)); }
}

/** Configuration-driven add-on ordering; browser returns never grant credits. */
export class CreditAddonService {
  private readonly orders = new Map<string, CreditOrder>();
  private readonly payments = new Map<string, string>();
  constructor(private readonly ledger: BillingLedger, private readonly catalogue: readonly CreditProductVersion[], private readonly now: () => string = () => new Date().toISOString()) {}

  async createCheckout(scope: BillingScope, input: { billingAccountId: string; creditProductVersionId: string; provider: string; adapter: PaymentAdapter; returnUrls: { success: string; cancel: string }; freePlan: boolean }): Promise<{ order: CreditOrder; redirectUrl: string }> {
    if (scope.product !== 'EVERSALLY') throw new Error('Self-serve credit checkout is Eversally-only at launch');
    if (input.freePlan) throw new Error('Free plans cannot purchase processing credits');
    const product = this.catalogue.find(item => item.product === scope.product && item.creditProductVersionId === input.creditProductVersionId);
    const now = this.now();
    if (!product || !product.enabled || product.effectiveFrom > now || (product.effectiveTo && product.effectiveTo <= now)) throw new Error('Credit product is not available');
    const order: CreditOrder = { orderId: randomUUID(), scope: structuredClone(scope), billingAccountId: input.billingAccountId, provider: input.provider, productSnapshot: Object.freeze(structuredClone(product)), status: 'PENDING', createdAt: now };
    this.orders.set(order.orderId, order);
    const result = await input.adapter.createOneTimeCreditCheckout(input.billingAccountId, product.creditProductVersionId, input.returnUrls);
    return { order: structuredClone(order), redirectUrl: result.redirectUrl };
  }

  recordVerifiedPayment(orderId: string, providerPaymentId: string, paidAt: string): ProcessingCreditLot {
    const order = this.orders.get(orderId); if (!order) throw new Error('Unknown credit order');
    const assigned = this.payments.get(`${order.provider}|${providerPaymentId}`);
    if (assigned && assigned !== orderId) throw new Error('Payment is assigned to another order');
    if (order.status === 'PAID' && order.lotId) return this.ledger.grantCredits(order.scope, { quantity: order.productSnapshot.credits, source: 'ES_TOP_UP', grantedAt: paidAt, idempotencyKey: `credit-payment:${order.provider}:${providerPaymentId}`, documentId: order.orderId });
    const lot = this.ledger.grantCredits(order.scope, { quantity: order.productSnapshot.credits, source: 'ES_TOP_UP', grantedAt: paidAt, idempotencyKey: `credit-payment:${order.provider}:${providerPaymentId}`, documentId: order.orderId });
    order.status = 'PAID'; order.providerPaymentId = providerPaymentId; order.lotId = lot.lotId;
    this.payments.set(`${order.provider}|${providerPaymentId}`, orderId); return lot;
  }

  getOrder(orderId: string): CreditOrder | undefined { const order = this.orders.get(orderId); return order && structuredClone(order); }

  requestFullRefund(orderId: string, observedAt: string): CreditOrder {
    const order = this.requirePaidOrder(orderId); const lot = this.orderLot(order);
    if (lot.remainingQuantity !== lot.originalQuantity || lot.reservedQuantity) { order.status = 'REFUND_REVIEW'; return structuredClone(order); }
    this.ledger.reverseCreditGrant(order.scope, order.orderId, observedAt, `refund:${order.orderId}`);
    order.status = 'REFUNDED'; return structuredClone(order);
  }

  recordChargeback(orderId: string): CreditOrder {
    const order = this.requirePaidOrder(orderId); const lot = this.orderLot(order);
    if (lot.remainingQuantity > 0 && !lot.reservedQuantity) this.ledger.freezeCreditLot(order.scope, lot.lotId);
    order.status = 'CHARGEBACK_REVIEW'; return structuredClone(order);
  }

  private requirePaidOrder(orderId: string): CreditOrder { const order = this.orders.get(orderId); if (!order || !order.lotId) throw new Error('Paid credit order not found'); return order; }
  private orderLot(order: CreditOrder): ProcessingCreditLot { const lot = this.ledger.listCreditLots(order.scope).find(item => item.lotId === order.lotId); if (!lot) throw new Error('Purchased credit lot not found'); return lot; }
}

/** Durable-inbox trust boundary: verified webhook plus authoritative payment facts are required. */
export class CreditPaymentWebhookProcessor {
  constructor(private readonly addons: CreditAddonService, private readonly store: CreditPaymentEventStore, private readonly adapters: Readonly<Record<string, CreditPaymentAdapter>>, private readonly now: () => string = () => new Date().toISOString()) {}
  async process(provider: string, headers: Record<string, string>, body: Buffer): Promise<CreditPaymentInboxRecord> {
    const adapter = this.adapters[provider]; if (!adapter) throw new Error('Credit payment provider is not configured');
    const verified = await adapter.parseAndVerifyCreditWebhook(headers, body);
    const duplicate = this.store.get(provider, verified.eventId); if (duplicate) return duplicate;
    const record: CreditPaymentInboxRecord = { provider, ...verified, receivedAt: this.now(), state: 'RECEIVED' }; this.store.put(record);
    let payment: AuthoritativeCreditPayment;
    try { payment = await adapter.fetchAuthoritativeCreditPayment(verified.paymentId); }
    catch (error) { return this.review(record, `Authoritative payment fetch failed: ${error instanceof Error ? error.message : 'unknown error'}`); }
    if (payment.paymentId !== verified.paymentId || payment.orderId !== verified.orderId) return this.review(record, 'Payment or order identity mismatch');
    const order = this.addons.getOrder(verified.orderId); if (!order) return this.review(record, 'Credit order not found');
    if (order.provider !== provider) return this.review(record, 'Credit order provider mismatch');
    if (payment.amountMinor !== order.productSnapshot.priceMinor || payment.currency.toUpperCase() !== order.productSnapshot.currency.toUpperCase() || payment.creditProductVersionId !== order.productSnapshot.creditProductVersionId) return this.review(record, 'Credit product, amount, or currency mismatch');
    if (payment.status === 'PENDING') return this.finish(record, 'IGNORED', 'Payment pending');
    if (payment.status !== 'PAID') return this.review(record, `Payment is ${payment.status}`);
    this.addons.recordVerifiedPayment(order.orderId, payment.paymentId, verified.occurredAt);
    return this.finish(record, 'APPLIED');
  }
  private finish(record: CreditPaymentInboxRecord, state: CreditPaymentInboxRecord['state'], detail?: string): CreditPaymentInboxRecord { const next = { ...record, state, detail }; this.store.update(next); return next; }
  private review(record: CreditPaymentInboxRecord, reason: string): CreditPaymentInboxRecord { this.store.addReview({ provider: record.provider, eventId: record.eventId, orderId: record.orderId, paymentId: record.paymentId, reason, createdAt: this.now() }); return this.finish(record, 'REVIEW', reason); }
}

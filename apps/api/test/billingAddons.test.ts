import { BillingLedger, BillingScope, PaymentAdapter } from '../src/billing';
import { AuthoritativeCreditPayment, CreditAddonService, CreditPaymentAdapter, CreditPaymentWebhookProcessor, CreditProductVersion, InMemoryCreditPaymentEventStore } from '../src/billingAddons';

const scope: BillingScope = { product: 'EVERSALLY', environment: 'test', spaceId: 'space-1', dataHomeRegion: 'ca-central-1' };
const product: CreditProductVersion = { creditProductVersionId: 'pack-500-v1', product: 'EVERSALLY', credits: 500, priceMinor: 300, currency: 'USD', effectiveFrom: '2026-01-01T00:00:00.000Z', enabled: true };
const checkoutAdapter = { createOneTimeCreditCheckout: jest.fn(async () => ({ redirectUrl: 'https://checkout.example' })) } as unknown as PaymentAdapter;

describe('processing-credit add-on payments', () => {
  test('grants exactly one purchase lot after a verified, authoritative paid webhook', async () => {
    const ledger = new BillingLedger(); const addons = new CreditAddonService(ledger, [product], () => '2026-08-25T00:00:00.000Z');
    const { order } = await addons.createCheckout(scope, { billingAccountId: 'payer', creditProductVersionId: product.creditProductVersionId, provider: 'STRIPE', adapter: checkoutAdapter, returnUrls: { success: 'ok', cancel: 'cancel' }, freePlan: false });
    const authoritative: AuthoritativeCreditPayment = { paymentId: 'payment-1', orderId: order.orderId, status: 'PAID', amountMinor: 300, currency: 'USD', creditProductVersionId: product.creditProductVersionId };
    const adapter: CreditPaymentAdapter = { parseAndVerifyCreditWebhook: jest.fn(async () => ({ eventId: 'event-1', paymentId: 'payment-1', orderId: order.orderId, occurredAt: '2026-08-25T01:00:00.000Z' })), fetchAuthoritativeCreditPayment: jest.fn(async () => authoritative) };
    const store = new InMemoryCreditPaymentEventStore(); const processor = new CreditPaymentWebhookProcessor(addons, store, { STRIPE: adapter });
    expect(await processor.process('STRIPE', {}, Buffer.from('{}'))).toMatchObject({ state: 'APPLIED' });
    expect(await processor.process('STRIPE', {}, Buffer.from('{}'))).toMatchObject({ state: 'APPLIED' });
    expect(ledger.balance(scope, undefined, '2026-08-25T02:00:00.000Z').availableProcessingCredits).toBe(500);
    expect(ledger.listEvents(scope).filter(event => event.category === 'PROCESSING_CREDITS_GRANTED')).toHaveLength(1);
  });

  test('does not grant from browser checkout, pending payment, or mismatched price facts', async () => {
    const ledger = new BillingLedger(); const addons = new CreditAddonService(ledger, [product], () => '2026-08-25T00:00:00.000Z');
    const { order } = await addons.createCheckout(scope, { billingAccountId: 'payer', creditProductVersionId: product.creditProductVersionId, provider: 'PAYPAL', adapter: checkoutAdapter, returnUrls: { success: 'ok', cancel: 'cancel' }, freePlan: false });
    expect(ledger.balance(scope).availableProcessingCredits).toBe(0);
    const payment: AuthoritativeCreditPayment = { paymentId: 'payment-2', orderId: order.orderId, status: 'PENDING', amountMinor: 300, currency: 'USD', creditProductVersionId: product.creditProductVersionId };
    const adapter: CreditPaymentAdapter = { parseAndVerifyCreditWebhook: jest.fn(async () => ({ eventId: 'event-pending', paymentId: payment.paymentId, orderId: order.orderId, occurredAt: '2026-08-25T01:00:00.000Z' })), fetchAuthoritativeCreditPayment: jest.fn(async () => payment) };
    const store = new InMemoryCreditPaymentEventStore(); const processor = new CreditPaymentWebhookProcessor(addons, store, { PAYPAL: adapter });
    expect(await processor.process('PAYPAL', {}, Buffer.from('{}'))).toMatchObject({ state: 'IGNORED', detail: 'Payment pending' });
    expect(ledger.balance(scope).availableProcessingCredits).toBe(0);

    payment.status = 'PAID'; payment.amountMinor = 301;
    (adapter.parseAndVerifyCreditWebhook as jest.Mock).mockResolvedValue({ eventId: 'event-mismatch', paymentId: payment.paymentId, orderId: order.orderId, occurredAt: '2026-08-25T02:00:00.000Z' });
    expect(await processor.process('PAYPAL', {}, Buffer.from('{}'))).toMatchObject({ state: 'REVIEW', detail: 'Credit product, amount, or currency mismatch' });
    expect(store.reviews).toHaveLength(1); expect(ledger.balance(scope).availableProcessingCredits).toBe(0);
  });

  test('rejects free and Nightframe self-serve purchases', async () => {
    const addons = new CreditAddonService(new BillingLedger(), [product]);
    await expect(addons.createCheckout(scope, { billingAccountId: 'payer', creditProductVersionId: product.creditProductVersionId, provider: 'STRIPE', adapter: checkoutAdapter, returnUrls: { success: 'ok', cancel: 'cancel' }, freePlan: true })).rejects.toThrow('Free plans');
    await expect(addons.createCheckout({ ...scope, product: 'NIGHTFRAME' }, { billingAccountId: 'payer', creditProductVersionId: 'nf-pack', provider: 'NONE', adapter: checkoutAdapter, returnUrls: { success: 'ok', cancel: 'cancel' }, freePlan: false })).rejects.toThrow('Eversally-only');
  });

  test('refunds only unused packs and freezes unspent chargeback credits for review', async () => {
    const ledger = new BillingLedger(); const addons = new CreditAddonService(ledger, [product], () => '2026-08-25T00:00:00.000Z');
    const paidOrder = async (paymentId: string) => {
      const { order } = await addons.createCheckout(scope, { billingAccountId: 'payer', creditProductVersionId: product.creditProductVersionId, provider: 'STRIPE', adapter: checkoutAdapter, returnUrls: { success: 'ok', cancel: 'cancel' }, freePlan: false });
      addons.recordVerifiedPayment(order.orderId, paymentId, '2026-08-25T01:00:00.000Z'); return order;
    };
    const unused = await paidOrder('unused-payment');
    expect(addons.requestFullRefund(unused.orderId, '2026-08-25T02:00:00.000Z').status).toBe('REFUNDED');
    expect(ledger.listCreditLots(scope).find(lot => lot.documentId === unused.orderId)).toMatchObject({ status: 'REVOKED', remainingQuantity: 0 });

    const used = await paidOrder('used-payment');
    ledger.reserveProcessing(scope, { reservationId: 'job', quantity: 1, observedAt: '2026-08-25T02:00:00.000Z' });
    ledger.finalizeProcessing(scope, 'job', 'COMMIT', '2026-08-25T02:01:00.000Z');
    expect(addons.requestFullRefund(used.orderId, '2026-08-25T03:00:00.000Z').status).toBe('REFUND_REVIEW');
    expect(addons.recordChargeback(used.orderId).status).toBe('CHARGEBACK_REVIEW');
    expect(ledger.listCreditLots(scope).find(lot => lot.documentId === used.orderId)?.status).toBe('FROZEN');
    expect(ledger.balance(scope).availableProcessingCredits).toBe(0);
  });
});

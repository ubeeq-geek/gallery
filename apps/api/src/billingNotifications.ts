import { randomUUID } from 'crypto';
import { BillingScope } from './billing';

export interface ProcessingCreditNotification extends BillingScope {
  notificationId: string;
  threshold: 80 | 100;
  referenceCredits: number;
  availableCredits: number;
  consumedCredits: number;
  notificationCycleId: string;
  inApp: true;
  emailRequested: boolean;
  createdAt: string;
}

const scopeKey = (scope: BillingScope) => `${scope.product}|${scope.environment}|${scope.dataHomeRegion}|${scope.spaceId}`;

/** Produces idempotent creator notices when consumption crosses configured pool thresholds. */
export class ProcessingCreditNotifier {
  private readonly notifications = new Map<string, ProcessingCreditNotification>();

  evaluate(scope: BillingScope, input: { previousAvailable: number; currentAvailable: number; referenceCredits: number; notificationCycleId: string; emailPreference: boolean; observedAt: string }): ProcessingCreditNotification[] {
    for (const value of [input.previousAvailable, input.currentAvailable, input.referenceCredits]) {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('Credit notification quantities must be non-negative integers');
    }
    if (!input.notificationCycleId.trim()) throw new Error('Notification cycle is required');
    if (!input.referenceCredits) return [];
    const previousConsumed = input.referenceCredits - Math.min(input.previousAvailable, input.referenceCredits);
    const currentConsumed = input.referenceCredits - Math.min(input.currentAvailable, input.referenceCredits);
    const created: ProcessingCreditNotification[] = [];
    for (const threshold of [80, 100] as const) {
      const boundary = input.referenceCredits * threshold / 100;
      if (previousConsumed >= boundary || currentConsumed < boundary) continue;
      const key = `${scopeKey(scope)}|${input.notificationCycleId}|${threshold}`;
      const prior = this.notifications.get(key);
      if (prior) { created.push(structuredClone(prior)); continue; }
      const notification: ProcessingCreditNotification = Object.freeze({
        ...scope, notificationId: randomUUID(), threshold, referenceCredits: input.referenceCredits,
        availableCredits: input.currentAvailable, consumedCredits: currentConsumed, notificationCycleId: input.notificationCycleId, inApp: true,
        emailRequested: input.emailPreference, createdAt: input.observedAt
      });
      this.notifications.set(key, notification); created.push(structuredClone(notification));
    }
    return created;
  }

  list(scope: BillingScope): ProcessingCreditNotification[] {
    return [...this.notifications.values()].filter(notification => scopeKey(notification) === scopeKey(scope)).map(notification => structuredClone(notification));
  }
}

import type { ExternalEngagementCurrent, ExternalEngagementSnapshot, IntegrationActivity } from './domain';

/** Current values are replaceable aggregates; events are immutable observations. */
export interface IntegrationActivitySplit {
  current: ExternalEngagementCurrent[];
  history: ExternalEngagementSnapshot[];
  events: IntegrationActivity[];
}

export const integrationActivitySplit = (
  current: ExternalEngagementCurrent[],
  history: ExternalEngagementSnapshot[],
  events: IntegrationActivity[]
): IntegrationActivitySplit => ({
  current: [...current].sort((a, b) => b.capturedAt.localeCompare(a.capturedAt)),
  history: [...history].sort((a, b) => b.capturedAt.localeCompare(a.capturedAt)),
  events: [...events].sort((a, b) => (b.occurredAt || b.firstSeenAt).localeCompare(a.occurredAt || a.firstSeenAt))
});

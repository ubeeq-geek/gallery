export type FederationMetricUnit = 'Count' | 'Milliseconds' | 'Seconds';

export interface FederationMetricLog {
  _aws: {
    Timestamp: number;
    CloudWatchMetrics: Array<{
      Namespace: 'Ubeeq/Federation';
      Dimensions: string[][];
      Metrics: Array<{ Name: string; Unit: FederationMetricUnit }>;
    }>;
  };
  InstanceId: string;
  RemoteInstanceId?: string;
  Operation?: string;
  [key: string]: unknown;
}

type MetricDefinition = { name: string; unit: FederationMetricUnit; value: (detail: Record<string, unknown>) => number };

const count = (name: string): MetricDefinition => ({ name, unit: 'Count', value: () => 1 });
const definitions: Record<string, MetricDefinition> = {
  'federation.verify.invalid_audience': count('SignatureFailure'),
  'federation.verify.untrusted_instance': count('UntrustedInstance'),
  'federation.verify.invalid_key': count('InvalidSigningKey'),
  'federation.verify.expired_request': count('ExpiredRequest'),
  'federation.verify.invalid_signature': count('SignatureFailure'),
  'federation.verify.replay': count('ReplayAttempt'),
  'federation.asset.failed': count('AssetFailure'),
  'federation.asset.replicated': count('AssetReplicated'),
  'federation.callback.queued': count('CallbackQueued'),
  'federation.callback.delivered': count('CallbackDelivered'),
  'federation.callback.retry_scheduled': count('CallbackRetry'),
  'federation.callback.dead_letter': count('CallbackDeadLetter'),
  'federation.reconciliation.drift': count('ReconciliationDrift'),
  'federation.grant.transition': count('GrantTransition'),
  'federation.publication.transition': count('PublicationTransition'),
  'federation.moderation.latency': { name: 'ModerationLatency', unit: 'Milliseconds', value: (detail) => finite(detail.durationMs) },
  'federation.asset.latency': { name: 'AssetProcessingLatency', unit: 'Milliseconds', value: (detail) => finite(detail.durationMs) },
  'federation.callback.latency': { name: 'CallbackDeliveryLatency', unit: 'Milliseconds', value: (detail) => finite(detail.durationMs) }
};

const finite = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
const safeDimension = (value: unknown): string | undefined =>
  typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value) ? value : undefined;

/**
 * Creates a CloudWatch Embedded Metric Format observer. Only deployment and
 * instance identifiers are dimensions; actor, Work, publication, and grant
 * identifiers are deliberately excluded to bound cardinality and protect
 * creator privacy.
 */
export const createFederationMetricObserver = (options: {
  instanceId: string;
  write?: (line: string) => void;
  now?: () => Date;
}) => {
  const instanceId = safeDimension(options.instanceId);
  if (!instanceId) throw new Error('Federation metrics require a safe, bounded instance identifier');
  return (event: string, detail: Record<string, unknown> = {}): void => {
    const definition = definitions[event];
    if (!definition) return;
    const remoteInstanceId = safeDimension(detail.remoteInstanceId ?? detail.targetInstanceId ?? detail.sourceInstanceId);
    const operation = safeDimension(detail.operation ?? detail.event);
    const dimensionNames = ['InstanceId', ...(remoteInstanceId ? ['RemoteInstanceId'] : []), ...(operation ? ['Operation'] : [])];
    const metric: FederationMetricLog = {
      _aws: {
        Timestamp: (options.now?.() ?? new Date()).getTime(),
        CloudWatchMetrics: [{ Namespace: 'Ubeeq/Federation', Dimensions: [dimensionNames], Metrics: [{ Name: definition.name, Unit: definition.unit }] }]
      },
      InstanceId: instanceId,
      ...(remoteInstanceId ? { RemoteInstanceId: remoteInstanceId } : {}),
      ...(operation ? { Operation: operation } : {}),
      [definition.name]: definition.value(detail)
    };
    (options.write ?? console.log)(JSON.stringify(metric));
  };
};

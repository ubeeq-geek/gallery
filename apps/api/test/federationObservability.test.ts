import { createFederationMetricObserver } from '../src/federationObservability';

describe('federation embedded metrics', () => {
  it('emits bounded, namespaced metrics with safe operational dimensions', () => {
    const lines: string[] = [];
    const observe = createFederationMetricObserver({ instanceId: 'eversally', write: (line) => lines.push(line), now: () => new Date('2026-08-26T12:00:00.000Z') });
    observe('federation.callback.retry_scheduled', { targetInstanceId: 'nightframe', event: 'publication.status', status: 503, actorUri: 'https://nightfra.me/creators/private' });
    const value = JSON.parse(lines[0]);
    expect(value).toMatchObject({
      _aws: { Timestamp: 1787745600000, CloudWatchMetrics: [{ Namespace: 'Ubeeq/Federation', Dimensions: [['InstanceId', 'RemoteInstanceId', 'Operation']], Metrics: [{ Name: 'CallbackRetry', Unit: 'Count' }] }] },
      InstanceId: 'eversally', RemoteInstanceId: 'nightframe', Operation: 'publication.status', CallbackRetry: 1
    });
    expect(value).not.toHaveProperty('actorUri');
    expect(JSON.stringify(value)).not.toContain('private');
  });

  it('drops unsafe and high-cardinality dimensions and ignores unknown signals', () => {
    const lines: string[] = [];
    const observe = createFederationMetricObserver({ instanceId: 'eversally', write: (line) => lines.push(line) });
    observe('federation.asset.failed', { sourceInstanceId: 'not safe/value', actorUri: 'secret', durationMs: 4 });
    observe('federation.unknown', { sourceInstanceId: 'nightframe' });
    expect(lines).toHaveLength(1);
    const value = JSON.parse(lines[0]);
    expect(value._aws.CloudWatchMetrics[0].Dimensions).toEqual([['InstanceId']]);
    expect(value).toMatchObject({ InstanceId: 'eversally', AssetFailure: 1 });
  });

  it('records latency as a non-negative finite measurement', () => {
    const lines: string[] = [];
    const observe = createFederationMetricObserver({ instanceId: 'eversally', write: (line) => lines.push(line) });
    observe('federation.moderation.latency', { durationMs: 725 });
    expect(JSON.parse(lines[0])).toMatchObject({ ModerationLatency: 725 });
  });

  it('rejects unsafe local instance dimensions instead of publishing invalid EMF', () => {
    expect(() => createFederationMetricObserver({ instanceId: 'unsafe instance/id' })).toThrow('safe, bounded instance identifier');
  });
});

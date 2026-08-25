import { redriveRegionalDlq } from '../src/regionalDlqRedriveHandler';

const queues = { scan: { source: 'scan-dlq', destination: 'scan' }, image: { source: 'image-dlq', destination: 'image' }, video: { source: 'video-dlq', destination: 'video' }, publication: { source: 'publication-dlq', destination: 'publication' } };
it('redrives only messages belonging to the configured cell and audits the operator', async () => {
  const body = JSON.stringify({ id: 'job', assetId: 'asset', product: 'eversally', environment: 'prod', dataHomeRegion: 'eu-central-1' }); const send = jest.fn(); const remove = jest.fn(); const audit = jest.fn();
  const receive = jest.fn().mockResolvedValueOnce([{ body, receiptHandle: 'receipt' }]).mockResolvedValueOnce([]);
  await expect(redriveRegionalDlq({ queue: 'scan', requestedBy: 'operator' }, { product: 'eversally', environment: 'prod', region: 'eu-central-1' }, queues, { receive, send, remove, audit })).resolves.toEqual({ redriven: 1 });
  expect(send).toHaveBeenCalledWith('scan', body, { groupId: 'asset', deduplicationId: 'job' }); expect(remove).toHaveBeenCalled(); expect(audit).toHaveBeenCalledWith(expect.objectContaining({ requestedBy: 'operator', redriven: 1 }));
});

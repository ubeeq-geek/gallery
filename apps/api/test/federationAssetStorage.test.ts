import { CopyObjectCommand, DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { S3FederationAssetStorage } from '../src/federationAssetStorage';

describe('S3FederationAssetStorage', () => {
  test('streams quarantine bytes with encryption and promotes by copy then delete', async () => {
    const commands: unknown[] = []; const client = { send: jest.fn(async (command) => { commands.push(command); return {}; }) };
    const storage = new S3FederationAssetStorage(client as never, 'asset-bucket', 'federation/');
    const body: AsyncIterable<Uint8Array> = { async *[Symbol.asyncIterator]() { yield Buffer.from('one'); yield Buffer.from('two'); } };
    await storage.putQuarantine('federation/quarantine/item', body, { source: 'nightframe' });
    await storage.promote('federation/quarantine/item', 'federation/assets/final item');
    expect(commands[0]).toBeInstanceOf(PutObjectCommand);
    expect((commands[0] as PutObjectCommand).input).toMatchObject({ Bucket: 'asset-bucket', Key: 'federation/quarantine/item', ServerSideEncryption: 'AES256' });
    expect(commands[1]).toBeInstanceOf(CopyObjectCommand);
    expect((commands[1] as CopyObjectCommand).input).toMatchObject({ Key: 'federation/assets/final item', CopySource: 'asset-bucket/federation/quarantine/item' });
    expect(commands[2]).toBeInstanceOf(DeleteObjectCommand);
  });
  test('rejects keys outside the dedicated federation prefix', async () => {
    const storage = new S3FederationAssetStorage({ send: jest.fn() } as never, 'asset-bucket', 'federation/');
    await expect(storage.delete('other/asset')).rejects.toThrow('prefix');
    await expect(storage.delete('federation/../private')).rejects.toThrow('prefix');
  });
});


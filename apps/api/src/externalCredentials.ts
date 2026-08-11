import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

const VERSION = 'v1';

const encryptionKey = (secret: string | undefined): Buffer => {
  if (!secret?.trim()) {
    throw new Error('External account token encryption is not configured');
  }
  return createHash('sha256').update(secret, 'utf8').digest();
};

export const encryptExternalCredential = (value: string, secret: string | undefined): string => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
};

export const decryptExternalCredential = (value: string, secret: string | undefined): string => {
  const [version, ivValue, tagValue, ciphertextValue] = value.split('.');
  if (version !== VERSION || !ivValue || !tagValue || !ciphertextValue) {
    throw new Error('Stored external account credential is invalid');
  }
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(secret), Buffer.from(ivValue, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, 'base64url')),
    decipher.final()
  ]).toString('utf8');
};

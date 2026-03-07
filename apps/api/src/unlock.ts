import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

export interface UnlockPayload {
  galleryId: string;
  userId?: string;
}

export const hashPassword = async (plainText: string): Promise<string> => bcrypt.hash(plainText, 10);

export const verifyPassword = async (plainText: string, hash: string): Promise<boolean> => bcrypt.compare(plainText, hash);

export const issueUnlockToken = (payload: UnlockPayload, secret: string, expiresInSeconds: number): string =>
  jwt.sign(payload, secret, { expiresIn: expiresInSeconds });

export const verifyUnlockToken = (token: string, secret: string): UnlockPayload =>
  jwt.verify(token, secret) as UnlockPayload;

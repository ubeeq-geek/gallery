import { CognitoJwtVerifier } from 'aws-jwt-verify';
import type { NextFunction, Request, Response } from 'express';

export interface AuthUser {
  userId: string;
  groups: string[];
}

declare global {
  namespace Express {
    interface Request {
      authUser?: AuthUser;
    }
  }
}

const ADMIN_GROUP = 'Admins';

export const createOptionalAuthMiddleware = (opts: { userPoolId?: string; clientId?: string; tokenUse?: 'id' | 'access' }) => {
  const verifier = opts.userPoolId && opts.clientId
    ? CognitoJwtVerifier.create({
        userPoolId: opts.userPoolId,
        clientId: opts.clientId,
        tokenUse: opts.tokenUse || 'id'
      })
    : null;

  return async (req: Request, _res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      if (typeof req.headers['x-user-id'] === 'string') {
        req.authUser = {
          userId: req.headers['x-user-id'],
          groups: typeof req.headers['x-user-groups'] === 'string'
            ? req.headers['x-user-groups'].split(',').map((x) => x.trim()).filter(Boolean)
            : []
        };
      }
      return next();
    }

    if (!verifier) return next();

    try {
      const token = authHeader.slice('Bearer '.length);
      const payload = await verifier.verify(token);
      req.authUser = {
        userId: String(payload.sub),
        groups: Array.isArray(payload['cognito:groups']) ? (payload['cognito:groups'] as string[]) : []
      };
    } catch {
      req.authUser = undefined;
    }

    return next();
  };
};

export const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
  if (!req.authUser) {
    return res.status(401).json({ message: 'Authentication required' });
  }
  if (!req.authUser.groups.includes(ADMIN_GROUP)) {
    return res.status(403).json({ message: 'Admin role required' });
  }
  return next();
};

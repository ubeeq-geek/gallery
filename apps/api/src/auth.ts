import { CognitoJwtVerifier } from 'aws-jwt-verify';
import type { Request, Response, NextFunction } from 'express';
import type { AppConfig } from './config';

export interface AuthUser {
  userId: string;
  displayName: string;
  groups: string[];
}

export type AppRole = 'user' | 'artist' | 'admin';

const ADMIN_GROUP = 'Admins';
const ARTIST_GROUP = 'Artists';

declare global {
  namespace Express {
    interface Request {
      authUser?: AuthUser;
    }
  }
}

export const createOptionalAuthMiddleware = (config: AppConfig) => {
  const verifier = config.cognitoUserPoolId && config.cognitoClientId
    ? CognitoJwtVerifier.create({
        userPoolId: config.cognitoUserPoolId,
        tokenUse: config.cognitoTokenUse || 'id',
        clientId: config.cognitoClientId
      })
    : null;

  return async (req: Request, _res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      const devUserId = req.headers['x-user-id'];
      if (typeof devUserId === 'string') {
        const devGroups = typeof req.headers['x-user-groups'] === 'string'
          ? req.headers['x-user-groups'].split(',').map((x) => x.trim()).filter(Boolean)
          : [];
        const devRole = typeof req.headers['x-user-role'] === 'string' ? req.headers['x-user-role'].trim().toLowerCase() : '';
        if (devRole === 'admin' && !devGroups.includes(ADMIN_GROUP)) {
          devGroups.push(ADMIN_GROUP);
        }
        if (devRole === 'artist' && !devGroups.includes(ARTIST_GROUP)) {
          devGroups.push(ARTIST_GROUP);
        }
        req.authUser = {
          userId: devUserId,
          displayName: typeof req.headers['x-user-name'] === 'string' ? req.headers['x-user-name'] : 'Dev User',
          groups: devGroups
        };
      }
      return next();
    }

    if (!verifier) {
      return next();
    }

    try {
      const token = authHeader.slice('Bearer '.length);
      const payload = await verifier.verify(token);
      req.authUser = {
        userId: payload.sub,
        displayName: (payload['cognito:username'] as string) || (payload.email as string) || 'User',
        groups: Array.isArray(payload['cognito:groups']) ? (payload['cognito:groups'] as string[]) : []
      };
    } catch {
      req.authUser = undefined;
    }
    return next();
  };
};

export const requireAuth = (req: Request, res: Response, next: NextFunction) => {
  if (!req.authUser) {
    return res.status(401).json({ message: 'Authentication required' });
  }
  return next();
};

const hasRole = (user: AuthUser, role: AppRole): boolean => {
  if (role === 'admin') {
    return user.groups.includes(ADMIN_GROUP);
  }
  if (role === 'artist') {
    return user.groups.includes(ARTIST_GROUP) || user.groups.includes(ADMIN_GROUP);
  }
  return true;
};

export const resolveRole = (user: AuthUser): AppRole => {
  if (hasRole(user, 'admin')) return 'admin';
  if (hasRole(user, 'artist')) return 'artist';
  return 'user';
};

const requireRole = (role: AppRole, message: string) => (req: Request, res: Response, next: NextFunction) => {
  if (!req.authUser) {
    return res.status(401).json({ message: 'Authentication required' });
  }
  if (!hasRole(req.authUser, role)) {
    return res.status(403).json({ message });
  }
  return next();
};

export const requireAdmin = requireRole('admin', 'Admin role required');
export const requireArtistOrAdmin = requireRole('artist', 'Artist or admin role required');

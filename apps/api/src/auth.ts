import bcrypt from 'bcryptjs';
import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { AuditLog } from './audit.js';
import { config } from './config.js';

export type Role = 'admin' | 'operator' | 'viewer';

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  passwordHash: string;
}

export interface AuthedUser {
  id: string;
  email: string;
  role: Role;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthedUser;
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Demo accounts for judges. Saved to the database the first time the server starts. */
export function seedUsers(): User[] {
  const hash = bcrypt.hashSync('demo1234', 8);
  return [
    { id: 'u1', email: 'admin@demo.com', name: 'Asha Admin', role: 'admin', passwordHash: hash },
    { id: 'u2', email: 'operator@demo.com', name: 'Omar Operator', role: 'operator', passwordHash: hash },
    { id: 'u3', email: 'viewer@demo.com', name: 'Vera Viewer', role: 'viewer', passwordHash: hash },
  ];
}

export class AuthService {
  constructor(readonly users: User[] = seedUsers()) {}

  login(email: string, password: string): { user: User; accessToken: string; refreshToken: string } {
    const user = this.users.find((u) => u.email.toLowerCase() === email.toLowerCase());
    // Compare even when the user is missing, so response time does not reveal which emails exist.
    const ok = bcrypt.compareSync(password, user?.passwordHash ?? '$2a$08$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv');
    if (!user || !ok) throw new ApiError(401, 'INVALID_CREDENTIALS', 'Wrong email or password.');
    return { user, ...this.issue(user) };
  }

  private issue(user: User) {
    const claims = { sub: user.id, email: user.email, role: user.role };
    return {
      accessToken: jwt.sign(claims, config.jwtSecret, { expiresIn: config.accessTtl as jwt.SignOptions['expiresIn'] }),
      refreshToken: jwt.sign({ sub: user.id, type: 'refresh' }, config.jwtRefreshSecret, { expiresIn: config.refreshTtl as jwt.SignOptions['expiresIn'] }),
    };
  }

  refresh(refreshToken: string): { accessToken: string } {
    try {
      const p = jwt.verify(refreshToken, config.jwtRefreshSecret) as { sub: string; type?: string };
      const user = this.users.find((u) => u.id === p.sub);
      if (!user || p.type !== 'refresh') throw new Error('bad token');
      return { accessToken: this.issue(user).accessToken };
    } catch {
      throw new ApiError(401, 'INVALID_TOKEN', 'Refresh token is invalid or expired.');
    }
  }

  verifyAccess(token: string): AuthedUser {
    try {
      const p = jwt.verify(token, config.jwtSecret) as { sub: string; email: string; role: Role; type?: string };
      if (p.type === 'refresh') throw new Error('refresh token used as access token');
      return { id: p.sub, email: p.email, role: p.role };
    } catch {
      throw new ApiError(401, 'INVALID_TOKEN', 'Access token is missing, invalid or expired.');
    }
  }
}

export function requireAuth(auth: AuthService) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return next(new ApiError(401, 'UNAUTHENTICATED', 'Send Authorization: Bearer <token>.'));
    try {
      req.user = auth.verifyAccess(header.slice(7));
      next();
    } catch (e) {
      next(e);
    }
  };
}

/** One permission check in one place. A denied attempt is written to the audit log. */
export function requireRole(audit: AuditLog, ...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const u = req.user;
    if (!u || !roles.includes(u.role)) {
      audit.add(u ?? null, 'forbidden', { method: req.method, path: req.path, needs: roles });
      return next(new ApiError(403, 'FORBIDDEN', `This needs one of: ${roles.join(', ')}.`));
    }
    next();
  };
}

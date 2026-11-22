import { SetMetadata, createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Role } from '@learnsdlc/shared';

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const ROLES_KEY = 'roles';
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

/**
 * The caller as the guard resolved them from the users row at request time,
 * not as the token described them when it was signed, which may be a week old.
 */
export interface AuthUser {
  id: string;
  email: string;
  role: Role;
  cohort: string;
  /** Verified token generation for long-lived operations; not an authorization cache. */
  sessionVersion?: number;
}

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => {
  const request = ctx.switchToHttp().getRequest();
  return request.user;
});

import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@learnsdlc/shared';
import { IS_PUBLIC_KEY, ROLES_KEY } from './auth.decorators';
import { AuthService } from './auth.service';
import { bearerToken } from './bearer';

/**
 * Bearer tokens are checked against the users row, not only their signature:
 * a token whose version, account or suspension state no longer matches the
 * row is refused, so a password change or an admin action takes effect on
 * every outstanding token rather than in seven days. The row read is cached
 * only while a lookup is in flight; every request checks fresh shared authority.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();
    const header: string = request.headers['authorization'] || '';
    const token = bearerToken(header);
    if (!token) throw new UnauthorizedException('missing bearer token');
    request.user = await this.auth.authenticate(token);
    return true;
  }
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;
    const { user } = context.switchToHttp().getRequest();
    if (!user || !required.includes(user.role)) {
      throw new ForbiddenException('insufficient role');
    }
    return true;
  }
}

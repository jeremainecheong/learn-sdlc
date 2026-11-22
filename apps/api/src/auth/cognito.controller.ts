import { Body, Controller, Get, HttpCode, HttpException, Logger, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { IsEmail, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import type { Request, Response } from 'express';
import { REQUEST_ID_HEADER } from '@learnsdlc/shared';
import { AuthService } from './auth.service';
import { config, siteUrl } from '../config';
import { Public } from './auth.decorators';
import { CognitoFlowFailure, CognitoService, CognitoStateUnavailable, cognitoNonceCookie, COGNITO_STATE_TTL_MS } from './cognito.service';
import { RateLimit, RateLimitGuard } from './rate-limit.guard';
import { readCookie } from './google.controller';
import { requestCorrelationId } from '../observability/logger';
import { normaliseEmail } from './email';

export class CognitoEmailDto { @IsEmail() @MaxLength(254) email!: string; }
export class CognitoConfirmDto extends CognitoEmailDto {
  @IsString() @MinLength(1) @MaxLength(64) @Matches(/^\S+$/) code!: string;
}

@Controller('auth')
@UseGuards(RateLimitGuard)
export class CognitoController {
  private readonly logger = new Logger(CognitoController.name);
  constructor(private readonly cognito: CognitoService, private readonly auth: AuthService) {}
  @Public() @HttpCode(200) @RateLimit(10,900,{identityField:'email',perAddress:{max:config.signInMaxPerAddress,windowSeconds:60}}) @Post('confirm')
  confirm(@Body() dto: CognitoConfirmDto) { return this.cognito.confirm(normaliseEmail(dto.email),dto.code); }
  @Public() @HttpCode(200) @RateLimit(5,900,{identityField:'email',perAddress:{max:config.signInMaxPerAddress,windowSeconds:60}}) @Post('confirm/resend')
  resend(@Body() dto: CognitoEmailDto) { return this.cognito.resend(normaliseEmail(dto.email)); }
  @Public() @RateLimit(config.signInMaxPerAddress,60) @Get('sso/start')
  start(@Query('provider') provider: string, @Query('next') next: string|undefined, @Res() res: Response) {
    const {url,nonce}=this.cognito.beginSignIn(provider,next);
    const cookie=cognitoNonceCookie();
    res.setHeader('Cache-Control','no-store');
    res.cookie(cookie.name,nonce,{httpOnly:true,sameSite:'lax',secure:cookie.secure,path:'/',maxAge:COGNITO_STATE_TTL_MS});
    res.redirect(302,url);
  }
  /**
   * The last hop of signing out. The web first saves, then
   * revokes the app session (`POST /auth/logout`) and clears it, and only then
   * navigates here, so no bearer rides this request and none is read. Managed
   * mode goes on to Cognito's hosted /logout with the registered logout_uri;
   * local mode goes straight to /login. It reads no query parameter, so it
   * cannot become an open redirect, and it sets no cookie.
   */
  @Public() @RateLimit(config.signInMaxPerAddress,60) @Get('sso/signout')
  signOut(@Res() res: Response) {
    res.setHeader('Cache-Control','no-store'); res.setHeader('Referrer-Policy','no-referrer');
    res.redirect(302,config.authProvider==='cognito' ? this.cognito.signOutUrl(siteUrl()) : siteUrl()+'/login');
  }
  @Public() @RateLimit(config.signInMaxPerAddress,60) @Get('sso/callback')
  async callback(@Query('code') code:string|undefined,@Query('state') state:string|undefined,
    @Query('error') error:string|undefined,@Req() req:Request,@Res() res:Response) {
    const reference=requestCorrelationId((req as Request & {requestId?:unknown}).requestId);
    res.setHeader(REQUEST_ID_HEADER,reference);
    res.setHeader('Cache-Control','no-store'); res.setHeader('Referrer-Policy','no-referrer');
    const cookie=cognitoNonceCookie();
    // Every callback ends this browser attempt, including rejected or failed
    // exchanges. The request cookie remains available for verification below.
    res.clearCookie(cookie.name,{httpOnly:true,sameSite:'lax',secure:cookie.secure,path:'/'});
    let stage:'provider'|'callback'|'identity_binding'='provider';
    try {
      if (error) throw new Error('provider refused');
      stage='callback';
      const answer=await this.cognito.complete(code,state,readCookie(req.headers.cookie,cookie.name));
      stage='identity_binding';
      const auth=await this.auth.cognitoSession(answer.identity);
      const next=answer.returnPath?'?next='+encodeURIComponent(answer.returnPath):'';
      res.redirect(302,siteUrl()+'/login/callback'+next+'#token='+encodeURIComponent(auth.token));
    } catch (error) {
      // Fixed, same-origin failure destination. Never reflect provider strings,
      // state, tokens, email or an unverified next parameter in the redirect.
      const detail=error instanceof HttpException ? error.getResponse() : undefined;
      const conflict=stage==='identity_binding' && typeof detail==='object' && detail!==null && 'code' in detail && detail.code==='IDENTITY_LINK_REQUIRED';
      const flow=error instanceof CognitoFlowFailure || error instanceof CognitoStateUnavailable ? error : null;
      const reason=flow?.code==='COGNITO_FLOW_EXPIRED' ? 'sso_expired' : conflict ? 'identity_link_required' : 'sso_failed';
      const diagnosticCode=flow?.code ?? (conflict ? 'IDENTITY_LINK_REQUIRED' : stage==='provider' ? 'COGNITO_PROVIDER_REFUSED' : stage==='identity_binding' ? 'COGNITO_SESSION_FAILED' : 'COGNITO_CALLBACK_FAILED');
      this.logger.warn(`Cognito sign-in failure stage=${flow?.stage ?? stage} code=${diagnosticCode} rid=${reference}`);
      res.redirect(302,siteUrl()+'/login?error='+reason+'&reference='+reference);
    }
  }
}

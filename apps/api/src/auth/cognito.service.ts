import { BadRequestException, Inject, Injectable, Optional, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { isUniqueViolation } from '../db/unique-violation';
import { CognitoIdentityProviderClient, SignUpCommand, ConfirmSignUpCommand, ResendConfirmationCodeCommand,
  InitiateAuthCommand, ForgotPasswordCommand, ConfirmForgotPasswordCommand, ChangePasswordCommand } from '@aws-sdk/client-cognito-identity-provider';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { Repository } from 'typeorm';
import { config } from '../config';
import { InjectRepository } from '../db/inject';
import { SettingEntity } from '../db/entities';
import { UUID_PATTERN } from '../db/uuid';
import { safeReturnPath } from './return-path';

export const COGNITO_CLIENT = 'COGNITO_CLIENT';
export const COGNITO_TOKEN_VERIFIER = 'COGNITO_TOKEN_VERIFIER';
export const COGNITO_STATE_TTL_MS = 10 * 60_000;
export interface CognitoIdentity { sub: string; email: string; emailVerified: boolean; name?: string; appUserId?: string; nonce?: string; }
export interface CognitoVerifier { verify(token: string): Promise<Record<string, unknown>>; }
export interface ConfirmationRequired { confirmationRequired: true; email: string; }
export interface CognitoPasswordResetResult { subject: string; verifiedEmail?: string; }
export const passwordChangedSignInRequired = () => new ServiceUnavailableException({
  statusCode: 503,
  code: 'PASSWORD_CHANGED_SIGN_IN_REQUIRED',
  message: 'Your password was changed, but application session recovery could not be completed. Sign in with your new password. If sign-in is unavailable, contact the LearnSDLC host.',
});
/** The longest one call to Cognito or its token endpoint may take before it is abandoned. */
const COGNITO_CALL_TIMEOUT_MS = 15_000;
/** The pool's AWS region: a user pool id is `<region>_<id>`. Read per call, as config may change in specs. */
const cognitoRegion = (): string => config.cognitoUserPoolId.split('_')[0];
const SUBJECT = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const failure = () => new UnauthorizedException('That sign-in could not be verified. Start again.');

type CognitoFlowStage = 'state' | 'nonce' | 'replay' | 'exchange' | 'identity';
type CognitoFlowCode = 'COGNITO_FLOW_INVALID' | 'COGNITO_FLOW_EXPIRED' | 'COGNITO_BROWSER_MISMATCH'
  | 'COGNITO_FLOW_REPLAYED' | 'COGNITO_EXCHANGE_FAILED' | 'COGNITO_IDENTITY_INVALID';
/** Only locally classified failures carry callback diagnostics. Never attach
 * raw provider errors, response bodies, state or credentials to these errors. */
export class CognitoFlowFailure extends UnauthorizedException {
  constructor(readonly stage: CognitoFlowStage, readonly code: CognitoFlowCode) {
    super({ code, message: code === 'COGNITO_FLOW_EXPIRED'
      ? 'That sign-in attempt expired. Start again from the sign-in page.'
      : 'That sign-in could not be verified. Start again.' });
  }
}
export class CognitoStateUnavailable extends ServiceUnavailableException {
  readonly stage = 'replay';
  readonly code = 'COGNITO_STATE_STORE_UNAVAILABLE';
  constructor() { super('Sign-in could not be completed safely. Start again shortly.'); }
}

export function cognitoNonceCookie() {
  const secure = config.cognitoRedirectUrl.startsWith('https://');
  return { name: secure ? '__Host-cognito-nonce' : 'cognito-nonce', secure };
}

@Injectable()
export class CognitoService {
  private client?: CognitoIdentityProviderClient;
  private verifier?: CognitoVerifier;
  constructor(
    @InjectRepository(SettingEntity) private readonly states: Repository<SettingEntity>,
    @Optional() @Inject(COGNITO_CLIENT) client?: CognitoIdentityProviderClient,
    @Optional() @Inject(COGNITO_TOKEN_VERIFIER) verifier?: CognitoVerifier,
  ) { this.client = client; this.verifier = verifier; }

  enabled(): boolean {
    return config.authProvider === 'cognito' && Boolean(config.cognitoUserPoolId && config.cognitoClientId && config.cognitoDomain && config.cognitoRedirectUrl);
  }
  providers() {
    return this.enabled() ? config.cognitoProviders.map(id => ({ id, label: id === 'Google' ? 'Google' : id })) : [];
  }
  private ready() {
    if (!this.enabled()) throw new ServiceUnavailableException('Managed sign-in is not configured. Contact the LearnSDLC host.');
  }
  private sdk() {
    this.ready();
    return this.client ??= new CognitoIdentityProviderClient({ region: cognitoRegion(), maxAttempts: 1 });
  }
  private mapError(error: unknown, email?: string): never {
    const name = (error as { name?: string })?.name;
    if (name === 'UserNotConfirmedException') throw new UnauthorizedException({ code: 'CONFIRMATION_REQUIRED', email,
      message: 'Confirm your email address before signing in.' });
    if (['NotAuthorizedException','UserNotFoundException','PasswordResetRequiredException'].includes(name || '')) {
      throw new UnauthorizedException('Sign-in was not accepted. Check your password, use your sign-in provider, or request a password reset.');
    }
    if (['CodeMismatchException','ExpiredCodeException'].includes(name || '')) throw new BadRequestException('That confirmation code is invalid or expired. Request a new code.');
    if (name === 'InvalidPasswordException') throw new BadRequestException('That password does not meet the managed account requirements. Use at least eight characters and avoid common passwords.');
    if (name === 'UsernameExistsException' || name === 'AliasExistsException') throw new BadRequestException('An account with that email may already exist. Sign in or request a password reset.');
    throw new ServiceUnavailableException('Managed sign-in is temporarily unavailable. Try again shortly.');
  }
  async verifyIdentity(token: string, nonce?: string, nativeMigration = false): Promise<CognitoIdentity> {
    this.ready();
    if (typeof token !== 'string' || token.length > 24000) throw failure();
    this.verifier ??= CognitoJwtVerifier.create({ userPoolId: config.cognitoUserPoolId, clientId: config.cognitoClientId, tokenUse: 'id' });
    let claims: Record<string, unknown>;
    try { claims = await this.verifier.verify(token); } catch { throw failure(); }
    const mapping = claims['custom:learnsdlc_id'];
    const verified = claims.email_verified === true;
    const nativeLegacy = nativeMigration && typeof mapping === 'string' && UUID_PATTERN.test(mapping);
    const expectedIssuer = `https://cognito-idp.${cognitoRegion()}.amazonaws.com/${config.cognitoUserPoolId}`;
    if (claims.iss !== expectedIssuer || claims.aud !== config.cognitoClientId || claims.token_use !== 'id'
      || typeof claims.sub !== 'string' || !SUBJECT.test(claims.sub)
      || typeof claims.exp !== 'number' || claims.exp <= Date.now()/1000
      || (!verified && !nativeLegacy) || typeof claims.email !== 'string'
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(claims.email) || claims.email.length > 254
      || (nonce !== undefined && claims.nonce !== nonce)) throw failure();
    if (mapping !== undefined && (typeof mapping !== 'string' || !UUID_PATTERN.test(mapping))) throw failure();
    return { sub: claims.sub, email: claims.email.trim().toLowerCase(), emailVerified: verified,
      ...(typeof claims.name === 'string' ? { name: claims.name.trim().slice(0,100) } : {}),
      ...(typeof mapping === 'string' ? { appUserId: mapping } : {}),
      ...(typeof claims.nonce === 'string' ? { nonce: claims.nonce } : {}) };
  }
  async register(email: string, password: string, name: string): Promise<ConfirmationRequired> {
    this.ready();
    if (!/^[0-9a-f]{64}$/i.test(config.cognitoMigrationSecret)) throw new ServiceUnavailableException('Managed registration is not configured.');
    const timestamp=String(Math.floor(Date.now()/1000));
    const nonce=randomBytes(16).toString('hex');
    const signature=createHmac('sha256',Buffer.from(config.cognitoMigrationSecret,'hex'))
      .update(`signup.${timestamp}.${nonce}.${email}.${config.cognitoUserPoolId}`).digest('hex');
    try {
      await this.sdk().send(new SignUpCommand({ ClientId: config.cognitoClientId, Username: email, Password: password,
        UserAttributes: [{ Name: 'email', Value: email }, { Name: 'name', Value: name.trim() }],
        ClientMetadata:{signupTimestamp:timestamp,signupNonce:nonce,signupSignature:signature} }), { abortSignal: AbortSignal.timeout(COGNITO_CALL_TIMEOUT_MS) });
    } catch (error) { this.mapError(error, email); }
    // Even an auto-confirmed pool does not turn registration into app login.
    return { confirmationRequired: true, email };
  }
  async confirm(email: string, code: string) {
    try { await this.sdk().send(new ConfirmSignUpCommand({ ClientId: config.cognitoClientId, Username: email,
      ConfirmationCode: code, ForceAliasCreation: false }), { abortSignal: AbortSignal.timeout(COGNITO_CALL_TIMEOUT_MS) });
    } catch (error) { this.mapError(error,email); }
    return { confirmed: true as const, email };
  }
  async resend(email: string) {
    try { await this.sdk().send(new ResendConfirmationCodeCommand({ ClientId: config.cognitoClientId, Username: email }), { abortSignal: AbortSignal.timeout(COGNITO_CALL_TIMEOUT_MS) }); }
    catch (error) { if (!['UserNotFoundException','InvalidParameterException'].includes((error as Error)?.name)) this.mapError(error,email); }
    return { sent: true as const, message: 'If that account needs confirmation, a code has been requested.' };
  }
  async passwordIdentity(email: string, password: string): Promise<{ identity: CognitoIdentity; accessToken: string }> {
    try {
      const answer = await this.sdk().send(new InitiateAuthCommand({ ClientId: config.cognitoClientId,
        AuthFlow: 'USER_PASSWORD_AUTH', AuthParameters: { USERNAME: email, PASSWORD: password } }), { abortSignal: AbortSignal.timeout(COGNITO_CALL_TIMEOUT_MS) });
      if (answer.ChallengeName || !answer.AuthenticationResult?.IdToken || !answer.AuthenticationResult.AccessToken) {
        throw new UnauthorizedException('This account needs an additional sign-in step. Use your sign-in provider or contact the LearnSDLC host.');
      }
      return { identity: await this.verifyIdentity(answer.AuthenticationResult.IdToken,undefined,true), accessToken: answer.AuthenticationResult.AccessToken };
    } catch (error) { if (error instanceof UnauthorizedException) throw error; this.mapError(error,email); }
  }
  async forgot(email: string) {
    try { await this.sdk().send(new ForgotPasswordCommand({ ClientId: config.cognitoClientId, Username: email }), { abortSignal: AbortSignal.timeout(COGNITO_CALL_TIMEOUT_MS) }); }
    catch (error) { if (!['UserNotFoundException','InvalidParameterException'].includes((error as Error)?.name)) this.mapError(error,email); }
    return { sent: true as const, delivery: 'code' as const, message: 'If password recovery is available for that account, a confirmation code has been requested. Accounts using Google or institutional sign-in should recover access with that provider.' };
  }
  async reset(email: string, code: string, password: string, boundSubject?: string): Promise<CognitoPasswordResetResult> {
    if (boundSubject !== undefined && !SUBJECT.test(boundSubject)) throw failure();
    // Cognito accepts a native user's immutable sub as Username. Pin a linked
    // account's operation to that subject in this configured client/pool, so
    // a mutable email alias cannot cause a different account to be revoked.
    // https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_ConfirmForgotPassword.html
    try { await this.sdk().send(new ConfirmForgotPasswordCommand({ ClientId: config.cognitoClientId, Username: boundSubject ?? email,
      ConfirmationCode: code, Password: password }), { abortSignal: AbortSignal.timeout(COGNITO_CALL_TIMEOUT_MS) }); }
    catch (error) { this.mapError(error,email); }
    // Confirmation already changed the password. A pinned subject needs no
    // second authentication request before revocation. This does not assert
    // which email/phone delivered the code or invent verified-email credit.
    if (boundSubject !== undefined) return { subject: boundSubject };
    try {
      const { identity } = await this.passwordIdentity(email,password);
      return { subject: identity.sub, ...(identity.emailVerified ? { verifiedEmail: identity.email } : {}) };
    } catch {
      // An unlinked identity still needs signed subject proof. Do not link by
      // email, retry confirmation, or misreport its committed password change.
      throw passwordChangedSignInRequired();
    }
  }
  async changePassword(email: string, sub: string, oldPassword: string, nextPassword: string) {
    const { identity, accessToken } = await this.passwordIdentity(email,oldPassword);
    if (identity.sub !== sub) throw failure();
    try { await this.sdk().send(new ChangePasswordCommand({ AccessToken: accessToken,
      PreviousPassword: oldPassword, ProposedPassword: nextPassword }), { abortSignal: AbortSignal.timeout(COGNITO_CALL_TIMEOUT_MS) }); }
    catch (error) { this.mapError(error,email); }
  }
  private stateKey() { return createHmac('sha256',config.jwtSecret).update('learnsdlc-cognito-state-v1').digest(); }
  private sign(body: string) { return createHmac('sha256',this.stateKey()).update(body).digest('base64url'); }
  private codeVerifier(nonce: string) { return createHmac('sha256',this.stateKey()).update('pkce:'+nonce).digest('base64url'); }
  private domain() {
    this.ready();
    const raw = config.cognitoDomain;
    const domain = new URL(raw.includes('://') ? raw : 'https://'+raw);
    if (domain.protocol !== 'https:' || domain.username || domain.password || domain.search || domain.hash || domain.pathname !== '/') throw new ServiceUnavailableException('Managed sign-in configuration is invalid.');
    return domain.origin;
  }
  beginSignIn(provider: string, next?: string) {
    if (!this.providers().some(item => item.id === provider)) throw new BadRequestException('That sign-in provider is not enabled.');
    const nonce = randomBytes(32).toString('base64url');
    const body = Buffer.from(JSON.stringify({ n: nonce, p: provider, r: safeReturnPath(next), exp: Date.now()+COGNITO_STATE_TTL_MS })).toString('base64url');
    const state = body+'.'+this.sign(body);
    const params = new URLSearchParams({ response_type:'code',client_id:config.cognitoClientId,
      redirect_uri:config.cognitoRedirectUrl, identity_provider:provider,
      scope:'openid email profile aws.cognito.signin.user.admin',state,nonce,prompt:'login',
      code_challenge:createHash('sha256').update(this.codeVerifier(nonce)).digest('base64url'), code_challenge_method:'S256' });
    return { nonce, url:this.domain()+'/oauth2/authorize?'+params };
  }
  /**
   * Where a managed sign-out sends the browser once the web
   * has revoked the app session. Cognito's hosted /logout ends the hosted
   * sign-in session on this browser and returns to `<site>/login`. The
   * logout_uri must equal a registered logout URL of the app client byte for
   * byte (infra/preview/terraform/cognito.tf `logout_urls`), so nothing (no
   * query, no fragment) is ever added to it. It carries no token, state,
   * nonce or identity, and it neither calls nor stores anything. It does not
   * sign anyone out of Google.
   */
  signOutUrl(site: string) {
    const params = new URLSearchParams({ client_id:config.cognitoClientId, logout_uri:site+'/login' });
    return this.domain()+'/logout?'+params;
  }
  async complete(code?: string, state?: string, browserNonce?: string): Promise<{ identity: CognitoIdentity; returnPath: string }> {
    this.ready();
    const invalidState = () => new CognitoFlowFailure('state','COGNITO_FLOW_INVALID');
    if (typeof state!=='string' || !state || state.length>4096) throw invalidState();
    const parts=state.split('.');
    if (parts.length!==2) throw invalidState();
    const expected=Buffer.from(this.sign(parts[0])); const signature=Buffer.from(parts[1]);
    if (expected.length!==signature.length || !timingSafeEqual(expected,signature)) throw invalidState();
    let payload: { n?:unknown;p?:unknown;r?:unknown;exp?:unknown };
    try { payload=JSON.parse(Buffer.from(parts[0],'base64url').toString()); } catch { throw invalidState(); }
    const now=Date.now();
    if (!payload || typeof payload.n!=='string' || !/^[A-Za-z0-9_-]{43}$/.test(payload.n)
      || typeof payload.exp!=='number' || !Number.isFinite(payload.exp)
      || payload.exp>now+COGNITO_STATE_TTL_MS || typeof payload.p!=='string'
      || !this.providers().some(item=>item.id===payload.p) || typeof payload.r!=='string') throw invalidState();
    // A browser normally removes this cookie at the same ten-minute expiry.
    // Diagnose expiry from authenticated state first; never exchange or store
    // it, and never classify a forged or invalid future state as expired.
    if (payload.exp<=now) throw new CognitoFlowFailure('state','COGNITO_FLOW_EXPIRED');
    if (typeof code!=='string' || !code || code.length>4096) throw invalidState();
    if (typeof browserNonce!=='string' || !browserNonce) throw new CognitoFlowFailure('nonce','COGNITO_BROWSER_MISMATCH');
    const a=Buffer.from(payload.n),b=Buffer.from(browserNonce);
    if (a.length!==b.length || !timingSafeEqual(a,b)) throw new CognitoFlowFailure('nonce','COGNITO_BROWSER_MISMATCH');
    const key='auth.cognito.state.'+createHash('sha256').update(state).digest('hex');
    try {
      await this.states.createQueryBuilder().delete().where('key LIKE :prefix AND value < :now', {prefix:'auth.cognito.state.%',now:String(Date.now())}).execute();
      await this.states.insert({key,value:String(payload.exp)});
    } catch (error) {
      if (isUniqueViolation(error)) throw new CognitoFlowFailure('replay','COGNITO_FLOW_REPLAYED');
      throw new CognitoStateUnavailable();
    }
    let idToken: unknown;
    try {
      const response=await fetch(this.domain()+'/oauth2/token',{method:'POST',signal:AbortSignal.timeout(COGNITO_CALL_TIMEOUT_MS),redirect:'error',
        headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',
          client_id:config.cognitoClientId,redirect_uri:config.cognitoRedirectUrl,code,code_verifier:this.codeVerifier(payload.n)}).toString()});
      const answer=await response.json() as {id_token?:unknown};
      if (!response.ok) throw failure();
      idToken=answer.id_token;
    } catch { throw new CognitoFlowFailure('exchange','COGNITO_EXCHANGE_FAILED'); }
    if (typeof idToken!=='string') throw new CognitoFlowFailure('exchange','COGNITO_EXCHANGE_FAILED');
    let identity: CognitoIdentity;
    try { identity=await this.verifyIdentity(idToken,payload.n); }
    catch { throw new CognitoFlowFailure('identity','COGNITO_IDENTITY_INVALID'); }
    return {identity,returnPath:safeReturnPath(payload.r)};
  }
}

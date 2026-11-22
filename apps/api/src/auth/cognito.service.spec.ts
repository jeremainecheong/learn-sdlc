import { passwordWorkFixture } from '../../test/password-work.fixture';
import 'reflect-metadata';
import { BadRequestException, ConflictException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { createHmac, generateKeyPairSync, sign } from 'crypto';
import { DataSource } from 'typeorm';
import { config } from '../config';
import { SettingEntity, UserEntity } from '../db/entities';
import { CognitoService, type CognitoIdentity } from './cognito.service';
import { safeReturnPath } from './return-path';
import { AuthService } from './auth.service';
import { AccountService } from '../account/account.service';
import { RecoveryService } from './recovery.service';
import { MailService } from '../mail/mail.service';
import { memoryDataSource } from '../../test/support/memory-db';

const SUB='12345678-1234-4234-8234-123456789abc';
const OTHER='23456789-2345-4345-8345-23456789abcd';
const POOL='ap-southeast-1_Example123';
const ISSUER='https://cognito-idp.ap-southeast-1.amazonaws.com/'+POOL;
const saved = {authProvider:config.authProvider,cognitoUserPoolId:config.cognitoUserPoolId,cognitoClientId:config.cognitoClientId,
  cognitoDomain:config.cognitoDomain,cognitoRedirectUrl:config.cognitoRedirectUrl,cognitoProviders:config.cognitoProviders,
  cognitoMigrationSecret:config.cognitoMigrationSecret,allowedEmailDomains:config.allowedEmailDomains};

let db:DataSource;
let sdk:jest.Mock;
let verify:jest.Mock;
let provider:CognitoService;
let auth:AuthService;
let jwt:JwtService;
const identity=(extra:Partial<CognitoIdentity>={}):CognitoIdentity=>({sub:SUB,email:'learner@example.test',emailVerified:true,name:'Learner',...extra});
const claims=(extra:Record<string,unknown>={})=>({iss:ISSUER,aud:'public-client',token_use:'id',sub:SUB,
  email:'learner@example.test',name:'Learner',email_verified:true,exp:Math.floor(Date.now()/1000)+3600,iat:Math.floor(Date.now()/1000),...extra});

beforeAll(async()=>{
  db=await memoryDataSource();
});
afterAll(async()=>{Object.assign(config,saved);await db.destroy();});
beforeEach(async()=>{
  Object.assign(config,{authProvider:'cognito',cognitoUserPoolId:POOL,cognitoClientId:'public-client',
    cognitoDomain:'https://example.auth.ap-southeast-1.amazoncognito.com',cognitoRedirectUrl:'https://learnsdlc.test/api/v1/auth/sso/callback',
    cognitoProviders:['Google'],cognitoMigrationSecret:'ab'.repeat(32),allowedEmailDomains:[]});
  await db.getRepository(SettingEntity).clear(); await db.getRepository(UserEntity).clear();
  sdk=jest.fn();verify=jest.fn().mockResolvedValue(claims());
  provider=new CognitoService(db.getRepository(SettingEntity),{send:sdk} as unknown as CognitoIdentityProviderClient,{verify});
  jwt=new JwtService({secret:'offline-cognito-app-secret',signOptions:{expiresIn:'7d'}});
  auth=new AuthService(passwordWorkFixture(), db.getRepository(UserEntity),jwt,provider);
  jest.spyOn(global,'fetch').mockRejectedValue(new Error('Offline test: no network allowed'));
});
afterEach(()=>{jest.restoreAllMocks();Object.assign(config,saved);});

it('registers only with a scoped signed migration proof and never creates an app session/row',async()=>{
  sdk.mockResolvedValue({UserConfirmed:false});
  await expect(auth.register(' Learner@Example.test ','Password!234','Learner')).resolves.toEqual({confirmationRequired:true,email:'learner@example.test'});
  const input=sdk.mock.calls[0][0].input;
  expect(input.UserAttributes).toEqual([{Name:'email',Value:'learner@example.test'},{Name:'name',Value:'Learner'}]);
  expect(input).not.toHaveProperty('SecretHash');
  const proof=input.ClientMetadata;
  expect(proof.signupSignature).toBe(createHmac('sha256',Buffer.from(config.cognitoMigrationSecret,'hex'))
    .update(`signup.${proof.signupTimestamp}.${proof.signupNonce}.learner@example.test.${POOL}`).digest('hex'));
  expect(JSON.stringify(input)).not.toContain(config.cognitoMigrationSecret);
  expect(await db.getRepository(UserEntity).count()).toBe(0);
});
it('refuses local email collisions before managed signup and never uses bcrypt login fallback',async()=>{
  await db.getRepository(UserEntity).save({email:'learner@example.test',displayName:'Legacy',passwordHash:'legacy'});
  await expect(auth.register('learner@example.test','Password!234','Learner')).rejects.toThrow(ConflictException);
  expect(sdk).not.toHaveBeenCalled();
  sdk.mockRejectedValue(Object.assign(new Error('sensitive provider detail'),{name:'NotAuthorizedException'}));
  await expect(auth.login('learner@example.test','legacy')).rejects.toThrow(UnauthorizedException);
  expect(sdk.mock.calls[0][0].input.AuthFlow).toBe('USER_PASSWORD_AUTH');
});
it('returns actionable confirmation required on password sign-in without granting a session',async()=>{
  sdk.mockRejectedValue(Object.assign(new Error('private'),{name:'UserNotConfirmedException'}));
  try { await auth.login('learner@example.test','password');throw new Error('unexpected success'); }
  catch(error) { expect((error as UnauthorizedException).getResponse()).toMatchObject({code:'CONFIRMATION_REQUIRED',email:'learner@example.test'}); }
  expect(await db.getRepository(UserEntity).count()).toBe(0);
});
it('keeps confirmation alias transfer disabled and refuses provider failures',async()=>{
  sdk.mockResolvedValue({});await provider.confirm('learner@example.test','123456');
  expect(sdk.mock.calls[0][0].input.ForceAliasCreation).toBe(false);
  sdk.mockRejectedValue(Object.assign(new Error('private'),{name:'CodeMismatchException'}));
  await expect(provider.confirm('learner@example.test','wrong')).rejects.toThrow(BadRequestException);
});
it('refuses absent managed configuration and never invokes local credentials',async()=>{
  config.cognitoClientId='';
  await expect(auth.login('learner@example.test','password')).rejects.toThrow(ServiceUnavailableException);
  expect(sdk).not.toHaveBeenCalled();
});

it.each([
  {aud:'another-client'},{iss:ISSUER+'wrong'},{token_use:'access'},{sub:''},{exp:0},
  {email_verified:false},{email:'malformed'},{'custom:learnsdlc_id':'not-a-uuid'},
])('rejects malformed or untrusted ID claims %p',async(change)=>{
  verify.mockResolvedValue(claims(change));
  await expect(provider.verifyIdentity('signed-token')).rejects.toThrow(UnauthorizedException);
});
it('uses real offline RSA verification with exact audience, pool and token-use checks',async()=>{
  const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  const jwk={...publicKey.export({format:'jwk'}),kty:'RSA',kid:'offline-key',use:'sig',alg:'RS256'};
  const real=CognitoJwtVerifier.create({userPoolId:POOL,clientId:'public-client',tokenUse:'id'});
  real.cacheJwks({keys:[jwk]});
  const service=new CognitoService(db.getRepository(SettingEntity),{send:sdk} as unknown as CognitoIdentityProviderClient,real);
  const token=(payload:Record<string,unknown>)=>{
    const body=Buffer.from(JSON.stringify({alg:'RS256',kid:'offline-key'})).toString('base64url')+'.'+Buffer.from(JSON.stringify(payload)).toString('base64url');
    return body+'.'+sign('RSA-SHA256',Buffer.from(body),privateKey).toString('base64url');
  };
  await expect(service.verifyIdentity(token(claims()))).resolves.toMatchObject(identity());
  for (const change of [{aud:'wrong'},{iss:ISSUER+'x'},{token_use:'access'}]) {
    await expect(service.verifyIdentity(token(claims(change)))).rejects.toThrow(UnauthorizedException);
  }
  const forged=token(claims()).slice(0,-12)+'AAAAAAAAAAAA';
  await expect(service.verifyIdentity(forged)).rejects.toThrow(UnauthorizedException);
  expect(sdk).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
});

it('issues learner-only three-hour sessions with provider+subject and rejects prior local tokens',async()=>{
  const result=await auth.cognitoSession(identity());
  const token=jwt.verify(result.token);
  expect(token).toMatchObject({provider:'cognito',cognitoSub:SUB,ver:0});
  expect(token.exp-token.iat).toBe(3*60*60);expect(typeof token.orig).toBe('number');expect(result.user.role).toBe('LEARNER');
  await expect(auth.authenticate(result.token)).resolves.toMatchObject({id:result.user.id});
  await expect(auth.authenticate(jwt.sign({sub:result.user.id,ver:0}))).rejects.toThrow(UnauthorizedException);
  await expect(auth.authenticate(jwt.sign({sub:result.user.id,ver:0,provider:'cognito',cognitoSub:OTHER}))).rejects.toThrow(UnauthorizedException);
  config.authProvider='local';
  await expect(auth.authenticate(result.token)).rejects.toThrow(UnauthorizedException);
});
it('preserves legacy work identity, roles, suspension and concurrent fields through trusted mapping',async()=>{
  const previous=await db.getRepository(UserEntity).save({email:'learner@example.test',displayName:'Instructor',passwordHash:'unchanged-hash',role:'INSTRUCTOR' as const,cohort:'existing-class'});
  const result=await auth.cognitoSession(identity({appUserId:previous.id}),'native');
  expect(result.user).toMatchObject({id:previous.id,role:'INSTRUCTOR',cohort:'existing-class',displayName:'Instructor'});
  const row=await db.getRepository(UserEntity).findOneByOrFail({id:previous.id});
  expect(row.passwordHash).toBe('unchanged-hash');expect(row.tokenVersion).toBe(1);expect(row.cognitoSub).toBe(SUB);
  await db.getRepository(UserEntity).update({id:row.id},{disabledAt:new Date().toISOString()});auth.forgetSession(row.id);
  await expect(auth.cognitoSession(identity())).rejects.toThrow(UnauthorizedException);
  await expect(auth.authenticate(result.token)).rejects.toThrow(UnauthorizedException);
});
it('allows only password-migrated existing identities to retain unverified legacy email',async()=>{
  const previous=await db.getRepository(UserEntity).save({email:'learner@example.test',displayName:'Legacy',passwordHash:'legacy',emailVerifiedAt:null});
  verify.mockResolvedValue(claims({email_verified:false,'custom:learnsdlc_id':previous.id}));
  sdk.mockResolvedValue({AuthenticationResult:{IdToken:'token',AccessToken:'private-access-token'}});
  const result=await auth.login('learner@example.test','correct-legacy-password');
  expect(result.user.id).toBe(previous.id);
  expect((await db.getRepository(UserEntity).findOneByOrFail({id:previous.id})).emailVerifiedAt).toBeNull();
  await expect(auth.cognitoSession(identity({emailVerified:false,appUserId:previous.id}))).rejects.toThrow(UnauthorizedException);
  await expect(provider.verifyIdentity('token','oauth-nonce')).rejects.toThrow(UnauthorizedException);
});
it('rejects unverified native new identity, wrong migration email and conflicting mapping',async()=>{
  verify.mockResolvedValue(claims({email_verified:false}));
  sdk.mockResolvedValue({AuthenticationResult:{IdToken:'token',AccessToken:'private'}});
  await expect(auth.login('learner@example.test','password')).rejects.toThrow(UnauthorizedException);
  const old=await db.getRepository(UserEntity).save({email:'other@example.test',displayName:'Other',passwordHash:'unchanged'});
  await expect(auth.cognitoSession(identity({appUserId:old.id}),'native')).rejects.toThrow(UnauthorizedException);
  await db.getRepository(UserEntity).update({id:old.id},{email:'learner@example.test',cognitoSub:OTHER});
  await expect(auth.cognitoSession(identity({appUserId:old.id}),'native')).rejects.toThrow(UnauthorizedException);
  expect((await db.getRepository(UserEntity).findOneByOrFail({id:old.id})).cognitoSub).toBe(OTHER);
});
it('never links verified external email to an unmapped local account',async()=>{
  const old=await db.getRepository(UserEntity).save({email:'learner@example.test',displayName:'Original',passwordHash:'unchanged'});
  await expect(auth.cognitoSession(identity())).rejects.toThrow(ConflictException);
  expect((await db.getRepository(UserEntity).findOneByOrFail({id:old.id})).cognitoSub).toBeNull();
});

it('binds OAuth to browser, PKCE and nonce, consumes state across service instances before exchange',async()=>{
  const begin=provider.beginSignIn('Google','/dashboard'); const url=new URL(begin.url);
  expect(url.searchParams.get('scope')).toContain('aws.cognito.signin.user.admin');
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  const state=url.searchParams.get('state')!;
  await expect(provider.complete('code',state,'wrong-browser')).rejects.toThrow(UnauthorizedException);
  expect(fetch).not.toHaveBeenCalled();
  verify.mockResolvedValue(claims({nonce:begin.nonce}));
  jest.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({id_token:'token'}),{status:200}));
  await expect(provider.complete('code',state,begin.nonce)).resolves.toMatchObject({returnPath:'/dashboard',identity:{sub:SUB}});
  const request=jest.mocked(fetch).mock.calls[0][1]!;
  const form=new URLSearchParams(request.body as string);
  expect(form.get('code_verifier')).toHaveLength(43);expect(form.has('client_secret')).toBe(false);
  const another=new CognitoService(db.getRepository(SettingEntity),{send:sdk} as unknown as CognitoIdentityProviderClient,{verify});
  await expect(another.complete('new-code',state,begin.nonce)).rejects.toThrow(UnauthorizedException);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('withholds nonce mismatch, provider refusal and malformed state without unsafe retries',async()=>{
  for (const state of ['garbage','a.b.c']) await expect(provider.complete('code',state,'nonce')).rejects.toThrow(UnauthorizedException);
  const begin=provider.beginSignIn('Google'); const state=new URL(begin.url).searchParams.get('state')!;
  jest.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({id_token:'token'}),{status:200}));
  await expect(provider.complete('code',state,begin.nonce)).rejects.toThrow(UnauthorizedException);
  await expect(provider.complete('code',state,begin.nonce)).rejects.toThrow(UnauthorizedException);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('refuses disabled providers and unsafe callback return paths',()=>{
  expect(()=>provider.beginSignIn('Unknown')).toThrow(BadRequestException);
  for (const path of ['//evil.test','/\t/evil.test','/\\evil.test','https://evil.test','/a\n']) expect(safeReturnPath(path)).toBe('');
  expect(safeReturnPath('/lessons?phase=design')).toBe('/lessons?phase=design');
});
it('fails closed if durable replay storage is unavailable before any token exchange',async()=>{
  const begin=provider.beginSignIn('Google');const state=new URL(begin.url).searchParams.get('state')!;
  jest.spyOn(db.getRepository(SettingEntity),'insert').mockRejectedValue(new Error('database unavailable'));
  await expect(provider.complete('code',state,begin.nonce)).rejects.toThrow(ServiceUnavailableException);
  expect(fetch).not.toHaveBeenCalled();
});

it('managed account password failure preserves app hash/session version and deletion refuses before data writes',async()=>{
  const session=await auth.cognitoSession(identity());
  const account=new AccountService(passwordWorkFixture(), db,auth,provider);
  sdk.mockRejectedValue(Object.assign(new Error('wrong password'),{name:'NotAuthorizedException'}));
  await expect(account.changePassword(session.user.id,'wrong','New-password!123')).rejects.toThrow(UnauthorizedException);
  await expect(auth.authenticate(session.token)).resolves.toBeDefined();
  await expect(account.deleteAccount(session.user.id,'learner@example.test')).rejects.toMatchObject({response:{code:'MANAGED_ACCOUNT_ACTION_REQUIRED'}});
  const row=await db.getRepository(UserEntity).findOneByOrFail({id:session.user.id});
  expect(row.passwordHash).toBe('');expect(row.tokenVersion).toBe(0);
});
it('managed password success uses subject-bound provider credentials and revokes app sessions without bcrypt',async()=>{
  const session=await auth.cognitoSession(identity());
  sdk.mockImplementation(command=>Promise.resolve(command.constructor.name==='InitiateAuthCommand'
    ? {AuthenticationResult:{IdToken:'verified-id',AccessToken:'private-access'}} : {}));
  const account=new AccountService(passwordWorkFixture(), db,auth,provider);
  await expect(account.changePassword(session.user.id,'Old-password!123','New-password!123')).resolves.toEqual({changed:true});
  expect(sdk.mock.calls[1][0].input).toEqual({AccessToken:'private-access',PreviousPassword:'Old-password!123',ProposedPassword:'New-password!123'});
  await expect(auth.authenticate(session.token)).rejects.toThrow(UnauthorizedException);
  expect((await db.getRepository(UserEntity).findOneByOrFail({id:session.user.id})).passwordHash).toBe('');
});
it('managed recovery uses codes, rejects legacy tokens, and never calls local mail or writes bcrypt',async()=>{
  const session=await auth.cognitoSession(identity());sdk.mockImplementation(command=>Promise.resolve(command.constructor.name==='InitiateAuthCommand'
    ? {AuthenticationResult:{IdToken:'verified-id',AccessToken:'private-access'}} : {}));
  const mail={delivery:jest.fn(()=>{throw new Error('local mail must not run');})} as unknown as MailService;
  const recovery=new RecoveryService(passwordWorkFixture(), db.getRepository(UserEntity),jwt,mail,auth,provider);
  await expect(recovery.forgot('learner@example.test')).resolves.toMatchObject({delivery:'code'});
  await expect(recovery.reset('legacy-token','New-password!123')).rejects.toThrow(BadRequestException);
  await expect(recovery.reset('','New-password!123','learner@example.test','123456')).resolves.toEqual({changed:true});
  await expect(auth.authenticate(session.token)).rejects.toThrow(UnauthorizedException);
  expect((await db.getRepository(UserEntity).findOneByOrFail({id:session.user.id})).passwordHash).toBe('');
});


it('accepts a valid bounded opaque Cognito subject rather than assuming RFC UUID syntax',async()=>{
  verify.mockResolvedValue(claims({sub:'provider-opaque-sub_123'}));
  await expect(provider.verifyIdentity('signed-token')).resolves.toMatchObject({sub:'provider-opaque-sub_123'});
});
it('does not send ChangePassword when reauthentication resolves a different subject',async()=>{
  sdk.mockResolvedValue({AuthenticationResult:{IdToken:'verified-id',AccessToken:'private-access'}});
  verify.mockResolvedValue(claims({sub:OTHER}));
  await expect(provider.changePassword('learner@example.test',SUB,'Old-password!123','New-password!123')).rejects.toThrow(UnauthorizedException);
  expect(sdk).toHaveBeenCalledTimes(1);
});
it('records later real mailbox verification on the same subject without changing profile or permissions',async()=>{
  const prior=await db.getRepository(UserEntity).save({email:'learner@example.test',displayName:'Retained',passwordHash:'legacy',emailVerifiedAt:null,cognitoSub:SUB,role:'INSTRUCTOR' as const});
  await auth.cognitoSession(identity({emailVerified:true,appUserId:prior.id}),'native');
  const row=await db.getRepository(UserEntity).findOneByOrFail({id:prior.id});
  expect(row.emailVerifiedAt).not.toBeNull();expect(row.displayName).toBe('Retained');expect(row.role).toBe('INSTRUCTOR');expect(row.passwordHash).toBe('legacy');
});

it('rejects expired and tampered OAuth state before replay storage or token exchange',async()=>{
  const begin=provider.beginSignIn('Google');const state=new URL(begin.url).searchParams.get('state')!;
  const changed=(state[0]==='A'?'B':'A')+state.slice(1);
  await expect(provider.complete('code',changed,begin.nonce)).rejects.toThrow(UnauthorizedException);
  const now=Date.now();jest.spyOn(Date,'now').mockReturnValue(now+11*60_000);
  await expect(provider.complete('code',state,begin.nonce)).rejects.toThrow(UnauthorizedException);
  expect(await db.getRepository(SettingEntity).count()).toBe(0);expect(fetch).not.toHaveBeenCalled();
});
it('identifies a signed expired flow without its expired cookie, then accepts one fresh browser-bound flow',async()=>{
  const clock=jest.spyOn(Date,'now');
  const started=Date.now();clock.mockReturnValue(started);
  const original=provider.beginSignIn('Google','/learn');
  const expiredState=new URL(original.url).searchParams.get('state')!;
  clock.mockReturnValue(started+10*60_000);
  await expect(provider.complete('code',expiredState,undefined)).rejects.toMatchObject({
    response:expect.objectContaining({code:'COGNITO_FLOW_EXPIRED'}),
  });
  expect(await db.getRepository(SettingEntity).count()).toBe(0);
  expect(fetch).not.toHaveBeenCalled();expect(verify).not.toHaveBeenCalled();
  const fresh=provider.beginSignIn('Google','/learn');
  verify.mockResolvedValue(claims({nonce:fresh.nonce}));
  jest.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({id_token:'fresh-token'}),{status:200}));
  await expect(provider.complete('fresh-code',new URL(fresh.url).searchParams.get('state')!,fresh.nonce))
    .resolves.toMatchObject({returnPath:'/learn',identity:{sub:SUB}});
  expect(fetch).toHaveBeenCalledTimes(1);expect(await db.getRepository(SettingEntity).count()).toBe(1);
});
it('does not classify forged expiry or a signed future timestamp as an expired verified flow',async()=>{
  const begin=provider.beginSignIn('Google');const state=new URL(begin.url).searchParams.get('state')!;
  const [body,signature]=state.split('.');
  const forged=Buffer.from(JSON.stringify({...JSON.parse(Buffer.from(body,'base64url').toString()),exp:1})).toString('base64url')+'.'+signature;
  const now=Date.now();jest.spyOn(Date,'now').mockReturnValue(now-11*60_000);
  for(const invalid of [forged,state]) {
    await expect(provider.complete('code',invalid,undefined)).rejects.toMatchObject({
      response:expect.objectContaining({code:'COGNITO_FLOW_INVALID'}),
    });
  }
  expect(await db.getRepository(SettingEntity).count()).toBe(0);expect(fetch).not.toHaveBeenCalled();
});
it('does not claim password-reset success or revoke app state when the provider rejects the code',async()=>{
  const session=await auth.cognitoSession(identity());
  const original=await db.getRepository(UserEntity).findOneByOrFail({id:session.user.id});
  sdk.mockRejectedValue(Object.assign(new Error('private code detail'),{name:'CodeMismatchException'}));
  const recovery=new RecoveryService(passwordWorkFixture(), db.getRepository(UserEntity),jwt,{} as MailService,auth,provider);
  await expect(recovery.reset('','New-password!123','learner@example.test','wrong')).rejects.toThrow(BadRequestException);
  const after=await db.getRepository(UserEntity).findOneByOrFail({id:session.user.id});
  expect(after.passwordHash).toBe(original.passwordHash);expect(after.tokenVersion).toBe(original.tokenVersion);
  await expect(auth.authenticate(session.token)).resolves.toBeDefined();
});

// The last hop of a managed sign-out, after the app
// session is revoked: Cognito's hosted /logout. Its logout_uri must equal a
// registered logout URL byte for byte (infra/preview/terraform/cognito.tf
// `logout_urls = ["<origin>/login"]`), so nothing is ever added to it.
describe('the hosted sign-out URL',()=>{
  const HOSTED='https://example.auth.ap-southeast-1.amazoncognito.com';
  const EXACT=HOSTED+'/logout?client_id=public-client&logout_uri='+encodeURIComponent('https://learnsdlc.test/login');
  it('is the normalised domain\'s /logout with only client_id and the registered logout_uri',()=>{
    const raw=provider.signOutUrl('https://learnsdlc.test');
    expect(raw).toBe(EXACT);
    const url=new URL(raw);
    expect(url.origin).toBe(HOSTED);expect(url.pathname).toBe('/logout');expect(url.hash).toBe('');
    expect([...url.searchParams.keys()]).toEqual(['client_id','logout_uri']);
    expect(url.searchParams.get('client_id')).toBe('public-client');
    const logout=new URL(url.searchParams.get('logout_uri')!);
    expect(logout.href).toBe('https://learnsdlc.test/login');expect(logout.search).toBe('');expect(logout.hash).toBe('');
    // No state, nonce, identity or token rides a sign-out, and nothing is stored or sent.
    expect(raw).not.toMatch(/token|state|nonce|redirect_uri|response_type|#/);
    expect(sdk).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['example.auth.ap-southeast-1.amazoncognito.com','https://example.auth.ap-southeast-1.amazoncognito.com/'])(
    'normalises the configured domain %p through the same rule as sign-in',(domain)=>{
    config.cognitoDomain=domain;
    expect(provider.signOutUrl('https://learnsdlc.test')).toBe(EXACT);
    expect(new URL(provider.beginSignIn('Google').url).origin).toBe(HOSTED);
  });
  it.each(['http://example.auth.ap-southeast-1.amazoncognito.com','https://example.auth.ap-southeast-1.amazoncognito.com/prefix',
    'https://example.auth.ap-southeast-1.amazoncognito.com/?next=x','https://user:pw@example.auth.ap-southeast-1.amazoncognito.com',
    'https://example.auth.ap-southeast-1.amazoncognito.com/#frag'])('refuses a domain that is not a bare HTTPS origin %p',(domain)=>{
    config.cognitoDomain=domain;
    expect(()=>provider.signOutUrl('https://learnsdlc.test')).toThrow(ServiceUnavailableException);
  });
  it('refuses when managed sign-in is not the configured provider',()=>{
    config.authProvider='local';
    expect(()=>provider.signOutUrl('https://learnsdlc.test')).toThrow(ServiceUnavailableException);
  });
});

import 'reflect-metadata';
import { ConflictException, INestApplication, Logger, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { config, siteUrl } from '../config';
import { AuthService } from './auth.service';
import { CognitoController } from './cognito.controller';
import { CognitoFlowFailure, CognitoService } from './cognito.service';
import { GoogleController } from './google.controller';
import { GoogleService } from './google.service';
import { RATE_LIMIT_COUNTER, RATE_LIMIT_KEY, RateLimitGuard } from './rate-limit.guard';
import { IS_PUBLIC_KEY } from './auth.decorators';
import { requestLogging } from '../observability/logger';

describe('Cognito browser/controller boundary (offline provider)',()=>{
  let app:INestApplication;
  let http:Parameters<typeof request>[0];
  const previous={authProvider:config.authProvider,cognitoRedirectUrl:config.cognitoRedirectUrl};
  const managed={providers:jest.fn(),beginSignIn:jest.fn(),complete:jest.fn(),confirm:jest.fn(),resend:jest.fn(),signOutUrl:jest.fn()};
  const auth={cognitoSession:jest.fn()};
  const google={enabled:jest.fn(()=>true),beginSignIn:jest.fn(),complete:jest.fn()};
  const counters=new Map<string,number>();
  beforeAll(async()=>{
    const module=await Test.createTestingModule({controllers:[CognitoController,GoogleController],providers:[
      {provide:CognitoService,useValue:managed},{provide:AuthService,useValue:auth},{provide:GoogleService,useValue:google},
      RateLimitGuard,{provide:RATE_LIMIT_COUNTER,useValue:{hit:async(key:string)=>{const count=(counters.get(key)??0)+1;counters.set(key,count);return count;},shutdown:async()=>{}}},
    ]}).compile();
    app=module.createNestApplication({logger:false});app.setGlobalPrefix('api/v1');
    app.use(requestLogging({log:()=>{},warn:()=>{},error:()=>{}}));
    app.useGlobalPipes(new ValidationPipe({whitelist:true,forbidNonWhitelisted:true,transform:true}));
    await app.init();http=app.getHttpServer();
  });
  afterAll(async()=>{Object.assign(config,previous);await app.close();});
  beforeEach(()=>{
    jest.clearAllMocks();counters.clear();config.authProvider='cognito';config.cognitoRedirectUrl='https://learnsdlc.test/api/v1/auth/sso/callback';
    managed.providers.mockReturnValue([{id:'Google',label:'Google'}]);
    managed.beginSignIn.mockReturnValue({url:'https://pool.auth.ap-southeast-1.amazoncognito.com/oauth2/authorize?state=signed-state',nonce:'browser-nonce'});
    managed.complete.mockResolvedValue({identity:{sub:'opaque-sub',email:'learner@example.test',emailVerified:true},returnPath:'/dashboard'});
    auth.cognitoSession.mockResolvedValue({token:'private.app.token',user:{id:'learner'}});
    managed.confirm.mockResolvedValue({confirmed:true,email:'learner@example.test'});
    managed.resend.mockResolvedValue({sent:true});
  });
  afterEach(()=>{jest.restoreAllMocks();});
  const failureDestination=(response:{headers:Record<string,string>},reason:string)=>{
    const url=new URL(response.headers.location);
    expect(url.origin).toBe(new URL(siteUrl()).origin);expect(url.pathname).toBe('/login');
    expect([...url.searchParams.keys()].sort()).toEqual(['error','reference']);
    expect(url.searchParams.get('error')).toBe(reason);
    expect(url.searchParams.get('reference')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(url.searchParams.get('reference')).toBe(response.headers['x-request-id']);expect(url.hash).toBe('');
    return url.searchParams.get('reference');
  };
  it('advertises only configured managed providers and explicit account capabilities',async()=>{
    const response=await request(http).get('/api/v1/auth/providers').expect(200);
    expect(response.body).toEqual({google:true,authProvider:'cognito',confirmationRequired:true,
      ssoProviders:[{id:'Google',label:'Google'}],passwordChange:true,accountDeletion:false});
    managed.providers.mockReturnValue([]);
    const unavailable=await request(http).get('/api/v1/auth/providers').expect(200);
    expect(unavailable.body.google).toBe(false);expect(google.enabled).not.toHaveBeenCalled();
  });
  it('sets a secure browser-bound nonce and routes legacy Google start through Cognito only',async()=>{
    for(const route of ['/api/v1/auth/sso/start?provider=Google&next=%2Fdashboard','/api/v1/auth/google?next=%2Fdashboard']){
      const response=await request(http).get(route).expect(302);
      const cookies=response.headers['set-cookie'];const cookie=Array.isArray(cookies)?cookies.join(';'):String(cookies);
      expect(cookie).toContain('__Host-cognito-nonce=browser-nonce');
      for(const attribute of ['HttpOnly','Secure','SameSite=Lax','Path=/'])expect(cookie).toContain(attribute);
      expect(response.headers.location).toContain('amazoncognito.com/oauth2/authorize');
    }
    expect(google.beginSignIn).not.toHaveBeenCalled();
    await request(http).get('/api/v1/auth/google/callback?code=old-direct-code&state=old-state').expect(400);
    expect(google.complete).not.toHaveBeenCalled();
  });
  it('puts only the app token in the frontend fragment and clears the nonce after successful identity resolution',async()=>{
    const response=await request(http).get('/api/v1/auth/sso/callback?code=one-use-code&state=signed-state')
      .set('Cookie','__Host-cognito-nonce=browser-nonce').expect(302);
    expect(managed.complete).toHaveBeenCalledWith('one-use-code','signed-state','browser-nonce');
    const url=new URL(response.headers.location);
    expect(url.origin).toBe(new URL(siteUrl()).origin);expect(url.pathname).toBe('/login/callback');
    expect(url.searchParams.get('next')).toBe('/dashboard');expect(url.hash).toBe('#token=private.app.token');
    expect(url.search).not.toContain('token');expect(response.headers['cache-control']).toBe('no-store');
    expect(JSON.stringify(response.headers['set-cookie'])).toContain('__Host-cognito-nonce=;');
  });
  it('does not reflect refused provider detail, token, or next destination',async()=>{
    managed.complete.mockRejectedValue(new UnauthorizedException('private-provider-error-canary'));
    const response=await request(http).get('/api/v1/auth/sso/callback?code=secret-code&state=bad&next=https://evil.test').expect(302);
    failureDestination(response,'sso_failed');
    expect(auth.cognitoSession).not.toHaveBeenCalled();
    expect(JSON.stringify(response.headers)).not.toContain('private-provider-error-canary');
  });
  it('returns an actionable fixed link-conflict code without reflecting arbitrary provider text',async()=>{
    auth.cognitoSession.mockRejectedValueOnce(new ConflictException({code:'IDENTITY_LINK_REQUIRED',message:'private-collision-detail'}));
    const response=await request(http).get('/api/v1/auth/sso/callback?code=code&state=state').expect(302);
    failureDestination(response,'identity_link_required');
    expect(response.headers.location).not.toContain('private-collision-detail');
  });
  it('returns the typed expiry reason with the validated server correlation ID and fixed diagnostic only',async()=>{
    const warn=jest.spyOn(Logger.prototype,'warn').mockImplementation(()=>{});
    managed.complete.mockRejectedValueOnce(new CognitoFlowFailure('state','COGNITO_FLOW_EXPIRED'));
    const reference='10aa2030-4050-4060-8070-8090a0b0c0d0';
    const response=await request(http).get('/api/v1/auth/sso/callback')
      .query({code:'private-code-canary',state:'private-state-canary'}).set('X-Request-Id',reference).expect(302);
    expect(failureDestination(response,'sso_expired')).toBe(reference);
    expect(warn).toHaveBeenCalledWith(`Cognito sign-in failure stage=state code=COGNITO_FLOW_EXPIRED rid=${reference}`);
    expect(auth.cognitoSession).not.toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)+JSON.stringify(response.headers)).not.toMatch(/private-code-canary|private-state-canary/);
  });
  it('never trusts an arbitrary exception expiry code or reflects malicious provider and correlation values',async()=>{
    const warn=jest.spyOn(Logger.prototype,'warn').mockImplementation(()=>{});
    managed.complete.mockRejectedValueOnce(new UnauthorizedException({code:'COGNITO_FLOW_EXPIRED',message:'private-provider-token-email-canary'}));
    const response=await request(http).get('/api/v1/auth/sso/callback')
      .query({code:'private-authorization-canary',state:'private-state-canary',next:'https://outside.example/private-next-canary'})
      .set('X-Request-Id','private-request-canary').expect(302);
    const reference=failureDestination(response,'sso_failed');
    expect(warn).toHaveBeenCalledWith(`Cognito sign-in failure stage=callback code=COGNITO_CALLBACK_FAILED rid=${reference}`);
    expect(JSON.stringify(warn.mock.calls)+JSON.stringify(response.headers)).not.toMatch(/private-|outside\.example/);
    expect(auth.cognitoSession).not.toHaveBeenCalled();
  });
  it('logs provider refusal as a fixed stage without reflecting its error query',async()=>{
    const warn=jest.spyOn(Logger.prototype,'warn').mockImplementation(()=>{});
    const response=await request(http).get('/api/v1/auth/sso/callback')
      .query({error:'private-provider-canary\nhttps://outside.example/token',state:'private-state-canary'}).expect(302);
    const reference=failureDestination(response,'sso_failed');
    expect(warn).toHaveBeenCalledWith(`Cognito sign-in failure stage=provider code=COGNITO_PROVIDER_REFUSED rid=${reference}`);
    expect(managed.complete).not.toHaveBeenCalled();expect(auth.cognitoSession).not.toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)+JSON.stringify(response.headers)).not.toMatch(/private-|outside\.example/);
  });
  it('validates confirmation inputs before any provider call and accepts a code with canonical email',async()=>{
    await request(http).post('/api/v1/auth/confirm').send({email:'not-email',code:'123456'}).expect(400);
    await request(http).post('/api/v1/auth/confirm').send({email:'learner@example.test',code:''}).expect(400);
    await request(http).post('/api/v1/auth/confirm').send({email:'learner@example.test',code:'123456',cognitoSub:'forged'}).expect(400);
    expect(managed.confirm).not.toHaveBeenCalled();
    await request(http).post('/api/v1/auth/confirm').send({email:'Learner@Example.test',code:'123456'}).expect(200);
    expect(managed.confirm).toHaveBeenCalledWith('learner@example.test','123456');
  });
  it.each([['confirm',10],['confirm/resend',5]] as const)('allows a shared classroom address while limiting %s attempts per identity',async(route,limit)=>{
    for(let learner=0;learner<50;learner++){
      await request(http).post('/api/v1/auth/'+route).send({email:`learner-${learner}@example.test`,...(route==='confirm'?{code:'123456'}:{})}).expect(200);
    }
    for(let attempt=1;attempt<limit;attempt++){
      await request(http).post('/api/v1/auth/'+route).send({email:'Learner-0@Example.test',...(route==='confirm'?{code:'123456'}:{})}).expect(200);
    }
    await request(http).post('/api/v1/auth/'+route).send({email:'learner-0@example.test',...(route==='confirm'?{code:'123456'}:{})}).expect(429);
  });
  it('allows fifty browser starts from one classroom address',async()=>{
    for(let learner=0;learner<50;learner++)await request(http).get('/api/v1/auth/sso/start?provider=Google').expect(302);
    expect(managed.beginSignIn).toHaveBeenCalledTimes(50);
  });
  // The last hop of signing out, after the web has
  // already revoked the app session. A top-level navigation, so no bearer rides
  // it; it reads no query, sets no cookie and puts no token in any URL.
  describe('sso/signout',()=>{
    const HOSTED='https://pool.auth.ap-southeast-1.amazoncognito.com/logout?client_id=public-client&logout_uri='
      +encodeURIComponent(siteUrl()+'/login');
    const noToken=(response:{headers:Record<string,unknown>})=>{
      const location=String(response.headers.location);
      expect(location).not.toMatch(/token|#/);
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
    };
    it('sends a managed sign-out to exactly the hosted /logout URL the service builds for this site',async()=>{
      managed.signOutUrl.mockReturnValue(HOSTED);
      const response=await request(http).get('/api/v1/auth/sso/signout').expect(302);
      expect(response.headers.location).toBe(HOSTED);
      expect(managed.signOutUrl).toHaveBeenCalledTimes(1);expect(managed.signOutUrl).toHaveBeenCalledWith(siteUrl());
      noToken(response);
      expect(auth.cognitoSession).not.toHaveBeenCalled();expect(managed.complete).not.toHaveBeenCalled();
    });
    it('reads no query parameter and no bearer, so it cannot become an open redirect',async()=>{
      managed.signOutUrl.mockReturnValue(HOSTED);
      const response=await request(http).get('/api/v1/auth/sso/signout')
        .query({logout_uri:'https://outside.example/login',redirect_uri:'https://outside.example/',next:'//outside.example',
          client_id:'another-client',token:'private-token-canary'})
        .set('Authorization','Bearer private-bearer-canary').expect(302);
      expect(response.headers.location).toBe(HOSTED);
      expect(managed.signOutUrl).toHaveBeenCalledWith(siteUrl());
      expect(JSON.stringify(response.headers)).not.toMatch(/outside\.example|another-client|private-/);
      noToken(response);
    });
    it('sends a local sign-out to this site\'s /login and never asks Cognito',async()=>{
      config.authProvider='local';
      const response=await request(http).get('/api/v1/auth/sso/signout?logout_uri=https%3A%2F%2Foutside.example%2Flogin').expect(302);
      expect(response.headers.location).toBe(siteUrl()+'/login');
      expect(managed.signOutUrl).not.toHaveBeenCalled();
      noToken(response);
    });
    it('is public and carries the same per-address limit as sso/start',()=>{
      const handler=(CognitoController.prototype as unknown as Record<string,object>).signOut;
      expect(typeof handler).toBe('function');
      expect(Reflect.getMetadata(IS_PUBLIC_KEY,handler)).toBe(true);
      expect(Reflect.getMetadata(RATE_LIMIT_KEY,handler)).toEqual({max:config.signInMaxPerAddress,windowSeconds:60});
      expect(Reflect.getMetadata(RATE_LIMIT_KEY,handler)).toEqual(Reflect.getMetadata(RATE_LIMIT_KEY,CognitoController.prototype.start));
    });
  });
});

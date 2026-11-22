import { EventEmitter } from 'events';
import { isHealthProbe, loggablePath, requestLogging } from './logger';

describe('isHealthProbe', () => {
  it('matches the health controller routes, with or without the global prefix', () => {
    expect(isHealthProbe('/api/v1/health')).toBe(true);
    expect(isHealthProbe('/api/v1/health/live')).toBe(true);
    expect(isHealthProbe('/api/v1/health/ready')).toBe(true);
    expect(isHealthProbe('/health/ready/')).toBe(true);
    expect(isHealthProbe('/api/v1/health/ready?verbose=1')).toBe(true);
  });

  it('does not match a request path that merely contains the word', () => {
    // The incident drill's probe is a learner action, not a load-balancer poll.
    expect(isHealthProbe('/api/v1/phases/f4c1/drill/health')).toBe(false);
    expect(isHealthProbe('/api/v1/health/ready/../phases')).toBe(false);
    expect(isHealthProbe('/api/v1/healthz')).toBe(false);
    expect(isHealthProbe('/api/v1/phases/health')).toBe(false);
  });
});

describe('loggablePath', () => {
  it('keeps the path and drops the whole query', () => {
    expect(loggablePath('/api/v1/phases/f4c1')).toBe('/api/v1/phases/f4c1');
    expect(loggablePath('/api/v1/audit?cursor=abc&limit=50')).toBe('/api/v1/audit');
    expect(loggablePath('/api/v1/audit?')).toBe('/api/v1/audit');
    expect(loggablePath('?code=secret')).toBe('');
  });

  // The preview capability is the whole authorisation for a
  // learner's running app: whoever has the string can open the app until it
  // stops. It travels in the path rather than in a header because a browser
  // frame's own fetches carry neither, which puts it in exactly the place this
  // function exists to keep secrets out of.
  describe('the live preview capability', () => {
    const capability = 'HB0m3Q1s6fVn2rTyXk9pLu4A';

    it('keeps the route and drops the capability, with or without the global prefix', () => {
      expect(loggablePath(`/api/v1/preview/${capability}/api/tasks`)).toBe('/api/v1/preview/…');
      expect(loggablePath(`/api/v1/preview/${capability}/`)).toBe('/api/v1/preview/…');
      expect(loggablePath(`/api/v1/preview/${capability}`)).toBe('/api/v1/preview/…');
      expect(loggablePath(`/preview/${capability}/app.js`)).toBe('/preview/…');
    });

    it('leaves every other path alone', () => {
      expect(loggablePath('/api/v1/phases/f4c1/preview')).toBe('/api/v1/phases/f4c1/preview');
      expect(loggablePath('/api/v1/previewing/things')).toBe('/api/v1/previewing/things');
    });
  });
});

describe('requestLogging', () => {
  it.each([undefined,'','private text rid=forged\nsecond-line','a'.repeat(5000),['one','two'],42])('replaces malformed caller request references without reflecting them (%#)', value => {
    const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const req = { headers: {'x-request-id':value}, method:'POST', originalUrl:'/api/v1/phases/p/interview/ask', requestId:'' };
    const res = Object.assign(new EventEmitter(), {statusCode:503,setHeader:jest.fn()});
    const next=jest.fn();
    requestLogging(logger as never)(req as never,res as never,next);
    res.emit('finish');
    expect(req.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(res.setHeader).toHaveBeenCalledWith('x-request-id',req.requestId);
    expect(logger.error.mock.calls[0][0]).toContain(`rid=${req.requestId}`);
    expect(logger.error.mock.calls[0][0]).not.toContain('private text');
    expect(logger.error.mock.calls[0][0]).not.toContain('second-line');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('preserves a bounded UUID correlation reference consistently across request, response and log',()=>{
    const id='F4EF0481-0C3E-4533-83B7-4CC7D071D02D';
    const logger={log:jest.fn(),warn:jest.fn(),error:jest.fn()};
    const req={headers:{'x-request-id':id},method:'POST',originalUrl:'/api/v1/phases/p/interview/ask',requestId:''};
    const res=Object.assign(new EventEmitter(),{statusCode:503,setHeader:jest.fn()});
    requestLogging(logger as never)(req as never,res as never,()=>undefined);res.emit('finish');
    expect(req.requestId).toBe(id.toLowerCase());
    expect(res.setHeader).toHaveBeenCalledWith('x-request-id',id.toLowerCase());
    expect(logger.error.mock.calls[0][0]).toContain(`rid=${id.toLowerCase()}`);
  });

  const drive = (method: string, originalUrl: string, statusCode: number) => {
    const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const res = Object.assign(new EventEmitter(), { statusCode, setHeader: jest.fn() });
    requestLogging(logger as never)({ headers: {}, method, originalUrl } as never, res as never, () => undefined);
    res.emit('finish');
    return logger;
  };

  it('stays quiet for a healthy probe and speaks up for a failing one', () => {
    expect(drive('GET', '/api/v1/health/ready', 200).log).not.toHaveBeenCalled();
    expect(drive('GET', '/api/v1/health/ready', 503).error).toHaveBeenCalledTimes(1);
  });

  it('logs the incident drill health check, which a substring match on /health would hide', () => {
    const logger = drive('POST', '/api/v1/phases/f4c1/drill/health', 200);
    expect(logger.log).toHaveBeenCalledTimes(1);
    expect(logger.log.mock.calls[0][0]).toContain('POST /api/v1/phases/f4c1/drill/health 200');
  });

  // google.controller.ts moves the minted session into the URL fragment
  // because a query string is the part that gets logged, and a request logger
  // that wrote req.originalUrl would put the authorization code back into the
  // access log the runbook says to ship to an aggregator.
  it('logs the Google callback without the authorization code or the state', () => {
    const code = '4%2F0AVMBsJi-authorization-code';
    const state = 'nonce-9c2f';
    const logger = drive('GET', `/api/v1/auth/google/callback?code=${code}&state=${state}&scope=email`, 302);

    expect(logger.log).toHaveBeenCalledTimes(1);
    const line = String(logger.log.mock.calls[0][0]);
    expect(line).toContain('GET /api/v1/auth/google/callback 302');
    expect(line).not.toContain(code);
    expect(line).not.toContain(state);
    expect(line).not.toContain('code=');
    expect(line).not.toContain('state=');
    expect(line).not.toContain('?');
  });

  it('drops the query on the failing callback too, which is the one an operator reads', () => {
    const logger = drive('GET', '/api/v1/auth/google/callback?code=leaked-on-failure&state=n1', 400);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const line = String(logger.warn.mock.calls[0][0]);
    expect(line).toContain('GET /api/v1/auth/google/callback 400');
    expect(line).not.toContain('leaked-on-failure');
    // The correlation id is what ties a log line to a reported failure, so
    // stripping the query costs the operator nothing.
    expect(line).toMatch(/rid=[0-9a-f-]{36}/);
  });
});

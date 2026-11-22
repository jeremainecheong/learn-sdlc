import { All, Controller, NotFoundException, Param, Req, Res } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { Public } from '../auth/auth.decorators';
import { config, webOriginList } from '../config';
import { SocketRunnerStatus } from '../execution/sandbox.service';
import { SandboxService } from '../execution/sandbox.service';
import { PREVIEW_DOOR_PREFIX, PreviewService } from './preview.service';

/**
 * The preflight the opaque-origin frame makes, answered before the API's own
 * CORS middleware refuses it.
 *
 * The preview frame has `sandbox` without `allow-same-origin`, so its document
 * has an opaque origin and every fetch it makes carries `Origin: null`. A JSON
 * POST is therefore preflighted, and `main.ts`'s `enableCors` (an allow list
 * of the web origins, quite rightly) answers that preflight 204 with no
 * `Access-Control-Allow-Origin` at all, which the browser reads as a refusal.
 * The learner's app could then read but never write, and the symptom is a
 * button in their own application that silently does nothing.
 *
 * So the door answers its own preflight, one path prefix, before the general
 * rule gets to it. `Allow-Credentials` is deliberately absent: `null` and
 * credentials together is the combination that would let any sandboxed page
 * anywhere make authenticated calls, and the capability in the path is the
 * whole authorisation here.
 */
export function previewDoorCors() {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== 'OPTIONS' || !req.originalUrl.startsWith(`${PREVIEW_DOOR_PREFIX}/`)) {
      next();
      return;
    }
    res.setHeader('Access-Control-Allow-Origin', 'null');
    res.vary('Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    res.setHeader('Access-Control-Max-Age', '600');
    res.setHeader('Cache-Control', 'no-store');
    res.statusCode = 204;
    res.end();
  };
}

/**
 * The door: the one way a browser reaches a learner's running application.
 *
 * Public, and on a controller of its own so no JWT guard ever sees it: the
 * frame is opaque-origin and carries no cookie, no header and no token, only
 * the unguessable capability in the path. An unknown, expired or someone
 * else's capability is **404 and never 403**: a 403 would tell whoever is
 * guessing that the session exists.
 *
 * A path under `api/` is the learner's own API, proxied to the child the
 * runner supervises. Everything else is a file out of their built front end,
 * served by the runner itself out of `web/dist`. One door, one origin, and the
 * app's own port is never returned to anyone.
 */
@Public()
@Controller('preview')
export class PreviewDoorController {
  constructor(
    private readonly preview: PreviewService,
    private readonly sandbox: SandboxService,
  ) {}

  /** `/preview/<capability>`: no trailing slash. The app's own document. */
  @All(':capability')
  root(
    @Param('capability') capability: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    return this.serve(capability, '', req, res);
  }

  /** `/preview/<capability>/<anything>`: a file, a hash route, or their API. */
  @All(':capability/*previewPath')
  rest(
    @Param('capability') capability: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    // Express 5 names wildcards and returns their decoded path segments as
    // an array. Rejoin once so nested assets and API paths reach the runner.
    const path = req.params.previewPath;
    return this.serve(capability, Array.isArray(path) ? path.join('/') : path || '', req, res);
  }

  private async serve(
    capability: string,
    at: string,
    req: Request,
    res: Response,
  ): Promise<void> {
    const session = await this.preview.resolve(capability);
    if (!session) throw new NotFoundException('no such preview');
    const runnerId = this.preview.runnerIdOf(session);

    this.headers(res);
    try {
      if (at === 'api' || at.startsWith('api/')) {
        await this.proxy(runnerId, at, req, res);
        return;
      }
      const asset = await this.sandbox.assetApp(runnerId, at);
      const body = this.withBase(asset, capability);
      res.setHeader('content-type', asset.contentType);
      res.status(asset.status).send(body);
    } catch (err) {
      this.refuse(res, err);
    }
  }

  /** One request from the learner's browser to the learner's own API. */
  private async proxy(runnerId: string, at: string, req: Request, res: Response): Promise<void> {
    const answer = await this.sandbox.proxyApp(
      runnerId,
      req.method,
      `/${at}${queryOf(req.originalUrl)}`,
      {
        ...(req.headers['content-type'] ? { 'content-type': String(req.headers['content-type']) } : {}),
        ...(req.headers.accept ? { accept: String(req.headers.accept) } : {}),
      },
      requestBody(req),
    );
    // The frame is opaque-origin, so its own fetches are cross-origin with
    // Origin: null. No Allow-Credentials: the capability in the path is the
    // authorisation, and `null` plus credentials is the pairing that would let
    // any sandboxed page anywhere call this API as somebody.
    res.setHeader('Access-Control-Allow-Origin', 'null');
    res.vary('Origin');
    const type = answer.headers['content-type'] || answer.headers['Content-Type'];
    if (type) res.setHeader('content-type', type);
    res.status(answer.status).send(answer.body);
  }

  /**
   * The headers that make an app in a frame safe to look at.
   *
   * `X-Frame-Options` has to be removed rather than overwritten: helmet sets
   * SAMEORIGIN for the whole API in main.ts, which is right for every other
   * route and is exactly what would stop the workspace framing this one.
   * `frame-ancestors` replaces it with the narrower rule, and the `sandbox`
   * directive says the same thing the iframe attribute says, so a learner who
   * opens their app in a new tab gets the same restrictions they had in the
   * panel.
   */
  private headers(res: Response): void {
    res.removeHeader('X-Frame-Options');
    const ancestors = webOriginList(config.webOrigin).filter(Boolean).join(' ');
    res.setHeader(
      'Content-Security-Policy',
      `frame-ancestors ${ancestors || "'none'"}; sandbox allow-scripts allow-forms allow-modals`,
    );
    // Nothing a preview serves may be cached: the next start of the same phase
    // is a different application behind the same-looking URL, and the URL
    // itself carries a credential.
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.removeHeader('Set-Cookie');
    // Global CORS permits credentials for the portal. Preview responses use
    // their path capability only, including when the frame sends Origin:null;
    // do not inherit the portal's credential permission after overriding ACAO.
    res.removeHeader('Access-Control-Allow-Credentials');
    // The frame runs without `allow-same-origin`, so the document inside it
    // has an **opaque** origin, and helmet's `Cross-Origin-Resource-Policy:
    // same-origin` then refuses to hand that document the bundle it was just
    // served, which is the same origin by URL and a different one by policy.
    // Measured in Chrome: the HTML loads (a navigation is exempt) and
    // `app.js` fails with net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin, so the
    // panel shows a working session over a blank page. Nothing is widened by
    // saying so: every byte here is already behind the capability, and the
    // only reader is the frame this header is for.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  }

  /**
   * The one rewrite the door makes: `<base href>` into the pack's own HTML.
   *
   * That single tag is what makes the learner's front end work unchanged. It
   * fetches `api/lists`, relative, exactly as it does under `docker compose
   * up`; without the base every one of those requests would go to the web
   * origin's own `/api` and the preview would be a blank page with no error in
   * it.
   */
  private withBase(
    asset: { contentType: string; bytes: Buffer; body: string },
    capability: string,
  ): Buffer {
    if (!asset.contentType.startsWith('text/html')) return asset.bytes;
    const base = `<base href="${PREVIEW_DOOR_PREFIX}/${capability}/">`;
    const html = asset.body;
    const head = html.indexOf('<head>');
    if (head === -1) return Buffer.from(`${base}${html}`, 'utf-8');
    const at = head + '<head>'.length;
    return Buffer.from(`${html.slice(0, at)}${base}${html.slice(at)}`, 'utf-8');
  }

  /**
   * What the runner refused with, in the door's own words.
   *
   * 404 for a session it has forgotten, so an id that has aged out reads the
   * same as one that never existed. 409 for a session that exists but is not
   * serving yet: the panel's own state, and a plain sentence rather than a
   * stack, because whatever is in the frame is what the learner sees.
   */
  private refuse(res: Response, err: unknown): void {
    if (err instanceof SocketRunnerStatus && err.status === 404) {
      throw new NotFoundException('no such preview');
    }
    if (err instanceof SocketRunnerStatus && err.status === 409) {
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.status(409).send('The app is not running.');
      return;
    }
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.status(502).send('The app could not be reached.');
  }
}

/** The query string of a URL, `?` included, or the empty string. */
function queryOf(url: string): string {
  const at = url.indexOf('?');
  return at === -1 ? '' : url.slice(at);
}

/**
 * The bytes a proxied request carries.
 *
 * `express.json()` runs in front of every route in this process and has
 * already turned a JSON body into an object by the time a controller sees it,
 * so the exact bytes are gone; re-serialising is the honest reconstruction,
 * and it is what the learner's own Flask app will parse either way. A body of
 * any other type was never parsed, and `content-length: 0` means there is
 * nothing to send rather than an empty object to invent.
 */
function requestBody(req: Request): Buffer {
  const raw = (req as Request & { rawBody?: Buffer }).rawBody;
  if (Buffer.isBuffer(raw)) return raw;
  // A request that carried no bytes at all: `express.json()` leaves `req.body`
  // as `{}` for those exactly as it does for a literal `{}`, and only the
  // headers can tell the two apart. `transfer-encoding: chunked` is the other
  // way a body arrives, with no content-length to declare it.
  const declared = req.headers['content-length'];
  const chunked = String(req.headers['transfer-encoding'] || '').includes('chunked');
  if (declared === '0' || (declared === undefined && !chunked)) return Buffer.alloc(0);
  const body: unknown = req.body;
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body, 'utf-8');
  if (body && typeof body === 'object') {
    const type = String(req.headers['content-type'] || '');
    if (type.includes('urlencoded')) {
      return Buffer.from(new URLSearchParams(body as Record<string, string>).toString(), 'utf-8');
    }
    return Buffer.from(JSON.stringify(body), 'utf-8');
  }
  return Buffer.alloc(0);
}

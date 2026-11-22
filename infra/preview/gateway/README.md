# Invitation gate

A small front door for the [reference AWS deployment](../../../docs/deployment/preview.md): only people holding an invitation reach the site at all. It sits in front of LearnSDLC's own sign-in and does not replace it, or roles, class membership or learner ownership. Caddy still passes the application's original `Authorization` header and request body to the API.

## In Compose

The service is `preview-gate` in `infra/preview/compose.yaml`: internal TCP port **8080**, uid and gid **10001**, read-only filesystem, every capability dropped, `no-new-privileges`. It publishes no port; Caddy alone publishes 80 and 443. It needs no application volume and no AWS credentials.

| Setting | Value |
| --- | --- |
| `GATE_SITE_HOST` | The exact HTTPS hostname, without scheme or port; the same as Caddy's `SITE_HOST` |
| `GATE_SECRET_FILE` | `/run/secrets/preview-gate.json` by default |
| `GATE_COOKIE_TTL_SECONDS` | `604800` (seven days) by default; 60 seconds to 31 days |
| `GATE_PORT` | `8080` by default |
| Health | Internal `GET /healthz`, which also checks that the secret file can be read |

Mount the **folder** that holds the JSON file, read-only, not the file itself, so an atomic replacement of the file stays visible. The file should be owned by 10001 with mode 0600, or root:10001 with mode 0640, in a folder the gate can traverse. Mount none of the application's other secrets here. From outside, `/healthz` and `/check` are behind the gate like everything else.

The file holds only the signing key and the invitation hashes, never the invitation codes themselves:

```json
{
  "signing_key": "<base64url of at least 32 random bytes>",
  "invites": [
    {"token_sha256": "<64 lowercase hexadecimal characters>", "expires_at": 2000000000, "revoked": false}
  ]
}
```

Keep the real file out of version control, image layers, environment values, Terraform state and logs.

## Issuing and revoking invitations

Run `invite.py` on the host, or wherever the secret file lives, with private paths:

```sh
python3 infra/preview/gateway/invite.py \
  --secret-file <path to preview-gate.json> \
  --site-host <your site host> \
  --output <a new private file for this invitation> \
  --days 7
```

It takes a lock (`preview-gate.json.lock`) so two issuers cannot collide, writes files atomically, never overwrites an existing output file, keeps an existing secret file's owner and group when run as root, and never prints the code. New files start at mode 0600; set the runtime owner before mounting. The output file is the one place that holds the invitation's address and code: send it only to the person invited. Nothing here sends e-mail.

To revoke an invitation, set its `revoked` to `true` (or remove its hash) in an atomically replaced file with the same owner and permissions, holding the same lock. The gate rereads the file on every check, and a missing or malformed file shuts everyone out. Rotating the signing key ends every existing cookie; bringing an invitation's expiry forward ends the cookies issued from it.

The address `/_preview/access/<code>` swaps a valid code for the signed `__Host-learnsdlc-preview` cookie and redirects (303) to `/`. A keyboard-accessible POST form at `/_preview/access` does the same without putting the code in an address, and accepts only same-host HTTPS origins. The cookie is `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, has no `Domain`, is tied to the invitation's hash and expires no later than the invitation. Responses are `no-store`, `no-referrer` and `noindex`, and error pages never echo a code or an address.

## Routing and the one exception

Caddy sends `/api`, `/api/*`, `/socket.io` and `/socket.io/*` to `api:4000` and everything else to `web:3000`, after asking the gate's `/check`. Only that check request has the `Authorization` header removed; the application's own request keeps it. Plain HTTP redirects to HTTPS, and Caddy manages the certificate.

One application path skips the invitation: `/api/v1/preview/` followed by a 32-character base64url preview capability and an optional sub-path (including `OPTIONS`). A learner's previewed app runs in an opaque-origin frame that sends no cookies, so this path reaches the API's capability-checked preview door directly; the API still checks the capability's validity, expiry, sandbox headers and CORS. No other API route becomes public. The gate reads Caddy's original request URI, refuses traversal, double decoding and encoded separators, and never follows a return address from the client. The trigger route `POST /api/v1/auth/cognito/migrate` also bypasses the gate in the Caddyfile, because the [Cognito trigger](../../../docs/deployment/cognito-sso.md) has no cookie; the API authenticates it by its own signature.

New WebSocket connections need the cookie too. An open stream cannot be re-checked frame by frame, so Caddy closes API streams after five minutes and the client reconnects through both the gate and the API's sign-in. Revoking an invitation therefore does not cut a stream that is already open.

Caddy discards its HTTP access, error and proxy logs, because addresses can carry invitation codes and preview capabilities; its start-up and certificate logs remain. Do not turn on debug or access logging. The gate itself logs no requests or tracebacks, accepts form bodies of at most 2,000 bytes, gives each request five seconds and serves at most 32 connections at once. Watch its availability with the health check, since request logs are deliberately absent.

## Tests

```sh
python3 -m unittest discover -s infra/preview/gateway -p 'test_*.py' -v
docker build -t learnsdlc-preview-gate:local infra/preview/gateway
python3 infra/preview/gateway/test_caddy.py
node infra/preview/gateway/test_native_form.cjs
```

- The unit tests (`test_gate.py`, `test_invite.py`) also run under `npm run test:infra`, with the other infrastructure unit tests. They cover cookie tampering, expiry, revocation and key rotation, exact URI parsing, the request deadline and body limit, same-origin form handling and concurrent issuing. `test_caddy.py` and `test_upstream.py` hold no `unittest` cases, so `discover` runs nothing from them.
- `test_caddy.py` runs the gate and Caddy in throwaway containers and networks on random loopback ports, with a local certificate authority, invented credentials and a stand-in upstream (`test_upstream.py`). It checks the HTTPS redirect, protected routes, header and body forwarding, the capability exception, traversal refusal, WebSocket upgrades, shutting everyone out when the gate is down, and that no request log leaks. It needs Docker and the image built above, and it removes what it created.
- `test_native_form.cjs` drives the invitation form in a real Chromium against a throwaway Caddy and gate. It needs Playwright, the two local images and a free loopback port 443.

None of these touch AWS or a real application, and none prove public DNS, certificate issuance, file permissions on a real host or a real sign-in.

References: [Caddy forward authentication](https://caddyserver.com/docs/caddyfile/directives/forward_auth), [Caddy reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy), [Caddy logging](https://caddyserver.com/docs/caddyfile/directives/log).

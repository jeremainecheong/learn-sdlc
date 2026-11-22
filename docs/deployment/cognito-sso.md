# Cognito sign-in

The [reference AWS deployment](preview.md) can hand passwords, e-mail confirmation and single sign-on to Amazon Cognito. LearnSDLC still keeps its own accounts, roles, classes and learning records in its database: Cognito proves who someone is, and the API links a verified Cognito subject to the existing learner id. A matching e-mail address alone never links an existing account. The API uses Cognito only when it runs with `AUTH_PROVIDER=cognito`; the default, `local`, keeps passwords in the application.

| Piece | Where |
|---|---|
| User pool, app client, domain, trigger function, its secret and log group | [`infra/preview/terraform/cognito.tf`](../../infra/preview/terraform/cognito.tf) |
| Trigger function source | [`infra/preview/cognito/migration.py`](../../infra/preview/cognito/migration.py) |
| Trigger packager, Google provider helper, offline Terraform check | `infra/preview/cognito/package.py`, `provision_google.py`, `verify_terraform.py` |
| API side | `apps/api/src/auth/cognito.service.ts`, `cognito.controller.ts`, `apps/api/src/identity-migration`, `apps/api/src/config/auth.ts` |

## What the module configures

| Setting | Value |
|---|---|
| Pool | Essentials tier, e-mail address as the case-insensitive user name, deletion protection and `prevent_destroy` |
| Passwords | At least 8 characters, no composition rules; the application's own password checks still apply |
| Registration | Through LearnSDLC's own form, which sends a signed proof to Cognito; Cognito then sends a confirmation code |
| Recovery | Verified e-mail only, by code; no SMS |
| App client | Public (no client secret), password and refresh-token sign-in, OAuth authorisation-code flow only, a single callback, token revocation on |
| Callback | `https://<preview_host>/api/v1/auth/sso/callback`; sign-out returns to `https://<preview_host>/login` |
| Tokens | Access and id tokens 15 minutes, refresh tokens 30 days |
| Readable attributes | `email`, `email_verified`, `name`, `custom:learnsdlc_id` (immutable) |
| Writable attributes | `email` and `name` only; users can never set their verified status or the LearnSDLC id |
| OAuth scopes | `openid email profile aws.cognito.signin.user.admin` |
| Identity providers | Cognito itself, plus the names in `cognito_identity_providers` (empty by default) |
| E-mail | Cognito's default e-mail service |
| Trigger | Python 3.13 on ARM64, 512 MB, 5-second timeout, with no network attachment, no learner access and no database or application-secret access; its role can read only its own key and write its own log group |

The application validates the OAuth state, nonce and PKCE (S256) values itself; Cognito's client settings do not force a client to use PKCE.

## Checking it without AWS

```sh
python3 infra/preview/cognito/package.py
python3 -m unittest discover -s infra/preview/cognito -p 'test_*.py' -v
terraform -chdir=infra/preview/terraform init -backend=false
python3 infra/preview/cognito/verify_terraform.py --terraform "$(command -v terraform)"
```

`package.py` writes a deterministic, source-only `.preview/cognito/migration.zip`, which git ignores; set `cognito_migration_zip_path` to use another file. `verify_terraform.py` copies the module and the Cognito plan tests into a temporary folder, reuses the providers that `init` installed, never copies state or variable files, and runs the tests against a mocked provider. The Python tests mock every AWS and HTTPS call, and `npm run test:infra` runs them with the other infrastructure unit tests. None of these prove that a real sign-in or a real e-mail works.

## Turning it on

1. Apply the module (see the [deployment guide](preview.md#deploying)), then read the outputs the application needs:

   ```sh
   terraform -chdir=infra/preview/terraform output -raw cognito_user_pool_id
   terraform -chdir=infra/preview/terraform output -raw cognito_client_id
   terraform -chdir=infra/preview/terraform output -raw cognito_domain
   terraform -chdir=infra/preview/terraform output -raw cognito_redirect_url
   terraform -chdir=infra/preview/terraform output -raw cognito_migration_secret_arn
   ```

2. Generate one random 32-byte key without printing it. Store it in the `cognito_migration_secret_arn` secret as JSON with exactly one field, `hmacKey`, holding the key as 64 lowercase hexadecimal characters. Give the API the same 64 characters as `COGNITO_MIGRATION_SECRET`. Write secrets through files with owner-only permissions, never through Terraform variables or command-line arguments. The trigger caches the key for at most 60 seconds, and only one key is accepted at a time, so rotate it on both sides together.
3. Add these to the API's settings (`/srv/learnsdlc/secrets/api.env` in the reference deployment), run the migrations, and restart the API:

   ```text
   AUTH_PROVIDER=cognito
   COGNITO_USER_POOL_ID=<cognito_user_pool_id output>
   COGNITO_CLIENT_ID=<cognito_client_id output>
   COGNITO_DOMAIN=<cognito_domain output, including https://>
   COGNITO_REDIRECT_URL=<cognito_redirect_url output>
   COGNITO_MIGRATION_SECRET=<the same 64-character key>
   COGNITO_PROVIDERS=<comma-separated providers you have configured, or empty>
   ```

   The API refuses to start if the pool id, client id, domain or callback is malformed.

## How existing accounts move over

The trigger handles Cognito's user-migration events. When someone signs in, or asks to reset a password, with an address Cognito does not know yet, the trigger posts a signed request to `POST /api/v1/auth/cognito/migrate`. The reverse proxy lets that one route past the invitation gate, because the trigger holds no invitation cookie; keep the site's HTTPS reachable from AWS Lambda.

- The body is canonical JSON (sorted keys, no extra spaces, UTF-8): the e-mail address, the password (or `null` for a reset), the pool id and the trigger name. The signature is HMAC-SHA256 over `timestamp + "." + nonce + "." + body`, sent in `X-Cognito-Migration-Timestamp`, `X-Cognito-Migration-Nonce` and `X-Cognito-Migration-Signature`. Bodies are at most 4 KiB each way.
- The API checks the signature, the pool and trigger, that the timestamp is within 60 seconds and that the nonce has not been used, before it looks the account up. It answers only with the account's id, e-mail, verified flag and display name, and only after checking the password; a reset without a password is accepted only for an address the application had already verified.
- The trigger sets `custom:learnsdlc_id` to the application's account id and keeps the real verified flag. A sign-in migration ends `CONFIRMED`, a reset migration `RESET_REQUIRED`; neither sends a welcome message.

Native registration is guarded the same way: Cognito's pre-sign-up event must carry a proof the API signed (`signup.<timestamp>.<nonce>.<email>.<poolId>`) after its own registration checks. A sign-up straight against Cognito without that proof is refused, and the trigger never confirms or verifies a native sign-up by itself. External-provider and administrator sign-ups pass through unchanged, and an external identity still needs a verified e-mail before the application accepts it.

The trigger works within Cognito's 5-second deadline with its own shorter one, does not retry by itself, and logs no event, password or provider reply.

## Adding Google

1. In Google Cloud, create a **Web application** OAuth client that asks only for `openid`, `email` and `profile`. Its authorised redirect URI is the `cognito_google_redirect_url` output (ending `/oauth2/idpresponse`), not the application's own callback.
2. Write a local JSON file with owner-only permissions:

   ```json
   {
     "awsProfile": "<your operator profile>",
     "awsRegion": "ap-southeast-1",
     "expectedAccountId": "<your AWS account id>",
     "userPoolId": "<cognito_user_pool_id output>",
     "clientId": "<Google OAuth client id>",
     "clientSecret": "<Google OAuth client secret>"
   }
   ```

3. Check it, then create or update the provider:

   ```sh
   python3 infra/preview/cognito/provision_google.py --config <your file>
   python3 infra/preview/cognito/provision_google.py --config <your file> --apply
   ```

   The helper checks the account, creates or updates only the Google provider, maps `email`, `email_verified` and `name`, keeps the secret out of process arguments and output, and never reads it back. Do not import the provider into Terraform: its secret would land in the state.
4. Add `Google` to `cognito_identity_providers`, apply, and set `COGNITO_PROVIDERS=Google` in the API's settings.
5. Sign in once with a real Google account, sign out and sign in again before you call it working.

`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` belong to the API's own direct Google sign-in in `local` mode, and are not used with Cognito.

## Adding an institutional provider

Cognito can also federate an organisation's SAML 2.0 or OpenID Connect provider. Agree these with the provider's administrators before you enable it:

| SAML 2.0 | OpenID Connect |
| --- | --- |
| Metadata URL or XML, signing certificate and its rotation | Issuer and discovery URL; client registration and how the secret is delivered |
| A stable `NameID` that is never reassigned (not an e-mail address) | A stable `sub` and how reassignment is handled |
| E-mail and display-name claims | `email` and `name`, with the `openid email profile` scopes |
| A signed claim that can map to Cognito's `email_verified` | A trusted `email_verified` claim |
| ACS URL `<cognito_domain>/saml2/idpresponse`, entity id `urn:amazon:cognito:sp:<cognito_user_pool_id>` | Callback `<cognito_domain>/oauth2/idpresponse` |

A mapped e-mail is not verified by default, and the application refuses an external identity without a verified e-mail. Never mark addresses verified because of their domain alone. See AWS's [SAML](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-saml-idp.html), [OIDC](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-oidc-idp.html) and [attribute mapping](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-specifying-attribute-mapping.html) guides.

## Before real learners use it

- **E-mail.** Cognito's default e-mail service has a small daily sending quota per account. Configure Amazon SES for the user pool before a class registers.
- **Password reset and sessions.** Cognito's password change and the application's session revocation are two separate steps. If the second fails after the first succeeded, the password has changed but sessions issued earlier stay valid until they expire. Do not treat a successful reset as proof that old sessions ended.
- **Deleting an account** in Cognito does not delete the application's records, and the reverse is also true; delete both deliberately.
- **Test the flows** with separate test accounts: native registration (wrong, expired and resent codes), existing accounts with verified and unverified addresses, wrong passwords, resets, Google sign-in and return, cancelled consent, tampered OAuth state, a replayed migration request and a missing key. Check that account, project and role ids are unchanged after each and that a failure never creates or overwrites an account.

AWS references: [user migration trigger](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-lambda-migrate-user.html), [trigger behaviour](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-working-with-lambda-triggers.html), [social providers](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-social-idp.html), [e-mail settings](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-email.html), [quotas](https://docs.aws.amazon.com/cognito/latest/developerguide/quotas.html).

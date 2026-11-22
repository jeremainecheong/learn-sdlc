# Reference AWS deployment

This folder holds the code for hosting LearnSDLC on AWS with one EC2 host for the trusted services and AWS Lambda MicroVMs for learner code. The [deployment guide](../../docs/deployment/preview.md) explains what it builds, what you need, how to deploy and operate it, and how to take it down.

| Path | What it is |
|---|---|
| [`terraform/`](terraform/README.md) | The Terraform module for every AWS resource |
| `compose.yaml` | The services that run on the host: PostgreSQL, Redis, the API, the web app, the invitation gate and Caddy |
| `Caddyfile` | The reverse proxy: TLS, the invitation check, routing to the API and the web app, retained build assets |
| [`gateway/`](gateway/README.md) | The invitation gate and its `invite.py` |
| `cognito/` | The Cognito trigger function, its packager, the Google provider helper and an offline Terraform check ([Cognito sign-in](../../docs/deployment/cognito-sso.md)) |
| `static_assets.py` | Keeps the previous release's immutable Next.js build files available across a release |

The MicroVM controller and guest image that run learner code are in [`../microvm`](../microvm), described in the [controller guide](../../docs/deployment/microvm-controller.md) and the [guest image guide](../../docs/deployment/microvm-guest.md).

# LearnSDLC documents

Every document in the repository, one line each, grouped by what you want to do. The [front page](../README.md) has the quick start.

## Running it

- [Running it on your own machine](local-run.md): both local modes in full, the AI key, the ports, the data, resetting, hosting a class from one laptop and the proof script.
- [Configuration](configuration.md): every environment variable, its default and what it does.
- [Troubleshooting](troubleshooting.md): the failures people meet, with their messages, causes and fixes.

## Teaching with it

- [User guide](user-guide.md): what learners, instructors and administrators see and do.
- [Teacher project upload](teacher-project-upload.md): preparing, uploading, sealing, validating, previewing, publishing and exporting a project of your own, and sign-off and quiz results.
- [Authoring format](authoring-format.md): the layout of a project archive, each phase's checks, the records, and the rules an uploaded archive must follow.

## Changing it

- [Architecture](architecture.md): how the parts fit together, how work is graded, the code runner and the AI path.
- [Development](development.md): the layout of the code, its conventions, the everyday commands, and adding a migration, a route, a page or a test.
- [Testing](testing.md): every test suite, what it proves, how to run it and what it needs.
- [HTTP API](api.md): the API by area, with its route table.
- [Design system](design-system.md): the themes, tokens and components of the interface.
- [Contributing](../CONTRIBUTING.md): how to propose a change and what a pull request must show.
- [Code of conduct](../CODE_OF_CONDUCT.md): how people here treat each other, and how to report a problem.
- [Changelog](../CHANGELOG.md): what each release holds.
- [Third-party material](../THIRD_PARTY.md): the fonts, images and packages that come from elsewhere, and their licences.
- [A demo class](demo/README.md): seeding a class of twenty-five learners so the teacher's console has something to show.
- [Shell components](../apps/web/components/shell/README.md): the components every signed-in page is drawn with.
- [Study guides](../apps/web/components/learn/README.md): where the words of the phase guides under `/learn` live.
- [Self-hosted fonts](../apps/web/public/fonts/README.md): the typefaces the web app serves itself.
- [API test fixtures](../apps/api/test/fixtures/README.md): the test data the API suite reads and how each set is made.
- [Stress harnesses](../scripts/stress/README.md): the adversarial and load tests of each subsystem.
- [Model evaluation harness](../apps/api/eval/README.md): scoring models on the product's AI jobs; it needs provider credentials and parts that are not in this repository.

## Deploying it

- [Production runbook](production-runbook.md): the single-host Compose deployment, from first deploy to upgrades, backups, metrics and failure modes.
- [Security](../SECURITY.md): how to report a vulnerability, and the security properties an operator should know.
- [Reference AWS deployment](deployment/preview.md): one EC2 host for the trusted services and AWS Lambda MicroVMs for learner code.
- [Terraform module](../infra/preview/terraform/README.md): the AWS resources of the reference deployment, with its inputs, outputs and checks.
- [Reference deployment folder](../infra/preview/README.md): what each file under `infra/preview` is.
- [Invitation gate](../infra/preview/gateway/README.md): the front door of the reference deployment.
- [MicroVM controller](deployment/microvm-controller.md): how learner code reaches a MicroVM through the runner's own socket.
- [MicroVM guest image](deployment/microvm-guest.md): the image each learner MicroVM boots.
- [Cognito sign-in](deployment/cognito-sso.md): handing passwords and single sign-on to Amazon Cognito.

# Third-party material

This page lists the third-party material in LearnSDLC from SMU SCIS: first the files kept in this repository, then the packages installed when it is built. It states facts as the repository records them. It is not legal advice.

For LearnSDLC itself, no licence has been chosen yet; until a LICENSE file is added, all rights are reserved. The licences below belong to the third-party material, not to LearnSDLC.

## 1. Third-party files in this repository

### Fonts

`apps/web/public/fonts` holds three variable fonts, served by the app itself so that no page makes an external font request. Their source is recorded in `apps/web/public/fonts/README.md`, and each licence file sits beside its font.

| File | Typeface | Taken from | Copyright line in its licence file | Licence |
|---|---|---|---|---|
| `outfit.woff2` | Outfit | Fontsource package `@fontsource-variable/outfit` | The Outfit Project Authors | SIL Open Font License 1.1 (`outfit-LICENSE.txt`) |
| `manrope.woff2` | Manrope | Fontsource package `@fontsource-variable/manrope` | The Manrope Project Authors | SIL Open Font License 1.1 (`manrope-LICENSE.txt`) |
| `space-grotesk.woff2` | Space Grotesk | Fontsource package `@fontsource-variable/space-grotesk` | The Space Grotesk Project Authors | SIL Open Font License 1.1 (`space-grotesk-LICENSE.txt`) |

### The page preview runtime

`apps/web/public/preview-runtime/react-runtime.js` is generated, not written by hand. `apps/web/components/workspace/preview/client/build-runtime.mjs` wraps the production CommonJS builds of React 19.3.0, React DOM 19.3.0 and React's `scheduler` package, read from `node_modules`, in a small module registry, so that a learner's page preview can load React with no network. Each wrapped file keeps its original header: "Copyright (c) Meta Platforms, Inc. and affiliates", under the MIT licence. The small hash router in the same file is written in `build-runtime.mjs` itself and is not copied from elsewhere. `npm run build:preview-runtime -w @learnsdlc/web` writes the file again.

### Video thumbnails

`apps/web/public/lessons` holds twelve thumbnail images (`video-*.jpg`) of third-party videos that the phase guides link to. `apps/web/public/lessons/video-sources.json` records, for each one, the video's address, its title, its publisher and the thumbnail address it was taken from. The publishers it names are Atlassian, Kent C. Dodds, Ben Myers, IBM Technology, Lucid Software, Computerphile, Net Ninja, Fireship, Docker, Google Workspace and Socratica. The repository does not record a licence or permission for these images.

### The Google sign-in mark

`apps/web/public/brand/google-g.png` is Google's "G" mark, drawn on the Google sign-in button. The repository does not record where the file came from or the terms it is used under.

### Recorded walkthroughs

`apps/web/public/walkthroughs` holds eight short videos with their poster images and caption files. The app labels them "Recorded in LearnSDLC" (`apps/web/components/landing/RecordedWalkthroughs.tsx`), and `apps/web/components/landing/reviewed-recordings.ts` holds the review record of each, so they are recordings of LearnSDLC itself.

### Illustrations and icons

The origin of the following is not recorded in the repository:

- `apps/web/public/artwork`: 23 illustrations (`.webp`) and the LearnSDLC mark (`learnsdlc-laptop-cap.svg`).
- `apps/web/app/icon.svg`, `apps/web/app/apple-icon.png` and `apps/web/app/opengraph-image.png`: the site icon, the home-screen icon and the image shown when a link to the site is shared.

### Nothing else is vendored

A search of every tracked file for licence headers, "Copyright" and SPDX identifiers finds them only in the font licence files and in the page preview runtime above. The content pack under `content/` carries no third-party licence header.

## 2. Packages installed when LearnSDLC is built

None of these is in the repository. npm, pip and Docker fetch them when LearnSDLC is installed or built.

### npm packages the product runs on

These are the production dependencies of the four npm workspaces (the root, `apps/api`, `apps/web` and `packages/shared`): every package reachable from a workspace's `dependencies`, with their own dependencies, optional dependencies and peer dependencies. A package needed only by the development tools under `devDependencies` is not counted. A development tool that is also an optional peer of a production package (`typescript`, `ts-node` and `playwright` are) is counted, because the lockfile does not mark it as development-only. The root and `packages/shared` declare no runtime dependency of their own, so every package below comes from `apps/api` or `apps/web`.

There are 548 distinct packages (by name and version). 67 of them are optional: mostly platform-specific builds, of which npm installs only the one for the machine, and the optional peers above.

| Licence, as each package declares it | Packages |
|---|---|
| MIT | 422 |
| Apache-2.0 | 61 |
| ISC | 33 |
| LGPL-3.0-or-later | 10 |
| BSD-3-Clause | 5 |
| BlueOak-1.0.0 | 4 |
| Apache-2.0 AND LGPL-3.0-or-later | 3 |
| Apache-2.0 AND LGPL-3.0-or-later AND MIT | 1 |
| (BSD-2-Clause OR MIT OR Apache-2.0) | 1 |
| (MIT AND BSD-3-Clause) | 1 |
| (MIT OR WTFPL) | 1 |
| 0BSD | 1 |
| BSD-2-Clause | 1 |
| CC-BY-4.0 | 1 |
| MIT-0 | 1 |
| Python-2.0 | 1 |
| SIL OPEN FONT LICENSE | 1 |

Every package declares a licence: none is missing.

#### For the owner's attention

These declare a licence that is not one of MIT, Apache-2.0, ISC, BSD-2-Clause or BSD-3-Clause, or that carries a copyleft or a non-SPDX identifier.

| Package | Licence | Reaches the product through | Note |
|---|---|---|---|
| `@img/sharp-libvips-*` 1.3.4 (10 platform builds) | LGPL-3.0-or-later | `next` (apps/web) → `sharp` (optional) → the build for the machine | The libvips image library, a native binary. Optional: npm installs only the build for the platform. |
| `@img/sharp-win32-arm64`, `-win32-ia32`, `-win32-x64` 0.35.5 | Apache-2.0 AND LGPL-3.0-or-later | `next` → `sharp` (optional) | Windows builds of `sharp` with libvips inside. Optional. |
| `@img/sharp-wasm32` 0.35.5 | Apache-2.0 AND LGPL-3.0-or-later AND MIT | `next` → `sharp` (optional) | WebAssembly build of `sharp` with libvips inside. Optional. |
| `caniuse-lite` 1.0.30001809 | CC-BY-4.0 | `next` (apps/web) | Browser support data, under a Creative Commons licence. |
| `geist` 1.7.2 | SIL OPEN FONT LICENSE | apps/web, directly | A font package; the identifier is not the SPDX form (`OFL-1.1`). |
| `argparse` 2.0.1 | Python-2.0 | `js-yaml` (apps/api) | Python Software Foundation licence. |
| `jackspeak` 3.4.3, `minipass` 7.1.3, `package-json-from-dist` 1.0.1, `path-scurry` 1.11.1 | BlueOak-1.0.0 | `typeorm` (apps/api) → `glob` | Blue Oak Model License. |
| `expand-template` 2.0.3 | (MIT OR WTFPL) | `better-sqlite3` (apps/api) → `prebuild-install` | A choice of two licences. |
| `rc` 1.2.8 | (BSD-2-Clause OR MIT OR Apache-2.0) | `better-sqlite3` → `prebuild-install` | A choice of three licences. |
| `sha.js` 2.4.12 | (MIT AND BSD-3-Clause) | `typeorm` (apps/api) | Both licences apply. |
| `nodemailer` 10.6.1 | MIT-0 | apps/api, directly | MIT without the attribution condition. |
| `tslib` 2.8.1 | 0BSD | the AWS SDK, Nest, `typeorm`, `rxjs` and others | Zero-clause BSD. |

No production dependency declares GPL, AGPL, SSPL or a proprietary licence. The only copyleft licence declared is the LGPL of libvips, inside the optional `sharp` builds above.

### Python packages the code runner pins

`apps/api/runner/runtime-locks/python-requirements.txt` pins, by version and hash, the Python packages that learner code and its tests run with. The licence column is read from the package metadata of the copy installed on the machine that wrote this page; where that copy's version differs from the pin, the version read is given.

| Package | Pinned | Licence (from metadata) | Version read |
|---|---|---|---|
| blinker | 1.9.0 | MIT | 1.9.0 |
| click | 8.3.3 | BSD-3-Clause | 8.1.7 |
| flask | 3.1.3 | BSD-3-Clause | 3.1.1 |
| iniconfig | 2.0.0 | MIT | 1.1.1 |
| itsdangerous | 2.2.0 | BSD | 2.2.0 |
| jinja2 | 3.1.6 | BSD | 3.1.4 |
| markupsafe | 2.1.5 | BSD-3-Clause | 2.1.5 |
| packaging | 24.2 | Apache Software License; BSD License (both classifiers) | 24.1 |
| pluggy | 1.5.0 | MIT | 1.5.0 |
| pygments | 2.21.0 | BSD-2-Clause | 2.18.0 |
| pytest | 9.0.3 | MIT | 8.3.4 |
| werkzeug | 3.1.8 | BSD | 3.1.3 |

### npm packages the code runner provides to learner code

`apps/api/runner/runtime-locks/package.json` and its lockfile pin the JavaScript packages learner code and its tests run with (React 18.3.1, React DOM 18.3.1, React Router DOM 7.18.2, jsdom 25.0.1 and Testing Library, with their dependencies). The runner's pre-baked layer installs them. Their lockfile records a licence for all 90 packages: 81 MIT, 3 ISC, 2 Apache-2.0, 2 BSD-2-Clause, 1 BSD-3-Clause and 1 MIT-0 (`@csstools/color-helpers`).

### Container images

The Compose files and Dockerfiles build on public images that Docker pulls: `node` (the API, the web app and the runner), `python` (the runner and the reference deployment's invitation gate), `postgres`, `redis`, `caddy`, `axllent/mailpit` (the local stack's mail catcher), `localstack/localstack` (the optional Lambda test path) and the AWS Lambda MicroVM base image (the reference deployment). Their licences are not recorded in the repository.

## How the package lists were made

- **npm.** A one-off script, not kept in the repository, read `package-lock.json` and walked each workspace's `dependencies` through Node's resolution rules, adding each package's `dependencies`, `optionalDependencies` and `peerDependencies`. It took each package's licence from the `license` field of its `package.json` under `node_modules` (or the older `licenses` list). For the 37 optional platform builds that npm had not installed on the machine, it took the `license` field the lockfile records. The set it found was checked against npm's own: it is exactly the lockfile's entries not marked as development-only.
- **Python.** A one-off script read the pinned names from `python-requirements.txt` and printed `License-Expression`, `License` and the licence classifiers from the installed package metadata (`importlib.metadata`) of Python 3.11.
- **Runner's npm packages.** Read from the `license` field of each entry in `apps/api/runner/runtime-locks/package-lock.json`.

Run again after any dependency change, these give the current figures; the counts on this page are those of the lockfiles at the commit that added it.

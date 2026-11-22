import { safeRelativePath } from './zip-reader';

/**
 * The secret rule's names and the printed path, pure, for the two places
 * that hold a pack's paths to it: the upload door's scan over the archive
 * (`checkPackFiles`, `authoring/upload-limits.ts`) and an older archive's
 * conversion over the paths it writes (`layoutFromManifest`,
 * `legacy-layout.ts`). They live here, below both, because the loader
 * imports `legacy-layout.ts`, and `upload-limits.ts` imports the importer,
 * which imports the loader: the conversion importing the door's module would
 * close that cycle.
 */

const SECRET_DIRECTORIES = new Set(['.ssh', '.aws', '.git', '.gnupg', '.docker']);
const SECRET_NAMES = new Set([
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', '.npmrc', '.pypirc', '.netrc', '.git-credentials',
  '.htpasswd', 'credentials', 'credentials.json', '.dockercfg',
]);
const SECRET_EXTENSIONS = /\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk)$/i;

/** A PEM private key, by content. */
export const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;

/** The one dot-env file an older-layout pack may ship (TaskTrackr's own). */
export const ALLOWED_ENV_FILE = 'canonical/.env.example';

/**
 * Whether a pack-relative path is secret-shaped by its name: a `.env*` or
 * `*.env` file other than `allowedEnvFile`, a key or keystore, an
 * ssh/npm/pypi/netrc/aws/docker credential, or any file under a
 * version-control or credential folder that may hold a remote's token.
 */
export function isSecretPath(name: string, allowedEnvFile: string | null): boolean {
  const parts = name.split('/');
  const base = parts[parts.length - 1];
  const lower = base.toLowerCase();
  return (
    parts.slice(0, -1).some((part) => SECRET_DIRECTORIES.has(part.toLowerCase())) ||
    // `.env`, `.env.local`, `.envrc`, and `prod.env` / `config.env`
    ((/^\.env/i.test(base) || /\.env$/i.test(base)) && name !== allowedEnvFile) ||
    SECRET_NAMES.has(lower) ||
    SECRET_EXTENSIONS.test(base)
  );
}

/** A pack-relative path, printed only when it is plain. */
export function plainPath(value: string): string {
  return /^[A-Za-z0-9_./@-]{1,160}$/.test(value) && safeRelativePath(value) ? value : 'a file in the archive';
}

/**
 * The secret sentence for a path in the folder layout, which has
 * no `canonical/` and so no exception to name: an older archive's converted
 * paths (`layoutFromManifest`) and a new-layout archive.
 */
export const NEW_LAYOUT_SECRET = (where: string): string =>
  `${where} looks like a secret (a .env file, a private key or a credential). Leave secrets out of the archive and upload again.`;

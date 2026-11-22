import 'reflect-metadata';
import { BUMP_TOKEN_VERSION } from '../db/token-version';
import { PasswordWorkService } from '../auth/password-work.service';
import { isCommonPassword } from '../auth/common-passwords';
import dataSource from '../db/data-source';
import { UserEntity } from '../db/entities';
import { config } from '../config';
import { normaliseEmail } from '../auth/email';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@learnsdlc/shared';
import { runCli } from './run';

/**
 * Manual password recovery, for the operator with shell access.
 *
 *   npm run user:set-password -w @learnsdlc/api -- <email> <newPassword>
 *
 * The paths that need no shell (the emailed reset link, RecoveryService, and
 * the admin console) cover everyone except an account whose mailbox is gone
 * and the last admin, whom the console refuses to reset; this is how they get
 * back in. It reads
 * the same DATABASE_URL / DB_PATH as the running API and bumps tokenVersion,
 * so whoever held a session for the account is signed out; the running API
 * notices within its session-cache TTL.
 *
 * Exit codes: 0 set, 1 no such account, 2 bad usage, 70 an unexpected failure
 * (cli/run.ts).
 */
function usage(message: string): never {
  console.error(`${message}\nusage: npm run user:set-password -w @learnsdlc/api -- <email> <newPassword>`);
  process.exit(2);
}

async function main(argv: string[]): Promise<number> {
  if (config.authProvider === 'cognito') {
    console.error('Passwords are managed by Cognito. Use its recovery flow or the authenticated Cognito administration console; this local-password command is disabled.');
    return 2;
  }
  const [rawEmail, password] = argv;
  if (!rawEmail || !password) usage('email and new password are both required');
  // The same rules registration applies; a password set here is typed at the
  // same login form as any other.
  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    usage(`the password must be ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} characters`);
  }
  if (isCommonPassword(password)) {
    usage('that password appears in public breach lists; choose another');
  }
  const email = normaliseEmail(rawEmail);

  await dataSource.initialize();
  const passwords = new PasswordWorkService();
  try {
    const users = dataSource.getRepository(UserEntity);
    const user = await users.findOne({ where: { email } });
    if (!user) {
      console.error(`no account with the email ${email}`);
      return 1;
    }
    // A scoped update, not a save of the row read above: the API is serving
    // while this runs, and saving would put a suspension made during the hash
    // back to null. The version is added to in SQL for the same reason
    // (db/token-version.ts, BUMP_TOKEN_VERSION).
    await users.update(
      { id: user.id },
      { passwordHash: await passwords.hash(password), tokenVersion: BUMP_TOKEN_VERSION },
    );
    console.log(`password set for account ${user.id}; every existing session is signed out`);
    return 0;
  } finally {
    try { await passwords.close(); } finally { await dataSource.destroy(); }
  }
}

void runCli(() => main(process.argv.slice(2)));

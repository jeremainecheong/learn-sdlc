import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@learnsdlc/shared';
import { isCommonPassword } from './common-passwords';

/**
 * Why registration would refuse this password, or null. The same rules as
 * RegisterDto and `user:set-password`: a length from PASSWORD_MIN_LENGTH to
 * PASSWORD_MAX_LENGTH, and not one of the passwords every breach list opens
 * with. A password set from the environment is typed at the same sign-in form.
 *
 * scripts/host.sh asks this module, from the build, about the administrator
 * password it prompts for, so it refuses one before it starts anything, in
 * the words below. It imports nothing but the shared limits and the list.
 */
export function passwordRuleProblem(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    return `it must be ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters`;
  }
  if (isCommonPassword(password)) return 'it appears in public breach lists';
  return null;
}

/** The sentence a refused ADMIN_PASSWORD is reported with, by the API at boot and by scripts/host.sh. */
export function adminPasswordRefusal(problem: string): string {
  return `ADMIN_PASSWORD was refused, so no admin was created: ${problem}. Set one the registration form accepts`;
}

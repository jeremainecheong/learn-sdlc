import * as bcrypt from 'bcryptjs';
import { PASSWORD_BCRYPT_ROUNDS } from '../src/auth/password-work.protocol';
import type { PasswordWorkService } from '../src/auth/password-work.service';

/** Explicit unit-test dependency; production never imports this file. */
export function passwordWorkFixture(): PasswordWorkService {
  return {
    hash: jest.fn((password: string) => bcrypt.hash(password, PASSWORD_BCRYPT_ROUNDS)),
    compare: jest.fn((password: string, encoded: string) => bcrypt.compare(password, encoded)),
  } as unknown as PasswordWorkService;
}

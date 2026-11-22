import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { isEmail, validate } from 'class-validator';
import { CLASS_EMAIL_DOMAIN, buildClassPlan } from '../demo/class-plan';
import { LoginDto, RegisterDto } from '../dto';
import { DEMO_ADMIN_EMAIL, DEMO_INSTRUCTOR_EMAIL } from './demo-accounts';

/**
 * The accounts the product creates for itself (the demo staff, and the learners
 * of the seeded class) use addresses under `learnsdlc.test`, a name reserved
 * for testing (RFC 2606) that nobody can register. Under a domain someone
 * could own, mail the product sends to a demo account (a password reset, a
 * verification) could reach a stranger's mailbox.
 */
describe('the addresses of the accounts the product creates for itself', () => {
  const seededClass = buildClassPlan(1).personas.map((persona) => persona.email);
  const addresses = [DEMO_INSTRUCTOR_EMAIL, DEMO_ADMIN_EMAIL, ...seededClass];

  it('are under the reserved testing domain learnsdlc.test', () => {
    expect(CLASS_EMAIL_DOMAIN).toBe('class.learnsdlc.test');
    expect(seededClass.length).toBeGreaterThan(0);
    for (const address of addresses) expect(address).toMatch(/@(class\.)?learnsdlc\.test$/);
  });

  it('are addresses the sign-in and registration forms accept', async () => {
    for (const email of addresses) {
      expect(isEmail(email)).toBe(true);
      const login = plainToInstance(LoginDto, { email, password: 'any' });
      const register = plainToInstance(RegisterDto, {
        email,
        password: 'A-long-and-uncommon-one-7',
        displayName: 'Demo Account',
      });
      expect([email, await validate(login)]).toEqual([email, []]);
      expect([email, await validate(register)]).toEqual([email, []]);
    }
  });
});

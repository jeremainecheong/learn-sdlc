import { errorName } from './error-name';

describe('errorName', () => {
  it('names the class of a thrown error and never its message', () => {
    expect(errorName(new TypeError('/home/learner/secret.py'))).toBe('TypeError');
  });

  it('reads Error for a thrown value with no name', () => {
    expect(errorName(undefined)).toBe('Error');
    expect(errorName(null)).toBe('Error');
    expect(errorName('a string')).toBe('Error');
  });
});

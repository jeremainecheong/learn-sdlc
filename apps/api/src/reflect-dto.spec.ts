import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ReflectDto } from './dto';

/**
 * What `POST /phases/:id/reflect` accepts.
 *
 * A reflection is optional (`advance` does not read it) and one that is
 * written is at least 20 characters (`ReflectDto`).
 * So "optional" is the client's to honour by not posting an empty one: the
 * route is where a reflection is saved, and an empty body is not a reflection.
 * These three cases are the contract the merge sheet is built against.
 */
describe('ReflectDto', () => {
  const problems = async (reflection: unknown): Promise<string[]> =>
    (await validate(plainToInstance(ReflectDto, { reflection }))).flatMap((error) =>
      Object.values(error.constraints ?? {}),
    );

  it('refuses an empty reflection, so the client sends none rather than an empty one', async () => {
    expect(await problems('')).toContain('a reflection needs at least 20 characters of real thought');
  });

  it('refuses a written reflection under twenty characters', async () => {
    expect(await problems('too short')).toContain(
      'a reflection needs at least 20 characters of real thought',
    );
  });

  it('accepts a written reflection of twenty characters or more', async () => {
    expect(await problems('I cut the vague acceptance criterion.')).toEqual([]);
  });
});

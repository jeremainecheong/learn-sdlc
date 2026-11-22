import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DrillIncidentDto } from './dto';

/**
 * What `POST /phases/:id/drill/resolve` accepts for each of INCIDENT-1's three
 * answers: 20 to 2000 characters, counted as the runbook record counts them
 * (UTF-16 code units), so a write-up the route accepts is one the record holds.
 */
describe('DrillIncidentDto', () => {
  const fine = 'API_URL named localhost inside the network.';
  const problems = async (rootCause: string): Promise<string[]> =>
    (await validate(plainToInstance(DrillIncidentDto, { rootCause, fix: fine, actionItem: fine }))).flatMap((error) =>
      Object.values(error.constraints ?? {}),
    );

  it('accepts 2000 code units', async () => {
    expect(await problems('a'.repeat(2000))).toEqual([]);
    expect(await problems(`${'a'.repeat(1996)}\u{1F525}\u{1F525}`)).toEqual([]);
  });

  it('refuses 2001 code units even when they are 1999 characters', async () => {
    expect(await problems('a'.repeat(2001))).toEqual(['rootCause must be shorter than or equal to 2000 characters']);
    expect(await problems(`${'a'.repeat(1997)}\u{1F525}\u{1F525}`)).toEqual(['rootCause must be shorter than or equal to 2000 characters']);
  });
});

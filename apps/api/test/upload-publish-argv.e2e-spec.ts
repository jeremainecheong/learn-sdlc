import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AuthService } from '../src/auth/auth.service';
import { UPLOAD_PATH } from '../src/authoring/upload.service';
import {
  ACCEPTED_FAMILIES,
  RUN_SHAPE_CODES,
  RUN_SHAPE_SENTENCE_MARKS,
  PROPERTY_SEED,
  VARIANT_COUNT,
  acceptedFamilies,
  fixedCorpus,
  generateVariants,
  previewEdgeVariants,
  publishArgvRefusals,
  smokeEdgeVariants,
  uploadDoor,
  type Variant,
} from '../src/authoring/upload-publish-argv.property.spec';
import { RUN_SHAPES_CHECK_ID } from '../src/authoring/validation';
import type { ProjectContent } from '../src/content/content.types';
import { ProjectVersionEntity } from '../src/content/project.entities';
import { UserEntity } from '../src/db/entities';
import { bearer, HttpTarget } from './support/http';
import { bootApi } from './support/app';

/**
 * The e2e layer of the argv rule: **an
 * archive the upload door accepts is never refused at publish for the argv
 * rule**, over HTTP on the real AppModule (sqlite, IMPORT_MAX_BYTES unset, so
 * the production cap).
 *
 * For each archive: the whole fixed corpus (the Shelf pack, shelf-preview,
 * shelf-task, every accepted hostile.ts entry) and every variant the pure
 * layer's seeded generator and shape-6 and shape-5 edges yield that the door accepts, plus
 * a handful it refuses:
 *
 * 1. it is uploaded through the real route, and the route's verdict is the
 *    pure layer's (`uploadDoor`, the same `UploadService`);
 * 2. for an accepted one, the stored version's `compiled.content` is read
 *    back and publish's exact expression runs on it
 *    (`[...checkPackRuns(raw), ...checkRunLimits(raw)]`, raw =
 *    `rawPackManifestOf(compiled.content)`): it must be `[]`;
 * 3. the real publish route is called: it may refuse (a non-reference
 *    executable phase has no deep receipt on this host), but no refusal
 *    carries a `RUN_SHAPE_CODES` code, a run-shape row, or one of their sentences.
 *
 * Generator, corpus and the expression are imported from
 * `src/authoring/upload-publish-argv.property.spec.ts` (its specs register
 * only in its own run).
 */

/** At least this many generated variants go through the route and the publish route. */
const MIN_ACCEPTED_VARIANTS = 24;
/** And this many refused ones, so the route's refusals are seen to be the pure door's. */
const REFUSED_SAMPLE = 8;

describe('accepted at upload ⇒ never refused at publish for the argv rule (e2e, real AppModule)', () => {
  let app: INestApplication;
  let http: HttpTarget;
  let db: DataSource;
  const stamp = Date.now();
  let accounts = 0;
  let address = 0;

  /** Each request from its own address, so the per-address gates measure the routes, not this file. */
  const from = () => ({ 'x-forwarded-for': `10.78.${Math.floor(address / 250)}.${(address++ % 250) + 1}` });

  const teacherAccount = async () => {
    accounts += 1;
    const registered = await request(http)
      .post('/api/v1/auth/register')
      .set(from())
      .send({ email: `up4-${accounts}-${stamp}@upload-publish-argv.test`, password: 'Correct-Horse-9', displayName: `up4 ${accounts}` })
      .expect(201);
    const id = registered.body.user.id as string;
    await db.manager.update(UserEntity, { id }, { role: 'INSTRUCTOR' });
    app.get(AuthService).forgetSession(id);
    return { id, token: registered.body.token as string };
  };

  /** A teacher is good for five uploads a minute; a fresh one for each batch. */
  let teacher: { id: string; token: string } | null = null;
  let used = 0;
  const uploader = async () => {
    if (!teacher || used >= 5) {
      teacher = await teacherAccount();
      used = 0;
    }
    used += 1;
    return teacher;
  };

  const priorCap = process.env.IMPORT_MAX_BYTES;

  beforeAll(async () => {
    delete process.env.IMPORT_MAX_BYTES;
    // Test-only: read the client address from X-Forwarded-For (see `from`).
    ({ app, http } = await bootApi({ trustProxy: true }));
    db = app.get(DataSource);
  });

  afterAll(async () => {
    if (priorCap === undefined) delete process.env.IMPORT_MAX_BYTES;
    else process.env.IMPORT_MAX_BYTES = priorCap;
    await app?.close();
  });

  /** Upload one archive; for an accepted one, the stored content's expression and the real publish route. */
  const throughTheRoutes = async (variant: Variant) => {
    const who = await uploader();
    const archive = variant.archive();
    const res = await request(http)
      .post(UPLOAD_PATH)
      .set(bearer(who.token))
      .set(from())
      .send({ title: 'Books on a shelf', archiveBase64: archive.toString('base64') });
    expect({ variant: variant.name, serverError: res.status >= 500 }).toEqual({ variant: variant.name, serverError: false });
    if (res.status !== 201) return { accepted: false as const, status: res.status, code: res.body?.code as string };

    const { projectId, versionId } = res.body as { projectId: string; versionId: string };
    const version = await db.getRepository(ProjectVersionEntity).findOneByOrFail({ id: versionId });
    expect(version.status).toBe('draft');
    const stored = (version.compiled as { content: ProjectContent } | null)?.content;
    expect({ variant: variant.name, stored: Boolean(stored) }).toEqual({ variant: variant.name, stored: true });
    // publish's exact expression, over the stored compiled.content
    const expression = publishArgvRefusals(stored as ProjectContent).map((one) => one.code);
    expect({ variant: variant.name, expression }).toEqual({ variant: variant.name, expression: [] });

    // and the real publish route: whatever it says, it never draws a `RUN_SHAPE_CODES` refusal
    const published = await request(http)
      .post(`/api/v1/instructor/projects/${projectId}/versions/${versionId}/publish`)
      .set(bearer(who.token))
      .set(from())
      .send({ version: '1.0.0' });
    expect({ variant: variant.name, serverError: published.status >= 500 }).toEqual({ variant: variant.name, serverError: false });
    const checks = ((published.body?.validation?.checks ?? []) as { id: string; status: string; sentence: string }[]);
    // publish really validated: a 200 or a 400 with its report, never a 403/404/409/429 that says nothing
    expect({ variant: variant.name, publishStatus: [200, 400].includes(published.status) }).toEqual({ variant: variant.name, publishStatus: true });
    expect({ variant: variant.name, validated: checks.length > 0 }).toEqual({ variant: variant.name, validated: true });
    const runShapeRows = checks.filter((one) => one.id === RUN_SHAPES_CHECK_ID && one.status === 'failed').map((one) => one.sentence);
    expect({ variant: variant.name, runShapeRows }).toEqual({ variant: variant.name, runShapeRows: [] });
    const text = published.text;
    const codes = RUN_SHAPE_CODES.filter((code) => text.includes(code));
    expect({ variant: variant.name, codes }).toEqual({ variant: variant.name, codes: [] });
    const marks = RUN_SHAPE_CODES.flatMap((code) => RUN_SHAPE_SENTENCE_MARKS[code].filter((mark) => text.includes(mark)).map((mark) => `${code}: ${mark}`));
    expect({ variant: variant.name, marks }).toEqual({ variant: variant.name, marks: [] });
    return { accepted: true as const, status: res.status, publishStatus: published.status, blocking: (published.body?.validation?.blocking ?? []) as string[] };
  };

  it('the fixed corpus: the Shelf pack, shelf-preview, shelf-task and every accepted hostile.ts entry upload, store a content publish’s expression accepts, and the publish route draws no argv refusal', async () => {
    const corpus = fixedCorpus();
    expect(corpus.length).toBeGreaterThanOrEqual(4);
    for (const variant of corpus) {
      const seen = await throughTheRoutes(variant);
      expect({ variant: variant.name, accepted: seen.accepted }).toEqual({ variant: variant.name, accepted: true });
    }
  }, 600_000);

  it('the same detector sees an argv refusal when one is there: a stored shelf-preview draft whose preview argv gains one word is refused at the publish route with a run-shape row carrying ARGV_EXTRA’s sentence', async () => {
    const who = await uploader();
    const preview = fixedCorpus().find((one) => one.name === 'corpus shelf-preview')!;
    const res = await request(http)
      .post(UPLOAD_PATH)
      .set(bearer(who.token))
      .set(from())
      .send({ title: 'Books on a shelf', archiveBase64: preview.archive().toString('base64') })
      .expect(201);
    const { projectId, versionId } = res.body as { projectId: string; versionId: string };
    const repo = db.getRepository(ProjectVersionEntity);
    const version = await repo.findOneByOrFail({ id: versionId });
    const manifest = JSON.parse(JSON.stringify(version.manifest)) as { preview: { service: { command: string[] } } };
    expect(manifest.preview.service.command).toEqual(['python3', 'api/main.py']);
    // planted in the test only, on the row publish compiles from
    manifest.preview.service.command.push('--planted');
    await repo.update({ id: versionId }, { manifest: manifest as never });
    const published = await request(http)
      .post(`/api/v1/instructor/projects/${projectId}/versions/${versionId}/publish`)
      .set(bearer(who.token))
      .set(from())
      .send({ version: '1.0.0' });
    expect(published.status).toBe(400);
    const rows = ((published.body?.validation?.checks ?? []) as { id: string; status: string; sentence: string }[])
      .filter((one) => one.id === RUN_SHAPES_CHECK_ID && one.status === 'failed')
      .map((one) => one.sentence);
    expect(rows).toHaveLength(1);
    expect(RUN_SHAPE_SENTENCE_MARKS.ARGV_EXTRA.some((mark) => rows[0].includes(mark))).toBe(true);
    expect(rows[0]).toContain('project.preview.service.command');
    expect(String(published.body.message)).toContain(rows[0]);
  }, 120_000);

  it(`the seeded variants (seed 0x${PROPERTY_SEED.toString(16)}) and shape 6's and shape 5's edges: the route's verdict is the pure door's; every accepted one (≥${MIN_ACCEPTED_VARIANTS}) stores a content publish's expression accepts, and the publish route draws no argv refusal`, async () => {
    const pool = [...generateVariants(PROPERTY_SEED, VARIANT_COUNT), ...previewEdgeVariants(), ...smokeEdgeVariants()];
    const chosen: { variant: Variant; accepted: boolean; code?: string }[] = [];
    let refused = 0;
    for (const variant of pool) {
      const verdict = await uploadDoor(variant.archive());
      if (verdict.accepted) chosen.push({ variant, accepted: true });
      else if (refused < REFUSED_SAMPLE) {
        refused += 1;
        chosen.push({ variant, accepted: false, code: verdict.code });
      }
    }
    expect(chosen.filter((one) => one.accepted).length).toBeGreaterThanOrEqual(MIN_ACCEPTED_VARIANTS);
    let accepted = 0;
    const acceptedShapes: Record<string, number> = {};
    for (const one of chosen) {
      const seen = await throughTheRoutes(one.variant);
      // the route is the pure door
      expect({ variant: one.variant.name, accepted: seen.accepted, code: seen.accepted ? undefined : seen.code }).toEqual({
        variant: one.variant.name,
        accepted: one.accepted,
        code: one.accepted ? undefined : one.code,
      });
      if (seen.accepted) {
        accepted += 1;
        for (const shape of new Set(one.variant.shapes)) acceptedShapes[shape] = (acceptedShapes[shape] ?? 0) + 1;
      }
    }
    expect(accepted).toBeGreaterThanOrEqual(MIN_ACCEPTED_VARIANTS);
    // every shape family went through the routes accepted, shape 5 included
    expect(acceptedFamilies(acceptedShapes)).toEqual([...ACCEPTED_FAMILIES].sort());
  }, 1_200_000);
});

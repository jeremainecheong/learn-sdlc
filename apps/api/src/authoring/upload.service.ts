import { BadRequestException, HttpException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import {
  AUTHORING_ROUTES,
  DRAFT_FIRST_VERSION,
  PHASE_ORDER,
  compareMountPaths,
  phaseFolderName,
  PROJECT_TITLE_MAX,
  RUN_SHAPE_REFUSALS,
  RUN_SHAPE_REFUSAL_CODES,
  UPLOAD_REFUSALS,
  uploadRefusalForRunShape,
  type ProjectUploadRequest,
  type ProjectUploadResult,
  type ProjectUploadResultWithWarnings,
  type RunShapeFinding,
  type RunShapeRefusalCode,
  type PhaseKey,
  type UploadRefusalCode,
  type ValidationReport,
} from '@learnsdlc/shared';
import type { AuthUser } from '../auth/auth.decorators';
import { API_PREFIX, resolveImportMaxBytes } from '../config';
import { ContentService } from '../content/content.service';
import { LAYOUT_SENTENCES, isFolderLayout } from '../content/folder-layout';
import { ProjectImporterService, derivedFileRows, mintTeacherSlug } from '../content/importer.service';
import { checkedTaskBlock } from '../content/task-blocks';
import { QuizFileRefusal, phaseQuizzesOf } from '../content/quiz-files';
import { ConversionRefusal, isOlderLayout, layoutFromManifest } from '../content/legacy-layout';
import { compilePack, sandboxBudgetFor, soleTaskFor } from '../content/pack-compiler';
import type { ProjectContent } from '../content/content.types';
import { MemoryPackSource, packRootOf } from '../content/memory-pack-source';
import type { PackSource } from '../content/pack-source';
import { plainPath } from '../content/secret-paths';
import { UploadRefusal, archiveRefusalSentence, readZip, zipLimits, type ArchiveEntry } from '../content/zip-reader';
import { recordAudit } from '../audit/audit';
import { storableText, strictText } from './door-rules';
import { refuseInterviewOverCaps } from './interview-caps';
import { PlainTextRefusal, plainSource } from './plain-source';
import { clipEcho, quizFileBody, quizTaskRow, type QuizRowInput } from './quiz-rows';
import {
  CANONICAL_IN_UPLOAD,
  buildPackManifest,
  checkLoadedPack,
  checkPackFiles,
  checkPackRuns,
  checkRunLimits,
  checkRuntimeProfile,
  checkSealedPaths,
  checkUploadShape,
  desktopWarnings,
  printable,
  type PackRefusal,
  type RawPackManifest,
} from './upload-limits';
import { rawPackManifestOf } from './validation';
// How a loader failure is said: the wire's detail and the loader's own words.
import {
  JSON_PARSE_FAILURE,
  errorClassOf,
  escapeRegExp,
  jsonFailureDetail,
  loaderDetail,
  looksLikeFileName,
  parsedAt,
  refusalDetail,
  unlabelled,
} from './loader-sentences';

/** The importer's interface: the importer's draft, teacher-owned mode. */
export interface TeacherDraftImporter {
  importTeacherDraft(
    source: PackSource,
    options: {
      ownerId: string;
      title: string;
      /** Runs inside the draft's transaction; a throw rolls the draft back. */
      onWritten?: (manager: EntityManager, ids: { projectId: string; versionId: string; slug: string }) => Promise<void>;
      /** The archive's quiz files, by phase, as the quiz door's rows; absent when it holds none. */
      quizzes?: ReadonlyMap<PhaseKey, readonly QuizRowInput[]>;
    },
  ): Promise<TeacherDraftImport>;
}

export interface TeacherDraftImport {
  projectId: string;
  versionId: string;
  slug: string;
  report: ValidationReport;
}

/**
 * Every code the door answers is the contract's (`UPLOAD_REFUSAL_CODES`, which includes
 * NOT_A_PACK, WARMUP_NOT_UPLOADABLE, TITLE_INVALID, UNSUPPORTED_ARCHIVE and
 * EMPTY_ARCHIVE), so a 4xx body's `code` is always one of them.
 */
export type UploadWireCode = UploadRefusalCode;

/** A refusal as its 4xx body carries it: the contract's `ProjectUploadRefusal`, in Nest's envelope. */
export interface UploadRefusalBody {
  statusCode: number;
  error: string;
  /** Always equal to `sentence`. */
  message: string;
  code: UploadWireCode;
  /** Always `UPLOAD_REFUSALS[code]`: fixed, never a byte or a name of the archive. */
  sentence: string;
  findings: RunShapeFinding[];
  /**
   * Only under `NOT_A_PACK`, and only when the
   * door can say which part of the pack to fix (the loader's cleaned text, or
   * the door's own reading of `project.json`/`phase.json`) and
   * under `RUNTIME_OUTSIDE_PROFILE`, the sentence naming the first
   * package the runtime profile does not bake. At most
   * `UPLOAD_REFUSAL_DETAIL_MAX` printable characters. It may name entry paths
   * and values the pack chose; it never carries a byte of a file body, and
   * never a JSON.parse excerpt. Absent otherwise (the key is left out).
   */
  detail?: string;
}

/** The audit name an accepted upload's row carries (`AUTHORING_AUDIT_EVENTS`). */
const UPLOAD_AUDIT_EVENT = 'project.uploaded' as const;

/**
 * The injection token of an optional override of the archive cap, for a spec.
 * It is not an environment variable: the running app reads IMPORT_MAX_BYTES.
 */
export const UPLOAD_MAX_BYTES_TOKEN = 'authoring.upload-max-bytes';

/**
 * The shared contract's upload code (`UPLOAD_REFUSAL_CODES`) a reader or limit
 * code is filed under. The reader's and the limits' own codes are finer; the
 * teacher reads the shared code's fixed sentence.
 */
export function uploadCodeOf(code: string, sentence = ''): UploadWireCode {
  if ((RUN_SHAPE_REFUSAL_CODES as readonly string[]).includes(code)) {
    return uploadRefusalForRunShape(code as RunShapeRefusalCode);
  }
  switch (code) {
    case 'ARCHIVE_TOO_LARGE':
      return 'ARCHIVE_TOO_LARGE';
    case 'ARCHIVE_NOT_BASE64':
    case 'ARCHIVE_MALFORMED':
      return 'NOT_A_ZIP';
    case 'ARCHIVE_EMPTY':
      return 'EMPTY_ARCHIVE';
    case 'ARCHIVE_METHOD':
      return 'UNSUPPORTED_ARCHIVE';
    case 'ARCHIVE_NAME_TOO_LONG':
      // The contract's own code, whose sentence states the reader's two limits
      // (zipLimits: maxNameBytes 1,024, maxNameSegments 64).
      return 'ARCHIVE_NAME_TOO_LONG';
    case 'ARCHIVE_ENCRYPTED':
      return 'ENCRYPTED_ENTRY';
    case 'ARCHIVE_ZIP64':
    case 'ARCHIVE_DESCRIPTOR_MISMATCH':
    case 'ARCHIVE_SIZE_MISMATCH':
      return 'ZIP64_OR_SIZE_MISMATCH';
    case 'ARCHIVE_CRC_MISMATCH':
      return 'CRC_MISMATCH';
    case 'ARCHIVE_PATH_ESCAPE':
      return 'PATH_CLIMB';
    case 'ARCHIVE_SYMLINK':
      return 'SYMLINK';
    case 'ARCHIVE_DUPLICATE_NAME':
      return 'DUPLICATE_NAME';
    case 'ARCHIVE_CASE_COLLISION':
      return 'CASE_COLLISION';
    case 'ARCHIVE_NAME_NUL':
      return 'NUL_IN_NAME';
    case 'ARCHIVE_RATIO':
      return 'RATIO_BOMB';
    case 'ARCHIVE_TOTAL_TOO_LARGE':
      return 'TOTAL_SIZE_BOMB';
    case 'ARCHIVE_TOO_MANY_ENTRIES':
      return 'TOO_MANY_ENTRIES';
    case 'PACK_EXECUTABLE_SPLIT':
      return 'TWO_WORK_TASKS';
    case 'PACK_SECRET_FILE':
      return 'SECRET_FILE';
    case 'RUNTIME_OUTSIDE_PROFILE':
      return 'RUNTIME_OUTSIDE_PROFILE';
    case 'PACK_SEALED_BYTES':
      // The importer's byte rules only; a reserved path is its own code.
      return /finished one to edit/.test(sentence) ? 'SOLUTION_IN_EDITABLE' : 'HIDDEN_IN_WORKSPACE';
    case 'PACK_RESERVED_PATH':
    case 'PACK_NOT_TEXT':
    case 'PACK_COMPILE':
      // A workspace file under a sealed prefix, a file that is not text,
      // a refusal only the compiler makes. NOT_A_PACK's sentence; the reason,
      // naming the path the pack chose, rides in `detail`.
      return 'NOT_A_PACK';
    case 'PACK_OVER_BUDGET':
      return /per version/.test(sentence) ? 'CEILING_PER_VERSION' : 'CEILING_PER_PHASE';
    case 'PACK_WARMUP_NOT_UPLOADABLE':
      return 'WARMUP_NOT_UPLOADABLE';
    case 'UPLOAD_TITLE_INVALID':
      return 'TITLE_INVALID';
    default:
      // PACK_NO_PROJECT, PACK_UNREADABLE, PACK_INVALID, and anything unforeseen
      return 'NOT_A_PACK';
  }
}

function wireSentence(code: UploadWireCode): string {
  return UPLOAD_REFUSALS[code];
}

/**
 * The internal codes whose own sentence may ride in `detail` under
 * `NOT_A_PACK`: the loader's cleaned text (`PACK_INVALID`, built by
 * `loaderDetail`) and the door's own reading of the pack's JSON
 * (`PACK_UNREADABLE`, `PACK_NO_PROJECT`), whose sentences are the platform's
 * words around a fixed file label. Anything unforeseen filed under
 * `NOT_A_PACK` carries no detail.
 */
const DETAIL_CODES: ReadonlySet<string> = new Set([
  'PACK_INVALID',
  'PACK_UNREADABLE',
  'PACK_NO_PROJECT',
  // The door's own sentences, each naming a path the pack chose and a
  // reason; never a byte of a file body.
  'PACK_RESERVED_PATH',
  'PACK_NOT_TEXT',
  'PACK_COMPILE',
]);

const STATUS_TEXT: Record<number, string> = { 413: 'Payload Too Large', 415: 'Unsupported Media Type' };

/**
 * The 4xx a refusal travels as: the first reason's shared code and that
 * code's fixed sentence (`UPLOAD_REFUSALS[code]`, for EVERY code), and (for
 * the run-shape codes) every run-shape finding with its `where` and its own
 * fixed sentence. Never a 5xx, never a byte, a name or a package of the
 * archive in `sentence`. A pack the loader refuses still
 * answers NOT_A_PACK's fixed sentence; what a teacher needs to find the bad
 * file rides in the optional `detail` (see `UploadRefusalBody.detail`).
 */
export function uploadRefused(reasons: PackRefusal[], status = 400): HttpException {
  const first = reasons[0];
  const code = uploadCodeOf(first.code, first.sentence);
  const findings: RunShapeFinding[] =
    code === 'RUN_SHAPE_NOT_ALLOWED' || code === 'RUN_LIMIT_ABOVE_LEARNER'
      ? reasons
          .filter((one) => (RUN_SHAPE_REFUSAL_CODES as readonly string[]).includes(one.code))
          .map((one) => ({
            code: one.code as RunShapeRefusalCode,
            where: one.where,
            sentence: RUN_SHAPE_REFUSALS[one.code as RunShapeRefusalCode],
          }))
      : [];
  const sentence = wireSentence(code);
  const body: UploadRefusalBody = {
    statusCode: status,
    error: STATUS_TEXT[status] ?? 'Bad Request',
    message: sentence,
    code,
    sentence,
    findings,
  };
  // A runtime outside the profile also carries its own
  // sentence, which names the first package the profile does not bake
  // (`checkRuntimeProfile`); the fixed `sentence` never names it.
  const detail =
    (code === 'NOT_A_PACK' && DETAIL_CODES.has(first.code)) || code === 'RUNTIME_OUTSIDE_PROFILE'
      ? refusalDetail(first.sentence)
      : undefined;
  if (detail) body.detail = detail;
  return new HttpException(body, status);
}

function fromRefusal(error: UploadRefusal): HttpException {
  const status = error.code === 'ARCHIVE_TOO_LARGE' ? 413 : 400;
  return uploadRefused([{ code: error.code, where: error.where ?? 'archive', sentence: error.sentence }], status);
}

/* --------------------------- the route's body parser --------------------------- */

/** The upload path, under the global prefix. */
export const UPLOAD_PATH = `${API_PREFIX}${AUTHORING_ROUTES['projects.upload'].path}`;

/**
 * The JSON body limit for the upload path: base64 is 4/3 of the
 * archive, plus 4 KiB for the title and the JSON around it. The archive cap
 * itself is applied after decoding, so an archive one byte over is refused by
 * sentence and never by the parser.
 */
export function uploadBodyLimit(archiveMaxBytes: number): number {
  return Math.ceil((archiveMaxBytes * 4) / 3) + 4 * 1024;
}

/**
 * Every parser error on the upload path, said as an upload refusal: JSON, a
 * code and a sentence, never the parser's HTML page and never a byte of the
 * body (a parse error can embed what was sent).
 */
export function uploadParseRefusal(
  archiveMaxBytes: number,
): (error: unknown, req: unknown, res: { status(code: number): { json(body: unknown): void } }, next: (error?: unknown) => void) => void {
  const limits = zipLimits(archiveMaxBytes);
  return (error, _req, res, next) => {
    const failure = error as { type?: string; status?: number } | null;
    if (!failure || typeof failure.type !== 'string') return next(error);
    if (failure.type === UPLOAD_NOT_JSON) {
      // A body that is not JSON never reaches a parser.
      const refused = uploadRefused(
        [{ code: 'ARCHIVE_NOT_BASE64', where: 'archive', sentence: archiveRefusalSentence('ARCHIVE_NOT_BASE64', limits) }],
        415,
      );
      res.status(refused.getStatus()).json(refused.getResponse());
      return;
    }
    const code = failure.type === 'entity.too.large' ? 'ARCHIVE_TOO_LARGE' : 'ARCHIVE_NOT_BASE64';
    const refused = fromRefusal(new UploadRefusal(code, archiveRefusalSentence(code, limits)));
    res.status(refused.getStatus()).json(refused.getResponse());
  };
}

/** The error type `uploadJsonOnly` hands `uploadParseRefusal`. */
export const UPLOAD_NOT_JSON = 'upload.not.json';

type BodyRequest = {
  headers: Record<string, string | string[] | undefined>;
  is?(type: string): string | false | null;
  on?(event: string, listener: (...args: never[]) => void): unknown;
  resume?(): unknown;
  pause?(): unknown;
};

/**
 * The upload path reads JSON and nothing else. Wraps the
 * path's JSON parser (mounted behind the staff gate in `main.ts`): a request
 * that carries a body of any other type (a form, multipart, plain text, or
 * no type at all) is handed to `uploadParseRefusal` as an error before a byte
 * of it is read, so it is answered as an upload refusal in JSON (415, the
 * NOT_A_ZIP sentence) and never falls through to the global urlencoded parser
 * and its 4 MB HTML 413. A request with no body is left to the route, which
 * refuses it by sentence.
 *
 * The refused body is never parsed, but it is drained (read and
 * dropped, nothing kept) before the refusal is answered, so the client reads
 * the JSON refusal rather than a socket reset while it is still sending (a
 * 5 MB form body can otherwise meet `write ECONNRESET`). The drain stops at
 * `drainMax` (by default the JSON upload's own body limit) and past it the
 * refusal is answered at once.
 */
export function uploadJsonOnly<Req extends BodyRequest, Res>(
  parse: (req: Req, res: Res, next: (error?: unknown) => void) => unknown,
  drainMax: number = uploadBodyLimit(resolveImportMaxBytes()),
): (req: Req, res: Res, next: (error?: unknown) => void) => unknown {
  return (req, res, next) => {
    const hasBody = req.headers['transfer-encoding'] !== undefined || (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0');
    const json = typeof req.is === 'function' ? req.is('application/json') : null;
    if (hasBody && !json) {
      let answered = false;
      const refuse = (): void => {
        if (answered) return;
        answered = true;
        next(Object.assign(new Error('upload body is not JSON'), { type: UPLOAD_NOT_JSON, status: 415 }));
      };
      if (typeof req.on !== 'function' || typeof req.resume !== 'function') return refuse();
      let drained = 0;
      req.on('data', (chunk: { length: number }) => {
        drained += chunk.length;
        if (drained > drainMax) {
          // The paused request is
          // neither resumed nor destroyed; the 415 goes out keep-alive, and
          // the server's keepAliveTimeout (Node's default, 5 s) bounds how
          // long the paused socket is held before Node closes it.
          req.pause?.();
          refuse();
        }
      });
      req.on('end', refuse);
      req.on('error', refuse);
      req.on('close', refuse);
      req.resume();
      return undefined;
    }
    return parse(req, res, next);
  };
}

/**
 * Strict base64, decoded: whole quanta, the standard alphabet, padding only at
 * the end and no stray bits, or null. Linear in the body and without a
 * regular expression over it (a repeated-group pattern overflows V8's stack
 * past about 4.47 million characters, an archive of about 3.2 MiB, well under
 * the cap): Node's decoder skips what it cannot read, so a body is accepted
 * only when re-encoding its bytes gives the body back exactly.
 */
export function decodeStrictBase64(encoded: string): Buffer | null {
  if (encoded.length === 0 || encoded.length % 4 !== 0) return null;
  const bytes = Buffer.from(encoded, 'base64');
  return bytes.toString('base64') === encoded ? bytes : null;
}

/**
 * A teacher's archive, as base64 in JSON, becomes either a
 * refusal by sentence (4xx, no row written, no byte of the archive echoed)
 * or a call to the importer's `importTeacherDraft` over a `MemoryPackSource`.
 *
 * The order is cheapest-first and nothing is allocated past the cap:
 *
 * 1. the base64 **length** against the archive cap, before decoding;
 * 2. strict base64, then the decoded length against the cap (a one-byte-over
 *    archive whose base64 still fits the last quantum is caught here, by the
 *    same sentence);
 * 3. `readZip`: every hostile-archive refusal;
 * 4. the pack root (`project.json`), then secret-shaped files first, over
 *    every name and byte of the archive, the sentence and the
 *    dot-env exception by its layout; an older-layout archive is converted
 *    once into the folder layout (`layoutFromManifest`) and a
 *    new-layout one holding `canonical/` is refused; then the limits on the
 *    raw manifest the folders give (`buildPackManifest`): the upload's shape
 *    (no warm-up, one work task per executable phase), the run shapes, the
 *    learner limit, the runtime profile; then a sealed path with a
 *    dot-prefixed part; then every teacher text stored plain
 *    (`plainSource`) and each quiz file through the quiz door's
 *    rules;
 * 5. the loader (`ContentService.loadProject`), so a pack it refuses is a 400
 *    here and never an `Error` out of the importer's transaction;
 * 6. every file the loader read is UTF-8 text with no NUL (PostgreSQL text
 *    cannot hold U+0000, and a lenient decode would store a binary file
 *    mangled); then the importer's byte rules, the reserved paths and the
 *    microVM ceiling on the loaded pack; then publish's own run-shape reading
 *    of the loaded pack (one shipped-scripts rule, upload and publish); then
 *    the one compiler, as the importer will run it;
 * 7. only then `importTeacherDraft(source, { ownerId, title, quizzes })`, and one
 *    `project.uploaded` audit row. The warnings are the conversion's, the
 *    loader's, the plain-text pass's, then the desktop entries left out.
 *
 * The slug is minted from the title by the importer, never taken from the archive,
 * and reserved slugs are refused there: nothing the archive
 * says about its own name reaches the importer.
 */
@Injectable()
export class UploadService {
  private readonly logger = new Logger(UploadService.name);
  private readonly maxBytes: number;

  constructor(
    @Inject(ProjectImporterService) private readonly importer: TeacherDraftImporter,
    private readonly content: ContentService,
    private readonly dataSource: DataSource,
    @Optional() @Inject(UPLOAD_MAX_BYTES_TOKEN) maxBytes?: number,
  ) {
    // Read where main.ts reads the parser's ceiling, so the body limit and the
    // archive cap are one value (in the running app both are IMPORT_MAX_BYTES).
    this.maxBytes = maxBytes ?? resolveImportMaxBytes();
  }

  /** The longest base64 that can decode to an archive within the cap. */
  get maxBase64Length(): number {
    return 4 * Math.ceil(this.maxBytes / 3);
  }

  async upload(user: AuthUser, body: ProjectUploadRequest): Promise<ProjectUploadResultWithWarnings> {
    const limits = zipLimits(this.maxBytes);
    const tooLarge = (): HttpException =>
      fromRefusal(new UploadRefusal('ARCHIVE_TOO_LARGE', archiveRefusalSentence('ARCHIVE_TOO_LARGE', limits)));

    /* 1-2. the body: the base64 length first, then strict decoding, then the bytes */
    const encoded = (body as Partial<ProjectUploadRequest> | null)?.archiveBase64;
    if (typeof encoded !== 'string' || encoded.length === 0) {
      throw fromRefusal(new UploadRefusal('ARCHIVE_NOT_BASE64', archiveRefusalSentence('ARCHIVE_NOT_BASE64', limits)));
    }
    if (encoded.length > this.maxBase64Length) throw tooLarge();
    const rawTitle = (body as Partial<ProjectUploadRequest> | null)?.title;
    const title = typeof rawTitle === 'string' ? rawTitle.trim() : '';
    // Held to door-rules' storableText too, so a lone surrogate is refused, never stored as U+FFFD.
    if (!title || title.length > PROJECT_TITLE_MAX || /[\u0000-\u001f\u007f]/.test(title) || storableText(title) !== null) {
      throw uploadRefused([{
        code: 'UPLOAD_TITLE_INVALID',
        where: 'title',
        sentence: `Give the project a title of 1 to ${PROJECT_TITLE_MAX} characters; the project's address is made from it.`,
      }]);
    }
    const archive = decodeStrictBase64(encoded);
    if (!archive) {
      throw fromRefusal(new UploadRefusal('ARCHIVE_NOT_BASE64', archiveRefusalSentence('ARCHIVE_NOT_BASE64', limits)));
    }
    if (archive.length > this.maxBytes) throw tooLarge();

    /* 3-6. the archive, the pack, the limits, the loader, the loaded pack */
    let source: MemoryPackSource;
    let loaded: ProjectContent;
    let quizzes = new Map<PhaseKey, QuizRowInput[]>();
    // What reading the archive changed, for the teacher to check, in this
    // order: the older layout's conversion; the
    // loader's (a Requirements or Design phase of the old markdown kind
    // converted to the story or design kind, an older Deployment given its
    // runbook, an older Maintenance its ticket and change request); the texts
    // kept as plain text; the desktop entries left out.
    const warnings: string[] = [];
    // An older archive's own phase folders in a sentence that names the converted ones;
    // the identity for a new-layout archive. Declared here, as the importer's refusals are mapped too.
    let older = false;
    let archiveFolders = (text: string): string => text;
    try {
      const entries = readZip(archive, limits);
      const root = packRootOf(entries);
      const names = namesUnder(entries, root);
      const archived = new MemoryPackSource(entries, 'upload', root);
      // The secret scan first, over every name and byte of the archive.
      // Only its sentence and the dot-env exception take the layout, read
      // from project.json: one that lists phases is the older layout, and one
      // that cannot be read takes the folder arm, the stricter one.
      older = isOlderLayout(archived);
      const secrets = checkPackFiles(archived, names, { layout: older ? 'older' : 'folder' });
      if (secrets.length) throw uploadRefused(secrets);
      // From here the archive logs what the conversion, the derivation and the
      // plain-text pass read of it, for the strict text rule.
      archived.forgetReads();
      let derived = archived;
      const conversion: string[] = [];
      if (older) {
        // Each task block as the archive wrote it, held to the editor's wall in the editor's words at its own
        // folder, before the conversion moves a block's brief into its phase's taskPanel.
        refuseOlderTaskBlocks(archived);
        const converted = convertedOnce(archived);
        derived = converted.source;
        conversion.push(...converted.warnings);
        archiveFolders = archiveFolderNames(archived);
      } else if (holdsFolder(archived, 'canonical')) {
        throw uploadRefused([{ code: 'PACK_INVALID', where: 'canonical', sentence: CANONICAL_IN_UPLOAD }]);
      }
      // A refusal of the derived pack in its own words, naming an older
      // archive's own phase folders rather than the converted ones; a file
      // that does not parse is found in the archive itself, as the pointer
      // loader read it (a converted interview.json was the archive's own file).
      const invalid = (error: unknown, at: MemoryPackSource): HttpException => {
        const raw = error instanceof Error ? error.message : String(error);
        const json = older && (error instanceof SyntaxError || JSON_PARSE_FAILURE.test(raw));
        // the loader's failures carry the pack's name and the derivation's do not; the pointer reading wants it
        const inner = raw.startsWith(`${at.name}/`) ? raw.slice(at.name.length + 1) : raw;
        const said = json ? jsonFailureDetail(`${archived.name}/${archiveFolders(inner)}`, archived) : archiveFolders(loaderDetail(error, at));
        return uploadRefused([{ code: 'PACK_INVALID', where: 'pack', sentence: said }]);
      };
      let manifest: RawPackManifest;
      try {
        manifest = buildPackManifest(derived);
      } catch (error) {
        if (error instanceof UploadRefusal || error instanceof HttpException) throw error;
        throw invalid(error, derived);
      }
      const findings: PackRefusal[] = [
        ...checkUploadShape(manifest, names),
        ...checkPackRuns(manifest),
        ...checkRunLimits(manifest),
        ...checkRuntimeProfile(manifest),
      ];
      if (findings.length) throw uploadRefused(findings);
      const dotted = checkSealedPaths(manifest);
      if (dotted.length) throw uploadRefused(dotted);
      // Every teacher text stored plain, and each quiz file held to
      // the quiz door's rules, before the loader reads the pack.
      let plain: ReturnType<typeof plainSource>;
      try {
        plain = plainSource(derived);
      } catch (error) {
        if (!(error instanceof PlainTextRefusal)) throw error;
        const at = plainPath(error.at);
        const said =
          error.shape === 'quiz' ? LAYOUT_SENTENCES.notAQuiz(at, error.sentence)
            : error.shape === 'block' ? `${at}'s phase.json task block: ${error.sentence}`
              : `${at}: ${error.sentence}`;
        throw uploadRefused([{ code: 'PACK_INVALID', where: 'pack', sentence: archiveFolders(said) }]);
      }
      source = plain.source;
      quizzes = quizRowsOf(source, invalid);
      // From here the source logs what the loader reads.
      source.forgetReads();
      const loaderWarnings: string[] = [];
      try {
        loaded = this.content.loadProject(source, { convertLegacyRequirements: true, convertLegacyDesign: true, convertLegacyRunbook: true, convertLegacyChange: true, warnings: loaderWarnings, origin: 'upload' });
        // A hand-written interview meets the interview door's caps; a refusal is PACK_INVALID's detail.
        refuseInterviewOverCaps(loaded, source);
      } catch (error) {
        if (error instanceof UploadRefusal || error instanceof HttpException) throw error;
        // The wire sentence is NOT_A_PACK's fixed one; the
        // loader's cleaned text is this reason's own sentence and rides in
        // `detail` only (`uploadRefused`).
        throw invalid(error, source);
      }
      // The archive's own bytes first: a converted or plain file was re-encoded from text, so its log names
      // what the conversion, the derivation and the plain-text pass read; then what the loader read.
      const notText = [...notTextRefusals(archived), ...notTextRefusals(source)];
      if (notText.length) throw uploadRefused(notText);
      // JSON escapes: the bytes above are plain ASCII,
      // but a `\u0000` or a lone `\ud800` in a JSON file decodes to what
      // PostgreSQL text cannot hold (22021, a 500) or stores mangled (U+FFFD).
      const escaped = escapedTextRefusals(source, loaded);
      if (escaped.length) throw uploadRefused(escaped.map((one) => ({ ...one, sentence: archiveFolders(one.sentence) })));
      const after = checkLoadedPack(loaded);
      if (after.length) throw uploadRefused(after);
      // Publish's reading of the run shapes over the loaded
      // pack (`rawPackManifestOf`: a shipped script is a file some phase
      // mounts locked and no phase mounts editable), so upload and publish
      // ask one shipped-scripts rule and a draft that uploads can publish.
      const published = checkPackRuns(rawPackManifestOf(loaded));
      if (published.length) throw uploadRefused(published);
      // The one compiler, as the importer will run it.
      const compiled = compileRefusal(loaded, title, (message) => this.logger.warn(message));
      if (compiled) throw uploadRefused([compiled]);
      const leftOut = [...new Set([...archived.leftOut(), ...derived.leftOut(), ...source.leftOut()])].sort(compareMountPaths);
      warnings.push(...conversion, ...loaderWarnings, ...plain.warnings, ...desktopWarnings(leftOut));
    } catch (error) {
      if (error instanceof UploadRefusal) throw fromRefusal(error);
      if (error instanceof HttpException) throw error;
      // Anything else out of reading a hostile archive is still the archive's
      // fault, and still a refusal by sentence rather than a 500.
      this.logger.warn(`upload refused on an unexpected ${(error as Error)?.name ?? 'error'} while reading the archive`);
      throw fromRefusal(new UploadRefusal('ARCHIVE_MALFORMED', archiveRefusalSentence('ARCHIVE_MALFORMED', limits)));
    }

    /* 7. the draft, and the one audit row, in one transaction */
    // The `project.uploaded` row is written by
    // `onWritten`, inside the importer's own transaction, after every draft
    // row: a draft and its audit row commit together or not at all. A failed
    // audit write rolls the draft back and propagates unchanged (an
    // infrastructure failure, never filed as the archive's refusal) so the
    // teacher is never told an upload failed that left a draft behind. The
    // detail carries the slug (AuditList reads `detail.slug`).
    const archiveBytes = archive.length;
    // A refusal the importer makes (a task block's key, a block or quiz compile) names the converted
    // folder; for an older archive it is said again naming the archive's own. Its transaction has
    // rolled back, so nothing was written.
    const made = await this.importer.importTeacherDraft(source, {
      ownerId: user.id,
      title,
      ...(quizzes.size ? { quizzes } : {}),
      onWritten: (manager, ids) =>
        recordAudit(manager, {
          event: UPLOAD_AUDIT_EVENT,
          actorUserId: user.id,
          subjectUserId: user.id,
          targetId: ids.projectId,
          action: ids.slug,
          detail: { slug: ids.slug, versionId: ids.versionId, archiveBytes },
        }),
    }).catch((error: unknown) => {
      throw older ? inArchiveFolders(error, archiveFolders) : error;
    });
    this.logger.log(`project uploaded: ${made.slug} (${archive.length} bytes) by ${user.id}`);
    return {
      projectId: made.projectId,
      versionId: made.versionId,
      slug: made.slug,
      version: DRAFT_FIRST_VERSION,
      compile: compileSummaryOf(loaded),
      validation: made.report,
      ...(warnings.length ? { warnings } : {}),
    };
  }
}

/**
 * An older-layout archive in the folder layout, read once
 * (`layoutFromManifest`), each refusal said as the door says it: a
 * converted path the secret rule refuses with its findings; a
 * refusal of the layout (a key held twice) and machine output or an
 * editor's folder at a converted path in their own sentences; anything else
 * the pointer loader's words, `<phase folder>: <sentence>`.
 */
function convertedOnce(archive: MemoryPackSource): { source: MemoryPackSource; warnings: string[] } {
  try {
    return layoutFromManifest(archive);
  } catch (error) {
    if (error instanceof ConversionRefusal) throw uploadRefused(error.findings);
    if (error instanceof UploadRefusal || error instanceof HttpException) throw error;
    throw uploadRefused([{ code: 'PACK_INVALID', where: 'pack', sentence: loaderDetail(error, archive) }]);
  }
}

/**
 * An importer refusal for an older archive, its detail naming the archive's
 * own phase folders (`archiveFolderNames`): a `BadRequestException` whose
 * response holds a string `detail` (`packRefusal`'s body) is said again as
 * PACK_INVALID, which `refusalDetail` clamps afresh; anything else (an
 * infrastructure failure, the audit write's) propagates unchanged.
 */
function inArchiveFolders(error: unknown, archiveFolders: (text: string) => string): unknown {
  if (!(error instanceof BadRequestException)) return error;
  const response = error.getResponse();
  const detail = response && typeof response === 'object' ? (response as { detail?: unknown }).detail : undefined;
  if (typeof detail !== 'string') return error;
  return uploadRefused([{ code: 'PACK_INVALID', where: 'pack', sentence: archiveFolders(detail) }]);
}

/**
 * An older archive's phase.json `task` blocks, each checked as the importer
 * checked them before the door converted an older archive
 * (`checkedTaskBlock`, its refusal naming the folder `project.json` lists):
 * the conversion applies a block's `brief` to its phase's `taskPanel`, so the
 * editor's wall is asked of the block as it was written. A phase.json that
 * cannot be read is left to the conversion's own words, and a block holding
 * text the store cannot hold to the escape rule.
 */
function refuseOlderTaskBlocks(archive: MemoryPackSource): void {
  const listed = parsedAt(archive, 'project.json')?.phases;
  for (const rel of Array.isArray(listed) ? listed : []) {
    if (typeof rel !== 'string') continue;
    let spec: Record<string, unknown> | null;
    try {
      spec = parsedAt(archive.child(rel), 'phase.json');
    } catch {
      spec = null;
    }
    // a text the store cannot hold is the escape rule's, which names the file (`escapedTextRefusals`)
    if (spec && Object.prototype.hasOwnProperty.call(spec, 'task') && unstorableIn(spec.task) === null) checkedTaskBlock(rel, spec.task, 'older');
  }
}

/** Whether the source holds a folder named `name` beside `project.json` (a file of that name is the author's own). */
function holdsFolder(source: PackSource, name: string): boolean {
  return source.entries('').some((one) => one.name === name && one.isDirectory);
}

/**
 * An older archive's own phase folders in a sentence that names the
 * converted ones: the conversion writes each listed phase to
 * `phases/<place>-<key>`, which for an archive whose folders are named
 * otherwise (a subset keeping LearnSDLC's numbers, a custom name) is not the
 * teacher's folder. Each converted folder is put back as the archive's
 * `project.json` lists it, in one pass, wherever it stands as a path.
 */
function archiveFolderNames(archive: MemoryPackSource): (text: string) => string {
  const listed = parsedAt(archive, 'project.json')?.phases;
  const held: { key: PhaseKey; rel: string }[] = [];
  for (const rel of Array.isArray(listed) ? listed : []) {
    if (typeof rel !== 'string') continue;
    let key: unknown;
    try {
      key = parsedAt(archive.child(rel), 'phase.json')?.key;
    } catch {
      key = undefined;
    }
    if (typeof key === 'string' && (PHASE_ORDER as readonly string[]).includes(key)) held.push({ key: key as PhaseKey, rel });
  }
  held.sort((a, b) => PHASE_ORDER.indexOf(a.key) - PHASE_ORDER.indexOf(b.key));
  const back = new Map<string, string>();
  held.forEach((one, i) => {
    const converted = `phases/${phaseFolderName(i + 1, one.key)}`;
    const own = one.rel.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
    if (own !== converted) back.set(converted, own);
  });
  if (back.size === 0) return (text) => text;
  const pattern = new RegExp(`(^|[\\s(])(${[...back.keys()].map(escapeRegExp).join('|')})(?=$|[/:'\\s.,;)])`, 'g');
  return (text) => text.replace(pattern, (_all, before: string, converted: string) => `${before}${back.get(converted)}`);
}

/**
 * Each quiz file of the archive as the row the editor's quiz door writes:
 * its JSON (refused by name when it does not parse, never quoting
 * it), then the DTO's wall, the inherited key, the paper, `checkedQuiz`'s
 * checks with the task key as the title, and the title and brief caps, each
 * refusal in the "<path> is not a quiz: " shape with every value it echoes
 * clipped (`clipEcho`). Read after the plain-text pass, so a quiz's texts
 * are stored plain.
 */
function quizRowsOf(source: MemoryPackSource, invalid: (error: unknown, at: MemoryPackSource) => HttpException): Map<PhaseKey, QuizRowInput[]> {
  let files: ReturnType<typeof phaseQuizzesOf>;
  try {
    files = phaseQuizzesOf(source);
  } catch (error) {
    if (error instanceof QuizFileRefusal) throw uploadRefused([{ code: 'PACK_INVALID', where: 'quizzes', sentence: error.message }]);
    if (error instanceof UploadRefusal || error instanceof HttpException) throw error;
    throw invalid(error, source);
  }
  const out = new Map<PhaseKey, QuizRowInput[]>();
  for (const [key, list] of files) {
    out.set(key, list.map((one) => {
      try {
        return quizTaskRow(quizFileBody(one.raw), one.key, clipEcho);
      } catch (error) {
        if (!(error instanceof HttpException)) throw error;
        throw uploadRefused([{ code: 'PACK_INVALID', where: 'quizzes', sentence: LAYOUT_SENTENCES.notAQuiz(plainPath(one.at), error.message) }]);
      }
    }));
  }
  return out;
}

/**
 * Every file the loader read, held to door-rules'
 * `strictText` (fatal UTF-8, no U+0000): the files the importer would write
 * as rows and manifests, and nothing else (a binary the pack carries but no
 * phase mounts is never read, never stored, and is not refused). One refusal,
 * for the first file in path order: its plain pack-relative path and the
 * reason, never a byte of it.
 */
function notTextRefusals(source: MemoryPackSource): PackRefusal[] {
  for (const at of source.filesRead()) {
    const bytes = source.bytesOf(at);
    if (!bytes) continue;
    const text = strictText(bytes);
    if (text.ok) continue;
    const named = at.length <= 200 ? at : `${at.slice(0, 200)}...`;
    const why =
      text.why === 'nul'
        ? 'holds a null byte (U+0000), so it is not a text file'
        : 'is not UTF-8 text (an image, an icon or another binary file)';
    // Short enough that a 200-character path keeps
    // the remedy inside UPLOAD_REFUSAL_DETAIL_MAX.
    return [{
      code: 'PACK_NOT_TEXT',
      where: 'files',
      sentence: `${named} ${why}. A file the project reads must be UTF-8 text: leave it out of the pack or stop mounting it, and upload again`,
    }];
  }
  return [];
}

/**
 * JSON escapes: the strings the loader and the
 * importer *parse* out of the pack, held to door-rules' `storableText`. A
 * file's bytes can be plain ASCII (so `strictText` passes) and still decode,
 * through a JSON escape, to U+0000 (PostgreSQL text refuses it: driver error
 * 22021, a 500) or to half a surrogate pair (stored as U+FFFD, mangled).
 *
 * Two passes, the first refusal wins:
 * 1. every JSON file the pack is configured by, as the loader read it
 *    (`project.json`, each declared phase's `phase.json` with its `task` block
 *    included, since the importer reads that key itself, the interview file a
 *    `phase.json` names, and each `meta.json` under a declared phase): every
 *    key and string value; the refusal names that file;

 * 2. the loaded project itself, every string and key, as a backstop for any
 *    other parsed value; the refusal names the phase (or `project.json`).
 *
 * A mounted file's own text is never parsed here: a JSON data file holding the
 * six characters `\u0000` is stored as written and is not refused. A refusal
 * names the file and the reason, never a byte of a value.
 */
function escapedTextRefusals(source: MemoryPackSource, loaded: ProjectContent): PackRefusal[] {
  const read = new Set(source.filesRead());
  const inPack = (dir: PackSource, rel: string): string => unlabelled(dir.resolve(rel), source.name);
  const project = parsedAt(source, 'project.json');
  const declared = project?.phases;
  const phases = (Array.isArray(declared) ? declared : []).filter((rel): rel is string => typeof rel === 'string');
  const configs = new Set<string>(['project.json']);
  // The folder layout's configuration files, by their fixed names.
  if (project && isFolderLayout(project)) for (const at of read) if (FOLDER_CONFIG.test(at)) configs.add(at);
  for (const rel of phases) {
    try {
      const dir = source.child(rel);
      configs.add(inPack(dir, 'phase.json'));
      const interview = parsedAt(dir, 'phase.json')?.interview;
      const named =
        interview && typeof interview === 'object' && typeof (interview as { source?: unknown }).source === 'string'
          ? (interview as { source: string }).source
          : typeof interview === 'string' && looksLikeFileName(interview)
            ? interview
            : null;
      if (named !== null) configs.add(inPack(dir, named));
      const prefix = `${inPack(dir, '.')}/`;
      for (const at of read) if (at.startsWith(prefix) && /(^|\/)meta\.json$/.test(at)) configs.add(at);
    } catch {
      // a declared phase that leaves the pack: the loader has refused it already
    }
  }
  for (const at of [...configs].sort()) {
    if (!read.has(at)) continue;
    const bytes = source.bytesOf(at);
    if (!bytes) continue;
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString('utf8'));
    } catch {
      continue; // not JSON: the loader read it as text (strictText has held it)
    }
    const why = unstorableIn(value);
    if (why) return [escapeRefusal(at.length <= 200 ? at : `${at.slice(0, 200)}...`, why)];
  }
  const top = unstorableIn({ ...loaded, phases: [], warmup: undefined });
  if (top) return [escapeRefusal('project.json (or a file it names)', top)];
  for (const phase of loaded.phases) {
    const why = unstorableIn(phase);
    if (why) return [escapeRefusal(`the ${printable(String(phase.key)).slice(0, 40)} phase's phase.json (or a file it names)`, why)];
  }
  const warm = loaded.warmup === undefined ? null : unstorableIn(loaded.warmup);
  if (warm) return [escapeRefusal('the warm-up (or a file it names)', warm)];
  return [];
}

/** A folder-layout file the pack is configured by: a phase's `phase.json`, `interview.json`, a quiz file or a mutant's `meta.json`. */
const FOLDER_CONFIG = /^phases\/[^/]+\/(phase\.json|interview\.json|quizzes\/[^/]+\.json|mutants\/[^/]+\/meta\.json)$/;

/** The first reason a key or string anywhere in `value` cannot be stored (`storableText`), or null. Iterative: no depth limit. */
function unstorableIn(value: unknown): 'nul' | 'surrogate' | null {
  const stack: unknown[] = [value];
  while (stack.length) {
    const one = stack.pop();
    if (typeof one === 'string') {
      const why = storableText(one);
      if (why) return why;
    } else if (one && typeof one === 'object') {
      if (Array.isArray(one)) {
        for (const item of one) stack.push(item);
      } else {
        for (const [key, item] of Object.entries(one as Record<string, unknown>)) {
          const why = storableText(key);
          if (why) return why;
          stack.push(item);
        }
      }
    }
  }
  return null;
}

function escapeRefusal(where: string, why: 'nul' | 'surrogate'): PackRefusal {
  const what =
    why === 'nul'
      ? 'a null character (U+0000) written as a JSON escape'
      : 'half of a surrogate pair (a lone \\ud800-\\udfff JSON escape)';
  return {
    code: 'PACK_NOT_TEXT',
    where: 'files',
    sentence: `${where} holds ${what}, which a project cannot store. Remove it and upload again`,
  };
}

/**
 * The loaded pack compiled exactly as `importTeacherDraft`
 * compiles it (`{ ...loaded, slug, title, version: DRAFT_FIRST_VERSION }`),
 * so a pack only the compiler refuses is a 400 here and never a plain
 * `Error` out of the importer's transaction (a 500). The slug is minted from
 * the title as the importer mints it; the compiler's sentence loses its
 * `<slug>/` label and rides in `detail`. Only the compiler is asked: what the
 * importer meets after it (the database) is never filed as the archive's fault.
 */
function compileRefusal(loaded: ProjectContent, title: string, warn: (message: string) => void): PackRefusal | null {
  const slug = mintTeacherSlug(title, new Set());
  try {
    compilePack({ ...loaded, slug, title, version: DRAFT_FIRST_VERSION });
    return null;
  } catch (error) {
    if (error instanceof HttpException || error instanceof UploadRefusal) throw error;
    const plain = error instanceof Error && error.name === 'Error';
    // A throw that is not the compiler's own refusal (a TypeError,
    // a RangeError) is still the archive's 400, but it may be a compiler bug:
    // operators see its class, never its message (it can quote the pack).
    if (!plain) warn(`upload refused on an unexpected ${errorClassOf(error)} from the compiler`);
    const said = plain
      ? (error as Error).message.replace(new RegExp(`(^|[\\s(])${escapeRegExp(slug)}/`, 'g'), '$1')
      : 'The compiler could not read this pack. Check each phase.json against the authoring format and upload again';
    return { code: 'PACK_COMPILE', where: 'pack', sentence: said };
  }
}

/**
 * What the accepted draft holds, in counts: its phases, one task row per
 * phase (the importer materialises each phase's sole task), the file rows
 * the importer writes (`derivedFileRows`, every role), and the microVMs one
 * full pass costs (`sandboxBudgetFor`, read only).
 */
function compileSummaryOf(project: ProjectContent): ProjectUploadResult['compile'] {
  return {
    phases: project.phases.length,
    tasks: project.phases.length,
    files: derivedFileRows(project).length,
    sandboxBudget: project.phases.reduce((sum, phase) => sum + sandboxBudgetFor(phase, [soleTaskFor(phase)]), 0),
  };
}

/** The archive's entry names under the pack root, relative to it. */
function namesUnder(entries: ArchiveEntry[], root: string): string[] {
  const prefix = root ? `${root}/` : '';
  return entries
    .filter((entry) => entry.name.startsWith(prefix))
    .map((entry) => entry.name.slice(prefix.length))
    .filter(Boolean);
}

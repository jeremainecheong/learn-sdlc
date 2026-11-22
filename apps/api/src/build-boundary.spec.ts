import * as fs from 'fs';
import * as path from 'path';

/**
 * The production build is `tsc -p tsconfig.build.json`, and that config compiles
 * with `rootDir: src`. A source file under `src/` that imports anything outside
 * it makes `tsc` exit non-zero (TS6059), and `npm run build -w @learnsdlc/api`
 * is a `RUN` line of the API image, so the image stops building. `npm run
 * typecheck` cannot see it: it uses `tsconfig.json`, which includes `test/` and
 * names no `rootDir`. A developer tool that needs test support code belongs
 * under `test/`, where the build never looks.
 */
describe('the production build boundary', () => {
  const src = __dirname;

  const sources = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const at = path.join(dir, entry.name);
      if (entry.isDirectory()) return sources(at);
      return /\.ts$/.test(entry.name) && !/\.spec\.ts$/.test(entry.name) ? [at] : [];
    });

  it('compiles with rootDir src and leaves the specs out', () => {
    const config = JSON.parse(
      fs.readFileSync(path.join(src, '..', 'tsconfig.build.json'), 'utf-8'),
    );
    expect(config.compilerOptions.rootDir).toBe('src');
    expect(config.include).toEqual(['src']);
    expect(config.exclude).toEqual(['src/**/*.spec.ts']);
  });

  it('holds no built source that imports a file outside src', () => {
    const specifier = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
    const escapes = sources(src).flatMap((file) =>
      [...fs.readFileSync(file, 'utf-8').matchAll(specifier)]
        .map((match) => path.resolve(path.dirname(file), match[1]))
        .filter((target) => !target.startsWith(src + path.sep))
        .map((target) => `${path.relative(src, file)} -> ${path.relative(src, target)}`),
    );
    expect(escapes).toEqual([]);
  });
});

/**
 * The container reads a constructor parameter's token from its emitted design
 * type, and a parameter typed `T | null` (or any other union) emits `Object`.
 * With `@Optional()` and no explicit `@Inject(...)`, Nest then injects nothing
 * and says nothing: the service works in every hand-built spec and is absent
 * from the mounted application. That is how readiness lost its `content`
 * probes, which the release's host adapter requires of a candidate.
 */
describe('optional injections', () => {
  const src = __dirname;
  const sources = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const at = path.join(dir, entry.name);
      if (entry.isDirectory()) return sources(at);
      return /\.ts$/.test(entry.name) && !/\.spec\.ts$/.test(entry.name) ? [at] : [];
    });

  it('names its token wherever the parameter type is a union', () => {
    const parameter = /@Optional\(\)([^,)]*?:\s*[^,)=]*\|[^,)=]*)/g;
    const silent = sources(src).flatMap((file) =>
      [...fs.readFileSync(file, 'utf-8').matchAll(parameter)]
        .filter((match) => !/@Inject\w*\(/.test(match[1]))
        .map((match) => `${path.relative(src, file)}: ${match[0].replace(/\s+/g, ' ')}`),
    );
    expect(silent).toEqual([]);
  });
});

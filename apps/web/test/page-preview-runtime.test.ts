/**
 * The preview runtime asset is the installed React, wrapped.
 *
 * The frame loads React from `public/preview-runtime/react-runtime.js`. That
 * file is generated from node_modules by build-runtime.mjs, so a React
 * upgrade that forgets to regenerate it fails here rather than in a frame.
 */
import { readFileSync } from 'fs';
import * as path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { RUNTIME_FILE, buildRuntime } from '@/components/workspace/preview/client/build-runtime.mjs';

describe('runtime asset', () => {
  it('matches what the generator writes from the installed React', () => {
    expect(path.relative(path.resolve(__dirname, '..'), RUNTIME_FILE)).toBe('public/preview-runtime/react-runtime.js');
    expect(readFileSync(RUNTIME_FILE, 'utf8')).toBe(buildRuntime());
  });

  // The web image's build-context check reads every `require(...)` under
  // apps/web as an import that must resolve in the image. This asset is
  // browser code, so it names its own loader
  // `__previewRequire` and carries no `require(` call at all.
  it('carries no require() call, only its own __previewRequire loader', () => {
    const source = readFileSync(RUNTIME_FILE, 'utf8');
    const sf = ts.createSourceFile('react-runtime.js', source, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
    const named: string[] = [];
    const loader: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const arg = node.arguments[0];
        const spec = arg && ts.isStringLiteralLike(arg) ? arg.text : '?';
        if (node.expression.text === 'require') named.push(spec);
        if (node.expression.text === '__previewRequire') loader.push(spec);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    expect(named).toEqual([]);
    expect(loader.sort()).toEqual(['react', 'react', 'react', 'react-dom', 'scheduler']);
    expect(source).not.toMatch(/\brequire\s*\(/);
  });
});

#!/usr/bin/env node
/**
 * Writes `apps/web/public/preview-runtime/react-runtime.js`.
 *
 * The page preview frame has no network and no bundler, so React reaches it
 * as one static script from this app's own origin. React 19 ships no UMD
 * build, so this wraps the production CommonJS files of the react, react-dom
 * and scheduler packages the web app already depends on (the same versions,
 * read from node_modules, byte for byte except that each `require("x")` call
 * is renamed to the registry's `__previewRequire("x")`) in a tiny registry:
 *
 *   window.__learnsdlcPreviewRuntime = { version, has(name), require(name) }
 *
 * Nothing else is vendored. Run it again after a React upgrade; the
 * page-preview-runtime test fails until the asset matches the installed React.
 *
 *   npm run build:preview-runtime -w @learnsdlc/web
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.resolve(here, '../../../..');
const require = createRequire(path.join(web, 'package.json'));

const MODULES = [
  ['scheduler', 'scheduler/cjs/scheduler.production.js'],
  ['react', 'react/cjs/react.production.js'],
  ['react/jsx-runtime', 'react/cjs/react-jsx-runtime.production.js'],
  ['react-dom', 'react-dom/cjs/react-dom.production.js'],
  ['react-dom/client', 'react-dom/cjs/react-dom-client.production.js'],
];

/**
 * A small hash router answering to `react-router-dom`, written here (not
 * vendored): createHashRouter / createBrowserRouter / createMemoryRouter,
 * RouterProvider, Link, NavLink, Outlet, useParams, useNavigate, useLocation,
 * and pass-through HashRouter / BrowserRouter / MemoryRouter. The frame has an
 * opaque origin, so every router routes on the hash.
 */
const ROUTER_SHIM = `
  var React = require('react');
  var h = React.createElement;
  var Ctx = React.createContext({ outlet: null, params: {} });
  function current() { var x = (location.hash || '#/').slice(1).split('?')[0]; return x.charAt(0) === '/' ? x : '/' + x; }
  function navigate(to) { to = String(to); location.hash = '#' + (to.charAt(0) === '/' ? to : '/' + to); }
  function split(p) { return String(p || '').split('/').filter(Boolean); }
  function match(routes, segs, params) {
    for (var i = 0; i < (routes || []).length; i++) {
      var r = routes[i];
      if (r.path === '*') return [{ route: r, params: params }];
      var own = r.index ? [] : split(r.path), p = {}, ok = own.length <= segs.length;
      for (var k = 0; ok && k < own.length; k++) {
        if (own[k].charAt(0) === ':') p[own[k].slice(1)] = decodeURIComponent(segs[k]);
        else if (own[k] !== segs[k]) ok = false;
      }
      if (!ok) continue;
      var rest = segs.slice(own.length), all = Object.assign({}, params, p);
      if (r.index) { if (!rest.length) return [{ route: r, params: all }]; continue; }
      if (r.children) { var sub = match(r.children, rest, all); if (sub) return [{ route: r, params: all }].concat(sub); }
      if (!rest.length) return [{ route: r, params: all }];
    }
    return null;
  }
  function useHash() {
    var s = React.useState(current());
    React.useEffect(function () {
      function on() { s[1](current()); }
      addEventListener('hashchange', on);
      return function () { removeEventListener('hashchange', on); };
    }, []);
    return s[0];
  }
  function Outlet() { return React.useContext(Ctx).outlet || null; }
  function RouterProvider(props) {
    var path = useHash();
    var chain = match(props.router && props.router.routes, split(path), {});
    if (!chain) return h('p', null, 'No route matches ' + path);
    var out = null, params = chain[chain.length - 1].params;
    for (var i = chain.length - 1; i >= 0; i--) out = h(Ctx.Provider, { value: { outlet: out, params: params } }, chain[i].route.element || h(Outlet));
    return out;
  }
  function createRouter(routes) { return { routes: routes }; }
  function Link(props) {
    var rest = Object.assign({}, props);
    delete rest.to;
    var to = String(props.to);
    rest.href = '#' + (to.charAt(0) === '/' ? to : '/' + to);
    return h('a', rest, props.children);
  }
  function Pass(props) { return props.children || null; }
  module.exports = {
    createHashRouter: createRouter, createBrowserRouter: createRouter, createMemoryRouter: createRouter,
    RouterProvider: RouterProvider, Link: Link, NavLink: Link, Outlet: Outlet,
    useParams: function () { return React.useContext(Ctx).params; },
    useNavigate: function () { return navigate; },
    useLocation: function () { return { pathname: useHash(), search: '', hash: '' }; },
    HashRouter: Pass, BrowserRouter: Pass, MemoryRouter: Pass,
  };
`;

/**
 * The registry's loader is named `__previewRequire`, never `require`: this file
 * is browser code under apps/web/public, and the web image's build-context
 * check reads every `require('x')`
 * under apps/web as an import that must resolve in the image (react-dom's
 * `require("scheduler")` names a package apps/web does not declare). So each
 * `require("<string>")` call in a wrapped file is renamed, nothing else in it
 * changes, and the build fails if any other `require(` remains.
 */
const LOADER = '__previewRequire';
const REQUIRE_CALL = /\brequire\((["'])([^"'\\]+)\1\)/g;

function renameRequire(name, source) {
  const out = source.replace(REQUIRE_CALL, (_, quote, spec) => `${LOADER}(${quote}${spec}${quote})`);
  if (/\brequire\s*\(/.test(out)) throw new Error(`build-runtime: ${name} still calls require( after the rename.`);
  return out;
}

export function buildRuntime() {
  const version = require('react/package.json').version;
  const defs = MODULES.map(([name, file]) => {
    const pkg = file.split('/')[0];
    const source = readFileSync(path.join(path.dirname(require.resolve(`${pkg}/package.json`)), file.slice(pkg.length + 1)), 'utf8');
    return `defs[${JSON.stringify(name)}] = function (module, exports, ${LOADER}) {\n${renameRequire(name, source)}\n};`;
  });
  defs.push(`defs["react-router-dom"] = function (module, exports, ${LOADER}) {\n${renameRequire('react-router-dom', ROUTER_SHIM)}\n};`);
  return `/* LearnSDLC page preview runtime: react ${version}, react-dom ${version}, production CommonJS builds from node_modules. Generated by components/workspace/preview/client/build-runtime.mjs. */
(function () {
  var defs = {};
  var cache = {};
${defs.join('\n')}
  function load(name) {
    if (name === 'react/jsx-dev-runtime') name = 'react/jsx-runtime';
    if (cache[name]) return cache[name].exports;
    if (!Object.prototype.hasOwnProperty.call(defs, name)) throw new Error('The page preview runtime has no ' + name + '.');
    var module = { exports: {} };
    cache[name] = module;
    defs[name].call(module.exports, module, module.exports, load);
    return module.exports;
  }
  window.__learnsdlcPreviewRuntime = {
    version: ${JSON.stringify(version)},
    has: function (name) { return name === 'react/jsx-dev-runtime' || Object.prototype.hasOwnProperty.call(defs, name); },
    require: load,
  };
})();
`;
}

export const RUNTIME_FILE = path.join(web, 'public/preview-runtime/react-runtime.js');

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  mkdirSync(path.dirname(RUNTIME_FILE), { recursive: true });
  writeFileSync(RUNTIME_FILE, buildRuntime());
  console.log(`wrote ${path.relative(process.cwd(), RUNTIME_FILE)}`);
}

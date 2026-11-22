"""LearnSDLC static analyzer for Python learner code.

Reads a JSON job from stdin:

  { "files": {"path.py": "content", ...}, "targets": ["path.py", ...], "language": "python" }

and writes an AnalyzerReport to stdout:

  { "issues": [{path, line, severity, rule, message}, ...],
    "metrics": {files, functions, todosRemaining, maxComplexity, docstringCoverage},
    "functions": [{name, qualname, path, line, endLine, complexity, calls[], bodyHash}, ...],
    "imports": [{module, names[], path, line}, ...] }

`functions` and `imports` are the structural index the later phases read: the call
graph and function ledger in implementation, change impact in maintenance. Python is
parsed with `ast`; JavaScript is best-effort regex, so a declaration the regexes
cannot see (an anonymous callback, say) is absent rather than wrong. `bodyHash` is a
sha1 of the normalised body, so it is stable across reformatting and equal only when
two revisions of a function do the same thing.

Only stdlib is used, so the analyzer runs identically in local dev, CI and
the production runner image. Analysis targets are the learner-editable files;
other files are ignored.
"""

import ast
import hashlib
import json
import re
import sys

BANNED_CALLS = {"eval", "exec", "__import__", "compile"}
BANNED_IMPORTS = {"subprocess", "socket", "ctypes", "importlib"}
MAX_COMPLEXITY = 8
MAX_FUNCTION_LINES = 40
MAX_FUNCTIONS = 200
MAX_IMPORTS = 200
MAX_CALLS = 50

_WHITESPACE = re.compile(r"\s+")


def complexity_of(node):
    """1 + number of branch points: a cyclomatic-complexity approximation."""
    score = 1
    for child in ast.walk(node):
        if isinstance(child, (ast.If, ast.For, ast.While, ast.ExceptHandler, ast.Assert)):
            score += 1
        elif isinstance(child, ast.BoolOp):
            score += max(0, len(child.values) - 1)
        elif isinstance(child, (ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)):
            for gen in child.generators:
                score += len(gen.ifs)
    return score


def _sha1(text):
    return hashlib.sha1(text.encode("utf-8")).hexdigest()


def _add_capped(target, item, cap):
    """Append while the cap allows it; the cap bounds the report, not the analysis."""
    if target is not None and len(target) < cap:
        target.append(item)


def _call_names(node):
    """Names called anywhere inside `node`, first appearance first.

    An attribute call contributes its last segment (`self.get_task(x)` -> `get_task`)
    so a call can be matched against a function name. Nested definitions are walked
    too, the same way complexity_of() scores the whole subtree.
    """
    names = []
    seen = set()
    for child in ast.walk(node):
        if not isinstance(child, ast.Call):
            continue
        func = child.func
        if isinstance(func, ast.Name):
            name = func.id
        elif isinstance(func, ast.Attribute):
            name = func.attr
        else:
            name = None
        if name and name not in seen:
            seen.add(name)
            names.append(name)
            if len(names) >= MAX_CALLS:
                break
    return names


def _python_body_hash(node, lines):
    """sha1 of the function body, normalised so layout is not a change.

    `ast.unparse` re-renders the statements, dropping comments, blank lines and
    formatting; the docstring is dropped first, so prose edits do not read as
    behaviour edits. Without unparse (before 3.9) the raw body lines are collapsed.
    """
    body = list(node.body)
    if (
        body
        and isinstance(body[0], ast.Expr)
        and isinstance(body[0].value, ast.Constant)
        and isinstance(body[0].value.value, str)
    ):
        body = body[1:]
    if hasattr(ast, "unparse"):
        try:
            return _sha1("\n".join(ast.unparse(stmt) for stmt in body))
        except Exception:  # pragma: no cover - unparse refuses a node it cannot render
            pass
    if not body:
        return _sha1("")
    start = body[0].lineno - 1
    end = getattr(body[-1], "end_lineno", body[-1].lineno)
    return _sha1(_WHITESPACE.sub(" ", "\n".join(lines[start:end])).strip())


def _collect_python_functions(path, source, tree, functions):
    """Index every def in the module, source order, methods and nested defs included.

    The walk keeps its own stack rather than recursing, so deeply nested learner
    code cannot cost the whole report a RecursionError.
    """
    if functions is None:
        return
    lines = source.splitlines()
    pending = [(tree, ())]
    while pending:
        if len(functions) >= MAX_FUNCTIONS:
            return
        node, scope = pending.pop()
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            functions.append({
                "name": node.name,
                "qualname": ".".join(scope + (node.name,)),
                "path": path,
                "line": node.lineno,
                "endLine": getattr(node, "end_lineno", node.lineno),
                "complexity": complexity_of(node),
                "calls": _call_names(node),
                "bodyHash": _python_body_hash(node, lines),
            })
            scope = scope + (node.name,)
        elif isinstance(node, ast.ClassDef):
            scope = scope + (node.name,)
        pending.extend(reversed([(child, scope) for child in ast.iter_child_nodes(node)]))


def _collect_python_imports(path, tree, imports):
    """Index imports. `names` are the local bindings, empty for a plain `import x`."""
    if imports is None:
        return
    found = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                found.append({
                    "module": alias.name,
                    "names": [alias.asname] if alias.asname else [],
                    "path": path,
                    "line": node.lineno,
                })
        elif isinstance(node, ast.ImportFrom):
            found.append({
                "module": "." * node.level + (node.module or ""),
                "names": [alias.asname or alias.name for alias in node.names],
                "path": path,
                "line": node.lineno,
            })
    for item in sorted(found, key=lambda entry: (entry["line"], entry["module"])):
        _add_capped(imports, item, MAX_IMPORTS)


def _issue(path, line, severity, rule, message):
    """One finding, with its keys in the order the API and the report read them."""
    return {"path": path, "line": line, "severity": severity, "rule": rule, "message": message}


def analyze_python_file(path, source, issues, functions=None, imports=None):
    metrics = {"functions": 0, "documented": 0, "todos": 0, "maxComplexity": 0}

    for lineno, line in enumerate(source.splitlines(), start=1):
        if "TODO(learner)" in line:
            metrics["todos"] += 1
            issues.append(_issue(
                path, lineno, "warning", "todo-remaining",
                "A TODO(learner) marker is still in place.",
            ))

    try:
        tree = ast.parse(source, filename=path)
    except SyntaxError as exc:
        issues.append(_issue(
            path, exc.lineno or 1, "error", "syntax-error",
            f"Syntax error: {exc.msg}",
        ))
        return metrics

    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in BANNED_CALLS:
            issues.append(_issue(
                path, node.lineno, "error", "banned-construct",
                f"Use of {node.func.id}() is not allowed in learner code.",
            ))
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            names = [a.name.split(".")[0] for a in node.names] if isinstance(node, ast.Import) else [(node.module or "").split(".")[0]]
            for name in names:
                if name in BANNED_IMPORTS:
                    issues.append(_issue(
                        path, node.lineno, "error", "banned-import",
                        f"Importing {name} is not allowed in learner code.",
                    ))
        if isinstance(node, ast.ImportFrom) and any(a.name == "*" for a in node.names):
            issues.append(_issue(
                path, node.lineno, "warning", "wildcard-import",
                "Wildcard imports hide where names come from.",
            ))
        if isinstance(node, ast.Raise) and isinstance(node.exc, ast.Call) and isinstance(node.exc.func, ast.Name) and node.exc.func.id == "NotImplementedError":
            issues.append(_issue(
                path, node.lineno, "error", "not-implemented",
                "This function still raises NotImplementedError.",
            ))

        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            metrics["functions"] += 1
            if ast.get_docstring(node):
                metrics["documented"] += 1
            elif not node.name.startswith("_"):
                issues.append(_issue(
                    path, node.lineno, "info", "missing-docstring",
                    f"Public function {node.name}() has no docstring.",
                ))
            score = complexity_of(node)
            metrics["maxComplexity"] = max(metrics["maxComplexity"], score)
            if score > MAX_COMPLEXITY:
                issues.append(_issue(
                    path, node.lineno, "warning", "high-complexity",
                    f"{node.name}() has complexity {score} (limit {MAX_COMPLEXITY}) — consider splitting it.",
                ))
            end = getattr(node, "end_lineno", node.lineno)
            length = end - node.lineno + 1
            if length > MAX_FUNCTION_LINES:
                issues.append(_issue(
                    path, node.lineno, "warning", "long-function",
                    f"{node.name}() is {length} lines long (limit {MAX_FUNCTION_LINES}).",
                ))

    _collect_python_functions(path, source, tree, functions)
    _collect_python_imports(path, tree, imports)
    return metrics


JS_BANNED = ("eval(", "new Function(", "require('child_process')", 'require("child_process")',
             "require('vm')", 'require("vm")')
JS_BRANCH_KEYWORDS = ("if ", "if(", "for ", "for(", "while ", "while(", "case ", "catch ", "&&", "||", "?")


JS_KEYWORDS = {"if", "for", "while", "switch", "catch", "return", "function", "do", "else", "typeof",
               "new", "delete", "await", "yield", "throw", "with", "in", "of", "case", "class", "super"}

_JS_DECL = re.compile(
    r"""(?:^|[\n;{}()])[ \t]*(?P<decl>
        (?:export[ \t]+(?:default[ \t]+)?)?
        (?:
            (?:async[ \t]+)?function[ \t]*\*?[ \t]*(?P<fname>[A-Za-z_$][\w$]*)[ \t]*\(
          | (?:const|let|var)[ \t]+(?P<vname>[A-Za-z_$][\w$]*)[ \t]*=[ \t]*(?:async[ \t]*)?
                (?:function[ \t]*\*?[ \t]*(?:[A-Za-z_$][\w$]*[ \t]*)?)?\(
          | (?:static[ \t]+)?(?:async[ \t]+)?(?:get[ \t]+|set[ \t]+)?\*?[ \t]*(?P<mname>[A-Za-z_$][\w$]*)[ \t]*\(
        ))""",
    re.X,
)
_JS_ARROW = re.compile(
    r"""(?:^|[\n;{}()])[ \t]*(?P<decl>
        (?:export[ \t]+(?:default[ \t]+)?)?
        (?:const|let|var)[ \t]+(?P<name>[A-Za-z_$][\w$]*)[ \t]*=[ \t]*
        (?:async[ \t]+)?[A-Za-z_$][\w$]*[ \t]*)(?==>)""",
    re.X,
)
_JS_CLASS = re.compile(r"\bclass[ \t]+(?P<name>[A-Za-z_$][\w$]*)[^{]*\{")
_JS_CALL = re.compile(r"(?P<name>[A-Za-z_$][\w$]*)[ \t]*\(")
_JS_LINE_COMMENT = re.compile(r"//[^\n]*")
_JS_BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.S)
_JS_REQUIRE = re.compile(
    r"""(?:(?:const|let|var)[ \t]+(?P<binding>\{[^}]*\}|[A-Za-z_$][\w$]*)[ \t]*=[ \t]*)?
        require\([ \t]*(?P<rq>['"])(?P<module>[^'"]+)(?P=rq)[ \t]*\)""",
    re.X,
)
_JS_IMPORT = re.compile(
    r"""\bimport[ \t]+(?:(?P<clause>[^'";]+?)[ \t\r\n]+from[ \t\r\n]*)?(?P<iq>['"])(?P<module>[^'"]+)(?P=iq)""",
    re.X,
)


def _line_of(source, index):
    return source.count("\n", 0, index) + 1


def _js_skip_string(source, index):
    """Index just past the string or template literal opening at `index`."""
    quote = source[index]
    i = index + 1
    while i < len(source):
        if source[i] == "\\":
            i += 2
            continue
        if source[i] == quote:
            return i + 1
        i += 1
    return len(source)


def _js_skip_trivia(source, index):
    """Index just past the string or comment at `index`, else `index` unchanged."""
    ch = source[index]
    if ch in "\"'`":
        return _js_skip_string(source, index)
    if ch == "/" and index + 1 < len(source) and source[index + 1] in "/*":
        if source[index + 1] == "/":
            newline = source.find("\n", index)
            return len(source) if newline < 0 else newline + 1
        close = source.find("*/", index + 2)
        return len(source) if close < 0 else close + 2
    return index


def _js_match(source, index, opener, closer):
    """Index just past the bracket matching `source[index]`, or -1.

    Strings and comments are skipped so a bracket inside them cannot unbalance the
    scan. Regex literals are not tracked, which is why JS analysis is best-effort.
    """
    depth = 0
    i = index
    while i < len(source):
        moved = _js_skip_trivia(source, i)
        if moved != i:
            i = moved
            continue
        if source[i] == opener:
            depth += 1
        elif source[i] == closer:
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    return -1


def _js_expression_end(source, start):
    """End of the concise arrow expression at `start`: a closing bracket, comma, `;` or newline."""
    depth = 0
    i = start
    while i < len(source):
        moved = _js_skip_trivia(source, i)
        if moved != i:
            i = moved
            continue
        ch = source[i]
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            if depth == 0:
                return i
            depth -= 1
        elif depth == 0 and ch in ";,\n":
            return i
        i += 1
    return len(source)


def _js_body_span(source, index):
    """(start, end) of the body following a parameter list, or None when there is none.

    Covers `) {`, `) => {` and the concise `) => expr`.
    """
    arrow = re.match(r"\s*=>\s*", source[index:])
    start = index + arrow.end() if arrow else index
    brace = re.match(r"\s*\{", source[start:])
    if brace:
        open_brace = start + brace.end() - 1
        end = _js_match(source, open_brace, "{", "}")
        return (open_brace + 1, end - 1) if end > 0 else None
    if arrow:
        return (start, _js_expression_end(source, start))
    return None


def _js_class_ranges(source):
    """(start, end, name) for each class body, used to qualify method names."""
    ranges = []
    for match in _JS_CLASS.finditer(source):
        end = _js_match(source, match.end() - 1, "{", "}")
        ranges.append((match.start(), end if end > 0 else len(source), match.group("name")))
    return ranges


def _js_calls(body):
    names = []
    seen = set()
    for match in _JS_CALL.finditer(body):
        name = match.group("name")
        if name in JS_KEYWORDS or name in seen:
            continue
        seen.add(name)
        names.append(name)
        if len(names) >= MAX_CALLS:
            break
    return names


def _js_body_hash(body):
    stripped = _JS_BLOCK_COMMENT.sub(" ", _JS_LINE_COMMENT.sub(" ", body))
    return _sha1(_WHITESPACE.sub(" ", stripped).strip())


def _js_binding_names(clause):
    """Local names an import clause binds: `{a, b as c}` -> a, c; `* as ns` -> ns."""
    if not clause:
        return []
    names = []
    for part in re.sub(r"[{}]", " ", clause).split(","):
        tokens = re.findall(r"[A-Za-z_$][\w$]*", part)
        if tokens:
            names.append(tokens[-1])
    return names


def _collect_js_functions(path, source, functions):
    """Index named declarations, class methods and named arrows. Anonymous callbacks
    are invisible to the regexes, so they are simply absent from the index."""
    if functions is None:
        return
    classes = _js_class_ranges(source)
    candidates = []
    for match in _JS_DECL.finditer(source):
        name = match.group("fname") or match.group("vname") or match.group("mname")
        if not name or name in JS_KEYWORDS:
            continue
        close = _js_match(source, match.end() - 1, "(", ")")
        if close < 0:
            continue
        span = _js_body_span(source, close)
        if span:
            candidates.append((match.start("decl"), name, span))
    for match in _JS_ARROW.finditer(source):
        span = _js_body_span(source, match.end())
        if span:
            candidates.append((match.start("decl"), match.group("name"), span))

    seen_bodies = set()
    for start, name, (body_start, body_end) in sorted(candidates, key=lambda entry: entry[0]):
        if len(functions) >= MAX_FUNCTIONS:  # hashing bodies past the cap buys nothing
            return
        if body_start in seen_bodies:
            continue
        seen_bodies.add(body_start)
        body = source[body_start:body_end]
        scope = [name for begin, end, name in classes if begin <= start < end]
        _add_capped(functions, {
            "name": name,
            "qualname": ".".join(scope + [name]),
            "path": path,
            "line": _line_of(source, start),
            "endLine": _line_of(source, body_end),
            "complexity": 1 + sum(body.count(keyword) for keyword in JS_BRANCH_KEYWORDS),
            "calls": _js_calls(body),
            "bodyHash": _js_body_hash(body),
        }, MAX_FUNCTIONS)


def _collect_js_imports(path, source, imports):
    """Index `require(...)` and ESM `import ... from '...'`."""
    if imports is None:
        return
    found = []
    for match in _JS_REQUIRE.finditer(source):
        found.append({
            "module": match.group("module"),
            "names": _js_binding_names(match.group("binding")),
            "path": path,
            "line": _line_of(source, match.start()),
        })
    for match in _JS_IMPORT.finditer(source):
        found.append({
            "module": match.group("module"),
            "names": _js_binding_names(match.group("clause")),
            "path": path,
            "line": _line_of(source, match.start()),
        })
    for item in sorted(found, key=lambda entry: (entry["line"], entry["module"])):
        _add_capped(imports, item, MAX_IMPORTS)


def analyze_js_file(path, source, issues, functions=None, imports=None):
    """Heuristic (regex/line) analysis for JavaScript, with no AST dependency.

    Node ships no stdlib JS parser, so this checks the same *intent* as the
    Python AST analyzer: leftover TODOs, unimplemented stubs, banned dynamic
    execution, and a rough per-file complexity from branch keywords.
    """
    metrics = {"functions": 0, "documented": 0, "todos": 0, "maxComplexity": 0}
    lines = source.splitlines()
    for lineno, line in enumerate(lines, start=1):
        if "TODO(learner)" in line:
            metrics["todos"] += 1
            issues.append(_issue(path, lineno, "warning", "todo-remaining",
                                 "A TODO(learner) marker is still in place."))
        if "not implemented" in line.lower() and ("throw" in line.lower()):
            issues.append(_issue(path, lineno, "error", "not-implemented",
                                 "This function still throws a not-implemented error."))
        for banned in JS_BANNED:
            if banned in line:
                issues.append(_issue(path, lineno, "error", "banned-construct",
                                     f"Use of {banned.rstrip('(')} is not allowed in learner code."))
    metrics["functions"] = len(re.findall(r"\bfunction\b|=>", source))
    branch_points = sum(source.count(k) for k in JS_BRANCH_KEYWORDS)
    metrics["maxComplexity"] = 1 + branch_points
    if branch_points + 1 > MAX_COMPLEXITY * 3:  # file-level, JS lumps many funcs together
        issues.append(_issue(path, 1, "warning", "high-complexity",
                             f"High branching complexity ({branch_points + 1}); consider splitting functions."))
    metrics["documented"] = metrics["functions"]  # JS has no docstrings; do not penalise
    _collect_js_functions(path, source, functions)
    _collect_js_imports(path, source, imports)
    return metrics


def analyzer_for(path):
    """Which parser reads this file, or None when we have none for it.

    Dispatched per target rather than per job, because a full-stack phase has
    editable targets in two languages: `api/repository/tasks.py` and
    `web/src/lib/overdue.ts` arrive in the same job. One parser for all of them
    would hand a TypeScript file to Python's `ast`, report it as a syntax error,
    cost the learner the whole code_quality weight and tell them nothing about
    why.

    `.ts` and `.tsx` are skipped rather than parsed: esbuild strips types and
    this analyzer has no TypeScript grammar, so the honest answer is that the
    front end is not scored, not that it scored zero.
    """
    if path.endswith(".py"):
        return analyze_python_file
    if path.endswith((".js", ".jsx")):
        return analyze_js_file
    return None


def main():
    job = json.load(sys.stdin)
    files = job.get("files", {})
    language = job.get("language", "python")
    ext = ".js" if language == "javascript" else ".py"
    targets = job.get("targets") or [p for p in files if p.endswith(ext)]

    issues = []
    function_index = []
    import_index = []
    functions = 0
    documented = 0
    todos = 0
    max_complexity = 0
    analyzed = 0

    for path in targets:
        if path not in files:
            continue
        analyze = analyzer_for(path)
        if analyze is None:
            # Counted as nothing rather than as a file we read and found clean:
            # metrics.files is what the score is divided by.
            continue
        analyzed += 1
        metrics = analyze(path, files[path], issues, function_index, import_index)
        functions += metrics["functions"]
        documented += metrics["documented"]
        todos += metrics["todos"]
        max_complexity = max(max_complexity, metrics["maxComplexity"])

    report = {
        "issues": issues,
        "metrics": {
            "files": analyzed,
            "functions": functions,
            "todosRemaining": todos,
            "maxComplexity": max_complexity,
            "docstringCoverage": round(documented / functions, 2) if functions else 1.0,
        },
        "functions": function_index,
        "imports": import_index,
    }
    print(json.dumps(report))


if __name__ == "__main__":
    main()

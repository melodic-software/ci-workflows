"use strict";

// GraphQL operations committed in a repository validate against GitHub's
// public schema. GitHub rejects an invalid operation only at run time, after
// the lane that sends it has already started, so a spread of a type that
// cannot occur at that position (a User-typed field spread `... on Bot`)
// breaks every run until someone notices.
//
// What it checks, over the tracked JS, shell, workflow and Python files under
// the given paths (test files and Python `tests/` directories excluded):
// - every string literal that opens with `query`, `mutation` or
//   `subscription` (after an optional `query=`) and then `(` or `{` (an
//   operation name between them is allowed) parses and validates;
// - in JS, a `+` chain continues the literal, and `${NAME}` or `+ NAME` takes
//   the value of a same-file `const NAME =` built only from literals;
// - in Python, only a string token opens a literal, so a quote inside another
//   string or a comment opens none; adjacent literals (across lines inside
//   brackets, and across comments) continue it, triple quotes included, and
//   an f-string `{NAME}` takes the value of a same-file `NAME =` statement
//   built only from a number or literals, `{{` and `}}` being braces. A `+`
//   ends the literal;
// - any other interpolation (JS `${...}`, workflow `${{ }}`, shell `$NAME`,
//   `${...}` and `$(...)` outside single quotes, a Python f-string `{...}`)
//   takes a placeholder of its position: text inside a GraphQL string,
//   `"interpolated"` in an argument value (a type error on it alone is
//   dropped), `__typename` in a selection set, and nothing elsewhere. One
//   followed by arguments or a selection names a field, which no placeholder
//   can stand for. Once a placeholder stands in, an unused variable or
//   fragment is not an error: the interpolated text may use it;
// - a literal that opens with `{` and reads as a shorthand query, and
//   `query=@file`, cannot be checked;
// - a file with more request sites (`github.graphql(`,
//   `github.graphql.paginate(`, `request("POST /graphql"`, or a `gh api` /
//   `gh_api` command whose path is `graphql`, continuation lines joined, and
//   not a `function graphql(` wrapper) than extracted operations has sites it
//   cannot see. A Python argv list (`["api", "graphql", ...]`) is not counted
//   as a site.
// An operation that does not parse after that or names a field by
// interpolation, a shorthand or `query=@file`, and each unseen request site
// count against their file. The caller's allowlist lists each such file with
// its count and a reason, and the paths whose operations go to another
// GraphQL API; the check fails when the counts differ from that list, either
// way. Without an allowlist every count must be zero.
//
// The schema is GitHub's published SDL, committed gzipped at
// schemas/github/schema.docs.graphql.gz (outside .github/, so the review
// lanes skip the blob); refresh it with `gzip -9 -n` over
// https://docs.github.com/public/fpt/schema.docs.graphql when an operation
// needs a newer field.

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { gunzipSync } = require("node:zlib");

const { buildSchema, Kind, parse, validate } = require("graphql");

const SCHEMA = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "schemas",
  "github",
  "schema.docs.graphql.gz",
);
const SOURCE = /\.(?:c?js|mjs|sh|bash|ya?ml|py)$/;
const TEST_FILE =
  /\.test\.[^/]+$|(?:^|\/)tests\/.+\.py$|(?:^|\/)(?:test_[^/]*|[^/]*_test)\.py$/;
const OPENING =
  /[`'"]\s*(?:query=)?(?:query|mutation|subscription)\b\s*(?:[A-Za-z_]\w*\s*)?[({]/g;
const SHORTHAND = /[`'"]\s*\{/g;
const CALL_SITE =
  /\bgraphql(?:\.paginate)?\(|\brequest\(\s*[`'"](?:POST\s+)?\/graphql\b|\bgh(?:_api|\s+api)\b.*\sgraphql\b/;
const WRAPPER = /\bfunction\s+graphql\(/;
const QUERY_FILE = /\bquery=@/;
const COMMENT = /^\s*(?:#|\/\/|\*)/;
const CONSTANT = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*/g;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const PY_PREFIX = /^(?:[rRuUbB]|[fFtT][rR]?|[rR][fFtTbB]|[bB][rR])$/;
const PY_ASSIGNMENT = /[ \t]*=(?!=)[ \t]*/y;
const PY_NUMBER = /(-?\d+(?:\.\d+)?)[ \t]*(?:#.*)?(?:\r?\n|$)/y;
const PY_OPEN_PAREN = /\((?:\s|#.*)*/y;
const PY_QUOTE = /[A-Za-z]{0,2}(?:"""|'''|"|')/y;
const PY_END = /[ \t]*(?:#.*)?(?:\r?\n|$)/y;
const PY_CLOSE_PAREN = /(?:\s|#.*)*\)[ \t]*(?:#.*)?(?:\r?\n|$)/y;
const PLACEHOLDER = "interpolated";
const SELECTION = "__typename";

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL ?? "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

function trackedSources(root, paths, excluded) {
  return execFileSync("git", ["-C", root, "ls-files", "-z", "--", ...paths], {
    encoding: "utf8",
    env: GIT_ENV,
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter(
      (file) =>
        SOURCE.test(file) &&
        !TEST_FILE.test(file) &&
        !excluded.some((prefix) => file.startsWith(prefix)),
    );
}

// The allowlist: `exclude <path prefix> <reason>` or
// `<file> <count> <reason>`, `#` comments.
function readAllowlist(text) {
  const excluded = new Map();
  const counts = new Map();
  const errors = [];
  // Errors name the line number, never the line's text.
  text.split("\n").forEach((raw, n) => {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) return;
    const [key, value, ...reason] = line.split(/\s+/);
    if (reason.length === 0) errors.push(`allowlist line ${n + 1}: no reason`);
    else if (key === "exclude") excluded.set(value, reason.join(" "));
    else if (!/^\d+$/.test(value)) {
      errors.push(`allowlist line ${n + 1}: the second field is not a count`);
    } else counts.set(key, Number(value));
  });
  return { excluded, counts, errors };
}

// Whether the literal at `index` follows shell quoting: always in a shell
// script; in a workflow only inside a `run:` value, while a github-script
// `script:` body and everything else follow JS rules.
function shellAt(file, text, index) {
  if (/\.(?:sh|bash)$/.test(file)) return true;
  if (!/\.ya?ml$/.test(file)) return false;
  const lines = text.slice(0, index).split("\n");
  const own = lines[lines.length - 1];
  const inline = own.match(/^\s*(?:-\s+)?([\w-]+):/);
  if (inline) return inline[1] === "run";
  const indent = own.match(/^\s*/)[0].length;
  for (let n = lines.length - 2; n >= 0; n -= 1) {
    const key = lines[n].match(/^(\s*)(?:-\s+)?([\w-]+):/);
    if (key && key[1].length < indent) return key[2] === "run";
  }
  return false;
}

// The length of the balanced `open`...`close` group starting at `i`.
function groupLength(text, i, open, close) {
  let depth = 0;
  for (let j = i; j < text.length; j += 1) {
    if (text[j] === open) depth += 1;
    else if (text[j] === close && --depth === 0) return j + 1 - i;
  }
  return text.length - i;
}

// The length of the substitution starting with the `$` at `i`, or 0: a
// workflow `${{ }}` in every quoting, `${...}` in a JS template or outside
// shell single quotes, and shell `$NAME`, `$(...)` and `$1`-style parameters.
function substitutionLength(text, i, shell, quote) {
  const next = text[i + 1];
  if (text.startsWith("{{", i + 1)) return 1 + groupLength(text, i + 1, "{", "}");
  if (shell && quote === "'") return 0;
  if (next === "{" && (shell || quote === "`")) {
    return 1 + groupLength(text, i + 1, "{", "}");
  }
  if (!shell) return 0;
  if (next === "(") return 1 + groupLength(text, i + 1, "(", ")");
  const name = /^[A-Za-z_]\w*|^[0-9@#?*!$-]/.exec(text.slice(i + 1, i + 65));
  return name ? 1 + name[0].length : 0;
}

// What an unresolved substitution becomes at the end of `out`, given the
// source text after it. One that names a field (arguments or a selection
// follow it) has no placeholder and leaves the operation opaque.
function placeholder(out, scope, after = "") {
  if ((out.match(/(?<!\\)"/g) ?? []).length % 2 === 1) return PLACEHOLDER;
  const code = out.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  let parens = 0;
  let braces = 0;
  for (const c of code) {
    if (c === "(") parens += 1;
    else if (c === ")") parens -= 1;
    else if (c === "{") braces += 1;
    else if (c === "}") braces -= 1;
  }
  scope.complete = false;
  if (parens > 0) return /[:[=]\s*$/.test(code) ? ` "${PLACEHOLDER}" ` : " ";
  if (braces > 0) {
    if (/^\s*[({]/.test(after)) scope.opaque = true;
    return ` ${SELECTION} `;
  }
  return " ";
}

// The value of a same-file constant built only from literals, or null.
function resolve(scope, name) {
  if (!scope.constants?.has(name) || scope.resolving.has(name)) return null;
  if (scope.values.has(name)) return scope.values.get(name);
  scope.resolving.add(name);
  const inner = { ...scope, complete: true, opaque: false };
  const read = scope.python ? pythonValue : jsValue;
  const value = read(scope.constants.get(name), inner);
  scope.resolving.delete(name);
  scope.values.set(name, value);
  return value;
}

// A JS `const` value at `at`: a number, or a literal and its `+` chain.
function jsValue(at, scope) {
  const { text } = scope;
  const number = /^-?\d+(?:\.\d+)?/.exec(text.slice(at, at + 32));
  if (number) {
    const end = /^[ \t]*(?:[;,\n]|$)/.test(text.slice(at + number[0].length));
    return end ? number[0] : null;
  }
  if (!/[`'"]/.test(text[at])) return null;
  const chain = readChain(text, at, scope);
  if (!chain || !scope.complete) return null;
  return /^\s*(?:[;,)}]|$)/.test(text.slice(chain.end)) ? chain.body : null;
}

function matchAt(pattern, text, index) {
  pattern.lastIndex = index;
  return pattern.exec(text);
}

// A Python assignment's value at `at`: a number, or adjacent literals, in
// parentheses or not, that end the statement.
function pythonValue(at, scope) {
  const { text } = scope;
  const number = matchAt(PY_NUMBER, text, at);
  if (number) return number[1];
  const paren = matchAt(PY_OPEN_PAREN, text, at);
  const start = at + (paren ? paren[0].length : 0);
  const quote = matchAt(PY_QUOTE, text, start);
  if (!quote) return null;
  const open = start + quote[0].length - 1;
  const literal = scope.literals.get(open);
  if (!literal || literal.continues) return null;
  const chain = readPythonChain(text, open, scope);
  const end = matchAt(paren ? PY_CLOSE_PAREN : PY_END, text, chain.end);
  return scope.complete && end ? chain.body : null;
}

function substitute(out, expression, scope, after) {
  const inner = /^\$\{([^{].*)\}$/s.exec(expression)?.[1].trim();
  if (!scope.shell && inner && IDENTIFIER.test(inner)) {
    const value = resolve(scope, inner);
    if (value !== null) return value;
  }
  return placeholder(out, scope, after);
}

// The body of the literal opening at `start`, substitutions replaced, and
// where it ends, or null when it never closes. Shell single quotes have no
// escapes, except the `'\''` idiom that closes, escapes and reopens one.
function readLiteral(text, start, scope, prefix = "") {
  const quote = text[start];
  const raw = quote === "'" && scope.shell;
  let out = prefix;
  let i = start + 1;
  while (i < text.length) {
    const c = text[i];
    const length = c === "$" ? substitutionLength(text, i, scope.shell, quote) : 0;
    if (length > 0) {
      out += substitute(
        out,
        text.slice(i, i + length),
        scope,
        text.slice(i + length, i + length + 64),
      );
      i += length;
    } else if (raw && c === "'") {
      if (!text.startsWith("'\\''", i)) {
        return { body: out.slice(prefix.length), end: i + 1 };
      }
      out += "'";
      i += 4;
    } else if (!raw && c === "\\") {
      out += text[i + 1] === "n" ? "\n" : text[i + 1];
      i += 2;
    } else if (!raw && c === quote) {
      return { body: out.slice(prefix.length), end: i + 1 };
    } else {
      out += c;
      i += 1;
    }
  }
  return null;
}

// The length of the JS expression at `i`, up to a `+`, `;`, `,` or closing
// bracket at its own depth.
function expressionLength(text, i) {
  let depth = 0;
  let j = i;
  while (j < text.length) {
    const c = text[j];
    if (/[`'"]/.test(c)) {
      const literal = readLiteral(text, j, { shell: false, values: new Map() });
      if (!literal) return text.length - i;
      j = literal.end;
      continue;
    }
    if ("([{".includes(c)) depth += 1;
    else if (")]}".includes(c)) {
      if (depth === 0) break;
      depth -= 1;
    } else if (depth === 0 && /[+;,]/.test(c)) break;
    j += 1;
  }
  return j - i;
}

// The literal at `start` and, in JS, every `+` operand after it.
function readChain(text, start, scope) {
  const first = readLiteral(text, start, scope);
  if (!first || scope.shell) return first;
  let body = first.body;
  let i = first.end;
  for (;;) {
    const plus = /^\s*\+(?![+=])\s*/.exec(text.slice(i, i + 256));
    if (!plus) return { body, end: i };
    const j = i + plus[0].length;
    if (/[`'"]/.test(text[j])) {
      const next = readLiteral(text, j, scope, body);
      if (!next) return { body, end: i };
      body += next.body;
      i = next.end;
      continue;
    }
    const length = expressionLength(text, j);
    const expression = text.slice(j, j + length).trim();
    const value = IDENTIFIER.test(expression) ? resolve(scope, expression) : null;
    const after = text
      .slice(j + length, j + length + 64)
      .replace(/^\s*\+\s*[`'"]?/, "");
    body += value ?? placeholder(body, scope, after);
    i = j + length;
  }
}

// The length of the f-string replacement field starting with the `{` at `i`,
// past any string inside it.
function fieldLength(text, i) {
  let depth = 0;
  for (let j = i; j < text.length; j += 1) {
    const c = text[j];
    if (c === '"' || c === "'") {
      const close = text.indexOf(c, j + 1);
      if (close < 0) break;
      j = close;
    } else if ("([{".includes(c)) depth += 1;
    else if (")]}".includes(c) && --depth === 0) return j + 1 - i;
  }
  return text.length - i;
}

// The Python string literal whose quote, after any `prefix`, is at `q`:
// `open` is the quote its body follows (a triple's last).
function pythonLiteral(text, q, prefix) {
  const quote = text[q];
  const triple = text.startsWith(quote.repeat(3), q);
  const bodyStart = q + (triple ? 3 : 1);
  const formatted = /[fFtT]/.test(prefix);
  let i = bodyStart;
  let closing = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") i += 2;
    else if (formatted && (c === "{" || c === "}") && text[i + 1] === c) {
      i += 2;
    } else if (formatted && c === "{") i += fieldLength(text, i);
    else if (triple ? text.startsWith(quote.repeat(3), i) : c === quote) {
      closing = triple ? 3 : 1;
      break;
    } else if (!triple && c === "\n") break;
    else i += 1;
  }
  return {
    open: bodyStart - 1,
    bodyStart,
    bodyEnd: Math.min(i, text.length),
    end: Math.min(i, text.length) + closing,
    raw: /[rR]/.test(prefix),
    formatted,
    continues: false,
    next: null,
  };
}

// A Python file's string literals, by `open`, each linked to the literal an
// implicit concatenation joins to it (`next`), and the first `NAME =`
// statement of each name, to the index of its value.
function pythonTokens(text) {
  const literals = new Map();
  const constants = new Map();
  const word = /\w+/y;
  let depth = 0;
  let previous = null;
  let lineStart = true;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "#") {
      const end = text.indexOf("\n", i);
      i = end < 0 ? text.length : end;
    } else if (c === "\\" && text[i + 1] === "\n") {
      i += 2;
    } else if (c === "\n") {
      if (depth === 0) {
        previous = null;
        lineStart = true;
      }
      i += 1;
    } else if (/\s/.test(c)) {
      i += 1;
    } else {
      const name = matchAt(word, text, i)?.[0] ?? "";
      const after = i + name.length;
      const quoted = text[after] === '"' || text[after] === "'";
      if (quoted && (!name || PY_PREFIX.test(name))) {
        const literal = pythonLiteral(text, after, name);
        literals.set(literal.open, literal);
        if (previous) {
          previous.next = literal;
          literal.continues = true;
        }
        previous = literal;
        i = literal.end;
      } else {
        const value =
          lineStart && /^[A-Za-z_]/.test(name)
            ? matchAt(PY_ASSIGNMENT, text, after)
            : null;
        if (value && !constants.has(name)) {
          constants.set(name, value.index + value[0].length);
        }
        if ("([{".includes(c)) depth += 1;
        else if (")]}".includes(c)) depth = Math.max(0, depth - 1);
        previous = null;
        i += Math.max(name.length, 1);
      }
      lineStart = false;
    }
  }
  return { literals, constants };
}

// The body of the Python literal whose body follows the quote at `open`, and
// of each literal an implicit concatenation joins to it, f-string
// replacement fields replaced, and where the last one ends.
function readPythonChain(text, open, scope) {
  let literal = scope.literals.get(open);
  if (!literal) return null;
  let body = "";
  for (;;) {
    body += readPythonLiteral(text, literal, scope, body);
    if (!literal.next) return { body, end: literal.end };
    literal = literal.next;
  }
}

function readPythonLiteral(text, literal, scope, prefix) {
  let out = prefix;
  let i = literal.bodyStart;
  while (i < literal.bodyEnd) {
    const c = text[i];
    if (c === "\\" && !literal.raw) {
      out += text[i + 1] === "n" ? "\n" : text[i + 1];
      i += 2;
    } else if (
      literal.formatted &&
      (c === "{" || c === "}") &&
      text[i + 1] === c
    ) {
      out += c;
      i += 2;
    } else if (literal.formatted && c === "{") {
      const end = i + fieldLength(text, i);
      const expression = text.slice(i + 1, end - 1).trim();
      const { next } = literal;
      const after = (
        text.slice(end, literal.bodyEnd) +
        (next ? text.slice(next.bodyStart, next.bodyEnd) : "")
      ).slice(0, 64);
      const value = IDENTIFIER.test(expression)
        ? resolve(scope, expression)
        : null;
      out += value ?? placeholder(out, scope, after);
      i = end;
    } else {
      out += c;
      i += 1;
    }
  }
  return out.slice(prefix.length);
}

// Where each literal that `pattern` matches at its opening quote opens. In
// Python only a literal that no implicit concatenation continues opens one.
function openings(text, pattern, literals) {
  if (!literals) return [...text.matchAll(pattern)].map((match) => match.index);
  const sticky = new RegExp(pattern.source, "y");
  return [...literals.values()]
    .filter((literal) => !literal.continues)
    .map((literal) => literal.open)
    .filter((open) => matchAt(sticky, text, open));
}

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

// A literal opening with `{` is a shorthand operation when it parses as one
// anonymous query with at least one root field, all of which exist on Query;
// jq filters and JSON, `{}` included, fail one of those checks.
function isShorthand(schema, source) {
  let document;
  try {
    document = parse(source);
  } catch {
    return false;
  }
  const [definition, ...rest] = document.definitions;
  if (rest.length > 0 || definition.kind !== Kind.OPERATION_DEFINITION) {
    return false;
  }
  if (definition.name || definition.loc.startToken.kind !== "{") return false;
  const fields = schema.getQueryType().getFields();
  const { selections } = definition.selectionSet;
  return (
    selections.length > 0 &&
    selections.every(
      (selection) =>
        selection.kind === Kind.FIELD && selection.name.value in fields,
    )
  );
}

function extract(schema, file, text) {
  const operations = [];
  const unsupported = [];
  const js = /\.(?:c?js|mjs)$/.test(file);
  const python = /\.py$/.test(file);
  const tokens = python ? pythonTokens(text) : null;
  const literals = tokens?.literals;
  const constants = tokens?.constants ?? new Map();
  if (js) {
    for (const match of text.matchAll(CONSTANT)) {
      if (!constants.has(match[1])) {
        constants.set(match[1], match.index + match[0].length);
      }
    }
  }
  const values = new Map();
  const read = (index) => {
    const scope = {
      text,
      shell: shellAt(file, text, index),
      python,
      literals,
      constants,
      values,
      resolving: new Set(),
      complete: true,
      opaque: false,
    };
    let chain;
    if (python) chain = readPythonChain(text, index, scope);
    else if (js) chain = readChain(text, index, scope);
    else chain = readLiteral(text, index, scope);
    return (
      chain && {
        source: chain.body.replace(/^\s*query=/, ""),
        partial: !scope.complete,
        opaque: scope.opaque,
      }
    );
  };
  for (const index of openings(text, OPENING, literals)) {
    const literal = read(index);
    if (literal !== null) {
      operations.push({ file, line: lineOf(text, index), ...literal });
    }
  }
  for (const index of openings(text, SHORTHAND, literals)) {
    const literal = read(index);
    if (literal !== null && isShorthand(schema, literal.source)) {
      unsupported.push(
        `${file}:${lineOf(text, index)}: shorthand operation; open it with \`query\``,
      );
    }
  }
  text.split("\n").forEach((line, n) => {
    if (QUERY_FILE.test(line) && !COMMENT.test(line)) {
      unsupported.push(`${file}:${n + 1}: an operation read from a file is not checked`);
    }
  });
  const callSites = text
    .replace(/\\\r?\n/g, " ")
    .split("\n")
    .filter(
      (line) =>
        CALL_SITE.test(line) && !COMMENT.test(line) && !WRAPPER.test(line),
    ).length;
  return { operations, unsupported, callSites };
}

const placeholderValue = (node) =>
  node.kind === Kind.STRING && node.value === PLACEHOLDER;

// `syntax` when the operation cannot be checked, else its validation errors
// less the ones its placeholders cause: a type error on a placeholder value,
// and, once any placeholder stands in, a variable or fragment the
// interpolated text may have used.
function problems(schema, operation) {
  if (operation.opaque) {
    return { syntax: "an interpolation names a field", errors: [] };
  }
  let document;
  try {
    document = parse(operation.source);
  } catch (error) {
    return { syntax: error.message, errors: [] };
  }
  const errors = validate(schema, document)
    .filter(
      (error) => !error.nodes?.length || !error.nodes.every(placeholderValue),
    )
    .filter(
      (error) =>
        !operation.partial ||
        !/^(?:Variable|Fragment) ".+" is never used/.test(error.message),
    )
    .map((error) => error.message);
  return { syntax: null, errors };
}

// assumeValid skips the type-system rules, which GitHub's own schema breaks
// (an implementation field deprecated where its interface field is not);
// operations are still validated against every type and field it defines.
function loadSchema(file = SCHEMA) {
  return buildSchema(gunzipSync(fs.readFileSync(file)).toString("utf8"), {
    assumeValid: true,
  });
}

// Every failure in the tracked sources under `paths` of the repository at
// `root`, and a diagnostic line per unextractable site and per file that
// sends operations.
function check({ root, paths, schema, allowlist = "" }) {
  const listed = readAllowlist(allowlist);
  const failures = [...listed.errors];
  const diagnostics = [];
  const excluded = [...listed.excluded.keys()];
  const all = trackedSources(root, paths, []);
  for (const [prefix, reason] of listed.excluded) {
    if (!all.some((file) => file.startsWith(prefix))) {
      failures.push(
        `allowlist excludes ${prefix} (${reason}), which matches no tracked source`,
      );
    }
  }
  const found = new Map();
  let validated = 0;
  let unparsed = 0;
  let senders = 0;
  for (const file of trackedSources(root, paths, excluded)) {
    // A tracked symlink could point outside the checkout; read regular files only.
    if (!fs.lstatSync(path.join(root, file), { throwIfNoEntry: false })?.isFile()) {
      continue;
    }
    const entry = extract(
      schema,
      file,
      fs.readFileSync(path.join(root, file), "utf8"),
    );
    const checked = entry.operations.map((operation) => ({
      ...operation,
      ...problems(schema, operation),
    }));
    const syntax = checked.filter((operation) => operation.syntax);
    const gap = Math.max(0, entry.callSites - entry.operations.length);
    diagnostics.push(
      ...syntax.map((operation) => `${file}:${operation.line}: ${operation.syntax}`),
      ...entry.unsupported,
      ...(gap
        ? [`${file}: ${entry.callSites} request sites, ${entry.operations.length} operations`]
        : []),
    );
    const count = syntax.length + entry.unsupported.length + gap;
    if (count > 0) found.set(file, count);
    for (const operation of checked) {
      for (const message of operation.errors) {
        failures.push(`${file}:${operation.line}: ${message}`);
      }
    }
    validated += checked.length - syntax.length;
    unparsed += syntax.length;
    if (checked.length > 0) senders += 1;
  }
  for (const file of new Set([...found.keys(), ...listed.counts.keys()])) {
    const have = found.get(file) ?? 0;
    const want = listed.counts.get(file) ?? 0;
    if (have !== want) {
      failures.push(
        `${file}: ${have} sites cannot be checked, the allowlist lists ${want}`,
      );
    }
  }
  diagnostics.push(
    `${validated} operations validated, ${unparsed} unparsed, across ${senders} files`,
  );
  // One line per message: scanned text and file names can hold a newline,
  // which would let a caller's files write workflow commands into the log.
  const oneLine = (line) => line.replace(/\r?\n|\r/g, "\\n");
  return { failures: failures.map(oneLine), diagnostics: diagnostics.map(oneLine) };
}

function main(argv) {
  const options = { root: ".", schema: SCHEMA, allowlist: "", paths: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--root") options.root = argv[++i];
    else if (flag === "--schema") options.schema = argv[++i];
    else if (flag === "--allowlist") options.allowlist = argv[++i];
    else options.paths.push(flag);
  }
  if (options.paths.length === 0) options.paths.push(".github");
  const root = path.resolve(options.root);
  const file = options.allowlist && path.resolve(root, options.allowlist);
  // The allowlist lives in the caller's checkout, so a symlink could point anywhere.
  if (file && !fs.lstatSync(file, { throwIfNoEntry: false })?.isFile()) {
    console.log(`::error::allowlist ${options.allowlist} is not a regular file`);
    return 1;
  }
  const allowlist = file ? fs.readFileSync(file, "utf8") : "";
  const { failures, diagnostics } = check({
    root,
    paths: options.paths,
    schema: loadSchema(options.schema),
    allowlist,
  });
  for (const line of diagnostics) console.log(line);
  for (const line of failures) console.log(`::error::${line}`);
  return failures.length > 0 ? 1 : 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { check, extract, loadSchema, problems, readAllowlist };

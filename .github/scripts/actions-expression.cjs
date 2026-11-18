"use strict";

// Evaluates the subset of the Actions expression language the lanes' job
// and step gates use: github, inputs, job, needs, steps, vars, secrets and env context paths (a
// missing property is null), string literals, ! && || == != and parentheses,
// the case-insensitive contains/startsWith/endsWith (contains also over an
// array, by element), format, fromJSON, always(), and cancelled(), which is
// false: a gate is evaluated for a run nobody cancelled.

const str = (value) =>
  value === null || value === undefined ? "" : String(value);
const lower = (value) => str(value).toLowerCase();
const functions = {
  contains: (haystack, needle) =>
    Array.isArray(haystack)
      ? haystack.some((item) => lower(item) === lower(needle))
      : lower(haystack).includes(lower(needle)),
  startsWith: (text, prefix) => lower(text).startsWith(lower(prefix)),
  endsWith: (text, suffix) => lower(text).endsWith(lower(suffix)),
  format: (template, ...args) =>
    template.replace(/\{(\d+)\}/gu, (_, i) => str(args[Number(i)])),
  fromJSON: (text) => JSON.parse(text),
  always: () => true,
  cancelled: () => false,
};
const CONTEXTS = [
  "github",
  "inputs",
  "job",
  "needs",
  "steps",
  "vars",
  "secrets",
  "env",
];
const CONTEXT_PATH = new RegExp(
  String.raw`\b(${CONTEXTS.join("|")})((?:\.[A-Za-z_][\w-]*)+)`,
  "gu",
);

const evaluate = (expression, contexts) => {
  const body = expression
    .trim()
    .replace(/^\$\{\{([\s\S]*)\}\}$/u, "$1")
    .replace(
      CONTEXT_PATH,
      (_, root, rest) =>
        `${root}${rest
          .slice(1)
          .split(".")
          .map((key) => `?.[${JSON.stringify(key)}]`)
          .join("")}`,
    );
  const run = new Function(
    ...Object.keys(functions),
    ...CONTEXTS,
    `return (${body}) ?? null;`,
  );
  return run(
    ...Object.values(functions),
    ...CONTEXTS.map((name) => contexts[name]),
  );
};

module.exports = { evaluate };

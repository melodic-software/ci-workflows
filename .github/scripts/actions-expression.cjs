"use strict";

// Evaluates the subset of the Actions expression language the lanes' job
// and step gates use: github, inputs, needs and steps context paths (a
// missing property is null), string literals, ! && || == != and parentheses,
// the case-insensitive contains/startsWith/endsWith (contains also over an
// array, by element), format, fromJSON, always(), and cancelled(), which is
// false: a gate is evaluated for a run nobody cancelled.

const str = (value) =>
  value === null || value === undefined ? "" : String(value);
const functions = {
  contains: (haystack, needle) =>
    Array.isArray(haystack)
      ? haystack.some(
          (item) => str(item).toLowerCase() === str(needle).toLowerCase(),
        )
      : str(haystack).toLowerCase().includes(str(needle).toLowerCase()),
  startsWith: (text, prefix) =>
    str(text).toLowerCase().startsWith(str(prefix).toLowerCase()),
  endsWith: (text, suffix) =>
    str(text).toLowerCase().endsWith(str(suffix).toLowerCase()),
  format: (template, ...args) =>
    template.replace(/\{(\d+)\}/gu, (_, i) => str(args[Number(i)])),
  fromJSON: (text) => JSON.parse(text),
  always: () => true,
  cancelled: () => false,
};
const CONTEXTS = ["github", "inputs", "needs", "steps"];

const evaluate = (expression, contexts) => {
  const body = expression
    .trim()
    .replace(/^\$\{\{([\s\S]*)\}\}$/u, "$1")
    .replace(
      /\b(github|inputs|needs|steps)((?:\.[A-Za-z_][\w-]*)+)/gu,
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

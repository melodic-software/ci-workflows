"use strict";

// Evaluates the subset of the Actions expression language the lanes' job
// gates use: context paths (a missing property is null), string literals,
// ! && || == != and parentheses, and the case-insensitive
// contains/startsWith/endsWith plus format.

const str = (value) =>
  value === null || value === undefined ? "" : String(value);
const functions = {
  contains: (haystack, needle) =>
    str(haystack).toLowerCase().includes(str(needle).toLowerCase()),
  startsWith: (text, prefix) =>
    str(text).toLowerCase().startsWith(str(prefix).toLowerCase()),
  endsWith: (text, suffix) =>
    str(text).toLowerCase().endsWith(str(suffix).toLowerCase()),
  format: (template, ...args) =>
    template.replace(/\{(\d+)\}/gu, (_, i) => str(args[Number(i)])),
};

const evaluate = (expression, contexts) => {
  const body = expression
    .trim()
    .replace(/^\$\{\{([\s\S]*)\}\}$/u, "$1")
    .replace(
      /\b(github|inputs)((?:\.[A-Za-z_][\w-]*)+)/gu,
      (_, root, rest) =>
        `${root}${rest
          .slice(1)
          .split(".")
          .map((key) => `?.[${JSON.stringify(key)}]`)
          .join("")}`,
    );
  const run = new Function(
    ...Object.keys(functions),
    "github",
    "inputs",
    `return (${body}) ?? null;`,
  );
  return run(...Object.values(functions), contexts.github, contexts.inputs);
};

module.exports = { evaluate };

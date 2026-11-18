"use strict";

// A review level names a model, effort and turn budget. levels.json is the
// built-in table; a caller's CLAUDE_REVIEW_LEVELS variable, a JSON object, is
// merged over it: a known level takes the fields it names, a new level must
// name all three. A variable that breaks those rules is reported and the run
// uses the built-in table and level instead; a reported problem names fields
// and fixed text only, never the variable's text, which reaches the log.
// The caller workflow's review-level input fails the run when it names no
// level.

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_LEVEL = "standard";
const FIELDS = ["model", "effort", "max-turns"];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const LEVEL_NAME = /^[a-z][a-z0-9-]{0,31}$/u;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]*(\[1m\])?$/u;
const TURNS = /^[1-9][0-9]{0,5}$/u;

const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// The first reason a run's model, effort or turn budget is not one the
// launcher accepts, or null.
function runProblem(run) {
  if (typeof run.model !== "string" || !MODEL.test(run.model)) {
    return "The model must be a model alias or ID.";
  }
  if (!EFFORTS.includes(run.effort)) {
    return `The effort must be ${EFFORTS.slice(0, -1).join(", ")} or ${EFFORTS.at(-1)}.`;
  }
  if (!TURNS.test(String(run["max-turns"]))) {
    return "max-turns must be a whole number from 1 to 999999.";
  }
  return null;
}

function builtInLevels(file = path.join(__dirname, "levels.json")) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

class OverrideError extends Error {}

// The built-in table with the override merged over it. Throws an
// OverrideError, whose message holds no override text, on any override that
// is not a JSON object of known fields with accepted values.
function levelTable(overrideText = "", table = builtInLevels()) {
  const merged = structuredClone(table);
  if (overrideText === "") return merged;
  const fail = (text) => {
    throw new OverrideError(`CLAUDE_REVIEW_LEVELS ${text}`);
  };
  let override;
  try {
    override = JSON.parse(overrideText);
  } catch {
    fail("is not JSON.");
  }
  if (!isObject(override)) fail("must be a JSON object of levels.");
  for (const [name, fields] of Object.entries(override)) {
    if (!LEVEL_NAME.test(name)) {
      fail("has a level name that is not lower-case kebab of at most 32 characters.");
    }
    if (!isObject(fields)) fail(`level ${name} must be an object.`);
    if (Object.keys(fields).some((key) => !FIELDS.includes(key))) {
      fail(`level ${name} has a field other than ${FIELDS.join(", ")}.`);
    }
    const turns = fields["max-turns"];
    if (turns !== undefined && !(Number.isInteger(turns) || typeof turns === "string")) {
      fail(`level ${name}: max-turns must be a whole number from 1 to 999999.`);
    }
    const level = { ...merged[name], ...fields };
    const missing = FIELDS.filter((key) => level[key] === undefined);
    if (missing.length > 0) {
      fail(`level ${name} is new, so it needs ${missing.join(", ")}.`);
    }
    const problem = runProblem(level);
    if (problem) fail(`level ${name}: ${problem}`);
    merged[name] = level;
  }
  return merged;
}

// The run's model, effort and turn budget: each explicit value wins, and the
// level fills the rest. model-args, applied after this, wins over both.
// Returns { run, errors }: errors are the variable problems to report, each
// already replaced by a default. Throws only for a levelInput that names no
// level.
function resolveRun(
  { levelInput = "", levelVariable = "", levels = "", model = "", effort = "", maxTurns = "" },
  table = builtInLevels(),
) {
  const errors = [];
  let merged;
  try {
    merged = levelTable(levels, table);
  } catch (error) {
    if (!(error instanceof OverrideError)) throw error;
    errors.push(`${error.message} The built-in levels are used instead.`);
    merged = structuredClone(table);
  }
  let name = DEFAULT_LEVEL;
  if (levelInput !== "") {
    if (!Object.hasOwn(merged, levelInput)) {
      throw new Error(`The review-level input names no level; the levels are ${Object.keys(merged).join(", ")}.`);
    }
    name = levelInput;
  } else if (levelVariable !== "") {
    if (Object.hasOwn(merged, levelVariable)) name = levelVariable;
    else errors.push(`CLAUDE_REVIEW_LEVEL names no level; ${DEFAULT_LEVEL} is used instead.`);
  }
  const chosen = merged[name];
  return {
    level: name,
    errors,
    run: {
      model: model || chosen.model,
      effort: effort || chosen.effort,
      "max-turns": maxTurns || String(chosen["max-turns"]),
    },
  };
}

module.exports = { builtInLevels, levelTable, resolveRun, runProblem };

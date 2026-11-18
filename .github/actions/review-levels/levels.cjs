"use strict";

// A review level names a model, effort and turn budget. levels.json is the
// built-in table; a caller's CLAUDE_REVIEW_LEVELS variable, a JSON object, is
// merged over it: a known level takes the fields it names, a new level must
// name all three. Anything else fails, never falling back to a default.

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

// The built-in table with the override merged over it. Throws on any
// override that is not a JSON object of known fields with accepted values.
function levelTable(overrideText = "", table = builtInLevels()) {
  const merged = structuredClone(table);
  if (overrideText === "") return merged;
  let override;
  try {
    override = JSON.parse(overrideText);
  } catch (error) {
    throw new Error(`CLAUDE_REVIEW_LEVELS is not JSON: ${error.message}`);
  }
  if (!isObject(override)) {
    throw new Error("CLAUDE_REVIEW_LEVELS must be a JSON object of levels.");
  }
  for (const [name, fields] of Object.entries(override)) {
    if (!LEVEL_NAME.test(name)) {
      throw new Error(`CLAUDE_REVIEW_LEVELS level '${name}' must be lower-case kebab, at most 32 characters.`);
    }
    if (!isObject(fields)) {
      throw new Error(`CLAUDE_REVIEW_LEVELS level '${name}' must be an object.`);
    }
    const unknown = Object.keys(fields).filter((key) => !FIELDS.includes(key));
    if (unknown.length > 0) {
      throw new Error(`CLAUDE_REVIEW_LEVELS level '${name}' has unknown fields: ${unknown.join(", ")}; the fields are ${FIELDS.join(", ")}.`);
    }
    const turns = fields["max-turns"];
    if (turns !== undefined && !(Number.isInteger(turns) || typeof turns === "string")) {
      throw new Error(`CLAUDE_REVIEW_LEVELS level '${name}': max-turns must be a whole number from 1 to 999999.`);
    }
    const level = { ...merged[name], ...fields };
    const missing = FIELDS.filter((key) => level[key] === undefined);
    if (missing.length > 0) {
      throw new Error(`CLAUDE_REVIEW_LEVELS level '${name}' is new, so it needs ${missing.join(", ")}.`);
    }
    const problem = runProblem(level);
    if (problem) throw new Error(`CLAUDE_REVIEW_LEVELS level '${name}': ${problem}`);
    merged[name] = level;
  }
  return merged;
}

// The run's model, effort and turn budget: each explicit value wins, and the
// level fills the rest. model-args, applied after this, wins over both.
function resolveRun({ level = "", levels = "", model = "", effort = "", maxTurns = "" }, table) {
  const merged = levelTable(levels, table);
  const name = level || DEFAULT_LEVEL;
  if (!Object.hasOwn(merged, name)) {
    throw new Error(`review level '${name}' is not one of ${Object.keys(merged).join(", ")}.`);
  }
  const chosen = merged[name];
  return {
    level: name,
    model: model || chosen.model,
    effort: effort || chosen.effort,
    "max-turns": maxTurns || String(chosen["max-turns"]),
  };
}

module.exports = { builtInLevels, levelTable, resolveRun, runProblem };

"use strict";

// The intake-triage lane's output schema and the caller's typed verdict
// fields. One module for all three leg jobs and the apply job, so the schema
// the model is held to, and the checks its verdict passes, cannot drift
// between them.
//
// A caller's verdict-schema only adds fields. Every rule below is what keeps
// it from loosening the base schema or letting the model return unbounded
// text: a field it adds may not reuse a base name, every object stays closed
// (additionalProperties false), and every value has a bound the extract and
// check modes enforce again on what the model returned.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const BASE_FIELDS = ["labels", "comment", "needs_human", "reason", "type"];

const LIMITS = Object.freeze({
  inputBytes: 8192,
  fields: 16,
  depth: 3,
  maxLength: 1000,
  maxItems: 20,
  enumValues: 50,
  enumValueLength: 100,
  description: 300,
});

const NAME = /^[a-z][a-z0-9_]{0,63}$/u;
const TYPES = new Set(["string", "integer", "number", "boolean", "array", "object"]);
const KEYWORDS = {
  string: ["type", "description", "enum", "maxLength", "minLength"],
  integer: ["type", "description", "minimum", "maximum"],
  number: ["type", "description", "minimum", "maximum"],
  boolean: ["type", "description"],
  array: ["type", "description", "items", "maxItems", "minItems", "uniqueItems"],
  object: ["type", "description", "properties", "required", "additionalProperties"],
};

// The apply job's credential pattern: a verdict string matching it is
// dropped, never carried.
const CREDENTIAL =
  /(sk-ant-[A-Za-z0-9_-]{8,}|gh[opsur]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/u;

class VerdictSchemaError extends Error {
  constructor(message) {
    super(`verdict-schema: ${message}`);
    this.name = "VerdictSchemaError";
  }
}

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value, max) => Number.isInteger(value) && value >= 0 && value <= max;

// The base schema. Its key order is part of the contract: an unset
// verdict-schema must write these exact bytes, which the pin test holds.
function baseSchema(allowed, typeNames) {
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      // An enum needs at least one value; with nothing allowed, labels must be empty.
      labels:
        allowed.length > 0
          ? { type: "array", uniqueItems: true, items: { type: "string", enum: allowed } }
          : { type: "array", maxItems: 0 },
      comment: { type: "string", maxLength: 3000 },
      needs_human: { type: "boolean" },
      reason: { type: "string", maxLength: 500 },
    },
    required: ["labels", "comment", "needs_human", "reason"],
  };
  if (typeNames.length > 0) {
    schema.properties.type = { type: "string", enum: [...typeNames, "none"] };
    schema.required.push("type");
  }
  return schema;
}

function checkField(schema, where, depth) {
  if (depth > LIMITS.depth) throw new VerdictSchemaError(`${where} nests deeper than ${LIMITS.depth} levels`);
  if (!isObject(schema)) throw new VerdictSchemaError(`${where} must be a JSON Schema object`);
  if (typeof schema.type !== "string" || !TYPES.has(schema.type)) {
    throw new VerdictSchemaError(`${where} needs a type, one of ${[...TYPES].join(", ")}`);
  }
  const extra = Object.keys(schema).filter((key) => !KEYWORDS[schema.type].includes(key));
  if (extra.length > 0) {
    throw new VerdictSchemaError(`${where} (${schema.type}) may not use ${extra.join(", ")}`);
  }
  if (schema.description !== undefined) {
    if (typeof schema.description !== "string" || schema.description.length > LIMITS.description) {
      throw new VerdictSchemaError(`${where} description must be a string of at most ${LIMITS.description} characters`);
    }
  }
  switch (schema.type) {
    case "string": {
      if (schema.enum !== undefined) {
        const values = schema.enum;
        if (
          !Array.isArray(values) ||
          values.length === 0 ||
          values.length > LIMITS.enumValues ||
          new Set(values).size !== values.length ||
          !values.every((v) => typeof v === "string" && v.length > 0 && v.length <= LIMITS.enumValueLength)
        ) {
          throw new VerdictSchemaError(
            `${where} enum must hold 1 to ${LIMITS.enumValues} distinct strings of 1 to ${LIMITS.enumValueLength} characters`,
          );
        }
      }
      if (schema.maxLength !== undefined && !(isCount(schema.maxLength, LIMITS.maxLength) && schema.maxLength > 0)) {
        throw new VerdictSchemaError(`${where} maxLength must be a whole number from 1 to ${LIMITS.maxLength}`);
      }
      if (schema.enum === undefined && schema.maxLength === undefined) {
        throw new VerdictSchemaError(`${where} is a string with no maxLength or enum`);
      }
      if (schema.minLength !== undefined && !isCount(schema.minLength, schema.maxLength ?? LIMITS.maxLength)) {
        throw new VerdictSchemaError(`${where} minLength must be a whole number no larger than its maxLength`);
      }
      break;
    }
    case "integer":
    case "number": {
      for (const key of ["minimum", "maximum"]) {
        const bound = schema[key];
        if (!Number.isFinite(bound) || (schema.type === "integer" && !Number.isInteger(bound))) {
          throw new VerdictSchemaError(`${where} needs a finite ${key}${schema.type === "integer" ? " that is a whole number" : ""}`);
        }
      }
      if (schema.minimum > schema.maximum) throw new VerdictSchemaError(`${where} minimum is above its maximum`);
      break;
    }
    case "array": {
      if (!isCount(schema.maxItems, LIMITS.maxItems)) {
        throw new VerdictSchemaError(`${where} needs maxItems, a whole number from 0 to ${LIMITS.maxItems}`);
      }
      if (schema.minItems !== undefined && !isCount(schema.minItems, schema.maxItems)) {
        throw new VerdictSchemaError(`${where} minItems must be a whole number no larger than its maxItems`);
      }
      if (schema.uniqueItems !== undefined && typeof schema.uniqueItems !== "boolean") {
        throw new VerdictSchemaError(`${where} uniqueItems must be true or false`);
      }
      if (schema.items === undefined) throw new VerdictSchemaError(`${where} needs items`);
      checkField(schema.items, `${where}[]`, depth + 1);
      break;
    }
    case "object": {
      if (schema.additionalProperties !== false) {
        throw new VerdictSchemaError(`${where} must set additionalProperties to false`);
      }
      checkProperties(schema.properties, schema.required, where, depth + 1);
      break;
    }
    default:
      break;
  }
}

function checkProperties(properties, required, where, depth) {
  if (!isObject(properties) || Object.keys(properties).length === 0) {
    throw new VerdictSchemaError(`${where} needs a non-empty properties object`);
  }
  const names = Object.keys(properties);
  if (names.length > LIMITS.fields) throw new VerdictSchemaError(`${where} has more than ${LIMITS.fields} properties`);
  for (const name of names) {
    if (!NAME.test(name)) throw new VerdictSchemaError(`${where} property name ${JSON.stringify(name)} must match ${NAME.source}`);
    checkField(properties[name], `${where}.${name}`, depth);
  }
  if (required !== undefined) {
    if (
      !Array.isArray(required) ||
      new Set(required).size !== required.length ||
      !required.every((name) => typeof name === "string" && Object.hasOwn(properties, name))
    ) {
      throw new VerdictSchemaError(`${where} required must list distinct names from its properties`);
    }
  }
}

// The caller's verdict-schema input, checked; null when it is unset.
function parseExtension(text) {
  const raw = String(text ?? "");
  if (raw.trim() === "") return null;
  if (Buffer.byteLength(raw, "utf8") > LIMITS.inputBytes) {
    throw new VerdictSchemaError(`is longer than ${LIMITS.inputBytes} bytes`);
  }
  let extension;
  try {
    extension = JSON.parse(raw);
  } catch (error) {
    throw new VerdictSchemaError(`is not JSON (${error.message})`);
  }
  if (!isObject(extension)) throw new VerdictSchemaError("must be a JSON object");
  const extra = Object.keys(extension).filter((key) => key !== "properties" && key !== "required");
  if (extra.length > 0) throw new VerdictSchemaError(`may hold only properties and required, not ${extra.join(", ")}`);
  for (const name of Object.keys(extension.properties ?? {})) {
    if (BASE_FIELDS.includes(name)) throw new VerdictSchemaError(`field ${name} is a base field and cannot be redefined`);
  }
  checkProperties(extension.properties, extension.required, "verdict", 1);
  return { properties: extension.properties, required: extension.required ?? [] };
}

function mergeSchema(base, extension) {
  if (!extension) return base;
  const merged = structuredClone(base);
  for (const [name, field] of Object.entries(extension.properties)) {
    if (Object.hasOwn(merged.properties, name)) throw new VerdictSchemaError(`field ${name} is a base field and cannot be redefined`);
    merged.properties[name] = structuredClone(field);
  }
  merged.required.push(...extension.required);
  merged.additionalProperties = false;
  return merged;
}

// The lines appended to the prompt, one per added field.
function instructions(extension) {
  if (!extension) return "";
  const lines = Object.entries(extension.properties).map(([name, field]) => {
    const need = extension.required.includes(name) ? "required" : "optional";
    const text = (field.description ?? "").replace(/\s+/gu, " ").trim();
    return `- ${name} (${need})${text ? `: ${text}` : ""}`;
  });
  return `\nAlso return these fields in the structured output; the output schema bounds each one:\n${lines.join("\n")}\n`;
}

// Whether a value the model returned fits its field's schema. The CLI already
// validated it; this is the second check, as the extract step re-checks labels.
function fits(value, schema) {
  switch (schema.type) {
    case "string": {
      if (typeof value !== "string" || CREDENTIAL.test(value)) return false;
      const length = [...value].length;
      if (schema.maxLength !== undefined && length > schema.maxLength) return false;
      if (schema.minLength !== undefined && length < schema.minLength) return false;
      return schema.enum === undefined || schema.enum.includes(value);
    }
    case "integer":
    case "number":
      return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        (schema.type === "number" || Number.isInteger(value)) &&
        value >= schema.minimum &&
        value <= schema.maximum
      );
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return (
        Array.isArray(value) &&
        value.length <= schema.maxItems &&
        value.length >= (schema.minItems ?? 0) &&
        (schema.uniqueItems !== true || new Set(value.map((item) => JSON.stringify(item))).size === value.length) &&
        value.every((item) => fits(item, schema.items))
      );
    case "object":
      return isObject(value) && fitsFields(value, schema.properties, schema.required ?? []) !== null;
    default:
      return false;
  }
}

// The value's fields copied in schema order, or null when any is missing,
// unknown or out of bounds.
function fitsFields(value, properties, required) {
  if (!Object.keys(value).every((key) => Object.hasOwn(properties, key))) return null;
  const out = {};
  for (const [name, field] of Object.entries(properties)) {
    if (!Object.hasOwn(value, name)) {
      if (required.includes(name)) return null;
      continue;
    }
    if (!fits(value[name], field)) return null;
    out[name] = value[name];
  }
  return out;
}

// The verdict fields from the model's structured output, or null. Base
// fields in the output are ignored; only the caller's added fields are read.
function extractVerdict(structured, extension) {
  if (!extension || !isObject(structured)) return null;
  const picked = {};
  for (const name of Object.keys(extension.properties)) {
    if (Object.hasOwn(structured, name)) picked[name] = structured[name];
  }
  return fitsFields(picked, extension.properties, extension.required);
}

// A verdict object passed between jobs, checked again; null when it fails.
function checkVerdict(verdict, extension) {
  if (!extension || !isObject(verdict)) return null;
  return fitsFields(verdict, extension.properties, extension.required);
}

function writeOutputs(env, outputs) {
  if (!env.GITHUB_OUTPUT) return;
  const text = Object.entries(outputs)
    .map(([key, value]) => {
      const delimiter = `ghadelimiter_${crypto.randomUUID()}`;
      return `${key}<<${delimiter}\n${value}\n${delimiter}\n`;
    })
    .join("");
  fs.appendFileSync(env.GITHUB_OUTPUT, text);
}

function readStructured(executionFile) {
  try {
    const messages = JSON.parse(fs.readFileSync(executionFile, "utf8"));
    return (Array.isArray(messages) ? messages.findLast((m) => m?.type === "result") : undefined)?.structured_output;
  } catch {
    return undefined;
  }
}

function main(env = process.env) {
  const mode = String(env.INPUT_MODE ?? "").trim();
  const lines = [];
  let outputs;
  if (mode === "schema") {
    const extension = parseExtension(env.INPUT_VERDICT_SCHEMA);
    const allowed = JSON.parse(env.INPUT_ALLOWED || "[]");
    const typeNames = JSON.parse(env.INPUT_TYPE_NAMES || "[]");
    const promptFile = String(env.INPUT_PROMPT_FILE ?? "");
    if (!Array.isArray(allowed) || !Array.isArray(typeNames) || promptFile === "") {
      throw new Error("schema mode needs the compose step's allowed, type-names and prompt-file");
    }
    const schemaFile = path.join(path.dirname(promptFile), "schema.json");
    fs.writeFileSync(schemaFile, JSON.stringify(mergeSchema(baseSchema(allowed, typeNames), extension)));
    if (extension) {
      fs.appendFileSync(promptFile, instructions(extension));
      lines.push(`intake-triage-verdict: the output schema adds ${Object.keys(extension.properties).join(", ")}`);
    }
    outputs = { "schema-file": schemaFile };
  } else if (mode === "extract" || mode === "check") {
    const extension = parseExtension(env.INPUT_VERDICT_SCHEMA);
    let verdict = null;
    if (extension) {
      if (mode === "extract") {
        verdict = extractVerdict(readStructured(env.INPUT_EXECUTION_FILE ?? ""), extension);
      } else {
        try {
          verdict = checkVerdict(JSON.parse(env.INPUT_VERDICT ?? ""), extension);
        } catch {
          verdict = null;
        }
      }
      // Names only: the model's values never reach the log.
      lines.push(
        verdict
          ? `intake-triage-verdict: verdict carries ${Object.keys(verdict).join(", ") || "no fields"}`
          : "::warning title=intake-triage-verdict::The verdict was missing or broke verdict-schema's bounds; none is carried.",
      );
    }
    outputs = { verdict: verdict ? JSON.stringify(verdict) : "" };
  } else {
    throw new Error(`mode ${JSON.stringify(mode)} is not schema, extract or check`);
  }
  writeOutputs(env, outputs);
  return { outputs, lines };
}

if (require.main === module) {
  try {
    const { lines } = main();
    if (lines.length > 0) process.stdout.write(`${lines.join("\n")}\n`);
  } catch (error) {
    process.stdout.write(`::error title=intake-triage-verdict::${String(error.message).replace(/[\r\n]+/gu, " ")}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  BASE_FIELDS,
  LIMITS,
  VerdictSchemaError,
  baseSchema,
  checkVerdict,
  extractVerdict,
  instructions,
  main,
  mergeSchema,
  parseExtension,
};

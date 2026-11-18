"use strict";

// The intake-triage lane's output schema and the caller's verdict-schema
// fields (.github/actions/check-intake-triage-verdict). An unset verdict-schema
// must leave the schema the model is held to byte for byte as it was; a set
// one may only add bounded fields, and the values the model returns are
// checked against those bounds again.

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const MODULE = path.join(
  __dirname,
  "..",
  "actions",
  "check-intake-triage-verdict",
  "verdict.cjs",
);
const {
  VerdictSchemaError,
  baseSchema,
  checkVerdict,
  extractVerdict,
  main,
  mergeSchema,
  parseExtension,
  worstBytes,
} = require(MODULE);

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "intake-verdict-"));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const PROMPT = "REPO: o/r\nISSUE NUMBER: 7\n\nTriage it.\n";
function promptFile() {
  const directory = fs.mkdtempSync(path.join(scratch, "compose-"));
  const file = path.join(directory, "prompt.md");
  fs.writeFileSync(file, PROMPT);
  return file;
}

const schemaRun = (
  verdictSchema,
  allowed = ["priority: high", "bug"],
  typeNames = ["Bug", "Task"],
) => {
  const prompt = promptFile();
  const { outputs } = main({
    INPUT_MODE: "schema",
    INPUT_ALLOWED: JSON.stringify(allowed),
    INPUT_TYPE_NAMES: JSON.stringify(typeNames),
    INPUT_PROMPT_FILE: prompt,
    INPUT_VERDICT_SCHEMA: verdictSchema,
  });
  return {
    schemaText: fs.readFileSync(outputs["schema-file"], "utf8"),
    prompt: fs.readFileSync(prompt, "utf8"),
  };
};

// The bytes the compose step wrote before verdict-schema existed, written
// out by hand from its schema literal (intake-triage.yml at fac95e7).
const PINNED_WITH_TYPES =
  '{"type":"object","additionalProperties":false,"properties":{"labels":{"type":"array","uniqueItems":true,"items":{"type":"string","enum":["priority: high","bug"]}},"comment":{"type":"string","maxLength":3000},"needs_human":{"type":"boolean"},"reason":{"type":"string","maxLength":500},"type":{"type":"string","enum":["Bug","Task","none"]}},"required":["labels","comment","needs_human","reason","type"]}';
const PINNED_EMPTY =
  '{"type":"object","additionalProperties":false,"properties":{"labels":{"type":"array","maxItems":0},"comment":{"type":"string","maxLength":3000},"needs_human":{"type":"boolean"},"reason":{"type":"string","maxLength":500}},"required":["labels","comment","needs_human","reason"]}';

test("an unset verdict-schema writes the schema the compose step wrote, byte for byte, and leaves the prompt alone", () => {
  for (const unset of ["", "  \n"]) {
    const withTypes = schemaRun(unset);
    assert.equal(
      withTypes.schemaText,
      PINNED_WITH_TYPES,
      JSON.stringify(unset),
    );
    assert.equal(withTypes.prompt, PROMPT);
    assert.equal(schemaRun(unset, [], []).schemaText, PINNED_EMPTY);
  }
});

// What a later change may never do to a base field: drop it, stop requiring
// it, widen its enum, raise or remove its maxLength or maxItems, change its
// type, drop uniqueItems, or open the object.
function loosenings(snapshot, current, where = "schema") {
  const found = [];
  if (snapshot.type !== current.type) found.push(`${where} type changed`);
  if (
    snapshot.additionalProperties === false &&
    current.additionalProperties !== false
  ) {
    found.push(`${where} additionalProperties is no longer false`);
  }
  for (const key of ["maxLength", "maxItems"]) {
    if (snapshot[key] !== undefined && !(current[key] <= snapshot[key]))
      found.push(`${where} ${key} raised or removed`);
  }
  if (snapshot.uniqueItems === true && current.uniqueItems !== true)
    found.push(`${where} uniqueItems dropped`);
  if (snapshot.enum) {
    const extra = (current.enum ?? [null]).filter(
      (value) => !snapshot.enum.includes(value),
    );
    if (extra.length > 0) found.push(`${where} enum widened`);
  }
  if (snapshot.items)
    found.push(
      ...loosenings(snapshot.items, current.items ?? {}, `${where}[]`),
    );
  for (const [name, field] of Object.entries(snapshot.properties ?? {})) {
    if (!Object.hasOwn(current.properties ?? {}, name))
      found.push(`${where}.${name} dropped`);
    else
      found.push(
        ...loosenings(field, current.properties[name], `${where}.${name}`),
      );
  }
  for (const name of snapshot.required ?? []) {
    if (!(current.required ?? []).includes(name))
      found.push(`${where}.${name} no longer required`);
  }
  return found;
}

const SNAPSHOT = JSON.parse(PINNED_WITH_TYPES);

test("the base schema only grows: no field dropped, enum widened, bound raised or object opened", () => {
  assert.deepEqual(
    loosenings(
      SNAPSHOT,
      baseSchema(["priority: high", "bug"], ["Bug", "Task"]),
    ),
    [],
  );
  // A verdict-schema adds fields without loosening any base one.
  const merged = mergeSchema(
    SNAPSHOT,
    parseExtension(JSON.stringify(SIZE_ONLY)),
  );
  assert.deepEqual(loosenings(SNAPSHOT, merged), []);
  assert.ok(Object.hasOwn(merged.properties, "size"));
});

test("the only-grows check fails on each loosening", () => {
  const mutate = (change) => {
    const copy = structuredClone(SNAPSHOT);
    change(copy);
    return loosenings(SNAPSHOT, copy);
  };
  const cases = {
    "a dropped field": (s) => {
      delete s.properties.reason;
    },
    "a dropped required name": (s) => {
      s.required = s.required.filter((name) => name !== "comment");
    },
    "a widened label enum": (s) =>
      s.properties.labels.items.enum.push("agent-ready"),
    "a widened type enum": (s) => s.properties.type.enum.push("Epic"),
    "an enum removed": (s) => {
      delete s.properties.type.enum;
    },
    "a raised maxLength": (s) => {
      s.properties.comment.maxLength = 3001;
    },
    "a removed maxLength": (s) => {
      delete s.properties.reason.maxLength;
    },
    "an opened object": (s) => {
      s.additionalProperties = true;
    },
    "a dropped uniqueItems": (s) => {
      delete s.properties.labels.uniqueItems;
    },
  };
  for (const [name, change] of Object.entries(cases)) {
    assert.notDeepEqual(mutate(change), [], name);
  }
  const empty = JSON.parse(PINNED_EMPTY);
  const raised = structuredClone(empty);
  raised.properties.labels.maxItems = 1;
  assert.deepEqual(loosenings(empty, raised), [
    "schema.labels maxItems raised or removed",
  ]);
});

const SIZE_ONLY = {
  properties: {
    size: {
      type: "string",
      enum: ["S", "M", "L"],
      description: "The change's size.",
    },
  },
  required: ["size"],
};

const FULL = {
  properties: {
    size: {
      type: "string",
      enum: ["S", "M", "L"],
      description: "The change's size.",
    },
    complexity: { type: "integer", minimum: 1, maximum: 5 },
    uncertainty: { type: "number", minimum: 0, maximum: 1 },
    flags: {
      type: "array",
      maxItems: 5,
      uniqueItems: true,
      items: { type: "string", enum: ["breaking", "docs"] },
    },
    blocked_by: {
      type: "array",
      maxItems: 10,
      items: { type: "integer", minimum: 1, maximum: 999999 },
    },
    summary: {
      type: "string",
      maxLength: 200,
      description: "One line\nfor maintainers.",
    },
    ready: { type: "boolean" },
    owner: {
      type: "object",
      additionalProperties: false,
      properties: { team: { type: "string", maxLength: 40 } },
      required: ["team"],
    },
  },
  required: ["size", "complexity"],
};

test("a valid verdict-schema adds its fields, required after the base names, and names them in the prompt", () => {
  const { schemaText, prompt } = schemaRun(JSON.stringify(FULL));
  const schema = JSON.parse(schemaText);
  assert.deepEqual(Object.keys(schema.properties), [
    "labels",
    "comment",
    "needs_human",
    "reason",
    "type",
    "size",
    "complexity",
    "uncertainty",
    "flags",
    "blocked_by",
    "summary",
    "ready",
    "owner",
  ]);
  assert.deepEqual(schema.required, [
    "labels",
    "comment",
    "needs_human",
    "reason",
    "type",
    "size",
    "complexity",
  ]);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties.owner, FULL.properties.owner);
  assert.deepEqual(loosenings(SNAPSHOT, schema), []);
  assert.ok(prompt.startsWith(PROMPT));
  assert.match(prompt, /^- size \(required\): The change's size\.$/mu);
  assert.match(prompt, /^- complexity \(required\)$/mu);
  assert.match(
    prompt,
    /^- summary \(optional\): One line for maintainers\.$/mu,
  );
  assert.match(prompt, /^- owner \(optional\)$/mu);
});

const big = (count) => ({
  properties: Object.fromEntries(
    Array.from({ length: count }, (_, i) => [`f${i}`, { type: "boolean" }]),
  ),
});
const nest = (levels) => {
  let field = { type: "boolean" };
  for (let i = 0; i < levels; i += 1) {
    field = {
      type: "object",
      additionalProperties: false,
      properties: { inner: field },
    };
  }
  return { properties: { outer: field } };
};
const one = (field) => ({ properties: { field } });

test("a verdict-schema that breaks a rule fails closed, naming the rule", () => {
  const cases = {
    "not JSON": ["{", /not JSON/u],
    "not an object": ["[]", /must be a JSON object/u],
    "an unknown top-level key": [
      JSON.stringify({ ...SIZE_ONLY, additionalProperties: true }),
      /only properties and required/u,
    ],
    "no properties": [
      JSON.stringify({ required: [] }),
      /non-empty properties/u,
    ],
    "a required name it does not define": [
      JSON.stringify({ ...SIZE_ONLY, required: ["shape"] }),
      /required must list/u,
    ],
    "a repeated required name": [
      JSON.stringify({ ...SIZE_ONLY, required: ["size", "size"] }),
      /required must list/u,
    ],
    "an upper-case name": [
      JSON.stringify({ properties: { Size: { type: "boolean" } } }),
      /must match/u,
    ],
    "a prototype name": [
      '{"properties":{"__proto__":{"type":"boolean"}}}',
      /must match/u,
    ],
    "a type list": [
      JSON.stringify(one({ type: ["string", "null"], maxLength: 5 })),
      /needs a type/u,
    ],
    "an unknown type": [JSON.stringify(one({ type: "null" })), /needs a type/u],
    "a pattern": [
      JSON.stringify(one({ type: "string", maxLength: 5, pattern: "^a" })),
      /may not use pattern/u,
    ],
    "a $ref": [
      JSON.stringify(one({ type: "string", maxLength: 5, $ref: "#/x" })),
      /may not use \$ref/u,
    ],
    "an anyOf": [
      JSON.stringify(one({ type: "string", maxLength: 5, anyOf: [] })),
      /may not use anyOf/u,
    ],
    "an unbounded string": [
      JSON.stringify(one({ type: "string" })),
      /no maxLength or enum/u,
    ],
    "a string over the length cap": [
      JSON.stringify(one({ type: "string", maxLength: 1001 })),
      /maxLength must be/u,
    ],
    "a zero maxLength": [
      JSON.stringify(one({ type: "string", maxLength: 0 })),
      /maxLength must be/u,
    ],
    "an empty enum": [
      JSON.stringify(one({ type: "string", enum: [] })),
      /enum must hold/u,
    ],
    "an enum of 51 values": [
      JSON.stringify(
        one({
          type: "string",
          enum: Array.from({ length: 51 }, (_, i) => `v${i}`),
        }),
      ),
      /enum must hold/u,
    ],
    "an enum value over 100 characters": [
      JSON.stringify(one({ type: "string", enum: ["x".repeat(101)] })),
      /enum must hold/u,
    ],
    "a non-string enum value": [
      JSON.stringify(one({ type: "string", enum: [1] })),
      /enum must hold/u,
    ],
    "an enum on a number": [
      JSON.stringify(
        one({ type: "integer", minimum: 0, maximum: 3, enum: [1] }),
      ),
      /may not use enum/u,
    ],
    "a minLength above maxLength": [
      JSON.stringify(one({ type: "string", maxLength: 3, minLength: 4 })),
      /minLength/u,
    ],
    "an array with no maxItems": [
      JSON.stringify(one({ type: "array", items: { type: "boolean" } })),
      /needs maxItems/u,
    ],
    "an array over the item cap": [
      JSON.stringify(
        one({ type: "array", maxItems: 21, items: { type: "boolean" } }),
      ),
      /needs maxItems/u,
    ],
    "an array with no items": [
      JSON.stringify(one({ type: "array", maxItems: 3 })),
      /needs items/u,
    ],
    "an array of unbounded strings": [
      JSON.stringify(
        one({ type: "array", maxItems: 3, items: { type: "string" } }),
      ),
      /field\[\] is a string/u,
    ],
    "a number with no minimum": [
      JSON.stringify(one({ type: "number", maximum: 3 })),
      /finite minimum/u,
    ],
    "a number with no maximum": [
      JSON.stringify(one({ type: "number", minimum: 3 })),
      /finite maximum/u,
    ],
    "an integer with a fractional bound": [
      JSON.stringify(one({ type: "integer", minimum: 0.5, maximum: 3 })),
      /whole number/u,
    ],
    "a minimum above the maximum": [
      JSON.stringify(one({ type: "integer", minimum: 4, maximum: 3 })),
      /above its maximum/u,
    ],
    "an open nested object": [
      JSON.stringify(
        one({ type: "object", properties: { a: { type: "boolean" } } }),
      ),
      /additionalProperties to false/u,
    ],
    "a nested object set open": [
      JSON.stringify(
        one({
          type: "object",
          additionalProperties: true,
          properties: { a: { type: "boolean" } },
        }),
      ),
      /additionalProperties to false/u,
    ],
    "seventeen fields": [JSON.stringify(big(17)), /more than 16/u],
    "four levels of nesting": [JSON.stringify(nest(3)), /deeper than 3/u],
    "more than 8192 bytes": [
      JSON.stringify({
        properties: { a: { type: "boolean", description: "x".repeat(8200) } },
      }),
      /longer than 8192 bytes/u,
    ],
    "a description over 300 characters": [
      JSON.stringify(one({ type: "boolean", description: "x".repeat(301) })),
      /description/u,
    ],
  };
  for (const name of ["labels", "comment", "needs_human", "reason", "type"]) {
    cases[`the base field ${name}`] = [
      JSON.stringify({ properties: { [name]: { type: "boolean" } } }),
      /base field/u,
    ];
  }
  for (const [name, [text, message]] of Object.entries(cases)) {
    assert.throws(
      () => parseExtension(text),
      (error) =>
        error instanceof VerdictSchemaError && message.test(error.message),
      name,
    );
  }
  // At the caps themselves the schema passes.
  assert.ok(parseExtension(JSON.stringify(big(16))));
  assert.ok(parseExtension(JSON.stringify(nest(2))));
  assert.ok(
    parseExtension(
      JSON.stringify(
        one({
          type: "array",
          maxItems: 20,
          items: { type: "string", enum: ["a", "b"] },
        }),
      ),
    ),
  );
  assert.ok(
    parseExtension(JSON.stringify(one({ type: "string", maxLength: 1000 }))),
  );
});

test("a schema whose largest verdict would exceed 16384 bytes fails, counting 6 bytes a character", () => {
  // Hand-counted: {"a":"<10 characters>"} is 2 + 3 + 1 + (2 + 6 * 10) = 68.
  assert.equal(
    worstBytes({
      type: "object",
      properties: { a: { type: "string", maxLength: 10 } },
    }),
    68,
  );
  // {"b":false} is 11; {"n":[i,i,i]} is 2 + 3 + 1 + (2 + 3 * 24 + 2) = 82.
  assert.equal(
    worstBytes({ type: "object", properties: { b: { type: "boolean" } } }),
    11,
  );
  assert.equal(
    worstBytes({
      type: "object",
      properties: {
        n: {
          type: "array",
          maxItems: 3,
          items: { type: "integer", minimum: 0, maximum: 9 },
        },
      },
    }),
    82,
  );
  // An array of 20 strings of maxLength m: 2 + 3 + 1 + 2 + 20 * (2 + 6m) + 19
  // = 67 + 120m, so 135 gives 16267 and 136 gives 16387.
  const strings = (m) =>
    JSON.stringify({
      properties: {
        a: {
          type: "array",
          maxItems: 20,
          items: { type: "string", maxLength: m },
        },
      },
    });
  assert.ok(parseExtension(strings(135)));
  assert.throws(
    () => parseExtension(strings(136)),
    /up to 16387 bytes, over the 16384-byte cap/u,
  );
  // Seven arrays of 20 strings of 1000 characters.
  const seven = Object.fromEntries(
    Array.from({ length: 7 }, (_, i) => [
      `f${i}`,
      {
        type: "array",
        maxItems: 20,
        items: { type: "string", maxLength: 1000 },
      },
    ]),
  );
  assert.throws(
    () => parseExtension(JSON.stringify({ properties: seven })),
    /over the 16384-byte cap/u,
  );
});

test("a verdict over 16384 bytes is dropped by extract and check", () => {
  // Built directly, past parseExtension's worst-case check, to reach the value cap.
  const wide = {
    properties: { a: { type: "string", maxLength: 20000 } },
    required: ["a"],
  };
  // {"a":"<n x's>"} is n + 8 bytes.
  assert.deepEqual(extractVerdict({ a: "x".repeat(16376) }, wide), {
    a: "x".repeat(16376),
  });
  assert.equal(extractVerdict({ a: "x".repeat(16377) }, wide), null);
  assert.deepEqual(checkVerdict({ a: "x".repeat(16376) }, wide), {
    a: "x".repeat(16376),
  });
  assert.equal(checkVerdict({ a: "x".repeat(16377) }, wide), null);
});

test("uniqueItems compares objects whatever their key order", () => {
  const pairs = parseExtension(
    JSON.stringify({
      properties: {
        pairs: {
          type: "array",
          maxItems: 3,
          uniqueItems: true,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              a: { type: "integer", minimum: 0, maximum: 9 },
              b: { type: "integer", minimum: 0, maximum: 9 },
            },
          },
        },
      },
    }),
  );
  assert.equal(
    extractVerdict(
      {
        pairs: [
          { a: 1, b: 2 },
          { b: 2, a: 1 },
        ],
      },
      pairs,
    ),
    null,
  );
  assert.deepEqual(
    extractVerdict(
      {
        pairs: [
          { a: 1, b: 2 },
          { a: 2, b: 1 },
        ],
      },
      pairs,
    ),
    {
      pairs: [
        { a: 1, b: 2 },
        { a: 2, b: 1 },
      ],
    },
  );
});

test("schema mode fails the step with a one-line error and writes no schema file", () => {
  const prompt = promptFile();
  const result = spawnSync(process.execPath, [MODULE], {
    env: {
      PATH: process.env.PATH,
      INPUT_MODE: "schema",
      INPUT_ALLOWED: "[]",
      INPUT_TYPE_NAMES: "[]",
      INPUT_PROMPT_FILE: prompt,
      INPUT_VERDICT_SCHEMA: JSON.stringify({
        properties: { comment: { type: "string", maxLength: 9000 } },
      }),
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.equal(
    result.stdout,
    "::error title=check-intake-triage-verdict::verdict-schema: field comment is a base field and cannot be redefined\n",
  );
  assert.equal(
    fs.existsSync(path.join(path.dirname(prompt), "schema.json")),
    false,
  );
  assert.equal(fs.readFileSync(prompt, "utf8"), PROMPT);
});

const extension = parseExtension(JSON.stringify(FULL));
const GOOD = {
  size: "M",
  complexity: 3,
  uncertainty: 0.25,
  flags: ["docs"],
  blocked_by: [12, 40],
  summary: "Parser crash on empty input.",
  ready: false,
  owner: { team: "core" },
};

function extractRun(structured, verdictSchema = JSON.stringify(FULL)) {
  const directory = fs.mkdtempSync(path.join(scratch, "extract-"));
  const executionFile = path.join(directory, "execution.json");
  fs.writeFileSync(
    executionFile,
    JSON.stringify([
      { type: "system" },
      { type: "result", subtype: "success", structured_output: structured },
    ]),
  );
  const githubOutput = path.join(directory, "output");
  const { outputs, lines } = main({
    INPUT_MODE: "extract",
    INPUT_EXECUTION_FILE: executionFile,
    INPUT_VERDICT_SCHEMA: verdictSchema,
    GITHUB_OUTPUT: githubOutput,
  });
  return { outputs, lines, written: fs.readFileSync(githubOutput, "utf8") };
}

test("extract carries the added fields in schema order and leaves the base fields out", () => {
  const structured = {
    labels: ["bug"],
    comment: "Thanks.",
    needs_human: false,
    reason: "r",
    type: "Bug",
    owner: { team: "core" },
    ready: false,
    summary: "Parser crash on empty input.",
    blocked_by: [12, 40],
    flags: ["docs"],
    uncertainty: 0.25,
    complexity: 3,
    size: "M",
  };
  const { outputs, lines, written } = extractRun(structured);
  assert.equal(
    outputs.verdict,
    '{"size":"M","complexity":3,"uncertainty":0.25,"flags":["docs"],"blocked_by":[12,40],"summary":"Parser crash on empty input.","ready":false,"owner":{"team":"core"}}',
  );
  assert.match(
    written,
    /^verdict<<ghadelimiter_[0-9a-f-]+\n\{"size":"M",.*\}\nghadelimiter_[0-9a-f-]+\n$/u,
  );
  assert.deepEqual(lines, [
    "check-intake-triage-verdict: verdict carries size, complexity, uncertainty, flags, blocked_by, summary, ready, owner",
  ]);
  // An optional field the model left out is left out.
  assert.equal(
    extractRun({ size: "S", complexity: 1 }).outputs.verdict,
    '{"size":"S","complexity":1}',
  );
});

test("extract drops the whole verdict when any field is missing, unknown or out of bounds, and logs no value", () => {
  const { size: _size, ...withoutSize } = GOOD;
  assert.equal(
    extractRun(withoutSize).outputs.verdict,
    "",
    "a missing required field",
  );
  const cases = {
    "a size outside the enum": { size: "XL" },
    "a complexity above its maximum": { complexity: 6 },
    "a complexity below its minimum": { complexity: 0 },
    "a fractional integer": { complexity: 2.5 },
    "a complexity given as text": { complexity: "3" },
    "an uncertainty above its maximum": { uncertainty: 1.5 },
    "a flags list over maxItems": {
      flags: ["docs", "docs", "docs", "docs", "docs", "docs"],
    },
    "repeated flags": { flags: ["docs", "docs"] },
    "a flag outside the enum": { flags: ["urgent"] },
    "a blocker that is not a number": { blocked_by: ["#12"] },
    "a summary over maxLength": { summary: "x".repeat(201) },
    "a summary carrying a key": {
      summary: "token ghp_abcdefghijklmnopqrstuvwxyz0123",
    },
    "a ready flag given as text": { ready: "false" },
    "an owner with an unknown key": { owner: { team: "core", lead: "x" } },
    "an owner missing its required team": { owner: {} },
    "an owner given as a list": { owner: ["core"] },
  };
  for (const [name, change] of Object.entries(cases)) {
    const { outputs, lines } = extractRun({ ...GOOD, ...change });
    assert.equal(outputs.verdict, "", name);
    assert.equal(lines.length, 1, name);
    assert.match(
      lines[0],
      /^::warning title=check-intake-triage-verdict::/u,
      name,
    );
    assert.doesNotMatch(lines[0], /XL|ghp_|urgent|#12/u, name);
  }
  assert.equal(extractVerdict(undefined, extension), null);
  assert.equal(extractVerdict("not an object", extension), null);
});

test("an unset verdict-schema extracts nothing and logs nothing", () => {
  const { outputs, lines, written } = extractRun(GOOD, "");
  assert.equal(outputs.verdict, "");
  assert.deepEqual(lines, []);
  assert.match(written, /^verdict<<(ghadelimiter_[0-9a-f-]+)\n\n\1\n$/u);
});

test("check mode passes a verdict that fits and empties one that does not", () => {
  const check = (verdict, verdictSchema = JSON.stringify(FULL)) =>
    main({
      INPUT_MODE: "check",
      INPUT_VERDICT: verdict,
      INPUT_VERDICT_SCHEMA: verdictSchema,
    }).outputs.verdict;
  assert.equal(
    check(JSON.stringify({ size: "L", complexity: 5 })),
    '{"size":"L","complexity":5}',
  );
  assert.equal(
    check(JSON.stringify({ size: "L", complexity: 5, extra: 1 })),
    "",
  );
  assert.equal(check(JSON.stringify({ size: "L", complexity: 9 })), "");
  assert.equal(check("{not json"), "");
  assert.equal(check(JSON.stringify({ size: "L", complexity: 5 }), ""), "");
  assert.equal(checkVerdict(["L"], extension), null);
});

test("an unknown mode fails", () => {
  assert.throws(
    () => main({ INPUT_MODE: "apply" }),
    /not schema, extract or check/u,
  );
});

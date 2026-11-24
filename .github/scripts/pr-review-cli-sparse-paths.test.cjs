"use strict";

// Every path a pr-review-cli.yml review leg reads from its claude-code-plugins
// clone, in the workflow's own steps and in the local actions and scripts
// those steps run, lies inside the clone's sparse checkout. A path outside it
// is missing on the runner, and the step reading it fails on every run.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { parseWorkflow } = require("./workflow-yaml.cjs");

const repositoryRoot = path.join(__dirname, "..", "..");
const workflow = parseWorkflow(
  fs.readFileSync(
    path.join(repositoryRoot, ".github", "workflows", "pr-review-cli.yml"),
    "utf8",
  ),
);

const SPARSE_SET = /git -C "\$\{?(\w+)\}?" sparse-checkout set ([^\n]+)/u;

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

// git's cone mode, the default for `sparse-checkout set`: everything under a
// listed directory, plus the files directly inside the top level and inside
// each listed directory's ancestors. A reference with no extension in its
// last segment is taken as a directory, which must lie under a listed one.
function inCone(reference, directories) {
  if (directories.some((d) => reference === d || reference.startsWith(`${d}/`)))
    return true;
  if (!path.posix.basename(reference).includes(".")) return false;
  const parent = path.posix.dirname(reference);
  return parent === "." || directories.some((d) => d.startsWith(`${parent}/`));
}

// The source-root paths a script names through one of the variables that
// carry the clone: "$VAR/x", "${VAR}/x", path.join(env.VAR, "x"), and
// path.join(alias, "x") where alias was bound from env.VAR.
function referencedPaths(text, variables) {
  const found = new Set();
  for (const variable of variables) {
    const v = escapeRegExp(variable);
    for (const m of text.matchAll(
      new RegExp(`\\$\\{?${v}\\}?/([A-Za-z0-9._/-]+)`, "gu"),
    ))
      found.add(m[1]);
    const sources = [`(?:process\\.)?env\\.${v}`];
    for (const m of text.matchAll(
      new RegExp(
        `(?:(\\w+)\\s*:|(?:const|let|var)\\s+(\\w+)\\s*=)\\s*(?:process\\.)?env\\.${v}\\b`,
        "gu",
      ),
    ))
      sources.push(escapeRegExp(m[1] ?? m[2]));
    for (const m of text.matchAll(
      new RegExp(
        `path\\.join\\(\\s*(?:${sources.join("|")})\\s*,\\s*["'\`]([^"'\`]+)["'\`]`,
        "gu",
      ),
    ))
      found.add(m[1]);
  }
  return [...found];
}

const stepText = (s) =>
  [s.run, s.with?.script].filter((t) => typeof t === "string").join("\n");

const carriers = (map, value) =>
  Object.entries(map ?? {})
    .filter(([, v]) => v === value)
    .map(([k]) => k);

// The paths one local action reads from the clone, given the env names and
// input names that carry it into the action. Every file in the action's
// directory is scanned, so a script it runs is never skipped.
function actionReads(uses, envNames, inputNames) {
  const directory = path.join(
    repositoryRoot,
    uses.replace(/^(?:\$|\.)\//u, ""),
  );
  const action = parseWorkflow(
    fs.readFileSync(path.join(directory, "action.yml"), "utf8"),
  );
  const found = new Map();
  for (const s of action.runs?.steps ?? []) {
    const names = [
      ...envNames,
      ...Object.entries(s.env ?? {})
        .filter(([, v]) =>
          inputNames.some((i) =>
            new RegExp(
              `^\\$\\{\\{\\s*inputs\\.${escapeRegExp(i)}\\s*\\}\\}$`,
              "u",
            ).test(String(v)),
          ),
        )
        .map(([k]) => k),
    ];
    if (names.length === 0) continue;
    const where = `${uses} / ${s.name ?? s.id}`;
    for (const p of referencedPaths(stepText(s), names)) found.set(p, where);
    for (const file of fs.readdirSync(directory)) {
      if (file === "action.yml" || /\.test\./u.test(file)) continue;
      const full = path.join(directory, file);
      if (!fs.statSync(full).isFile()) continue;
      for (const p of referencedPaths(fs.readFileSync(full, "utf8"), names))
        found.set(p, `${uses}/${file}`);
    }
  }
  return found;
}

const legs = Object.entries(workflow.jobs).flatMap(([name, job]) => {
  const plugin = (job.steps ?? []).find((s) => SPARSE_SET.test(s.run ?? ""));
  if (!plugin) return [];
  const [, variable, list] = plugin.run.match(SPARSE_SET);
  return [
    {
      name,
      job,
      clone: plugin.env[variable],
      directories: list.trim().split(/\s+/u),
    },
  ];
});

test("cone coverage follows git's documented sparse-checkout set A/B/C example", () => {
  const set = ["A/B/C"];
  assert.equal(inCone("README.md", set), true, "top-level file");
  assert.equal(inCone("A/x.txt", set), true, "file directly in an ancestor");
  assert.equal(inCone("A/B/y.txt", set), true, "file directly in an ancestor");
  assert.equal(inCone("A/B/C/d/e.txt", set), true, "file under the set");
  assert.equal(inCone("A/B/C", set), true, "the set directory itself");
  assert.equal(inCone("A/D/z.txt", set), false, "file in a sibling directory");
  assert.equal(
    inCone("A/B/D/f.txt", set),
    false,
    "file in a sibling directory",
  );
  assert.equal(
    inCone("A/B", set),
    false,
    "an ancestor directory, only partly present",
  );
});

test("the source-root reference forms are recognized", () => {
  assert.deepEqual(
    referencedPaths(
      [
        'cp -R "$SOURCE/plugins/review" out',
        `x=("\${SOURCE}/.github/scripts/a/b.py" split)`,
        'require(path.join(env.SOURCE, ".github/actions/c/d.mjs"));',
        "run({ source: env.SOURCE });",
        'import(path.join(source, "plugins/review/lib/e.mjs"));',
        'git -C "$SOURCE" rev-parse HEAD',
        'cp "$OTHER/not/this.txt" .',
      ].join("\n"),
      ["SOURCE"],
    ).sort(),
    [
      ".github/actions/c/d.mjs",
      ".github/scripts/a/b.py",
      "plugins/review",
      "plugins/review/lib/e.mjs",
    ],
  );
});

test("pr-review-cli.yml has review legs that sparse-clone claude-code-plugins", () => {
  assert.ok(legs.length > 0, "no job runs git sparse-checkout set");
  for (const leg of legs) {
    assert.match(leg.clone ?? "", /claude-code-plugins$/u, leg.name);
    assert.ok(leg.directories.length > 0, leg.name);
  }
});

for (const leg of legs) {
  test(`${leg.name}: every path read from the claude-code-plugins clone is in its sparse checkout`, (t) => {
    const reads = new Map();
    for (const s of leg.job.steps) {
      const where = s.name ?? s.id;
      const envNames = carriers(s.env, leg.clone);
      const inputNames = carriers(s.with, leg.clone);
      if (envNames.length === 0 && inputNames.length === 0) continue;
      const found = new Map();
      for (const p of referencedPaths(stepText(s), envNames))
        found.set(p, where);
      if (/^(?:\$|\.)\//u.test(s.uses ?? ""))
        for (const [p, w] of actionReads(s.uses, envNames, inputNames))
          found.set(p, `${where} -> ${w}`);
      assert.ok(
        found.size > 0,
        `${leg.name} / ${where} receives the clone but names no path in a form this test recognizes; extend referencedPaths`,
      );
      for (const [p, w] of found) reads.set(p, w);
    }
    for (const [p, w] of reads) t.diagnostic(`reads ${p} (${w})`);
    const outside = [...reads]
      .filter(([p]) => !inCone(p, leg.directories))
      .map(([p, w]) => `${p} (read by ${w})`);
    assert.deepEqual(
      outside,
      [],
      `${leg.name} reads clone paths outside its sparse checkout (${leg.directories.join(" ")})`,
    );
  });
}

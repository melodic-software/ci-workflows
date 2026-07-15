"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { generateKeyPairSync } = require("node:crypto");

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const workflowPath = path.join(
  __dirname,
  "..",
  "workflows",
  "standards-sync.yml",
);
const workflow = fs.readFileSync(workflowPath, "utf8");
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });

function extractAttestationScript() {
  const lines = workflow.split(/\r?\n/u);
  const stepIndex = lines.findIndex((line) =>
    line.includes("- name: Attest App identity and exact repository access"),
  );
  assert.notEqual(stepIndex, -1, "attestation step must exist");
  const scriptIndex = lines.findIndex(
    (line, index) => index > stepIndex && /^ {10}script: \|$/u.test(line),
  );
  assert.notEqual(scriptIndex, -1, "attestation script block must exist");
  const body = [];
  for (let index = scriptIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.length > 0 && !line.startsWith("            ")) break;
    body.push(line.startsWith("            ") ? line.slice(12) : "");
  }
  return body.join("\n");
}

const attestationScript = extractAttestationScript();

function repository(name, id) {
  return {
    id,
    full_name: `melodic-software/${name}`,
    owner: { login: "melodic-software" },
  };
}

function expectedRepositories(count = 2) {
  return Array.from(
    { length: count },
    (_, index) => `melodic-software/repository-${index + 1}`,
  );
}

async function runAttestation({
  expected = expectedRepositories(),
  env = {},
  installation = {},
  metadataData,
  pages,
  snapshots,
  requestError,
  repositoryRequestError,
} = {}) {
  const originalEnvironment = { ...process.env };
  const calls = [];
  const secrets = [];
  const info = [];
  let repositoryObservation = -1;
  const defaultPages = [
    {
      total_count: expected.length,
      repositories: expected.map((fullName, index) => ({
        id: index + 1,
        full_name: fullName,
        owner: { login: "melodic-software" },
      })),
    },
  ];
  Object.assign(process.env, {
    APP_CLIENT_ID: "Iv23standards",
    APP_PRIVATE_KEY: privateKeyPem,
    APP_SLUG: "melodic-standards-sync",
    EXPECTED_APP_SLUG: "melodic-standards-sync",
    EXPECTED_INSTALLATION_ID: "144867070",
    EXPECTED_OWNER: "melodic-software",
    EXPECTED_REPOSITORIES: JSON.stringify(expected),
    INSTALLATION_ID: "144867070",
    ...env,
  });
  try {
    const github = {
      request: async (route, options) => {
        calls.push({ route, options });
        if (requestError) throw requestError;
        if (route === "GET /app/installations/{installation_id}") {
          return {
            data:
              metadataData === undefined
                ? {
                    id: 144867070,
                    app_slug: "melodic-standards-sync",
                    repository_selection: "selected",
                    target_type: "Organization",
                    account: { login: "melodic-software" },
                    suspended_at: null,
                    ...installation,
                  }
                : metadataData,
          };
        }
        assert.equal(route, "GET /installation/repositories");
        if (repositoryRequestError) throw repositoryRequestError;
        if (options.page === 1) repositoryObservation += 1;
        const snapshotPages =
          snapshots?.[repositoryObservation] ?? pages ?? defaultPages;
        const page = snapshotPages[options.page - 1];
        assert.notEqual(page, undefined, `unexpected page ${options.page}`);
        return { data: page };
      },
    };
    const core = {
      info: (message) => info.push(message),
      setSecret: (value) => secrets.push(value),
    };
    const execute = new AsyncFunction(
      "github",
      "core",
      "require",
      "Buffer",
      attestationScript,
    );
    await execute(github, core, require, Buffer);
    return { calls, info, secrets };
  } finally {
    for (const name of Object.keys(process.env)) {
      if (!(name in originalEnvironment)) delete process.env[name];
    }
    Object.assign(process.env, originalEnvironment);
  }
}

test("attests JWT metadata and one exact repository page", async () => {
  const before = Math.floor(Date.now() / 1000);
  const result = await runAttestation();
  const after = Math.floor(Date.now() / 1000);
  assert.equal(result.calls.length, 3);
  const jwt = result.calls[0].options.headers.authorization.replace(
    /^Bearer /u,
    "",
  );
  assert.match(
    result.calls[0].options.headers.authorization,
    /^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u,
  );
  const [encodedHeader, encodedPayload] = jwt.split(".");
  assert.deepEqual(
    JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")),
    { alg: "RS256", typ: "JWT" },
  );
  const payload = JSON.parse(
    Buffer.from(encodedPayload, "base64url").toString("utf8"),
  );
  assert.equal(payload.iss, "Iv23standards");
  assert.equal(payload.exp - payload.iat, 600);
  assert.ok(payload.iat >= before - 60 && payload.iat <= after - 60);
  assert.equal(result.calls[0].options.headers.authorization, `Bearer ${jwt}`);
  assert.deepEqual(result.calls[0].options.request, { timeout: 30_000 });
  assert.equal(
    result.calls[0].options.headers["x-github-api-version"],
    "2026-03-10",
  );
  assert.deepEqual(result.calls[1].options.page, 1);
  assert.deepEqual(result.calls[1].options.per_page, 100);
  assert.deepEqual(result.calls[1].options.request, { timeout: 30_000 });
  assert.equal(result.calls[1].options.headers.authorization, undefined);
  assert.equal(
    result.calls[1].options.headers["x-github-api-version"],
    "2026-03-10",
  );
  assert.equal(result.secrets.length, 1, "derived JWT must be masked");
  assert.equal(result.secrets[0], jwt);
  assert.deepEqual(result.info, [
    "Attested 2 selected repositories for melodic-standards-sync.",
  ]);
});

test("paginates a full exact repository set", async () => {
  const expected = expectedRepositories(101);
  const firstPage = expected.slice(0, 100).map((fullName, index) => ({
    id: index + 1,
    full_name: fullName,
    owner: { login: "melodic-software" },
  }));
  const secondPage = [
    {
      id: 101,
      full_name: expected[100],
      owner: { login: "melodic-software" },
    },
  ];
  const result = await runAttestation({
    expected,
    pages: [
      { total_count: 101, repositories: firstPage },
      { total_count: 101, repositories: secondPage },
    ],
  });
  assert.equal(result.calls.length, 5);
});

test("accepts the escaped-newline private-key form used by the token action", async () => {
  await runAttestation({
    env: { APP_PRIVATE_KEY: privateKeyPem.replace(/\n/gu, "\\n") },
  });
});

for (const [name, options, pattern] of [
  [
    "missing private key before API access",
    {
      env: { APP_PRIVATE_KEY: "" },
      requestError: new Error("network must not run"),
    },
    /APP_PRIVATE_KEY is missing/u,
  ],
  [
    "malformed metadata envelope",
    { metadataData: null },
    /metadata response is malformed/u,
  ],
  [
    "wrong App slug before API access",
    {
      env: { APP_SLUG: "wrong-app" },
      requestError: new Error("network must not run"),
    },
    /token App slug/u,
  ],
  [
    "wrong installation before API access",
    {
      env: { INSTALLATION_ID: "1" },
      requestError: new Error("network must not run"),
    },
    /token installation/u,
  ],
  [
    "malformed expected JSON",
    { env: { EXPECTED_REPOSITORIES: "{" } },
    /not valid JSON/u,
  ],
  ["empty expected set", { expected: [] }, /non-empty array/u],
  [
    "duplicate expected repository",
    {
      expected: [
        "melodic-software/repository-1",
        "melodic-software/repository-1",
      ],
    },
    /duplicate expected repository/u,
  ],
  [
    "foreign expected owner",
    { expected: ["other/repository-1"] },
    /invalid expected repository/u,
  ],
  [
    "nested expected repository path",
    { expected: ["melodic-software/group/repository-1"] },
    /invalid expected repository/u,
  ],
  [
    "all-repositories installation",
    { installation: { repository_selection: "all" } },
    /metadata does not match/u,
  ],
  [
    "wrong metadata installation",
    { installation: { id: 1 } },
    /metadata does not match/u,
  ],
  [
    "wrong metadata App slug",
    { installation: { app_slug: "wrong-app" } },
    /metadata does not match/u,
  ],
  [
    "wrong metadata target type",
    { installation: { target_type: "User" } },
    /metadata does not match/u,
  ],
  [
    "wrong metadata account",
    { installation: { account: { login: "other" } } },
    /metadata does not match/u,
  ],
  [
    "suspended installation",
    { installation: { suspended_at: "2026-07-15T00:00:00Z" } },
    /metadata does not match/u,
  ],
  [
    "missing repository access",
    {
      pages: [
        { total_count: 1, repositories: [repository("repository-1", 1)] },
      ],
    },
    /reports 1 repositories; expected 2/u,
  ],
  [
    "equal-count excess access",
    {
      pages: [
        {
          total_count: 2,
          repositories: [
            repository("repository-1", 1),
            repository("excess", 2),
          ],
        },
      ],
    },
    /repository access differs/u,
  ],
  [
    "malformed repository page",
    { pages: [{ total_count: "2", repositories: [] }] },
    /page 1 is malformed/u,
  ],
  [
    "foreign repository entry",
    {
      pages: [
        {
          total_count: 2,
          repositories: [
            repository("repository-1", 1),
            {
              id: 2,
              full_name: "other/repository-2",
              owner: { login: "other" },
            },
          ],
        },
      ],
    },
    /malformed or foreign entry/u,
  ],
]) {
  test(`fails closed on ${name}`, async () => {
    await assert.rejects(runAttestation(options), pattern);
  });
}

test("fails closed on duplicate entries across pages", async () => {
  const expected = expectedRepositories(101);
  const firstPage = expected.slice(0, 100).map((fullName, index) => ({
    id: index + 1,
    full_name: fullName,
    owner: { login: "melodic-software" },
  }));
  await assert.rejects(
    runAttestation({
      expected,
      pages: [
        { total_count: 101, repositories: firstPage },
        { total_count: 101, repositories: [firstPage[0]] },
      ],
    }),
    /duplicate entry/u,
  );
});

for (const [name, duplicate] of [
  [
    "repository ID",
    {
      id: 1,
      full_name: "melodic-software/repository-101",
      owner: { login: "melodic-software" },
    },
  ],
  [
    "repository full name",
    {
      id: 101,
      full_name: "melodic-software/repository-1",
      owner: { login: "melodic-software" },
    },
  ],
]) {
  test(`fails closed on a duplicate ${name}`, async () => {
    const expected = expectedRepositories(101);
    const firstPage = expected.slice(0, 100).map((fullName, index) => ({
      id: index + 1,
      full_name: fullName,
      owner: { login: "melodic-software" },
    }));
    await assert.rejects(
      runAttestation({
        expected,
        pages: [
          { total_count: 101, repositories: firstPage },
          { total_count: 101, repositories: [duplicate] },
        ],
      }),
      /duplicate entry/u,
    );
  });
}

test("fails closed when total_count changes", async () => {
  const expected = expectedRepositories(101);
  const firstPage = expected.slice(0, 100).map((fullName, index) => ({
    id: index + 1,
    full_name: fullName,
    owner: { login: "melodic-software" },
  }));
  await assert.rejects(
    runAttestation({
      expected,
      pages: [
        { total_count: 101, repositories: firstPage },
        {
          total_count: 102,
          repositories: [
            {
              id: 101,
              full_name: expected[100],
              owner: { login: "melodic-software" },
            },
          ],
        },
      ],
    }),
    /total_count changed/u,
  );
});

test("fails closed when equal-count access changes between observations", async () => {
  const first = [
    {
      total_count: 2,
      repositories: [
        repository("repository-1", 1),
        repository("repository-2", 2),
      ],
    },
  ];
  const second = [
    {
      total_count: 2,
      repositories: [
        repository("repository-1", 1),
        repository("replacement", 3),
      ],
    },
  ];
  await assert.rejects(
    runAttestation({ snapshots: [first, second] }),
    /changed between consecutive observations/u,
  );
});

test("fails closed on an incomplete page", async () => {
  const expected = expectedRepositories(101);
  await assert.rejects(
    runAttestation({
      expected,
      pages: [
        {
          total_count: 101,
          repositories: expected.slice(0, 99).map((fullName, index) => ({
            id: index + 1,
            full_name: fullName,
            owner: { login: "melodic-software" },
          })),
        },
      ],
    }),
    /page 1 is incomplete/u,
  );
});

test("propagates GitHub API failures", async () => {
  await assert.rejects(
    runAttestation({ requestError: new Error("API unavailable") }),
    /API unavailable/u,
  );
});

test("fails closed on repository inventory API failure", async () => {
  await assert.rejects(
    runAttestation({
      repositoryRequestError: new Error("repository API unavailable"),
    }),
    /repository API unavailable/u,
  );
});

test("workflow gates every target mutation behind full-manifest attestation", () => {
  const beforeSync = workflow.match(/^([\s\S]*?)\n {2}sync:\n/u)?.[1];
  const attest = workflow.match(/\n {2}attest:\n([\s\S]*?)\n {2}sync:\n/u)?.[1];
  const sync = workflow.match(/\n {2}sync:\n([\s\S]*)$/u)?.[1];
  assert.ok(beforeSync);
  assert.ok(attest);
  assert.ok(sync);
  assert.match(
    workflow,
    /expected-repositories: \$\{\{ steps\.build\.outputs\.expected-repositories \}\}/u,
  );
  assert.match(
    workflow,
    /full_matrix="\$\([\s\S]*?sync-manifest\.sh matrix[\s\S]*?--manifest "\$MANIFEST"\s*\n\s*\)"/u,
  );
  assert.doesNotMatch(
    workflow.match(/full_matrix="\$\(([\s\S]*?)\n\s*\)"/u)?.[1] ?? "",
    /--targets/u,
  );
  assert.match(attest, /needs: plan/u);
  assert.match(attest, /if: \$\{\{ !inputs\.dry-run \}\}/u);
  assert.match(attest, /owner: melodic-software/u);
  assert.match(attest, /permission-metadata: read/u);
  assert.doesNotMatch(attest, /permission-contents:/u);
  assert.doesNotMatch(attest, /^\s+repositories:/mu);
  assert.doesNotMatch(
    attest,
    /Check out target|create-pull-request|permission-contents: write/u,
  );
  assert.doesNotMatch(
    beforeSync,
    /Check out target|(?:path|working-directory): \.target|cd \.target|sync-manifest\.sh apply|create-pull-request|permission-contents: write/u,
  );
  assert.match(sync, /needs: \[plan, attest\]/u);
  assert.match(sync, /repositories: \$\{\{ matrix\.repo_name \}\}/u);
  assert.match(sync, /permission-contents: write/u);
  assert.match(sync, /name: Check out target/u);
  assert.match(sync, /peter-evans\/create-pull-request@/u);
});

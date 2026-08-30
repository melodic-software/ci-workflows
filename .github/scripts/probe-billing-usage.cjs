#!/usr/bin/env node
"use strict";

/**
 * Phase 0 / Phase 1 billing probe for prefer-hosted-while-free (ci-workflows#252).
 *
 * Probes:
 *   GET /organizations/{org}/settings/billing/usage
 *   GET /organizations/{org}/settings/billing/usage/summary
 *   GET /organizations/{org}/settings/billing/budgets
 *
 * Credential notes (recorded from the 2026-08-12 Phase 0 probe):
 * - Classic PAT with `admin:org` → HTTP 200 on usage + summary + budgets.
 * - Workflow `GITHUB_TOKEN` can NEVER read billing (no such permission).
 * - Fine-grained PATs are officially unsupported for these endpoints.
 * - GitHub App installation tokens: OpenAPI marks the endpoints
 *   `enabledForGitHubApps: true`. The permissions-required docs place them
 *   under Organization "Administration" (read). Map that to the App permission
 *   `organization_administration: read` (create-github-app-token input
 *   `permission-organization-administration: read`). Classic OAuth accepted
 *   scopes header reports `admin:org`. The melodic-ci-runner-observer App
 *   does NOT yet grant this permission — extend it (or a dedicated billing
 *   reader App) in github-iac before an App-token poll can replace the PAT.
 *
 * Usage:
 *   node .github/scripts/probe-billing-usage.cjs [--org melodic-software]
 *       [--included-minutes 3000] [--write-variable] [--json]
 *
 * Env:
 *   GH_TOKEN / GITHUB_TOKEN — token with billing read (admin:org or App with
 *     organization_administration: read)
 *   BILLING_ORG — default org when --org omitted
 */

const { spawnSync } = require("node:child_process");
const {
  DEFAULT_INCLUDED_MINUTES,
  billingMonth,
  evaluateBillingHeadroom,
  headroomToCachePayload,
} = require("./billing-headroom.cjs");

const DEFAULT_ORG = "melodic-software";
const STATE_VARIABLE = "CI_HOSTED_MINUTES_STATE";
const PROBE_VARIABLE = "CI_HOSTED_MINUTES_PROBE_JSON";

function parseArgs(argv) {
  const options = {
    org: process.env.BILLING_ORG || DEFAULT_ORG,
    includedMinutes: DEFAULT_INCLUDED_MINUTES,
    writeVariable: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--org") {
      options.org = argv[++i];
    } else if (arg === "--included-minutes") {
      options.includedMinutes = Number(argv[++i]);
    } else if (arg === "--write-variable") {
      options.writeVariable = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function ghApi(path, { method = "GET", body } = {}) {
  const args = ["api", "-X", method, path];
  if (body !== undefined) {
    args.push("--input", "-");
  }
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    input: body !== undefined ? JSON.stringify(body) : undefined,
  });
  // spawnSync reports ENOENT / timeout / signal / maxBuffer through `error`
  // with `status` left null, which the exit-code branch below would render as
  // the causeless "failed (exit null)". Both branches throw — this one only
  // names why. Never let the `status !== 0` test go: it is what makes a
  // missing `gh` binary fail closed.
  if (result.error) {
    const error = new Error(
      `gh api ${method} ${path} failed to spawn: ${result.error.message}`,
    );
    error.status = result.status;
    throw error;
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    const error = new Error(
      `gh api ${method} ${path} failed (exit ${result.status}): ${detail}`,
    );
    error.status = result.status;
    throw error;
  }
  const text = (result.stdout || "").trim();
  return text ? JSON.parse(text) : null;
}

function ghApiWithStatus(path) {
  const result = spawnSync("gh", ["api", "-i", path], { encoding: "utf8" });
  const combined = `${result.stdout || ""}${result.stderr || ""}`;
  const statusMatch = combined.match(/^HTTP\/[\d.]+ (\d+)/mu);
  const status = statusMatch ? Number(statusMatch[1]) : null;
  const bodyStart = combined.indexOf("\r\n\r\n");
  const altStart = combined.indexOf("\n\n");
  const start =
    bodyStart >= 0 ? bodyStart + 4 : altStart >= 0 ? altStart + 2 : -1;
  let body = null;
  if (start >= 0) {
    const raw = combined.slice(start).trim();
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
  }
  return { status, body, ok: result.status === 0 && status === 200 };
}

async function resolveVisibility(owner, repo) {
  try {
    const data = ghApi(`/repos/${owner}/${repo}`);
    return data?.private ? "private" : "public";
  } catch {
    return "unknown";
  }
}

function upsertOrgVariable(org, name, value) {
  try {
    ghApi(`/orgs/${org}/actions/variables/${name}`);
    ghApi(`/orgs/${org}/actions/variables/${name}`, {
      method: "PATCH",
      body: { name, value },
    });
  } catch {
    ghApi(`/orgs/${org}/actions/variables`, {
      method: "POST",
      body: {
        name,
        value,
        visibility: "private",
      },
    });
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`Usage: node probe-billing-usage.cjs [options]

Options:
  --org <name>              Organization (default: ${DEFAULT_ORG})
  --included-minutes <n>    Plan included minutes (default: ${DEFAULT_INCLUDED_MINUTES})
  --write-variable          Upsert ${STATE_VARIABLE} (+ ${PROBE_VARIABLE})
  --json                    Machine-readable JSON on stdout
  -h, --help                Show this help

Required App permission (when probing with an installation token):
  organization_administration: read
  (docs: Organization permissions for "Administration"; classic PAT: admin:org)
`);
    return 0;
  }

  const month = billingMonth();
  const usagePath = `/organizations/${options.org}/settings/billing/usage?year=${month.year}&month=${month.month}`;
  const summaryPath = `/organizations/${options.org}/settings/billing/usage/summary?year=${month.year}&month=${month.month}`;
  const budgetsPath = `/organizations/${options.org}/settings/billing/budgets`;

  const usageProbe = ghApiWithStatus(usagePath);
  const summaryProbe = ghApiWithStatus(summaryPath);
  const budgetsProbe = ghApiWithStatus(budgetsPath);

  const report = {
    org: options.org,
    month: `${month.year}-${String(month.month).padStart(2, "0")}`,
    probedAt: new Date().toISOString(),
    endpoints: {
      usage: { path: usagePath, status: usageProbe.status },
      summary: { path: summaryPath, status: summaryProbe.status },
      budgets: { path: budgetsPath, status: budgetsProbe.status },
    },
    requiredAppPermission: {
      name: "organization_administration",
      access: "read",
      docsSection: 'Organization permissions for "Administration"',
      classicPatScope: "admin:org",
      createGithubAppTokenInput: "permission-organization-administration: read",
      note: "Docs never name a dedicated 'billing' App permission; the usage endpoints sit under Organization Administration. melodic-ci-runner-observer lacks this grant today.",
    },
    headroom: null,
    state: "unknown",
    error: null,
  };

  // Both failure exits (usage probe not ok, headroom evaluation threw) record
  // the same unknown-state payload in both variables. `report.error` is read
  // when this runs, so each caller sets it first.
  const writeUnknownVariables = () => {
    const unknownPayload = JSON.stringify({
      state: "unknown",
      org: options.org,
      month: report.month,
      probedAt: report.probedAt,
      error: report.error,
    });
    upsertOrgVariable(options.org, STATE_VARIABLE, unknownPayload);
    upsertOrgVariable(options.org, PROBE_VARIABLE, unknownPayload);
    report.wroteVariables = [STATE_VARIABLE, PROBE_VARIABLE];
  };

  if (!usageProbe.ok) {
    report.error = `usage endpoint returned HTTP ${usageProbe.status}`;
    if (options.writeVariable) {
      writeUnknownVariables();
    }
    if (options.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stderr.write(
        `Phase 0 probe FAILED: ${report.error}\n` +
          `Required App permission: organization_administration: read\n`,
      );
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    }
    return 2;
  }

  try {
    const headroom = await evaluateBillingHeadroom({
      usageItems: usageProbe.body?.usageItems,
      resolveVisibility,
      includedMinutes: options.includedMinutes,
    });
    const payload = headroomToCachePayload(headroom, {
      org: options.org,
      probedAt: report.probedAt,
      month: report.month,
    });
    report.headroom = payload;
    report.state = payload.state;
    report.summaryStatus = summaryProbe.status;
    report.budgetsStatus = budgetsProbe.status;

    if (options.writeVariable) {
      // Selector requires timestamped JSON for `free` (rejects stale compact
      // free). Write the same payload to both variables.
      const serialized = JSON.stringify(payload);
      upsertOrgVariable(options.org, STATE_VARIABLE, serialized);
      upsertOrgVariable(options.org, PROBE_VARIABLE, serialized);
      report.wroteVariables = [STATE_VARIABLE, PROBE_VARIABLE];
    }

    if (options.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(
        `Phase 0 probe OK: usage HTTP ${usageProbe.status}, ` +
          `summary HTTP ${summaryProbe.status}, budgets HTTP ${budgetsProbe.status}\n` +
          `state=${payload.state} privateMinutes=${payload.privateMinutes}/` +
          `${payload.includedMinutes} (${(payload.consumptionRatio * 100).toFixed(1)}%) ` +
          `hasPaidSpend=${payload.hasPaidSpend}\n` +
          `Required App permission: organization_administration: read ` +
          `(classic PAT: admin:org)\n`,
      );
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    }
    return 0;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    report.state = "unknown";
    if (options.writeVariable) {
      writeUnknownVariables();
    }
    process.stderr.write(`Phase 0 probe ERROR: ${report.error}\n`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 1;
  }
}

if (require.main === module) {
  // Set exitCode rather than calling process.exit(): this script's entire
  // output is a JSON report written to stdout, and process.exit() abandons
  // pending writes. Piped stdout is asynchronous, so a report larger than the
  // pipe buffer is truncated mid-write — measured here at 128 KiB of a 400 KB
  // report. Assigning exitCode lets the process drain and exit naturally.
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`${error.stack || error}\n`);
      process.exitCode = 1;
    },
  );
}

module.exports = Object.freeze({
  STATE_VARIABLE,
  PROBE_VARIABLE,
  main,
  parseArgs,
});

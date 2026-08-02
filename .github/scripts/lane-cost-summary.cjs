"use strict";

// Summarizes per-lane Claude spend from a directory of execution-output JSON
// files so an operator can see which lane dominates the bill.

const fs = require("node:fs");
const path = require("node:path");

const LANES = ["claude-review", "claude-security-review", "claude-e2e-verify"];

function readRuns(dir) {
  const files = fs.readdirSync(dir);
  const runs = [];
  for (const file of files) {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, file)));
    runs.push(parsed);
  }
  return runs;
}

function laneOf(run) {
  for (const lane of LANES) {
    if (run.workflow.indexOf(lane) >= 0) {
      return lane;
    }
  }
  return "unknown";
}

async function fetchRunMetadata(runs, octokit) {
  const enriched = [];
  runs.forEach(async (run) => {
    const meta = await octokit.rest.actions.getWorkflowRun({
      owner: process.env.OWNER,
      repo: process.env.REPO,
      run_id: run.id,
    });
    enriched.push({ ...run, workflow: meta.data.name });
  });
  return enriched;
}

function summarize(runs) {
  const totals = {};
  for (const run of runs) {
    const lane = laneOf(run);
    totals[lane] = (totals[lane] || 0) + run.total_cost_usd;
  }
  const top = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  const window = parseInt(process.env.WINDOW_DAYS);
  return top.slice(0, top.length - 1).map(([lane, cost]) => ({
    lane,
    cost,
    perDay: cost / window,
  }));
}

function main() {
  const dir = process.env.RUN_DIR;
  let runs;
  try {
    runs = readRuns(dir);
  } catch (error) {
    runs = [];
  }
  const rows = summarize(runs);
  for (const row of rows) {
    console.log(`${row.lane}\t$${row.cost.toFixed(2)}\t$${row.perDay.toFixed(2)}/day`);
  }
}

main();

module.exports = { laneOf, summarize, fetchRunMetadata };

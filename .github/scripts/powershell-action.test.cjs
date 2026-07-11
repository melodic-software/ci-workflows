"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..", "..");
const runner = fs.readFileSync(
  path.join(root, ".github", "actions", "powershell", "Invoke-Pssa.ps1"),
  "utf8",
);
const settings = fs.readFileSync(
  path.join(root, "PSScriptAnalyzerSettings.psd1"),
  "utf8",
);

test("PowerShell analysis is single-pass and fails closed on analyzer errors", () => {
  assert.equal(runner.match(/Invoke-ScriptAnalyzer @params/gu)?.length, 1);
  assert.match(runner, /ErrorVariable\s*=\s*'analysisErrors'/u);
  assert.match(runner, /if \(\$analysisErrors\)[\s\S]*?exit 2/u);
  assert.doesNotMatch(runner, /\$maxAttempts|RULE_ERROR|exit 3/u);
  assert.doesNotMatch(runner, /pwsh\s+-NoProfile/u);
});

test("PowerShell analysis imports only the exact reviewed analyzer version", () => {
  assert.match(
    runner,
    /Where-Object \{ \$_\.Version -eq \[version\]\$AnalyzerVersion \}/u,
  );
  assert.match(
    runner,
    /Import-Module PSScriptAnalyzer -RequiredVersion \$AnalyzerVersion/u,
  );
  assert.doesNotMatch(
    runner,
    /-MinimumVersion|-ge \[version\]\$AnalyzerVersion/u,
  );
});

test("the unstable casing rule stays disabled while upstream issue 1708 is open", () => {
  assert.doesNotMatch(settings, /PSUseCorrectCasing/u);
  assert.match(runner, /Upstream issue #1708/u);
});

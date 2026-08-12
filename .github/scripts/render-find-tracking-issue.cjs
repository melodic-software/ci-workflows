"use strict";

const { bundledScript, cli, render } = require("./render.cjs");

function targetBundledScript(source) {
  return bundledScript("find-tracking-issue", source);
}

function targetRender(workflow, source, name) {
  return render("find-tracking-issue", workflow, source, name);
}

module.exports = Object.freeze({
  bundledScript: targetBundledScript,
  render: targetRender,
});

cli("find-tracking-issue");

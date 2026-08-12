"use strict";

const { bundledScript, cli, render } = require("./render.cjs");

function targetBundledScript(source) {
  return bundledScript("osv-scan-guard", source);
}

function targetRender(workflow, source) {
  return render("osv-scan-guard", workflow, source);
}

module.exports = Object.freeze({
  bundledScript: targetBundledScript,
  render: targetRender,
});

cli("osv-scan-guard");

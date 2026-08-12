"use strict";

const { bundledScript, cli, render } = require("./render.cjs");

function targetBundledScript(source) {
  return bundledScript("select-runner-workflow", source);
}

function targetRender(workflow, source) {
  return render("select-runner-workflow", workflow, source);
}

module.exports = Object.freeze({
  bundledScript: targetBundledScript,
  render: targetRender,
});

cli("select-runner-workflow");

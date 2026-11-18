#!/usr/bin/env bash
# shellcheck shell=bash
# Draft policy for the ci-status composite. `refuse` fails a draft pull request;
# `allow` passes it. A re-run keeps the payload of the event that started the
# run, so a contract-only run from the draft era that a full run re-runs after
# `ready_for_review` still carries `draft: true`: only a contract-only run,
# which reads its lanes verdict from `ci-lanes`, may pass on the live state.
#
# Environment: DRAFT_POLICY (refuse|allow), EVENT_DRAFT (the payload's
# pull_request.draft), CONTRACT_ONLY (true|false), PR_URL (the pull request's
# API URL), GH_TOKEN.
set -euo pipefail

case "${DRAFT_POLICY:-}" in
  allow)
    exit 0
    ;;
  refuse) ;;
  *)
    echo "::error::ci-status: draft must be refuse or allow, got '${DRAFT_POLICY:-}'"
    exit 1
    ;;
esac

if [[ "${EVENT_DRAFT:-}" != true ]]; then
  exit 0
fi

if [[ "${CONTRACT_ONLY:-}" == true ]]; then
  live_draft="$(gh api "${PR_URL:?}" --jq .draft)"
  if [[ "$live_draft" == false ]]; then
    echo "Ready for review now; this run's payload predates ready_for_review."
    exit 0
  fi
fi

echo "::error::ci-status: draft pull request; mark it ready for review to pass"
exit 1

"use strict";

// How triage-subscription and triage-fallback differ from the claude job
// (the key leg). generate-model-legs.cjs reads this; each find must match
// `count` times.

const KEY_COMMENT = `      # and extract steps run; the report-triage-status job carries the red. A handoff (key
      # only: a credit stop, or class auth with API status 401 or 402) skips
      # the extract step: the triage-subscription job triages instead. The outcome
      # step still writes the leg's record, with handoff true, so the key's
      # stop is recorded even when the triage-subscription job triages or has no
      # token. The outcome step's step-timeout-minutes repeats
`;
const DERIVED_COMMENT = `      # and extract steps run; the report-triage-status job carries the red. With the
      # fallback token set, a limit stop, a credit stop or a 401 or 402 hands
      # off to the triage-fallback job and skips the extract step; the fallback leg
      # never hands off. The outcome step's step-timeout-minutes repeats
`;
const OUTCOME_END = `          known-failure-class: \${{ steps.claude.outputs.lane-class }}
          handoff: \${{ steps.claude.outputs.handoff }}
`;

const leg = ({ job, name, secret, input, reason, recordComment }) => ({
  job,
  substitutions: [
    {
      find: "          leg: key\n",
      replace: `          leg: ${name}\n`,
      count: 1,
    },
    {
      find: `          credential-set: \${{ secrets.CLAUDE_API_KEY != '' }}\n`,
      replace: `          credential-set: \${{ secrets.${secret} != '' }}\n`,
      count: 1,
    },
    {
      find: `          selected: \${{ needs.check-key-credit.outputs.next-leg }}\n`,
      replace: `          reason: \${{ ${reason} }}\n`,
      count: 1,
    },
    { find: KEY_COMMENT, replace: DERIVED_COMMENT, count: 1 },
    {
      find: `          api-key: \${{ secrets.CLAUDE_API_KEY }}\n`,
      replace: `          ${input}: \${{ secrets.${secret} }}\n`,
      count: 1,
    },
    {
      find: OUTCOME_END,
      replace: `${OUTCOME_END}          # ${recordComment}
          fallback-reason: \${{ steps.credential.outputs.fallback-reason }}
`,
      count: 1,
    },
  ],
});

module.exports = {
  workflow: ".github/workflows/intake-triage.yml",
  keyJob: "claude",
  legs: [
    leg({
      job: "triage-subscription",
      name: "subscription",
      secret: "CLAUDE_CODE_OAUTH_TOKEN",
      input: "subscription-token",
      reason:
        "needs.claude.outputs.next-reason || needs.check-key-credit.outputs.next-reason",
      recordComment:
        "Why this job ran, for this leg's lane record (ci-workflows#806).",
    }),
    leg({
      job: "triage-fallback",
      name: "fallback",
      secret: "FALLBACK_CLAUDE_CODE_OAUTH_TOKEN",
      input: "fallback-token",
      reason: "needs.triage-subscription.outputs.next-reason",
      recordComment: "Why this job ran, for this leg's lane record.",
    }),
  ],
};

"use strict";

// How review-subscription and review-fallback differ from review-key.
// generate-model-legs.cjs reads this; each find must match `count` times.

const KEY_COMMENT = `      # check, extract and outcome steps; the status job carries the red. A
      # handoff skips the extract step: the subscription job reviews
      # instead. The step's env holds no GitHub token. Background tasks are
      # off so every subagent reports before the result
`;
const OUTCOME_END = `          handoff: \${{ steps.chunks.outputs.handoff || steps.claude.outputs.handoff }}
`;

const leg = ({ job, name, secret, input, reason, comment }) => ({
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
      find: `          key-off: \${{ vars.CLAUDE_API_KEYS_DISABLED == 'true' || vars.REVIEWS_KEY_EXHAUSTED == 'true' }}\n`,
      replace: `          reason: \${{ ${reason} }}\n`,
      count: 1,
    },
    { find: KEY_COMMENT, replace: comment, count: 1 },
    {
      find: `          api-key: \${{ secrets.CLAUDE_API_KEY }}\n`,
      replace: `          ${input}: \${{ secrets.${secret} }}\n`,
      count: 2,
    },
    {
      find: `${OUTCOME_END}\n      # After the outcome step`,
      replace: `${OUTCOME_END}          # Why this job ran, for this leg's lane record.
          fallback-reason: \${{ steps.credential.outputs.fallback-reason }}

      # After the outcome step`,
      count: 1,
    },
  ],
});

module.exports = {
  workflow: ".github/workflows/pr-review-cli.yml",
  keyJob: "review-key",
  legs: [
    leg({
      job: "review-subscription",
      name: "subscription",
      secret: "CLAUDE_CODE_OAUTH_TOKEN",
      input: "subscription-token",
      reason:
        "needs.review-key.outputs.next-reason || needs.check-key-credit.outputs.next-reason",
      comment: `      # check, extract and outcome steps; the status job carries the red. With
      # the fallback token set, a limit stop, a credit stop or a 401 or 402
      # hands off to the fallback job and skips the extract step. The step's
      # env holds no GitHub token. Background tasks are off so every subagent
      # reports before the result
`,
    }),
    leg({
      job: "review-fallback",
      name: "fallback",
      secret: "FALLBACK_CLAUDE_CODE_OAUTH_TOKEN",
      input: "fallback-token",
      reason: "needs.review-subscription.outputs.next-reason",
      comment: `      # check, extract and outcome steps; the status job carries the red. The
      # fallback leg never hands off. The step's env holds no GitHub token.
      # Background tasks are off so every subagent reports before the result
`,
    }),
  ],
};

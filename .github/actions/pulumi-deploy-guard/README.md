# Pulumi deployment guard

This composite action is the single pre-apply implementation shared by both
GitHub IaC repositories. Call only after: install exact Pulumi CLI, exchange
protected GitHub OIDC token. Call before: mint broad GitHub governance App
token.

Fails closed unless:

- Exactly one Pulumi issuer matches GitHub's token issuer.
- Complete set of personal-token `allow` policies exactly equals versioned
  bundled contract — every claim, empty `authorizedPermissions` array included.
- The requested operational-resource input is one JSON array containing zero to
  32 unique URNs from the named stack, and every requested URN appears zero or
  one time in a valid stack export.

Contract v2 uses GitHub's immutable owner/repository-ID subject plus exact
claims for: private repo, owner ID, actor ID, protected environment, main ref,
manual event, first run attempt, self-hosted runner, reserved workflow name.
Pulumi treats `*`, `?`, `.` as pattern operators — validator rejects all three
from every rule value. The workflow claim is a GitHub workflow **name**, not a
file identity; each caller must reserve `github-iac-production-deploy-v1`
exclusively for `.github/workflows/deploy.yml`, enforce uniqueness in own repo
tests.

Existing operational resources emit as newline-delimited refresh targets. Absent
resources are the explicit first-apply path and must be created with their
reviewed defaults. Stops apply: duplicate state, malformed responses, wildcard
or extra policies, unknown contracts, API failures, auth failures. Action never
prints tokens, never requests plaintext stack secrets. Temporary state export
deleted on exit.

An exactly empty JSON array (`[]`) is the explicit policy-only mode. The action
still verifies the named stack and complete OIDC policy, exports the stack, and
validates the export shape; it then emits deterministic zero counts, `[]` for
both JSON outputs, and an empty multiline target output. This lets a protected
apply retain the same identity and policy gate when it has no state-adoption
targets. Fails closed: omitted input, malformed JSON, any non-array value,
multiple JSON documents. Inputs with one to 32 URNs keep state-adoption behavior
above.

Immutable-subject cutover deliberately two-sided, fail-closed:

1. Add new v2 Pulumi allow policies while legacy policies still work.
2. Opt both GitHub IaC repos into GitHub immutable subjects via official REST
   setting (current Pulumi GitHub provider can't express it).
3. Prove a production-name token exchanges successfully and the hosted
   near-match canary token is rejected.
4. Remove every legacy allow policy.
5. Run this guard — blocks applies during overlap since complete live personal
   allow set must exactly equal reviewed v2 contract.

Ordering follows GitHub's requirement: update cloud trust before changing
emitted subject. Static matcher tests are supporting evidence, not a replacement
for the paired live positive/negative exchange.

Companion reusable version-drift workflow intentionally checks out caller to
read its `.pulumi.version`. Behavioral-tested implementation generated inline
from canonical `ci-workflows` script — no caller-owned copy or relative
called-repository path needed.

Contract based on [GitHub's documented OIDC claims](https://docs.github.com/en/actions/reference/security/oidc),
[Pulumi OIDC issuer policies](https://www.pulumi.com/docs/administration/access-identity/oidc-issuers/),
Pulumi's read-only [`stack export`](https://www.pulumi.com/docs/iac/cli/commands/pulumi_stack_export/).

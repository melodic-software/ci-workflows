# Pulumi deployment guard

This composite action is the single pre-apply implementation shared by both
GitHub IaC repositories. Call it only after installing an exact Pulumi CLI and
exchanging the protected GitHub OIDC token, and before minting the broad GitHub
governance App token.

It fails closed unless:

- exactly one Pulumi issuer matches GitHub's token issuer;
- the complete set of personal-token `allow` policies exactly equals the
  versioned bundled contract, including every claim and an empty
  `authorizedPermissions` array;
- the requested operational-resource input is one JSON array containing zero to
  32 unique URNs from the named stack, and every requested URN appears zero or
  one time in a valid stack export.

Contract v2 uses GitHub's immutable owner/repository-ID subject and additional
exact claims for the private repository, owner ID, actor ID, protected
environment, main ref, manual event, first run attempt, hosted runner, and
reserved workflow name. Pulumi treats `*`, `?`, and `.` as pattern operators,
so the validator rejects all three from every rule value. The workflow claim is
a GitHub workflow **name**, not a file identity; each caller must reserve
`github-iac-production-deploy-v1` exclusively for `.github/workflows/deploy.yml`
and enforce that uniqueness in its repository tests.

Existing operational resources are emitted as newline-delimited refresh targets.
Absent resources are the explicit first-apply path and must be created with a
reviewed hosted-only default. Duplicate state, malformed responses, wildcard or
extra policies, unknown contracts, API failures, and authentication failures all
stop the apply. The action never prints tokens or requests plaintext stack
secrets; its temporary state export is deleted on exit.

An exactly empty JSON array (`[]`) is the explicit policy-only mode. The action
still verifies the named stack and complete OIDC policy, exports the stack, and
validates the export shape; it then emits deterministic zero counts, `[]` for
both JSON outputs, and an empty multiline target output. This lets a protected
apply retain the same identity and policy gate when it has no state-adoption
targets. Omitting the input, passing malformed JSON, passing any non-array value,
or providing multiple JSON documents still fails closed. Inputs containing one
to 32 URNs retain the state-adoption behavior above.

Immutable-subject cutover is deliberately two-sided and fail-closed:

1. Add the new v2 Pulumi allow policies while the legacy policies still work.
2. Opt both GitHub IaC repositories into GitHub immutable subjects through the
   official REST setting (the current Pulumi GitHub provider cannot express it).
3. Prove a production-name token exchanges successfully and the hosted
   near-match canary token is rejected.
4. Remove every legacy allow policy.
5. Run this guard; it blocks applies during overlap because the complete live
   personal allow set must exactly equal the reviewed v2 contract.

This ordering follows GitHub's requirement to update cloud trust before changing
the emitted subject. Static matcher tests are supporting evidence, not a
replacement for the paired live positive/negative exchange.

The companion reusable version-drift workflow intentionally checks out the
caller to read its `.pulumi.version`. Its behavioral-tested implementation is
generated inline from the canonical `ci-workflows` script, so no caller-owned
copy or relative called-repository path is required.

The contract is based on [GitHub's documented OIDC claims](https://docs.github.com/en/actions/reference/security/oidc),
[Pulumi OIDC issuer policies](https://www.pulumi.com/docs/administration/access-identity/oidc-issuers/),
and Pulumi's read-only [`stack export`](https://www.pulumi.com/docs/iac/cli/commands/pulumi_stack_export/).

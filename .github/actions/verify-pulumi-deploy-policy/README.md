# Pulumi deployment guard

This composite action is the single pre-apply implementation shared by the
organization's Pulumi IaC repositories. Call only after: install exact Pulumi
CLI, exchange protected GitHub OIDC token. Call before: mint any broad
deployment credential.

Fails closed unless:

- Exactly one Pulumi issuer matches GitHub's token issuer.
- Complete set of personal-token `allow` policies exactly equals versioned
  bundled contract — every claim, empty `authorizedPermissions` array included.
- The requested operational-resource input is one JSON array containing zero to
  32 unique URNs from the named stack, and every requested URN appears zero or
  one time in a valid stack export.

Because the guard compares Pulumi's complete personal allow set against one
contract, every repository the organization trusts belongs in that one
contract. `contracts/kyle-sexton.json` is the org-wide contract and holds the
`github-iac` and `azure-iac` policies. `contracts/kyle-sexton-github-iac.json`
remains for callers pinned to an earlier release; it holds only the
`github-iac` policy, so it stops matching once Pulumi holds both.

Contract v2 uses GitHub's immutable owner/repository-ID subject plus exact
claims for: private repo, owner ID, actor ID, main ref, manual event, first run
attempt, self-hosted runner, workflow name. Each policy's environment must be
`<repository-name>-production`, and its workflow name must match
`^[a-z0-9-]+$`. The `sub` claim takes one of two forms:

- `repo:<owner>@<owner-id>/<name>@<repository-id>:environment:<environment>`
- that form followed by
  `:job_workflow_ref:<owner>/<name>/.github/workflows/<file>.yml@<ref>`, where
  `<file>` matches `^[a-z0-9-]+$` and `<ref>` is the policy's `ref` claim.

Pulumi treats `*`, `?`, `.` as pattern operators, so the validator rejects all
three from every rule value. The one exception is a `sub` that exactly equals
the second form: its `.` characters sit only in `.github/` and `.yml@`, where
no other character yields a workflow path GitHub runs.

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
2. Opt every IaC repo into GitHub immutable subjects via official REST
   setting (current Pulumi GitHub provider can't express it).
3. Prove a production-name token exchanges successfully and the hosted
   near-match canary token is rejected.
4. Remove every legacy allow policy.
5. Run this guard — blocks applies during overlap since complete live personal
   allow set must exactly equal reviewed v2 contract.

Ordering follows GitHub's requirement: update cloud trust before changing
emitted subject. Static matcher tests are supporting evidence, not a replacement
for the paired live positive/negative exchange.

Contract based on [GitHub's documented OIDC claims](https://docs.github.com/en/actions/reference/security/oidc),
[Pulumi OIDC issuer policies](https://www.pulumi.com/docs/administration/access-identity/oidc-issuers/),
Pulumi's read-only [`stack export`](https://www.pulumi.com/docs/iac/cli/commands/pulumi_stack_export/).

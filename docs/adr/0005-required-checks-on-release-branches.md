# ADR 0005: Required checks on release branches

- Status: Proposed (the owner agreed in chat on 2026-11-21 that `ci` runs for pull requests into `release/**`; set to Accepted when this ADR is merged)
- Date: 2026-11-21
- Issues: #60

## Context

The deliver loop refused `release/next` ("requires no checks, so nothing guards the merge"). `ci.yml` ran for pull requests into `main` only, so the build checks never reported for pull requests into `release/**` and could not be required there. The repository is public, so Actions minutes cost nothing and the earlier cost reason for building on `main` only does not apply.

## Decision

- `ci.yml` also runs for `pull_request` into `release/**`. The push trigger on `release/**` stays: it covers the merge commit.
- The rulesets `main` and `release` require `pr-checks / PR checks` and the build checks (`frontend`, `rust`; the aggregate job `ci` of #63 once it exists). Force pushes and deletion are blocked on both.
- Repository admins can bypass the rulesets, as in the sibling repositories.
- The rulesets are maintained in the GitHub UI, not as code.

## Consequences

- Feature pull requests into `release/next` are guarded by the same checks as `main`.
- The deliver loop starts on `release/next` without `--allow-no-required-checks`.
- More workflow runs per pull request.
- A renamed build job blocks merges until the ruleset is edited; the aggregate job `ci` (#63) removes this.

## Alternatives

- **Only `pr-checks / PR checks` on `release/**`:** no extra runs, but nothing builds before the merge.
- **Rulesets as code:** reviewable, but needs a sync workflow and an admin token for little gain on one repository.

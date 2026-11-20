# ADR 0002: Lint and format with oxlint and oxfmt

- Status: Proposed
- Date: 2026-11-20
- Issues: #38

## Context

The scaffold (#8) lints with ESLint (`angular-eslint`, `typescript-eslint`) and formats with Prettier. The GravionLabs agent skills installed for this repository (`setup-oxc-husky`, `ts-implementation`, `ts-test`) expect the Oxc tools oxlint and oxfmt. The two setups differ, and the choice was never recorded ([ADR 0001](0001-scope-and-stack.md) does not cover it).

Open point: oxlint may not cover the template rules of `angular-eslint`. This has to be checked before a switch.

## Decision

Proposed: lint with oxlint and format with oxfmt. `pnpm lint`, `pnpm format` and `pnpm format:check` keep their names and call the Oxc tools. ESLint, Prettier, their configuration and dev dependencies are removed. If oxlint leaves a gap in the Angular template rules, the gap is documented here, or ESLint stays for templates only (see Alternatives).

## Consequences

- Faster lint and format runs locally and in CI.
- The repository matches the setup the installed skills assume.
- The verification commands in `AGENTS.md` keep working unchanged.
- Rules without an oxlint equivalent are lost or need a second tool.
- Formatting output differs slightly from Prettier: one reformatting commit.

## Alternatives

- **Keep ESLint and Prettier:** no migration work and full Angular template rules, but slower and out of step with the installed skills.
- **Hybrid:** oxlint and oxfmt for everything, ESLint with `angular-eslint` for templates only. Closes the rule gap, keeps two lint tools.

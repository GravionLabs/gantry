# ADR 0006: ESLint for Angular templates and the Helix lint preset

- Status: Proposed
- Date: 2026-11-27
- Issues: #159

## Context

[ADR 0004](0004-lint-and-format-with-oxlint-and-oxfmt.md) moved linting to oxlint and noted a gap: oxlint does not read Angular templates, and ESLint for templates only could be added back. The Helix lint preset (`@gravionlabs/helix-lint`) needs exactly that: its rule `helix/no-raw-control` is an ESLint template rule, and its Stylelint preset checks the component styles.

## Decision

`pnpm lint` runs `oxlint`, then ESLint and Stylelint. This follows ADR 0006 of GravionLabs/skills (oxlint and oxfmt everywhere, ESLint only for Angular templates).

- ESLint lints templates only: `.html` files and, through the `angular-eslint` inline-template processor, the inline templates in `.ts` files. It runs with `--max-warnings 0`. TypeScript stays with oxlint.
- Stylelint (`stylelint.config.mjs`) lints `src/**/*.css` and the inline `styles` of components through `postcss-angular`. It adds a ban on native control type selectors, `.btn*` classes and px/rem sizes in the `font` shorthand to the preset.
- Exceptions live in `scripts/lint/helix-allow.json`: one file and one rule per entry, each with a reason; `helixAllow` throws without one.
- `src/testing/lint-probe/` holds deliberate violations; `src/testing/lint-probe.spec.ts` fails when a rule stops reporting.

## Consequences

- The template-rule gap of ADR 0004 is closed for the Helix rules; the other `angular-eslint` template rules are not enabled.
- Two more lint tools in the dev dependencies. `@gravionlabs/helix-lint`, `stylelint` and `postcss-angular` are pinned exactly, because the probe spec expects exact rule ids.
- `src/styles.scss` is not linted (Stylelint reads only `.css` and inline styles here).

## Alternatives

- **Stay with oxlint only:** no raw-control check; a new raw control would pass.
- **A hand-written spec like the former `component-styles.spec.ts`:** covers styles only, not templates, and duplicates the preset.

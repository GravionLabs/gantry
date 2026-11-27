Extends: node_modules/@gravionlabs/helix-ui/styleguide/STYLEGUIDE.md

# UI style guide

Binding for every UI change. Read the base guide named above first (`pnpm install` puts it there), then this file. This file holds only the rules of Gantry and its deviations; where it says nothing, the base applies. A deviation not listed here needs a reason in the PR.

## Components

### Resource views (Containers, Stacks, Images, Volumes, Networks)

- A view is, top to bottom: the heading, its actions and filters, messages, the list. The Containers, Images, Volumes and Networks headings are followed by the item count (Containers: shown of total).
- In Containers, Images, Volumes and Networks, the actions on the listed resources sit in one bar above the list. In Volumes and Networks, _Create…_ and _Remove…_ are at its start, _Prune unused…_ and _Refresh_ at its end. The actions of one stack are in its detail view.
- Filters narrow the loaded rows. A filter by state or usage is an `hx-select-button` with `[allowEmpty]="false"`.
- A view tells an endpoint without resources apart from a filter without matches.
- The list of a view is AG Grid, with `GRID_MODULES` and `GRID_THEME` of `src/app/grid/grid.ts` and a `getRowId`. Cell renderers and tooltips live in `src/app/grid/`.
- Selection actions work on the selected rows and are disabled while none applies. Containers select several rows (the header checkbox selects the filtered ones), show "n selected" and act on those the action applies to; Images, Volumes and Networks select one row.
- Rows that are no longer shown are not acted on: when the Containers grid goes away, its selection is cleared.
- The outcome of an action on several containers names each one that failed, with the message of the engine.

### Container details

- The sections of a container are `hx-tabs`, in this order: Overview, Logs, Terminal, Stats, Environment, Mounts, Networks, Labels, Raw JSON.
- A tab renders its content on first use (`hxTabContent`). The terminals are the exception: once opened, they live on while another tab is shown.
- Environment values are masked, also in the raw JSON, until the user reveals them; loading a container masks them again.
- A container that the endpoint does not have gets its own state, which names the endpoint and leads back to Containers.

### Terminals and logs

- Terminals of one container are tabs of an `hx-tab-bar`, one per session. Closing a tab ends its process, and the close button says so in its label.
- Without a running container no terminal can be opened, and a message says why. A session that ended says so in place; a failed one shows the engine's text in an error message with _Retry_, which starts the same command again in that tab.
- The log options and actions sit in an `hx-toolbar`.
- Terminal and log output is monospace on a dark surface.
- The log is virtually scrolled with a fixed line height and keeps a capped number of lines (`MAX_LOG_LINES`).
- Scrolling up pauses following and offers a button to follow again.
- In the log search, Enter goes to the next match and Shift+Enter to the previous one.

### Endpoint switcher

- The switcher is an `hx-popover` that the status bar button opens, not the popover of `hx-status-item`, which opens past the window edge for an item at the start. The app sets `aria-haspopup` and `aria-expanded` on that button.
- Each row names the status of its endpoint in text (`.hx-list-row-meta`, `stateLabel`); the dot adds to it.

### Headings and type

- The heading of a view (`h1`) is `--h-font-size-lg`, weight 600; the heading of a section, form or panel in it (`h2`) is `--h-font-size-md`. In Settings, the category heading is the size of the view heading.
- `pnpm lint` (and so CI) runs the Helix lint preset: `helix/no-raw-control` in templates, and Stylelint on `src/**/*.css` and inline `styles`: no hex or `rgb()`/`hsl()` color, `font-size` from the type scale, no rule set for a native control or a `.btn*` class. An exception is an entry of `scripts/lint/helix-allow.json` with one file, one rule and a reason; `helixAllow` throws without a reason. `src/testing/lint-probe/` holds deliberate violations and its spec fails when a rule stops reporting.

## Dialogs

Every question goes through the one `<hx-confirm-dialog />` of `app.html`. An `hx-dialog` sets `size` by this table, and each one is listed in it.

| Dialog type                   | `size` | In Gantry                                                                                                        |
| ----------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------- |
| Confirmation or short message | `sm`   | Remove, prune and take down: `HxConfirmationService`, which sizes its own dialog                                 |
| Form of a few fields          | `md`   | _Clean up unused data_ (system view; its preview is text). _Create a volume_ and _Create a network_ are popovers |
| Wide form, table or preview   | `lg`   | None yet                                                                                                         |

## UX rules

- A destructive action (remove, prune, down) asks and names what it removes. A prune lists the items it matches, or says that none matches right now.
- An accepted question acts only if the view and the endpoint (for _Down…_ also the open stack) are still those that asked.

## Deviations

| Base rule                                                                                          | This project                                                                                                                                                        | Reason                                                                                                 |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| STYLEGUIDE.md, Typography and spacing: a denser app sets the density option                        | The root font size is 13px (`src/styles.scss`) and `GRID_THEME` sets its own font sizes, row heights and spacing                                                    | A compact density that matches the desktop chrome of helix-desktop                                     |
| STYLEGUIDE.md, Tokens: colors are `var(--h-…)` tokens                                              | Log and terminal surfaces are dark with literal colors, in light and dark; ANSI output has a color class per palette entry                                          | Dark independent of the theme; allowlisted in `scripts/lint/helix-allow.json` (#159)                   |
| STYLEGUIDE.md, Typography and spacing: every `font-size` is a `--h-font-size-*` step               | The xterm terminal sets its font family and a numeric size in TypeScript                                                                                            | Open: why not read from the tokens?                                                                    |
| color.md, Status: a status is never color alone                                                    | A `stderr` log line is marked by a colored edge and tint only                                                                                                       | Open: why no text or icon?                                                                             |
| STYLEGUIDE.md, Components: toolbar actions sit in `hx-toolbar`                                     | The bars of the resource views are elements of the app                                                                                                              | Open: why not `hx-toolbar`?                                                                            |
| components.md, Button hierarchy: a view has at most one filled primary; a toolbar action is `text` | Every enabled Containers action is filled (_Kill_ and _Remove_ `danger`); in the other resource views, _Remove…_, _Prune…_ and _Refresh_ are `outlined` `secondary` | Open: why these looks?                                                                                 |
| ux-rules.md, Which element for what: a passing result is a toast                                   | The result of an action is an `hx-message` with _Dismiss_ in the view                                                                                               | Open: why inline?                                                                                      |
| dialogs.md, Confirmations: a question is asked with `HxConfirmationService`                        | Removing an endpoint asks in an inline `hx-message`                                                                                                                 | Open: why inline?                                                                                      |
| ux-rules.md, Confirm or undo: an action that cannot be undone asks first                           | Closing a terminal tab ends its process without a question                                                                                                          | Open: should it ask?                                                                                   |
| dialogs.md, Confirmations: a dialog whose main action is destructive is a confirmation             | _Clean up unused data_ is an `hx-dialog` whose last step is _Remove_ (`danger`)                                                                                     | The categories, the preview and the confirm step are one flow (#157)                                   |
| dialogs.md, Enter: the primary button is the submit button                                         | In _Clean up unused data_, Enter asks for the preview; _Remove_ is `type="button"`                                                                                  | Enter on a category must not remove data                                                               |
| forms.md, Field anatomy: each checkbox sits in its own `hx-field`                                  | The option of a remove or _Take down…_ confirmation is an `hx-checkbox` in a `<label>` that wraps it                                                                | One option of a question, not a form field with hint or error; the label names it (rubric audit, #160) |

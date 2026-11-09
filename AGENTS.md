# aside-pane (pi extension)

Published to npm as `aside-pane`. Loaded locally through the symlink `~/.pi/agent/extensions/aside` ->
`~/gitcm/aside`; `package.json` points pi at `index.ts`.

## Rules

- Greenfield: keep no legacy code, shims, dead code, or stale names.  Reshape
  for clarity with every change.
- The selection step MUST stay intuitive and low friction.
- aside has no knowledge of or dependency on any other extension: never name, detect, or special-case
  one. Fixes for how other extensions behave in an aside must work for every extension (e.g. by
  following pi's own session lifecycle).
- Be defensive against other extensions: nothing an extension does in an aside session (throwing,
  hanging, outliving the session) may crash or hang pi, as far as aside can prevent it.
- Deviate from pi's normal behaviour as little as possible: reuse pi's keys, keybinding actions,
  state (e.g. tool-output expansion), rendering, and wording instead of inventing aside-specific
  ones. Any deviation needs a stated reason in `SPEC.md`.
- `SPEC.md` is the source of truth for behaviour. Read it before changing behaviour and update it
  in the same change. It describes the current state only, never history.
- `README.md` is for users: plain language, limitations as what the user notices and what to do.
  No implementation details. Update it with any user-visible change.

## Check

- `npm run check` type checks against the installed pi (no `npm install` needed).
- UI tests: tmux (`pi --session-dir /tmp/s --fork <session.jsonl>`, `send-keys`, `capture-pane -p`,
  `resize-window`), or without tmux python `pty.fork` + `pyte.Screen` (venv `/tmp/aside-venv`).
- Run TS outside pi with `<release>/node_modules/.bin/jiti` (node's strip-types rejects parameter
  properties) from a dir whose `node_modules` links to the release's, with a copy of `src/` in it:
  imports resolve from each file's own folder.

## Review

Before finishing any change, review the whole repo, not just the diff, for the three points below.
Fix what you find in the same change. Report only real issues, each verified (grep, read, or run),
as file:line, problem, fix. When you can, run them as parallel read-only `pi -p` agents, one per
point, each told to read this file first and to edit nothing.

- **Private data**: no keys, tokens, passwords, internal hostnames, personal paths (`/Users/...`),
  session files, or real conversation content in tracked files or in history (`git log -p --all`).
- **Clean code**: no dead code, unused exports, imports, types, or config entries; no shims, stale
  names, history comments ("previously", "no longer", "legacy", TODO); no comment that no longer
  matches its code. No other extension named or special-cased. `SPEC.md`, `README.md`, and this
  file (Layout, pi internals) match the code. Code ported from pi matches the installed release,
  and the version it names is current.
- **Performance**: no work per render, keystroke, or streamed token that grows with the
  conversation or the answer (re-render, re-parse, re-serialize, copy); cache by identity and
  version, and render only what changed or shows. No timers, listeners, or subscriptions that
  outlive their aside; no unbounded arrays or maps. Rank findings by real impact.

## pi internals this relies on

- The question box gets pi's editor autocomplete through a pass-through
  `ctx.ui.addAutocompleteProvider` wrapper registered on `session_start` (pi clears wrappers on a
  session switch). It only sees wrappers registered before aside's.
- Overlays: pi re-reads the `overlayOptions()` object's fields each render, so getters resize live.
  Overlays never shrink content under them; to reflow, in `fullscreen` mode swap the layout root
  (`setLayoutRoot()` after `isViewportTUI(tui)`) with pi-tui `HStack`/`VStack` (see
  `src/ui/reflow.ts`). Stack entries are copied on add, so size spacers by what `render()`
  returns. An `HStack` renders every entry to measure its height, so pi's root goes in wrapped as
  empty-rendering with its layout node (`Symbol.for("@earendil-works/pi-tui/layout-node")`, not
  exported). `regular` mode has no layout tree. pi refuses TUI mode switches while overlays are open.
- In-memory session (`src/agent/session.ts`): `bindExtensions({})` before choosing a model from
  `modelRuntime.getAvailable()`; custom instructions via `appendSystemPromptOverride` (the
  `systemPrompt` option drops pi's tool list and rules; `appendSystemPrompt` replaces the user's
  APPEND_SYSTEM.md).
- `session.dispose()` emits no `session_shutdown`; `closeSession` runs each extension's shutdown
  handlers concurrently under a time limit, then disposes, so no extension's timers outlive it.

## Layout

- `index.ts`: entry point (command, shortcuts, events)
- `src/config.ts`: limits, sizes, keys; `src/types.ts`: shared types
- `src/stack.ts`: the stack of asides, its overlay, and stack-wide model settings
- `src/level.ts`: one aside's state (selection, thread, session, usage)
- `src/commands.ts`: slash commands in the question box, and its autocomplete (pi's, with them)
- `src/agent/`: answering through an in-memory pi session
  - `session.ts`: creating and closing the session, applying the model
  - `ask.ts`: asking a question
  - `handoff.ts`: handing a thread to the level below, summarized or whole
  - `env.ts`: what those need from the stack, and messages to the main conversation
  - `changes.ts`: tool-call lines and what calls changed
  - `command-check.ts`: which shell commands of an answer made changes the user asked for
  - `prompts.ts`: system prompts
- `src/context/`: what is sent to the model
  - `parts.ts`: turns and exchanges as selectable parts
  - `blocks.ts`: focus and background blocks
  - `text.ts`: text helpers
- `src/ui/`: rendering and input
  - `layout.ts`: side or stacked layout, live overlay options
  - `stack-view.ts`: the overlay component; lays out panes and collapsed levels, routes the mouse
  - `pane.ts`: one aside pane
  - `question-box.ts`: the question box, pi's CustomEditor without borders
  - `reflow.ts`: moves the main conversation out from under aside 1 (fullscreen mode)
  - `anchor.ts`: keeps the top line in place when text re-wraps
  - `tool-call.ts`: one tool call, drawn by pi's tool component with the tool's renderers

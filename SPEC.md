# aside — specification

The build prompt and source of truth for what `aside` does and why. An agent should be able to
build the same extension from it in one pass.

**Maintaining it:** describe current behaviour only, edited in place as a snapshot. No history
("previously", "now", "no longer", changelogs); that belongs in git. No code, pseudocode, file
layouts, or function names; name pi APIs only in [Platform notes](#platform-notes). Numbers are
defaults: keep the behaviour, tune if needed. If README.md or AGENTS.md disagree with this file,
this file wins. Update it in the same change as any user-visible behaviour.

---

## Purpose

`aside` is a [pi](https://pi.dev) extension for asking side questions about parts of the current
conversation in a pane next to it, without adding anything to the conversation. In a long session
the user often wants something small ("what did you mean by X?", "summarize those turns", "fix that
typo while the agent carries on"). Asking in the main conversation clutters history, uses context,
and can pull the agent off track. The main conversation gets only a summary or the whole discussion
when the user chooses, and a list of anything the aside changed.

## Principles

1. **Picking what to ask about takes no effort.** Hotkey, type, Enter. The latest part is selected.
2. **No switching between selecting and typing.** Focus stays in the question box; `shift+↑↓`
   change the selection while typing.
3. **The user sees what they picked** and when the next question uses a different selection.
4. **The model knows what the user means:** selected parts in full, the rest as short background.
5. **The main conversation is never changed behind its back:** only what the user sends down, plus a list
   of changes so the main agent never works from a stale picture.
6. **Asides are ephemeral:** in memory while open, discarded on close, never written to disk.
7. **Hard to misuse:** no stray key or click destroys work the user did not mean to discard.

## Hard requirements

- Works inside tmux (the user's setup) and in a plain terminal; check every feature, key, and
  rendering path in both.
- The selection step stays intuitive and low friction; added steps or modes need a very good reason.
- Deviates from pi's normal behaviour as little as possible: pi's keys, keybinding actions, state,
  rendering, and wording are reused; any deviation is stated here with its reason.
- Runs only in pi's interactive terminal UI; elsewhere it says so and does nothing.

## Concepts

- **Turn**: one user prompt in the main conversation and everything up to the next prompt (agent
  text, tool calls and results, user shell commands, extension messages). Listed by the first
  non-empty line of the prompt.
- **Aside**: a pane with a **thread** of questions, answers, and what nested asides sent down.
- **Exchange**: one question and its answer; what a nested aside sent down (a summary or its whole
  thread) is also an exchange, marked as one.
- **Part**: what an aside asks about: turns for aside 1, exchanges of aside N−1 for aside N.
- **Stack**: aside N asks about aside N−1. Only the top aside takes input.
- **Selection**: one part or a contiguous range.

## Opening

- `ctrl+shift+a` (or `alt+a`) opens aside 1, or refocuses the top aside if one is open.
- `/aside` opens it, or refocuses the top aside if one is open. It takes no question; with any
  arguments it only shows a notice that its verbs work inside an aside.
- With no turns yet, it says there is nothing to ask about and does not open.

## The pane

Top to bottom:

1. **Title**: "Aside 2 · about aside 1", with the selection on the right ("turn 3", "turns 2–5",
   "all 7 turns", "exchange 1").
2. **Part list**: numbered, newest last, at most 5 rows (fewer in short panes). Selected parts
   highlighted, cursor emphasized, scrolls to the cursor with more-above/below markers. What
   nested asides sent down is marked, summaries, whole threads, and changes-only entries differently.
3. **Thread area**: before the first question, a **preview** of the selected parts (prompt and reply
   shortened, tool-call count). After it, the **thread** as Markdown. Prompts in the preview and
   questions in the thread are styled as the main pane styles a user prompt, followed by the part
   number or what the question asked about. The model's thinking streams in place, between the
   text and tool calls, styled as the main pane styles it (the theme's thinking colour,
   italic), or as one "Thinking..." line while thinking is hidden. Text is drawn with pi's Markdown
   component, one per section kept across frames as in pi's main pane, so what changes a component
   (an extension that patches or redraws pi's Markdown, e.g. a copy button's "Copied" note) shows
   at the next frame. Extensions' Markdown transformers apply as in the main pane: to questions as
   user messages, and to the answer and thinking as assistant messages, told whether the answer
   still streams (and run again when it ends); not to labels, notices, previews, or what nested
   asides sent down. They are read from the first aside session that starts (every aside session
   loads the same extensions); text drawn before that is drawn again with them. Deviation: pi's
   built-in Mermaid transformer is not exported, so Mermaid blocks stay code. The thread follows streaming output
   unless scrolled away, with a notice line at the end for status messages. It renders at most 5
   exchanges at a time (latest by default) so streaming stays fast; scrolling past either edge
   slides the next exchange in while keeping the text in place, so the thread scrolls like one
   document. When the pane's width changes (another aside opens or closes, the window resizes),
   the line at the top stays at the top unless the thread follows the end. The header shows counts outside the window ("↑ 2 earlier · ↓ 1 newer") and, when the
   selection differs from the last question's, warns "next question → turns 2–4".
4. **Question box** (below).
5. **Key hints** for aside-specific keys only (selection, nested aside, sending down,
   expand or collapse once the thread has something a nested aside sent down, `esc` to stop while
   streaming, pi's exit key to close), at most two lines. The nested-aside hint
   disappears at the depth limit, and the `esc` hint hides while the autocomplete list is open.
6. **Bottom border**: model, thinking level, and this aside's usage (its answers, checks, and the
   summaries of nested asides closed on it) in pi's footer notation, cost
   first so a narrow border keeps it. Aside usage is not in pi's totals.

When space runs out, shrink the list and thread, then drop hint lines; always keep the question box
and bottom border.

### Keys

- `shift+↑` / `shift+↓`: select the previous or next single part.
- The latest part is selected on open; new parts move the selection only if it was on the latest.
- `enter`: ask (or run the slash command). `esc`: stop a streaming answer, command check, or summary
  of a nested aside, and nothing
  else, as in pi: it never closes an aside, so pressing it repeatedly to stop an answer is safe.
  pi's exit key (`ctrl+d` unless rebound) with an empty question box closes the top aside at once,
  mirroring pi's exit-when-empty; with text it deletes forward as in pi. Anything streaming (answer,
  command check, summary of a nested aside) is stopped and its result dropped without waiting:
  closing says the user no longer wants it.
  `ctrl+shift+a` / `alt+a`: open a nested aside. `ctrl+s`: summarize down and
  close. `ctrl+shift+s`: send the whole thread down and close. pi's expand key (`ctrl+o` unless
  rebound): expand or collapse tool calls and what nested asides sent down. pi's thinking toggle (`ctrl+t` unless
  rebound): show or hide thinking in every open aside. `pageUp` / `pageDown`: scroll the thread
  (they page the autocomplete list while it is open, as in pi). Other keys go to the question box.
- **Thinking visibility** starts as pi's thinking-block setting (global, plus project when the
  project is trusted) when the stack opens. The toggle in an aside shows pi's notice wording
  ("Thinking blocks: hidden") and lasts until the stack closes; it is not saved. Deviation from
  pi, which saves it: extensions cannot change the main pane's thinking state, so saving would
  make pi's setting disagree with what the main pane shows. Clicking a thinking block does not
  toggle just that block (deviation: clicks in the thread are a non-goal). The hidden label is
  pi's default; one set by an extension is not readable.
- The open aside keeps focus. Moving between asides is only by stacking and closing.

## Asking

- **Context.** Focus parts go in full (tool calls and results shortened when very long; whole block
  about 200,000 chars). Other parts go in short form (prompt, reply, omitted tool-call count),
  nearest first within about 60,000 chars, with gaps marked.
- **Session.** Each aside answers through its own in-memory pi agent session, started in the
  background when the aside opens so the first answer does not wait, and discarded on close the
  way pi ends a session on quit: its extensions get `session_shutdown` before it is disposed.
  Unlike pi, each extension gets it on its own, all at once (each one's handlers still in order),
  and the aside waits at most 3 seconds before disposing. Reason: an aside must not crash or hang
  pi because of an extension, so one extension's failing or stuck handler must not keep the others
  from cleaning up (a timer left using a disposed session's ctx kills pi). It
  loads the user's extensions (except aside), skills, and context files, so it can do whatever the
  main agent can, MCP included. Its system prompt is pi's own plus the aside's instructions.
- **Follow-ups** continue the session: full context with the first question, then only the
  question, plus the new focus and a note when the selection changed.
- **Instructions** tell the model what an aside is, that answers are not added to the main
  conversation, which parts are focus and background, to answer concisely in Markdown, quote
  specifics when useful, and say so rather than guess. Also that its changes are real, the main
  agent may be working at the same time, to make only requested changes, that changes are listed
  for the main agent, and to ask before a call that could change or delete data outside the
  working directory unless the user asked for exactly that.
- **Tools**: the main agent's active tools plus read, grep, find, ls, bash, edit, write. Each call
  shows in the thread as pi's main pane shows it: pi's tool component with the tool's own
  renderers (an extension's, or pi's built-in ones), from its first streamed arguments on, with
  live progress from the tool's partial results, its result, and pi's tool-output expansion
  (`ctrl+o` unless rebound) collapsing or expanding every call at once. Calls made by code that
  calls tools (codemode) show inside their parent's row, as in pi. A message that fails or is
  stopped marks the calls it was streaming as failed, with pi's wording. Output padding and image
  width come from pi's settings. Deviations: images in tool results are not drawn, because an
  overlay splices rendered lines, which breaks terminal image sequences; clicks in a tool's row do
  nothing (clicks in the thread are a non-goal); if pi's tool component throws, the call falls
  back to one line (tool name and its salient argument), so another extension cannot break the
  pane. What the thread hands on (nested asides, handoffs, the command check) keeps one line per
  call.
- **Extensions' hooks** (permission checks, guards, logging) apply to aside tool calls, as separate
  instances with no UI. The README says dialogs don't appear in an aside.
- **Changes go down with the aside.** Possible changes from every answer are collected per aside,
  duplicates removed, and go one level down when the aside closes, as part of the one message or
  entry it sends: appended after what is sent down (`ctrl+s`, `ctrl+shift+s`), or on their own when
  it is closed with pi's exit key ("Changes from aside N"; in the main conversation a message whose first
  line says an aside made changes). The level below also takes them over, so its own handoff lists
  them again (a summary may drop them; the main conversation always gets the exact list), and a
  whole thread sent down does not repeat a nested aside's list inside it. The list has two sections:
  - **Files and commands**: files edited or written (not failed edits), and shell commands judged
    by intent: when an answer that ran commands ends (stopped ones too), one model call with the
    aside's model, without thinking, gets the level's questions, the answer, and each command with its
    status and output, and lists a command only when the user asked for a change and the command
    modified, created, moved, or deleted files or was destructive. Lookups, and changes the user did
    not ask for, are left out. The pane shows "Checking what the commands changed…" meanwhile;
    nothing else starts on that aside until it ends, so a handoff always has the verdict. Stopped
    with `esc` or failed, every command of that answer is listed as not checked. Closed with pi's
    exit key before the answer or check ends, the check never runs: every command is listed as not
    checked, and calls still running are listed as if they succeeded. Tells the agent to
    re-read those files.
  - **MCP calls and code that may have changed outside data**: successful calls to tools pi puts
    in an MCP namespace (`mcp__<server>`), and to tools pi marks as reaching other tools (such as
    codemode). Judged only from what pi reports about a tool, so it works the same for tools of
    any extension. Not listed: failed calls and known read-only calls: tools declared read-only,
    and tools whose name has a lookup word (get, list, search, query, …) and no action word
    (create, update, delete, run, …). Code (a codemode script, or code sent to a server's execute
    tool) is judged by the tools it calls. Telling the agent to check before relying on that data.
  In the main conversation it does not start a turn and is queued if the agent is busy; a
  changes-only message shows no notice. In aside N−1 it goes with the next question, with a notice.
  Nothing is sent when pi shuts down or switches sessions.
- **Alongside the main agent.** The first change in an answer while the main agent is busy adds a
  thread line warning it may be changing the same files. Edits to the same file never interleave.
- Answers stream; `esc` stops one. Errors and stops show on that exchange.
- **Thinking stays in the aside.** It is shown but never part of what a nested aside asks about,
  a summary, or a whole thread sent down, the same way turns of the main conversation are read
  without thinking.
- **Model.** Each aside has its own model and thinking level. Aside 1 copies the main
  conversation's current ones when it opens (never pi's default); a nested aside copies the aside
  below it when it opens. After that nothing follows anything: changes in the main conversation or
  in another aside never reach it, and only `/model` and `/thinking` in that aside change it.
  Thinking is clamped to the model. The model is applied to the session before every question; a
  model the session cannot use is an error for that exchange.
- The turn list updates when the main agent finishes a turn.

## Sending down

- `ctrl+s` closes the aside at once and summarizes its thread in the background with its model and
  thinking level; the summary goes one level down when it is ready. Deviation from waiting for it:
  the keys exist to close, so closing never waits for a model call. Meanwhile:
  - **Aside 1**: pi's footer shows "aside: summarizing for the main conversation…", also after the
    last aside closed. A prompt sent before the summary arrives goes without it, and the summary
    is queued for the next turn.
  - **Aside N**: aside N−1 shows "Summarizing aside N…", its usage counts the summary, and it takes
    no question and sends nothing down until the summary arrives, so its next question and its own
    handoff always include it. `esc` there stops the summary.
  - A summary that fails or is stopped sends the whole thread instead, with a warning naming why.
  - Nothing arrives when the level below closes first or pi quits or switches sessions. The changes
    still do: the level below takes them over as the aside closes.
- `ctrl+shift+s` delivers the whole thread as it is (every answered question and answer, and what
  nested asides sent down) without a model call, then closes the aside.
- Neither key keeps an aside open: if delivery fails, it closes anyway with an error notice. Losing
  an aside's thread is acceptable; keeping it open would defeat the keys.
- A few short bullets, about 150 words: conclusions, facts, decisions, corrections that matter
  below, without back-and-forth or restating what is known.
- **From aside 1**: a visible message in the main conversation, labelled with the turns it covers
  and whether it is a summary or the whole discussion, followed by the list of changes, if any.
  It does not start a turn; it is queued if the agent is busy.
- **From aside N**: an entry in aside N−1's thread, marked as a summary or a thread, followed by
  the list of changes, if any, sent with its next question as a note from the user, with a notice
  that it arrived.
- **One message per closed aside.** Whatever an aside sends down, its changes included, arrives as
  one message (main conversation) or one entry (aside N−1), never two.
- **Collapsed like pi's own summaries.** What was sent down (changes-only messages too) shows as
  one line (its label and a hint naming the expand key; in the main conversation every kind is
  labelled `[aside]`, and its first line says which) until pi's tool-output expansion is on,
  then in full: in the main conversation as pi shows any extension message, in an aside as the
  thread entry. There is one
  expansion state, pi's: the expand key in an aside toggles it for the main conversation too, the
  same as pressing it there. Only the display collapses; the model always gets the full text.
- Needs at least one answered question, and nothing streaming or still coming from a nested aside.
  Outcomes show as pi notices.

## Stacking

- Up to 5 deep. Needs at least one question in the current aside; otherwise the key does nothing.
  Trying to open a 6th shows a notice about the limit.
- A nested aside lists the previous aside's exchanges, excluding what it sent down itself. Its model
  gets the selected exchanges as focus, the rest of that thread as background, and the main
  conversation in short form (about 40,000 chars), not the levels in between.
- pi's exit key closes only the top aside; the one below becomes top with its draft intact.

## Layout

Follows the window shape and updates live on resize.

- **Tall** when columns < about 2 × rows (cells are about twice as tall as wide), otherwise **wide**.
- **One aside**: wide, the right half (at least 48 columns); tall, the top half so pi's editor and
  latest output stay visible.
- **The main conversation moves aside** in pi's fullscreen mode: while asides are open it re-wraps
  into the space aside 1 leaves (left half when wide, bottom half when tall), editor and footer
  included, so nothing is hidden under the pane. It keeps that space while more asides are stacked
  (they cover the whole screen anyway), and gets the full window back when the last aside closes.
  Each re-wrap keeps the conversation's first visible line on top, unless it follows the end.
  Deviation from pi, whose scroll view keeps a row number, so the re-wrapped lines above move
  other text into view: hooks on the conversation's scroll view do this while asides are open and
  through the re-wrap when the last one closes, then come off.
  Deviation from pi, which draws overlays over its content: an aside is read beside the
  conversation it is about, so hiding half of it defeats the purpose. In pi's regular mode the
  aside draws over the conversation: that mode prints to the terminal's scrollback and cannot
  re-wrap without clearing it.
- **Two or more**: full screen; the previous and top aside split it evenly (side by side when wide,
  stacked when tall). Lower levels, main included, collapse to slivers on the left labelled `M`,
  `1`, `2`… (wide) or one-row strips on top (tall), deeper ones slightly brighter.
- The previous aside is drawn inactive (muted, no cursor), shows its draft on one row, and hints
  that the aside above is asking about it.

## Question box

- It is pi's own editor with the autocomplete of pi's editor, so it behaves exactly as pi's
  editor except for the aside's keys above, which the pane takes first. It is built with the editor
  factory pi's main editor is built with, read when the box is created, so editor extensions (modal
  editing, persistent history, …) apply to it as to pi's editor; it is wired as pi wires a custom
  editor: submit and change, border colour, padding, autocomplete, and, for editors built on pi's
  editor, esc, pi's exit key, and the expand and thinking actions, where an extension's own esc and
  exit handlers win, as in pi. An editor extension can therefore take esc or the exit key first
  (e.g. esc leaving an insert mode) before the aside acts on it. If the factory or the editor it
  built throws, the box falls back to pi's own editor, keeping the text. pi's editor handles esc,
  pi's exit key, the expand and thinking toggles, and enter, and the aside acts on them as listed
  under Keys. pi's other app keys (model cycling, image paste, extension shortcuts) do nothing in an
  aside. Enter does nothing while an answer, check, or nested aside's summary is streaming; text that is not asked
  (a command kept with a notice) goes back into the box.
- Completion is pi's: `tab` completes paths (a list when several match), `@` searches files, and
  other extensions' completions work, all from pi's editor provider. The list shows under the text
  in at most half of the rows left, with pi's `autocompleteMaxVisible` rows. Slash commands
  complete from the aside's commands (below).
- Deviations from pi's editor, for the pane layout: border rows show only when they hold more than
  the line (pi's scroll markers, an extension's label such as a mode name), uncoloured, and
  `editorPaddingX` is ignored (the pane has its own borders and prompt column), it grows to 8 rows,
  and history is shared between asides.
- `↑` / `↓` work as in pi's editor: move between lines; on the first line (empty box, cursor at
  start, or a recalled question) browse history. They never change the selection.
- History: questions from any aside, up to 100, shared and kept in memory while pi runs, never on
  disk, after what editor extensions put in the editor's history when they build it.
- Pastes keep line breaks; long lines wrap. Grows to 8 rows, then scrolls with the cursor visible
  and markers for hidden rows. Empty box shows a placeholder naming what it asks about.
- The draft survives stacking. The thread shows multi-line questions with their breaks.

## Slash commands

`/` at the start opens pi's autocomplete list with the aside's commands, and arguments complete as
in pi (`/model` and `/thinking` for this aside's model, `/aside` its verbs). Thinking levels and
`/aside` verbs match by prefix (deviation: pi matches fuzzily, which for a few short words lists
unrelated ones, e.g. `close` for `/aside s`); command names and models match fuzzily, as in pi. Keys are pi's: `tab`
completes, `enter` on a command name completes and runs it, `enter` on an argument only fills it
in, `esc` closes the list. pi commands that cannot run in an aside say so in their description.

- **Skills and prompt templates** expand into the question as pi's editor expands them. The thread
  shows what was typed; the model gets the expansion. Nothing reaches the main conversation.
- **`/model [name]`**: model for this aside only; a partial name works if it matches one.
- **`/thinking [level]`**: thinking level for this aside only, only levels the model supports.
- **`/aside`**: opens a nested aside. **`/aside summary`**, **`/aside send`**, **`/aside close`**: the
  same as `ctrl+s`, `ctrl+shift+s`, and pi's exit key on an empty box. Any other argument stays in
  the box with a notice listing the verbs. Typing `/aside ` lists the verbs.
- **pi commands** (built-ins and extension commands) cannot run in an aside: the command goes into
  pi's editor if it is empty, with a notice to close the asides and press Enter; otherwise it stays
  in the box with an explanation. `/reload` only shows a notice to run it from pi's editor.
- Other text starting with `/` is asked as a normal question.
- `/model` and `/thinking` choices go with the aside: asides opened on top of it start with them,
  and they are gone when it closes.

## Mouse

Only where pi enables it (fullscreen mode, the default).

- Click a part in the top aside to select it; shift+click extends the range.
- The wheel scrolls the thread under the pointer, including the previous aside.
- Collapsed levels consume clicks and do nothing; a stray click never closes asides.

## Shipped documentation

- `README.md` for users, in plain language: purpose, quick start, features, key and command
  tables, limitations as what the user notices and what to do, terminal setup (`alt+a` needs
  Option-as-Meta on macOS; tmux needs `extended-keys on` and `extended-keys-format csi-u` for `ctrl+shift+…` keys; `/aside`
  and `ctrl+j` always work), install and uninstall (symlink, `pi install <path>`, or `--extension`,
  one at a time). No implementation details.
- `AGENTS.md` for contributors: rules, how to check, and the source layout.
- This file.

## How to verify

- Type check against the installed pi.
- Run pi for real on a disposable session with turns, in tmux and in a plain terminal, with real
  keystrokes and resizes. Cover: opening, selecting, asking (real model call), stopping,
  summarizing and sending the whole thread at both levels, stacking and closing, both layouts at
  depth 1 and 2 with live resize,
  a very short pane, every new-line key, each kind of slash command, clicks on collapsed levels,
  an aside that edits a file and runs a command (main agent idle and busy), and an MCP call from
  an aside, nested included.
- `shift+enter`, `shift+↑`, `ctrl+j`, and `alt+…` are encoded differently inside and outside tmux.

## Non-goals

- Persisting asides across closes or restarts.
- Writing to the main conversation beyond what the user sends down and change lists.
- Running pi's own commands inside an aside.
- Click or drag interactions beyond selection and scrolling.

---

## Platform notes

Facts about pi, checked against **pi 1.3.0**; built-in command names, template argument
substitution, tool info, tool events, and the tool component against **pi 1.5.0**. Hints, not requirements; re-check on upgrade.

- Overlays: pi keeps an overlay's options object and re-reads its fields every render, so computed
  fields let one overlay change size and position live. Not a documented contract; the documented
  fallback is a per-render visibility option.
- Fullscreen mode lays the screen out as a component tree with horizontal and vertical stacks;
  the root can be replaced through the typed viewport TUI API, but the current root is read from a
  field outside the typed API. Stack entries are copied when added, so live sizes come from a
  child's measured size (lines and their width), not from computed entry fields. pi refuses to
  switch TUI mode while an overlay is open. Regular mode has no layout tree.
- pi-tui's multi-line editor draws borders above and below its text, decides the new-line keys,
  collapses large pastes (expanded text is retrievable), and uses up-arrow history on line one.
- Extensions can list extension, skill, and template commands with their source files. Built-in
  command names and template argument substitution are not exported and must be reproduced.
- Extensions can read and set pi's editor text but cannot run built-in commands.
- pi exports the main pane's user-prompt component: Markdown on the theme's user-message background,
  wrapped in OSC 133 prompt marks, and takes Markdown transformers. The output-padding setting the
  main pane passes it is not available to extensions; the default applies.
- A session's extension runner lists extensions' Markdown transformers. pi applies them in order
  through a Markdown option, skipping one that throws or returns no string; its own Mermaid
  transformer is internal. pi's Markdown component returns the same lines array while its text and
  width are unchanged and nothing invalidated it.
- Extensions can send a visible custom message without starting a turn, or queue it for the next.
- A message renderer for a custom message type gets pi's tool-output expansion state and is re-run
  when it changes; returning nothing falls back to pi's default custom-message rendering.
  Extensions can read and set that state, and the overlay factory gets pi's keybindings, so a pane
  can match the expand action (`app.tools.expand`) as rebound. Per-message expansion is not
  available to extension messages.
- Extensions can stream any registered model, list available models, and get supported thinking
  levels.
- The main pane's thinking visibility is not in the extension API; pi saves it to its settings
  (`hideThinkingBlock`) on every toggle, and a settings manager created for the cwd and agent dir
  reads it. The hidden-thinking label extensions can set is write-only. The main pane draws
  thinking as Markdown in the theme's `thinkingText` colour, italic, and hidden thinking as that
  label in the same style. Session events stream thinking deltas alongside text deltas.
- An extension cannot call other extensions' tools (MCP included) from a command, shortcut, or
  overlay. It can create an in-process SDK agent session instead:
  - The default resource loader takes an extension filter (each has a resolved path) and a function
    editing the text appended to pi's system prompt (after the base prompt, before context files
    and skills). Passing appended text or a replacement prompt directly drops the user's prompt
    files or pi's tool list.
  - An in-memory session manager keeps it off disk; a tool allowlist picks tools by name.
  - Binding extensions with no UI starts them; only then can the model be set, matched by provider
    and id among the session's available models. Create and bind take a fraction of a second.
  - Prompting with template expansion off sends text as is, without running extension commands.
  - Session events stream text deltas, streamed tool-call arguments (in the message), tool start,
    partial results and end (args, result, error, duration), the parent call of nested calls, turn
    starts, and finished messages with stop reasons. Aborting stops a running tool.
  - pi exports its main pane's tool component. A session resolves a tool's renderers through its
    extensions' renderer lookups over the tool's definition; built-in definitions include pi's
    renderers. Renderers can redraw themselves (a callback that invalidates and requests a render),
    so the component's lines can change between session events.
- A session's tool info names a tool's namespace (`mcp__<server>` for pi's MCP tools), its declared
  annotations (e.g. read-only), and, for tools that reach other tools (codemode, tool search), a
  `reachesTools` function. Tools proxied by an extension without these look like plain tools.
- Built-in edit and write tools serialize writes to the same file process-wide.
- The session branch is readable as entries (messages, custom messages, branch summaries) and still
  holds raw entries after compaction.
- The open hotkeys are global shortcuts (open or refocus); the focused aside handles the same keys
  itself to stack.

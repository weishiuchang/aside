# aside-pane

Hold a side conversation about part of your [pi](https://pi.dev) conversation, in a pane next to
it, without adding it to the conversation.

Good for small things in a long session: "what did you mean by that?", "summarize those three
turns", "is that file really like that?", "fix that typo while the agent carries on". You decide
whether anything comes back.

## Not a `/btw`

A `/btw` is built for one quick question: ask, read the answer, move on. aside-pane is built for a
side conversation you stay in for a while:

- **Threaded.** Keep following up; the aside remembers the whole discussion.
- **About a specific part.** Point it at one turn or a range of turns, and change that as you go.
- **Stackable.** Open an aside about an aside, each in its own pane, sharing the screen with the
  main conversation instead of covering it.
- **You decide what comes back.** Throw the discussion away, or send a summary or the whole
  thing to the conversation it came from.

A one-off question works too: ask it, then close the aside with `ctrl+d`.

## Quick start

1. Press `ctrl+shift+a` (or `alt+a`, or type `/aside`). A pane opens with your latest turn
   selected. A *turn* is one prompt you sent plus everything the agent did in response.
2. Type a question and press `enter`. The answer streams into the pane.
3. Press `ctrl+s` to send a short summary to the main conversation and close the aside,
   `ctrl+shift+s` to send the whole discussion as it is, or `ctrl+d` (question box empty) to close
   it and throw it away.

## What it can do

- **Pick what to ask about** with `shift+↑`/`shift+↓` while you type.
  The pane previews your pick and warns when the next question is about something different.
- **Follow up** in the same aside; it remembers the discussion.
- **Type the way you do in pi.** The question box uses your editor extensions too (for example
  Vim-style editing with its mode label, or saved prompt history on `↑`). Such an extension can
  use `esc` or `ctrl+d` first: with Vim-style editing, `esc` in insert mode goes to normal mode,
  and only the next `esc` stops an answer.
- **Do things.** An aside has the same tools as the main agent (files, commands, MCP servers,
  other extensions' tools). Each action shows as it does in the main conversation, live progress
  included (for example a subagent's status while it runs); `ctrl+o` expands or collapses them.
- **Keep the main agent informed.** When an aside edits files, runs commands that change files
  because you asked for a change, or makes MCP calls that may have changed something, a list of
  them goes down when you close it: at the end of the
  summary or discussion you send, or on its own if you close with `ctrl+d`. Either way it arrives as
  one collapsed line, in the main conversation or in the aside below (which passes it on when it
  closes). Failed MCP calls, calls waiting on sign-in or approval, and lookups are left out. After
  an answer that ran commands, the aside briefly shows "Checking what the commands changed…" while
  its model decides which ones to list; press `esc` to skip that and list them all (closing the
  aside with `ctrl+d` lists them all too). The
  agent reads the list with your next prompt; it doesn't start working on its own.
- **Ask about an aside.** `ctrl+shift+a` inside an aside opens another on top that asks about the
  first one's answers (up to 5 deep). `ctrl+s` or `ctrl+shift+s` there sends to the aside below.
- **Stay out of the way.** A summary or discussion you send down shows as one line, like pi's
  branch summaries. Press `ctrl+o` (pi's key for expanding tool output) to read it in full, in
  the main conversation or in an aside. The agent always gets the full text.
- **Keep the conversation readable.** While an aside is open, the main conversation re-wraps into
  the other half of the window instead of hiding under the pane (in pi's default fullscreen mode).
- **Fit the window.** Wide window: the aside takes the right half. Tall window: the top half. With
  two or more open, the top two share the screen and the rest shrink to thin strips. Resizing
  rearranges everything right away.
- **Draw text the way the main conversation does**, including what extensions add to it (for
  example a copy button on code blocks). Mermaid diagrams stay code in an aside.
- **Show the model's thinking** the way the main conversation does, or as one "Thinking..." line
  if you hid thinking in pi. Thinking stays in the aside: it isn't sent down.
- **Show cost.** Each aside's bottom border shows its model and what it has cost so far.

## Keys

| Anywhere in pi | |
|---|---|
| `ctrl+shift+a` or `alt+a` | Open an aside, or go back to the open one |
| `/aside` | Open an aside, or go back to the open one |

| Inside an aside | |
|---|---|
| `shift+↑` / `shift+↓` | Pick an earlier or later turn |
| `enter` | Ask |
| `ctrl+s` | Close and send a summary to the level below (it follows a few seconds later) |
| `ctrl+shift+s` | Send the whole discussion, as it is, to the level below and close |
| `ctrl+shift+a` or `alt+a` | Open an aside about this aside |
| `ctrl+o` | Expand or collapse what was sent down from an aside above (same as in pi) |
| `ctrl+t` | Show or hide thinking in the asides (same key as in pi) |
| `esc` | Stop the answer, or the summary coming from an aside above (never closes the aside) |
| `ctrl+d` (question box empty) | Close the aside right away, dropping any answer or summary still coming (same key that exits pi) |
| `pageUp` / `pageDown`, mouse wheel | Scroll the answers |
| `shift+enter` or `ctrl+j` | New line (or type `\` before `enter`) |
| `↑` / `↓` | Move between lines, or recall earlier questions |
| `tab`, `@` | Complete paths and files, as in pi's editor |
| Click / shift+click | Pick a turn / a range (needs pi's fullscreen mode) |

| Slash commands in an aside (type `/` for the list) | |
|---|---|
| `/skill:<name> …`, `/<template> …` | Use a skill or prompt template, as in pi |
| `/model`, `/thinking` | Change model or thinking level for this aside only |
| `/aside` | Open an aside about this aside |
| `/aside summary`, `/aside send`, `/aside close` | Same as `ctrl+s`, `ctrl+shift+s`, `ctrl+d` |
| Other pi commands (`/compact`, `/mcp`, …) | Can't run in an aside: it puts the command in pi's editor for you (if empty); close the asides and press `enter` |
| `/reload` | Can't run in an aside: close the asides and run it in pi's editor |

## Limitations

- **Nothing is saved.** Closing an aside or quitting pi throws it away. Use `ctrl+s` or
  `ctrl+shift+s` to keep what matters.
- **Changes are real and immediate.** The main agent only hears about them when you close the
  asides (quitting pi or switching sessions skips the list). If it is working on the same files at
  the same time, the two can collide; the pane warns you.
- **The MCP list in the note is a best guess, from tool names.** It may list a lookup whose name
  sounds like an action, leave out an action whose name sounds like a lookup, or miss MCP tools
  that your setup registers one by one.
- **Commands are judged by the aside's model.** A command is listed only when you asked for a
  change and the model thinks it changed files or was destructive. Changes the aside made without
  being asked aren't listed, and the model can misjudge a command; say so in the summary you send
  if it matters.
- **Only in pi's main editor:** pi and extension commands, pasted images, `!`
  shell commands, and typing a follow-up while an answer streams (wait, or `esc` to stop it).
- **No images in tool output.** A tool result with an image shows without it.
- **Showing or hiding thinking:** asides start with whatever pi's `ctrl+t` last chose. `ctrl+t` in
  an aside changes only the open asides, until they close: pi's setting and the main conversation
  stay as they were. Clicking a thinking block doesn't show or hide just that one. If an extension
  renamed pi's "Thinking..." label, asides still say "Thinking...".
- **No pop-ups in an aside.** MCP sign-in, permission prompts, and extensions that ask questions
  get no dialog there, and approvals from the main conversation don't carry over. Sign in from the
  main editor, then ask again.
- **Cost isn't in pi's footer**, only in each aside's border, and it goes away when the aside
  closes. A summary sent to the main conversation isn't counted anywhere.
- **A summary takes a few seconds to arrive.** `ctrl+s` closes the aside at once; pi's footer says
  "aside: summarizing…" until the summary lands. If you send a prompt before then, the agent gets
  the summary with your next one, so wait for the footer to clear when the prompt depends on it. If
  the summary fails, the whole discussion is sent instead. In an aside below, you can't ask until
  the summary from the aside above has arrived; `esc` stops it and sends the whole discussion.
  Quitting pi or switching sessions first drops it.
- **Each aside has its own model and thinking level.** A new aside starts with the settings of
  whatever it was opened from (the main conversation, or the aside below) and keeps them: later
  changes there don't reach it. `/model` and `/thinking` change only the aside you type them in,
  and are gone when it closes.
- **`ctrl+o` expands everything at once**, in the asides and the main conversation, the same
  as it does for tool output in pi. There is no way to expand just one summary.
- **In pi's regular mode (`--tui-mode regular`) the aside covers half the conversation.** Its text
  stays where it was. Use fullscreen mode (the default), or close the aside to read what is under it.
- You need at least one question in an aside before opening another on top of it.
- The first MCP call in an aside can take a moment while it connects.
- Only works in pi's interactive terminal, not in print or RPC mode.

### Terminal setup

- `alt+a` needs your terminal to send Option/Alt as Meta (macOS terminals usually don't by default).
- In tmux, `ctrl+shift+a`, `ctrl+shift+s`, and `shift+enter` need `set -g extended-keys on` and
  `set -g extended-keys-format csi-u` in your tmux config.
- `/aside` and `ctrl+j` always work.

## Install

```bash
pi install npm:aside-pane
```

Then start pi, or run `/reload` if it's already running. `pi list` shows it once installed.

To try it for one session without installing, run `pi -e npm:aside-pane`.

To uninstall, `pi remove npm:aside-pane`.

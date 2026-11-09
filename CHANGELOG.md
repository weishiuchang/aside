# Changelog

## [Unreleased]

- The question box uses your editor extensions, as pi's main input box does (e.g. Vim-style
  editing with its mode label, saved prompt history).

- Tool calls show as they do in the main conversation, drawn by each tool's own renderer, with
  live progress while they run (e.g. a subagent's status), results, and `ctrl+o` to expand.

- `ctrl+s` closes the aside at once; the summary follows in the background, with a footer status
  while it is on its way. If it fails, the whole discussion is sent instead.

## [0.1.0] - 2026-11-04

- First release: hold a threaded side conversation about one turn or a range of turns, in a pane
  beside the main conversation. Open it with `ctrl+shift+a`, `alt+a`, or `/aside`.
- Stack asides about asides, up to 5 deep.
- Send a summary (`ctrl+s`) or the whole discussion (`ctrl+shift+s`) to the conversation it came
  from, or close it and throw it away (`ctrl+d`).
- Asides have the main agent's tools. When one closes, the main agent hears which files and
  commands it changed.

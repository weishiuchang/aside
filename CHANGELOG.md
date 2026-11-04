# Changelog

## [0.1.0] - 2026-11-04

- First release: hold a threaded side conversation about one turn or a range of turns, in a pane
  beside the main conversation. Open it with `ctrl+shift+a`, `alt+a`, or `/aside`.
- Stack asides about asides, up to 5 deep.
- Send a summary (`ctrl+s`) or the whole discussion (`ctrl+shift+s`) to the conversation it came
  from, or close it and throw it away (`ctrl+d`).
- Asides have the main agent's tools. When one closes, the main agent hears which files and
  commands it changed.

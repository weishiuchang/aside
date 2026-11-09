/** Limits, sizes, and keys. Numbers are defaults: tune them freely, keep the behaviour. */

// Context sent to the model, in characters.
export const FOCUS_MAX_CHARS = 200_000;
export const BACKGROUND_MAX_CHARS = 60_000;
/** The shortened main conversation given to nested asides. */
export const NESTED_MAIN_MAX_CHARS = 40_000;
export const TOOL_ARGS_MAX_CHARS = 1_500;
export const TOOL_RESULT_MAX_CHARS = 3_000;
export const BRIEF_PROMPT_MAX_CHARS = 1_500;
export const BRIEF_REPLY_MAX_CHARS = 1_200;
/** What the check of an answer's shell commands gets: each command, its output, and the answer. */
export const COMMAND_CHECK_COMMAND_MAX_CHARS = 2_000;
export const COMMAND_CHECK_OUTPUT_MAX_CHARS = 600;
export const COMMAND_CHECK_ANSWER_MAX_CHARS = 3_000;

/** Asides that can be stacked (the main conversation not counted). */
export const MAX_DEPTH = 5;
/** Questions kept in the shared question history (the same as pi's editor). */
export const HISTORY_MAX = 100;
/** How long a closing aside waits for its extensions' `session_shutdown` handlers before disposing. */
export const SHUTDOWN_WAIT_MS = 3_000;

// Layout.
/** Cell height / cell width. A window is tall when cols < rows * this. */
export const CELL_ASPECT = 2;
/** Minimum width of aside 1 beside the main conversation. */
export const SIDE_MIN_WIDTH = 48;
/** Columns of each collapsed level in a wide window. */
export const SLIVER_WIDTH = 2;
/** Rows of each collapsed level in a tall window. */
export const STRIP_HEIGHT = 1;
/** Rows of the part list before it scrolls. */
export const LIST_MAX_ROWS = 5;
/** Exchanges (or previewed parts) the thread renders at once; scrolling slides others in. */
export const THREAD_WINDOW = LIST_MAX_ROWS;
/** Rows the question box grows to before it scrolls. */
export const MAX_INPUT_ROWS = 8;
/** Rows of the question box's autocomplete list when pi's `autocompleteMaxVisible` is unset (pi's default). */
export const AUTOCOMPLETE_MAX_VISIBLE = 5;

/** Custom message type of what an aside sends to the main conversation (summary, thread, or changes). */
export const MESSAGE_TYPE = "aside";

// Keys.
/** Open an aside; inside one, open a nested aside on top. */
export const OPEN_KEYS = ["alt+a", "ctrl+shift+a"] as const;
/** Hand the thread to the level below and close: summarized, or the whole thread as it is. */
export const SUMMARY_KEY = "ctrl+s";
export const THREAD_KEY = "ctrl+shift+s";

/**
 * The activity marker: one line saying what Codex is doing right now.
 *
 * Codex is told, through the thread's developer instructions, to write
 * `%%%ACTIVITY: <one line>%%%` whenever it starts something new. The server
 * lifts that line out of the agent-message stream, keeps the last one in
 * `progress.activity`, and cuts every marker out of the text it hands back as
 * the turn's result.
 *
 * The cost is one string per session, overwritten. Nothing accumulates.
 */

/** Opens a marker. The `ACTIVITY:` tag is what keeps a `%%%` run in quoted output from matching. */
const ACTIVITY_OPEN = "%%%ACTIVITY:";
/** Closes a marker. */
const ACTIVITY_CLOSE = "%%%";
/** Hard cap on the stored line. A longer one is cut to this length. */
export const MAX_ACTIVITY_LENGTH = 120;
/**
 * Characters scanned for the closing sentinel before the opener is given up as
 * ordinary text. It bounds both the memory one stream can hold and the damage a
 * `%%%ACTIVITY:` inside quoted output can do.
 */
const ACTIVITY_SCAN_LIMIT = 480;

const FULL_LINE_MARKER = new RegExp(
  `^[ \\t]*%%%ACTIVITY:[^\\n\\r]{0,${ACTIVITY_SCAN_LIMIT}}?%%%[ \\t]*(?:\\r?\\n)?`,
  "gm"
);
const INLINE_MARKER = new RegExp(`%%%ACTIVITY:[^\\n\\r]{0,${ACTIVITY_SCAN_LIMIT}}?%%%`, "g");
const FULL_LINE_UNCLOSED = /^[ \t]*%%%ACTIVITY:[^\n\r]*(?:\r?\n)?/gm;
const INLINE_UNCLOSED = /%%%ACTIVITY:[^\n\r]*/g;

/**
 * The standing instruction the server puts on every thread it starts.
 *
 * It asks for the subject of the work in the language of the request, and says
 * the marker is cut from the answer so Codex never uses one to carry content.
 */
export const ACTIVITY_MARKER_INSTRUCTION = `# Activity marker

Whenever you start a new activity, write exactly one line of this form:

${ACTIVITY_OPEN} <what you are doing right now>${ACTIVITY_CLOSE}

- Write it in your assistant message, on a line of its own, before you start the activity.
- Write a new one every time the activity changes. While the activity is unchanged, write nothing.
- Write it in the language of the user's request.
- One line, at most ${MAX_ACTIVITY_LENGTH} characters, no line break inside the marker.
- Name the subject of the work: the file, the test, the command, the question. Not "working", not "thinking".
- No jokes, no tool names, no percentages, no internal reasoning, no session or turn identifiers.
- Never put quoted output, code or a file listing inside the marker.
- The marker is cut out of the answer the caller reads, so never use one to carry the answer itself.`;

/** Environment switch that stops the server from sending the instruction. */
function activityMarkerInstructionEnabled(): boolean {
  return process.env.CODEX_MCP_DISABLE_ACTIVITY_MARKER !== "1";
}

/**
 * The developer instructions a thread starts with: the marker protocol, then
 * whatever the caller asked for.
 */
export function composeDeveloperInstructions(callerInstructions?: string): string | undefined {
  const parts: string[] = [];
  if (activityMarkerInstructionEnabled()) parts.push(ACTIVITY_MARKER_INSTRUCTION);
  const caller = callerInstructions?.trim();
  if (caller) parts.push(caller);
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/**
 * Reads the agent-message stream and reports each finished marker.
 *
 * Deltas are model tokens: a measured run cut them at a median of three
 * characters, and `%%%` arrives as `"%%"` + `"%\n"` as readily as whole. The
 * scanner therefore holds a carry buffer across deltas and decides on the
 * concatenation, not on one delta.
 *
 * Text outside a marker is dropped as it passes, so the buffer never grows past
 * an opener's worth of tail while no marker is open, and past
 * `ACTIVITY_SCAN_LIMIT` while one is.
 */
export class ActivityMarkerScanner {
  private pending = "";
  private inMarker = false;

  /** Feed one delta; get back the markers that closed on it, oldest first. */
  push(delta: string): string[] {
    if (delta.length === 0) return [];
    const found: string[] = [];
    this.pending += delta;

    for (;;) {
      const scanned = this.inMarker ? this.readMarkerBody(found) : this.seekOpener();
      if (!scanned) return found;
    }
  }

  /**
   * Move the buffer past the next opener. False when none is in it, and what
   * cannot yet be decided stays in the buffer for the next delta.
   */
  private seekOpener(): boolean {
    const open = this.pending.indexOf(ACTIVITY_OPEN);
    if (open === -1) {
      // An opener cut across two deltas lives in this tail.
      const keep = ACTIVITY_OPEN.length - 1;
      if (this.pending.length > keep) this.pending = this.pending.slice(-keep);
      return false;
    }
    this.pending = this.pending.slice(open + ACTIVITY_OPEN.length);
    this.inMarker = true;
    return true;
  }

  /**
   * Read the text after an opener: a marker that closed goes to `found`, and an
   * opener the text disowned is given up. False while neither is decided yet.
   */
  private readMarkerBody(found: string[]): boolean {
    const close = this.pending.indexOf(ACTIVITY_CLOSE);
    const newline = this.pending.search(/[\r\n]/);
    const closes = close !== -1 && (newline === -1 || close < newline);
    // The limit is read before the close, so how the stream was cut cannot
    // change the verdict on the same text.
    if (closes && close <= ACTIVITY_SCAN_LIMIT) {
      const line = this.pending.slice(0, close).trim();
      this.pending = this.pending.slice(close + ACTIVITY_CLOSE.length);
      this.inMarker = false;
      if (line.length > 0) found.push(line.slice(0, MAX_ACTIVITY_LENGTH));
      return true;
    }

    if (newline !== -1 || this.pending.length > ACTIVITY_SCAN_LIMIT) {
      // No closing sentinel on this line: the opener was ordinary text. Give it
      // up and look for a real marker in what followed it.
      this.inMarker = false;
      return true;
    }

    return false;
  }

  /** Drop a half-read marker. Called when the message or the turn it belonged to ends. */
  reset(): void {
    this.pending = "";
    this.inMarker = false;
  }
}

/**
 * The text without its markers.
 *
 * The caller asked Codex a question and reads Codex's answer; the lines the
 * server put there for itself do not belong in it. Text carrying no marker is
 * returned as it came.
 */
export function stripActivityMarkers(text: string): string {
  if (!text.includes(ACTIVITY_OPEN)) return text;
  const stripped = text
    .replace(FULL_LINE_MARKER, "")
    .replace(INLINE_MARKER, "")
    .replace(FULL_LINE_UNCLOSED, "")
    .replace(INLINE_UNCLOSED, "");
  return stripped
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The turn record without the markers its own copy of the text carries.
 *
 * `TurnResult.turn` is the backend's record of the finished turn, and it holds
 * the assistant text a second time in `turn.items[].text`. `TurnResult.text` is
 * stripped, that second copy was not, and a caller reading the turn put a raw
 * `%%%ACTIVITY: …%%%` line back into the answer it reported.
 *
 * Only `items[].text` is rewritten. Everything else of the turn is passed
 * through as the backend sent it.
 */
export function stripActivityMarkersFromTurn(turn: unknown): unknown {
  if (!isPlainRecord(turn)) return turn;
  const stripped: Record<string, unknown> = { ...turn };
  if (Array.isArray(stripped.items)) {
    stripped.items = stripped.items.map((item) =>
      isPlainRecord(item) && typeof item.text === "string"
        ? { ...item, text: stripActivityMarkers(item.text) }
        : item
    );
  }
  return stripped;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

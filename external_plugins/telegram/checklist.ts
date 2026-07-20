// checklist.ts — tappable Telegram checklists for the `reply` tool's optional
// `checklist` param (owner msg 5347, 2026-07-20: "tap an item, it strikes
// through, no need to type 'bought X'").
//
// BACKGROUND: native Telegram checklists (Bot API 9.1 sendChecklist /
// editMessageChecklist) are business-connection-only (Telegram Premium, "from
// a business account") — they cannot send bot→owner in a plain DM. See
// research/2026-07-18-telegram-checklists.md (NO-BUILD verdict on the native
// path) and BACKLOG.md ~line 695. This file implements the approved
// alternative: standard Bot API inline-keyboard buttons, one per item, with
// per-item toggle.
//
// Pure, side-effect-free (like telegram-format.ts / idea-inbox.ts) — no
// grammY/bot-token/network — see checklist.test.ts.
//
// ── STATE WITHOUT A DATABASE ────────────────────────────────────────────
// The item texts + checked/unchecked state are never written to a durable
// store. Every tap re-derives the full list from the TAPPED MESSAGE itself:
//   - callback_data is just `chk:<index>` (a handful of bytes — Telegram
//     caps callback_data at 64 bytes) — it names WHICH item, nothing else.
//   - the item TEXTS + current checked state live in the message's own
//     `reply_markup.inline_keyboard` button labels (exactly one button per
//     item, top-to-bottom == item order) — each label already encodes both
//     (`☐ text` / `✅ text`).
//   - the free-text header above the items (the caller's `text` argument, if
//     any) is recovered from `message.text` by dropping its last N lines
//     (N = button count) plus the one blank separator line before them.
// This (not an in-process Map) is the primary source of truth deliberately:
// the bot process restarts routinely (plugin reconnects, deploys — see
// memory-mirror/tg-plugin-deploy.md), and a checklist sent before a restart
// must stay toggleable after one. State that only lived in this process's
// memory would go dark on every restart; state re-derived from the message
// Telegram already stores for us survives it for free.
//
// A small in-memory cache (server.ts, mirroring the existing
// `pendingPermissions` Map pattern) is layered ON TOP as an optimization for
// the hot path — see server.ts's checklistCache comment — but every function
// here works correctly from cold (text + keyboard only), which is what makes
// that cache safe to lose on restart.
//
// ── MARK CHOICE ──────────────────────────────────────────────────────────
// Owner's explicit final choice (msg 5354, 2026-07-20): `☐` unchecked / `✅`
// checked, overriding an earlier 🔴/🟢 pass. Kept as ONE named constant so a
// future swap (e.g. to ⬜/✅) is a one-line change — see CHECKLIST_MARKS below
// for the rendering caveat flagged back to the owner per his instruction.

/** The only place the toggle glyphs are chosen — swap here to change both
 * the button label and (indirectly, via buttonLabel()) every render.
 *
 * ⚠️ RENDERING CAVEAT (flagged to the owner per his instruction, not silently
 * "fixed"): `☐` (U+2610 BALLOT BOX) is a *text-presentation* character in
 * Unicode's emoji-presentation tables — several clients (default Windows
 * fonts, some web renderers) draw it as a thin monochrome glyph, while `✅`
 * (U+2705, emoji-presentation by default) is always full-colour everywhere.
 * The pair can look visually mismatched (one looks like "an emoji", the
 * other like "punctuation"). If that bothers him in practice, `⬜` (U+2B1C
 * WHITE LARGE SQUARE) or `▫️` (U+25AB + VS16) both default to full emoji
 * presentation and would look more consistent alongside `✅` — a one-line
 * swap here either way. */
export const CHECKLIST_MARKS = {
  unchecked: '☐',
  checked: '✅',
} as const

/** Telegram's overall inline-keyboard button cap (research/2026-07-18-telegram-checklists.md §4). */
export const MAX_ITEMS = 100
/** Telegram's InlineKeyboardButton.text length cap, in characters. */
export const MAX_BUTTON_LABEL = 64
/** Conservative cap on the composed (pre-HTML-conversion) message source —
 * Telegram's actual sendMessage text limit is 4096 chars of FINAL text; our
 * markdown-ish source (with `~~..~~` wrappers) is always >= the final
 * rendered length, so checking the source here is a safe/conservative
 * pre-flight, not an exact accounting. */
export const MAX_MESSAGE_CHARS = 4096

export interface ChecklistItem {
  text: string
  checked: boolean
}

export interface ChecklistButton {
  text: string
  callback_data: string
}

/** OUTPUT shape (what buildChecklistKeyboard/renderChecklist produce) — kept
 * grammY-free so this module has zero framework dependency. Every button we
 * construct always carries callback_data, hence non-optional here. */
export type ChecklistKeyboard = ChecklistButton[][]

/** INPUT shape for the parse side (flattenButtons/parseChecklistMessage/
 * applyToggle) — deliberately just `{ text }`. Telegram's real
 * InlineKeyboardButton union includes variants with no callback_data at all
 * (a game/url/login/web_app button), so a keyboard we're re-parsing (which
 * might not even be one WE sent) can't be assumed to satisfy
 * ChecklistButton's stricter shape. We never need to read callback_data back
 * out when reconstructing state — the item's array position already tells
 * us its index — so `{ text }` is also all the parse side actually uses. */
export interface IncomingButton {
  text: string
}
export type IncomingKeyboard = IncomingButton[][]

export interface BuiltChecklist {
  header: string
  items: ChecklistItem[]
  /** Markdown-ish source text (checked items wrapped `~~like this~~`) meant
   * to be passed through the EXISTING auto-formatter (telegram-format.ts's
   * sendWithAutoFormat / markdownToTelegramHtml) — reuse, not a second
   * formatting pipeline. `~~text~~` is that formatter's existing
   * strikethrough syntax. */
  text: string
  keyboard: ChecklistKeyboard
}

/** Items must render as a single text line each (the header/item-count line
 * math in parseChecklistMessage depends on it) — strip embedded newlines
 * rather than let them silently corrupt the line count. */
export function sanitizeItemText(raw: string): string {
  return raw.replace(/\r?\n/g, ' ').trim()
}

/** Truncates (with an ellipsis) so `mark + ' ' + text` fits Telegram's
 * 64-character button-label cap. Deterministic and pure — parseChecklistMessage
 * re-derives the SAME label from (text, checked) and compares, so truncation
 * needs no special-casing on the parse side (see its doc comment). */
export function truncateForButton(mark: string, text: string): string {
  const prefix = `${mark} `
  const budget = MAX_BUTTON_LABEL - prefix.length
  if (text.length <= budget) return `${prefix}${text}`
  const kept = Math.max(0, budget - 1) // reserve 1 char for the ellipsis
  return `${prefix}${text.slice(0, kept)}…`
}

export function buttonLabel(text: string, checked: boolean): string {
  return truncateForButton(checked ? CHECKLIST_MARKS.checked : CHECKLIST_MARKS.unchecked, text)
}

export function buildChecklistKeyboard(items: ChecklistItem[]): ChecklistKeyboard {
  return items.map((item, idx) => [
    { text: buttonLabel(item.text, item.checked), callback_data: `chk:${idx}` },
  ])
}

/** Composes the raw markdown-ish source (header + items) — checked items are
 * wrapped in `~~..~~` (telegram-format.ts's existing strikethrough syntax).
 * When header is blank/whitespace-only, it (and its separator blank line)
 * are omitted entirely — mirrored by parseChecklistMessage's header-line-
 * count math below. */
export function renderChecklistSource(header: string, items: ChecklistItem[]): string {
  const lines = items.map(item => (item.checked ? `~~${item.text}~~` : item.text))
  return header.trim() ? `${header}\n\n${lines.join('\n')}` : lines.join('\n')
}

export function renderChecklist(header: string, items: ChecklistItem[]): BuiltChecklist {
  const text = renderChecklistSource(header, items)
  if (text.length > MAX_MESSAGE_CHARS) {
    throw new Error(
      `checklist: rendered message is ${text.length} chars, exceeds Telegram's ~${MAX_MESSAGE_CHARS}-char limit — shorten the header or items`,
    )
  }
  return { header, items, text, keyboard: buildChecklistKeyboard(items) }
}

/** Builds a fresh (all-unchecked) checklist from raw item strings — the
 * `reply` tool's entry point for a new `checklist: string[]` message. */
export function buildChecklist(header: string, rawItems: string[]): BuiltChecklist {
  if (rawItems.length === 0) {
    throw new Error('checklist: at least one item is required (omit the parameter for a plain reply)')
  }
  if (rawItems.length > MAX_ITEMS) {
    throw new Error(`checklist: ${rawItems.length} items exceeds Telegram's ${MAX_ITEMS}-button limit`)
  }
  const items: ChecklistItem[] = rawItems.map((raw, idx) => {
    const clean = sanitizeItemText(raw)
    if (clean === '') throw new Error(`checklist: item ${idx} is empty after trimming`)
    return { text: clean, checked: false }
  })
  return renderChecklist(header, items)
}

export type ParsedChecklist =
  | { ok: true; header: string; items: ChecklistItem[] }
  | { ok: false; reason: string }

// Flattens a keyboard we rendered ourselves (exactly one button per row).
// Any row shape we don't produce (0 or 2+ buttons) means this isn't OUR
// keyboard — fail safe rather than guess which button was "the" item.
function flattenButtons(keyboard: IncomingKeyboard): IncomingButton[] | null {
  const out: IncomingButton[] = []
  for (const row of keyboard) {
    if (row.length !== 1) return null
    out.push(row[0])
  }
  return out
}

function parseCheckedFromLabel(label: string): boolean | null {
  if (label.startsWith(`${CHECKLIST_MARKS.checked} `)) return true
  if (label.startsWith(`${CHECKLIST_MARKS.unchecked} `)) return false
  return null
}

/**
 * Re-derives { header, items } from a checklist message we previously sent
 * (its current plain text + its current inline keyboard) — see the module
 * doc comment for why this replaces a database.
 *
 * Cross-validation (the fail-safe half of "a tap on a message whose text was
 * edited meanwhile must fail safely"): for every item, the button label is
 * recomputed from (that item's OWN text line, that button's OWN checked
 * flag) via the same deterministic buttonLabel() used to render — and
 * compared against the ACTUAL label on the button. Because buttonLabel() is
 * pure and includes its own truncation, this one comparison is enough; no
 * separate truncation-aware string logic is needed on the parse side. Any
 * mismatch (label doesn't match its own text line, a foreign keyboard shape,
 * fewer text lines than buttons) returns `ok:false` — never throws, never
 * guesses which item to toggle.
 */
export function parseChecklistMessage(text: string, keyboard: IncomingKeyboard): ParsedChecklist {
  const buttons = flattenButtons(keyboard)
  if (buttons == null || buttons.length === 0) {
    return { ok: false, reason: 'not a checklist keyboard (expected exactly one button per row)' }
  }

  const checkedFlags = buttons.map(b => parseCheckedFromLabel(b.text))
  if (checkedFlags.some(c => c == null)) {
    return { ok: false, reason: "a button label doesn't start with a known checklist mark" }
  }

  const lines = text.split('\n')
  if (lines.length < buttons.length) {
    return { ok: false, reason: 'message has fewer text lines than checklist buttons — edited externally?' }
  }
  const itemLines = lines.slice(lines.length - buttons.length)
  const headerLineCount = Math.max(0, lines.length - buttons.length - 1)
  const header = lines.slice(0, headerLineCount).join('\n')

  const items: ChecklistItem[] = itemLines.map((lineText, i) => ({
    text: lineText,
    checked: checkedFlags[i] as boolean,
  }))

  for (let i = 0; i < items.length; i++) {
    const expectedLabel = buttonLabel(items[i].text, items[i].checked)
    if (buttons[i].text !== expectedLabel) {
      return {
        ok: false,
        reason: `item ${i}: button label doesn't match its text line — edited externally?`,
      }
    }
  }

  return { ok: true, header, items }
}

/** Parses `chk:<index>` callback_data. Returns null for anything else
 * (garbage, a foreign prefix like `perm:...`, non-digit index) — the caller
 * treats null as "not a checklist tap", never as index 0. */
export function parseCallbackData(data: string): number | null {
  const m = /^chk:(\d+)$/.exec(data)
  if (!m) return null
  return Number(m[1])
}

export type ToggleResult =
  | { ok: true; header: string; items: ChecklistItem[] }
  | { ok: false; reason: string }

/** Flips items[idx].checked. Bounds-checked (out-of-range or non-integer
 * idx → ok:false, never throws — covers "out-of-range/garbage callback
 * data" together with parseCallbackData's own null-on-garbage). */
export function toggleChecklistItem(parsed: ParsedChecklist, idx: number): ToggleResult {
  if (!parsed.ok) return parsed
  if (!Number.isInteger(idx) || idx < 0 || idx >= parsed.items.length) {
    return { ok: false, reason: `index ${idx} out of range (0..${parsed.items.length - 1})` }
  }
  const items = parsed.items.map((item, i) => (i === idx ? { ...item, checked: !item.checked } : item))
  return { ok: true, header: parsed.header, items }
}

/** Convenience wrapper: parse-then-toggle-then-render in one call, for
 * server.ts's cold path (no cache hit) — parse from the message the button
 * lives on, toggle the tapped index, and produce the next BuiltChecklist to
 * edit the message with. */
export function applyToggle(
  text: string,
  keyboard: IncomingKeyboard,
  idx: number,
): { ok: true; built: BuiltChecklist } | { ok: false; reason: string } {
  const parsed = parseChecklistMessage(text, keyboard)
  const toggled = toggleChecklistItem(parsed, idx)
  if (!toggled.ok) return toggled
  return { ok: true, built: renderChecklist(toggled.header, toggled.items) }
}

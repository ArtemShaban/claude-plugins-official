// telegram-format.ts — auto-formatter for outbound Telegram messages.
//
// PROBLEM (Артём, msg 2031 + screenshot): assistant replies contain GFM-ish
// markdown (**bold**, `code`, etc.) but the reply/edit_message tools default
// to format:'text' (no parse_mode) unless the CALLER remembers to pass
// format:'markdownv2' *and* hand-escape every MarkdownV2 reserved char
// (`_*[]()~\`>#+-=|{}.!`) correctly. In practice the caller (the assistant)
// forgets the opt-in, so the raw markdown syntax shows up literally in the
// chat — ugly, and the actual bug this file fixes.
//
// FIX: auto-convert common markdown to Telegram formatting by default, with
// a mandatory plain-text fallback so a formatting bug can never drop a
// message (sent≠seen doctrine — see CLAUDE.md §0).
//
// DESIGN DECISION — Telegram HTML parse_mode, not MarkdownV2:
// MarkdownV2 requires escaping 18 reserved characters (`_*[]()~\`>#+-=|{}.!`)
// EVERYWHERE they appear outside a recognized entity, and nesting rules are
// fragile (e.g. a literal '.' or '-' in ordinary prose must be escaped or
// Telegram 400s the whole message). Telegram's HTML parse_mode only requires
// escaping three characters in text content (& < >) and tags are explicit
// (<b>, <i>, <code>, <pre>, <a href>, <s>, <blockquote>) — far fewer ways for
// arbitrary assistant prose to accidentally produce an invalid/reject-worthy
// payload. HTML is the more robust choice for auto-converting unpredictable
// text, so that's what this module emits.
//
// Pure, side-effect-free (like idea-inbox.ts) so it's unit-testable without
// grammY, a bot token, or a network — see telegram-format.test.ts.

/** Escape the three characters Telegram's HTML parse_mode treats as special
 * in text content. Order matters: '&' must be escaped first. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Placeholder tokens use the Unicode Private-Use-Area (U+E000/E001) — chars
// that won't appear in real assistant text and that escapeHtml() leaves
// untouched (they contain no & < >), so protected spans survive every later
// transform pass intact until the final restore step.
const PLACEHOLDER_RE = /(\d+)/g

function looksLikeTableRow(line: string): boolean {
  const t = line.trim()
  return t.includes('|') && t.length > 0
}

function isTableSeparatorRow(line: string): boolean {
  const t = line.trim()
  if (!t.includes('-')) return false
  return /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(t)
}

/**
 * Extract GFM-style tables (a header row + a `---|---` separator row,
 * followed by 0+ more '|'-bearing rows) into monospace <pre> placeholders.
 *
 * Telegram has NO table syntax — there is nothing to "convert" a table into.
 * We degrade gracefully: render the raw table text inside a monospace block
 * so columns still roughly line up, rather than emitting mangled prose (bare
 * '|' characters reflowed by Telegram's proportional font) or silently
 * dropping the content.
 */
function extractTables(lines: string[], store: (html: string) => string): string[] {
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    if (
      looksLikeTableRow(lines[i]) &&
      i + 1 < lines.length &&
      isTableSeparatorRow(lines[i + 1])
    ) {
      const block: string[] = [lines[i], lines[i + 1]]
      let j = i + 2
      while (j < lines.length && looksLikeTableRow(lines[j])) {
        block.push(lines[j])
        j++
      }
      out.push(store(`<pre>${escapeHtml(block.join('\n'))}</pre>`))
      i = j
      continue
    }
    out.push(lines[i])
    i++
  }
  return out
}

/**
 * Block-level transforms over ALREADY html-escaped text: blockquotes,
 * headers, horizontal rules, unordered-list bullets. Runs after escapeHtml()
 * so '>' has become the literal string "&gt;" — that's why the blockquote
 * check matches "&gt;" rather than ">".
 */
function processBlocks(escapedText: string): string {
  const lines = escapedText.split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    // Blockquote: consecutive lines starting with (escaped) '>'.
    if (/^&gt;\s?/.test(line)) {
      const block: string[] = []
      let j = i
      while (j < lines.length && /^&gt;\s?/.test(lines[j])) {
        block.push(lines[j].replace(/^&gt;\s?/, ''))
        j++
      }
      out.push(`<blockquote>${block.join('\n')}</blockquote>`)
      i = j
      continue
    }

    // Header: '#' .. '######' + a space. Telegram has no header syntax —
    // the closest visual equivalent is a bold line.
    const header = line.match(/^(#{1,6})\s+(.*)$/)
    if (header) {
      out.push(`<b>${header[2]}</b>`)
      i++
      continue
    }

    // Horizontal rule.
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push('──────────')
      i++
      continue
    }

    // Unordered list item — normalize the marker to a bullet. Doing this at
    // block level (before the inline emphasis pass) also means a lone
    // leading '-'/'*'/'+' marker can never be mistaken for an emphasis
    // delimiter by the inline pass that runs later.
    const listItem = line.match(/^(\s*)[-*+]\s+(.*)$/)
    if (listItem) {
      out.push(`${listItem[1]}• ${listItem[2]}`)
      i++
      continue
    }

    out.push(line)
    i++
  }
  return out.join('\n')
}

/** Inline emphasis pass: strikethrough, bold, italic. Links are handled
 * separately (and BEFORE this runs on the outer text) so a URL containing
 * '_' or '*' can never be misread as an emphasis delimiter. */
function processInline(text: string): string {
  let out = text
  out = out.replace(/~~([\s\S]+?)~~/g, '<s>$1</s>')
  out = out.replace(/\*\*([\s\S]+?)\*\*/g, '<b>$1</b>')
  // Underscore bold/italic require a non-word boundary on both sides so
  // snake_case_identifiers outside code spans aren't torn into emphasis
  // (CommonMark's "intraword emphasis" rule for '_').
  out = out.replace(/(?<![\w])__([\s\S]+?)__(?![\w])/g, '<b>$1</b>')
  out = out.replace(/\*([^*\n]+?)\*/g, '<i>$1</i>')
  out = out.replace(/(?<![\w])_([^_\n]+?)_(?![\w])/g, '<i>$1</i>')
  return out
}

const LINK_RE = /\[([^[\]]+)\]\(([^\s)]+)\)/g

/**
 * Convert GFM-ish markdown (as an assistant naturally writes it) into
 * Telegram HTML parse_mode markup.
 *
 * Never throws on malformed/partial markdown by design — unmatched
 * delimiters (a stray '*' with no closing '*', a truncated ``` fence, etc.)
 * simply fall through as literal escaped text instead of producing broken
 * tags. That said, callers MUST still go through sendWithAutoFormat (below)
 * rather than call this directly for anything user-facing, since it is the
 * single place that also survives an unexpected internal throw.
 */
export function markdownToTelegramHtml(source: string): string {
  const placeholders: string[] = []
  const store = (html: string): string => {
    const token = `${placeholders.length}`
    placeholders.push(html)
    return token
  }

  let text = source

  // 1. Fenced code blocks — protect content verbatim (only & < > escaped),
  //    rendered with a language class when a fence language is given.
  text = text.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (_m, lang: string, code: string) => {
    const trimmed = code.replace(/\n$/, '')
    const langAttr = lang.trim()
    const inner = langAttr
      ? `<pre><code class="language-${escapeHtml(langAttr)}">${escapeHtml(trimmed)}</code></pre>`
      : `<pre><code>${escapeHtml(trimmed)}</code></pre>`
    return store(inner)
  })

  // 2. Inline code spans — same protection, single-line only (CommonMark
  //    inline code doesn't span lines either).
  text = text.replace(/`([^`\n]+)`/g, (_m, code: string) => store(`<code>${escapeHtml(code)}</code>`))

  // 3. GFM tables — degrade to a monospace block (see extractTables' doc
  //    comment). Done on raw (pre-escape) lines so escaping happens once,
  //    inside the placeholder builder.
  text = extractTables(text.split('\n'), store).join('\n')

  // 4. Escape everything that's left (ordinary prose + markdown syntax
  //    chars, none of which are & < > so they survive untouched).
  text = escapeHtml(text)

  // 5. Block-level structure: blockquotes / headers / hr / list bullets.
  text = processBlocks(text)

  // 6. Links — protected BEFORE the inline emphasis pass so a URL
  //    containing '_' or '*' can't be misread as emphasis. The link label
  //    still gets its own (recursive) emphasis pass.
  text = text.replace(LINK_RE, (_m, label: string, url: string) => {
    const safeUrl = url.replace(/"/g, '&quot;')
    return store(`<a href="${safeUrl}">${processInline(label)}</a>`)
  })

  // 7. Inline emphasis over whatever prose remains.
  text = processInline(text)

  // 8. Restore protected spans (code/tables/links) — fully-finalized HTML,
  //    never touched by steps 4-7.
  text = text.replace(PLACEHOLDER_RE, (_m, idx: string) => placeholders[Number(idx)] ?? '')

  return text
}

/**
 * Send (or edit) with auto-formatting AND a mandatory plain-text fallback.
 *
 * `send(text, parseMode)` is the caller's actual Telegram API call — kept
 * generic/injectable so this stays unit-testable without grammY. Behavior:
 *   1. Try to format `rawText` (via `format`, default markdownToTelegramHtml).
 *      A throw here is caught — never lets a converter bug reach the caller.
 *   2. If formatting succeeded, try `send(formatted, 'HTML')`.
 *   3. If step 1 failed, OR step 2's send rejected (e.g. Telegram 400 "can't
 *      parse entities" from some markup edge case we didn't anticipate),
 *      fall back to `send(rawText, undefined)` — plain text, guaranteed to
 *      contain no parse_mode-sensitive markup. This is the load-bearing
 *      guarantee: a formatting bug must never drop a message
 *      (sent≠seen — CLAUDE.md §0).
 *
 * Deliberately does NOT try to distinguish "Telegram rejected the markup"
 * from "some unrelated send error" before falling back — if the underlying
 * failure is unrelated to formatting (network blip, chat blocked the bot,
 * etc.), the plain-text retry fails the same way and that real error still
 * propagates to the caller. The extra retry costs one wasted call in that
 * case and buys unconditional safety in the case that matters.
 */
export async function sendWithAutoFormat<T>(
  send: (text: string, parseMode: 'HTML' | undefined) => Promise<T>,
  rawText: string,
  format: (s: string) => string = markdownToTelegramHtml,
): Promise<T> {
  let formatted: string | undefined
  try {
    formatted = format(rawText)
  } catch {
    formatted = undefined
  }

  if (formatted !== undefined) {
    try {
      return await send(formatted, 'HTML')
    } catch {
      // Fall through to the plain-text retry below.
    }
  }

  return send(rawText, undefined)
}

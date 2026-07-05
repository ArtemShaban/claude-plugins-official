// Unit tests for telegram-format.ts — the outbound markdown→Telegram-HTML
// auto-formatter (fixes Артём's "raw **bold** shows up literally" complaint,
// msg 2031). Pure functions, no grammY/bot-token/network needed.

import { describe, expect, test } from 'bun:test'
import { escapeHtml, markdownToTelegramHtml, sendWithAutoFormat } from './telegram-format'

describe('escapeHtml', () => {
  test('escapes & < > and only those, in the right order', () => {
    expect(escapeHtml('5 > 3 & 2 < 1')).toBe('5 &gt; 3 &amp; 2 &lt; 1')
  })

  test('does not double-escape an already-escaped ampersand', () => {
    // '&' must be escaped FIRST or '&lt;' would become '&amp;lt;'.
    expect(escapeHtml('<')).toBe('&lt;')
  })
})

describe('markdownToTelegramHtml — inline constructs', () => {
  test('bold: **text**', () => {
    expect(markdownToTelegramHtml('**bold**')).toBe('<b>bold</b>')
  })

  test('italic: *text*', () => {
    expect(markdownToTelegramHtml('*italic*')).toBe('<i>italic</i>')
  })

  test('italic: _text_', () => {
    expect(markdownToTelegramHtml('_italic_')).toBe('<i>italic</i>')
  })

  test('bold: __text__', () => {
    expect(markdownToTelegramHtml('__bold__')).toBe('<b>bold</b>')
  })

  test('strikethrough: ~~text~~', () => {
    expect(markdownToTelegramHtml('~~gone~~')).toBe('<s>gone</s>')
  })

  test('inline code: `code`', () => {
    expect(markdownToTelegramHtml('`code`')).toBe('<code>code</code>')
  })

  test('inline code content is HTML-escaped, not interpreted as markdown', () => {
    expect(markdownToTelegramHtml('`a < b && **not bold**`')).toBe(
      '<code>a &lt; b &amp;&amp; **not bold**</code>',
    )
  })

  test('link: [text](url)', () => {
    expect(markdownToTelegramHtml('[Claude](https://claude.ai)')).toBe(
      '<a href="https://claude.ai">Claude</a>',
    )
  })

  test('link label keeps its own emphasis', () => {
    expect(markdownToTelegramHtml('[**bold link**](https://x.com)')).toBe(
      '<a href="https://x.com"><b>bold link</b></a>',
    )
  })

  test('a URL containing underscores is not mangled by italic parsing', () => {
    expect(markdownToTelegramHtml('[docs](https://x.com/a_b_c)')).toBe(
      '<a href="https://x.com/a_b_c">docs</a>',
    )
  })

  test('snake_case identifiers outside code spans are left alone (not torn into <i>)', () => {
    expect(markdownToTelegramHtml('run check_base_fresh.sh now')).toBe(
      'run check_base_fresh.sh now',
    )
  })

  test('multiple independent bold pairs in one message', () => {
    expect(markdownToTelegramHtml('**a** and **b**')).toBe('<b>a</b> and <b>b</b>')
  })

  test('a lone unmatched asterisk stays literal (no broken tag)', () => {
    expect(markdownToTelegramHtml('5 * 3 = 15')).toBe('5 * 3 = 15')
  })
})

describe('markdownToTelegramHtml — code blocks', () => {
  test('fenced code block with a language tag', () => {
    const src = '```js\nconst x = 1;\n```'
    expect(markdownToTelegramHtml(src)).toBe(
      '<pre><code class="language-js">const x = 1;</code></pre>',
    )
  })

  test('fenced code block without a language tag', () => {
    const src = '```\nplain\n```'
    expect(markdownToTelegramHtml(src)).toBe('<pre><code>plain</code></pre>')
  })

  test('code block content with reserved/HTML chars is escaped, not parsed', () => {
    const src = '```\nif (a < b && b > c) { return; }\n```'
    expect(markdownToTelegramHtml(src)).toBe(
      '<pre><code>if (a &lt; b &amp;&amp; b &gt; c) { return; }</code></pre>',
    )
  })
})

describe('markdownToTelegramHtml — block structure', () => {
  test('header (#) becomes a bold line', () => {
    expect(markdownToTelegramHtml('# Title')).toBe('<b>Title</b>')
  })

  test('h2-h6 all become bold lines', () => {
    expect(markdownToTelegramHtml('### Section')).toBe('<b>Section</b>')
  })

  test('unordered list bullets (-, *, +) normalize to •', () => {
    expect(markdownToTelegramHtml('- one\n* two\n+ three')).toBe('• one\n• two\n• three')
  })

  test('ordered list items are left as-is (no native Telegram equivalent needed)', () => {
    expect(markdownToTelegramHtml('1. first\n2. second')).toBe('1. first\n2. second')
  })

  test('blockquote (>) wraps in <blockquote>', () => {
    expect(markdownToTelegramHtml('> quoted line')).toBe('<blockquote>quoted line</blockquote>')
  })

  test('multi-line blockquote groups into one <blockquote>', () => {
    expect(markdownToTelegramHtml('> line one\n> line two')).toBe(
      '<blockquote>line one\nline two</blockquote>',
    )
  })

  test('horizontal rule becomes a plain separator, not broken markup', () => {
    const out = markdownToTelegramHtml('above\n---\nbelow')
    expect(out).not.toContain('<')
    expect(out.split('\n')).toEqual(['above', '──────────', 'below'])
  })
})

describe('markdownToTelegramHtml — tables degrade gracefully (Telegram has no table syntax)', () => {
  test('a GFM table is wrapped in a monospace <pre> block, not silently dropped', () => {
    const src = '| A | B |\n|---|---|\n| 1 | 2 |'
    const out = markdownToTelegramHtml(src)
    expect(out.startsWith('<pre>')).toBe(true)
    expect(out.endsWith('</pre>')).toBe(true)
    expect(out).toContain('| A | B |')
    expect(out).toContain('| 1 | 2 |')
  })
})

describe('markdownToTelegramHtml — reserved-character robustness (never a 400)', () => {
  // The exact set MarkdownV2 requires escaping. HTML mode only cares about
  // & < >, so all of these should survive as plain, safely-escaped text with
  // no unmatched/broken tags introduced.
  test('a message packed with every MarkdownV2-reserved char produces valid, literal output', () => {
    const src = '_*[]()~`>#+-=|{}.!'
    const out = markdownToTelegramHtml(src)
    expect(out).toBe('_*[]()~`&gt;#+-=|{}.!')
    // No tag was opened at all — the lone '>' became the text entity '&gt;',
    // not an actual '<'/'>' character, so no real tag markup exists here.
    expect(out).not.toContain('<')
  })

  test('reserved chars scattered through a normal sentence still render safely', () => {
    const src = 'Цена: $50-100 (approx.) | done! #win_win {ok} ~maybe~ [not a link'
    const out = markdownToTelegramHtml(src)
    // Must not throw (already implicit — a throw would fail the test) and
    // must not contain a dangling unescaped '<' or unmatched tag soup.
    expect(out).not.toMatch(/<[a-z]/i)
  })

  test('digits elsewhere in the message are not corrupted by the placeholder mechanism', () => {
    // Regression guard: placeholder tokens must be unambiguous vs. ordinary
    // digits (dates/prices/list numbers) already in the text.
    const src = 'meet at 14:30 on 2026-07-05, cost $1200; also `x = 42`'
    const out = markdownToTelegramHtml(src)
    expect(out).toBe('meet at 14:30 on 2026-07-05, cost $1200; also <code>x = 42</code>')
  })
})

describe('sendWithAutoFormat — the mandatory delivery guarantee', () => {
  test('happy path: sends the formatted HTML in one call', async () => {
    const calls: Array<[string, string | undefined]> = []
    const send = async (text: string, parseMode: 'HTML' | undefined) => {
      calls.push([text, parseMode])
      return { message_id: 1 }
    }
    const result = await sendWithAutoFormat(send, '**bold**')
    expect(result).toEqual({ message_id: 1 })
    expect(calls).toEqual([['<b>bold</b>', 'HTML']])
  })

  test('converter throws → falls back to plain text, message still sends', async () => {
    const calls: Array<[string, string | undefined]> = []
    const send = async (text: string, parseMode: 'HTML' | undefined) => {
      calls.push([text, parseMode])
      return { message_id: 2 }
    }
    const throwingFormat = () => {
      throw new Error('converter blew up')
    }
    const result = await sendWithAutoFormat(send, 'hello **world**', throwingFormat)
    expect(result).toEqual({ message_id: 2 })
    // Only the plain fallback call happened — no attempt with a formatted
    // (possibly-garbage) payload and parse_mode set.
    expect(calls).toEqual([['hello **world**', undefined]])
  })

  test('Telegram rejects the formatted send (simulated 400) → plain-text retry fires, message still sends', async () => {
    const calls: Array<[string, string | undefined]> = []
    const send = async (text: string, parseMode: 'HTML' | undefined) => {
      calls.push([text, parseMode])
      if (parseMode === 'HTML') {
        throw new Error("Bad Request: can't parse entities: 400")
      }
      return { message_id: 3 }
    }
    const result = await sendWithAutoFormat(send, '**bold**')
    expect(result).toEqual({ message_id: 3 })
    expect(calls).toEqual([
      ['<b>bold</b>', 'HTML'],
      ['**bold**', undefined],
    ])
  })

  test('a totally unrelated send failure still propagates (not silently swallowed)', async () => {
    const send = async (_text: string, _parseMode: 'HTML' | undefined) => {
      throw new Error('network unreachable')
    }
    await expect(sendWithAutoFormat(send, 'hi')).rejects.toThrow('network unreachable')
  })

  test('plain text with no markdown passes through unchanged and sends formatted (no-op conversion)', async () => {
    const calls: Array<[string, string | undefined]> = []
    const send = async (text: string, parseMode: 'HTML' | undefined) => {
      calls.push([text, parseMode])
      return { message_id: 4 }
    }
    await sendWithAutoFormat(send, 'no markdown here')
    expect(calls).toEqual([['no markdown here', 'HTML']])
  })
})

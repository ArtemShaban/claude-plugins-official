// Unit tests for checklist.ts — the reply tool's optional `checklist` param
// (tappable inline-button checklists, owner msg 5347 2026-07-20). Pure
// functions, no grammY/bot-token/network needed — see checklist.ts's doc
// comment for the "state lives in the message, not a database" design.

import { describe, expect, test } from 'bun:test'
import {
  CHECKLIST_MARKS,
  MAX_ITEMS,
  buildChecklist,
  buttonLabel,
  parseChecklistMessage,
  parseCallbackData,
  toggleChecklistItem,
  applyToggle,
  renderChecklist,
  renderChecklistSource,
  sanitizeItemText,
  truncateForButton,
  type ChecklistItem,
  type IncomingKeyboard,
} from './checklist'

// applyToggle()/parseChecklistMessage() expect the PLAIN text Telegram would
// hand back on the NEXT update — i.e. `~~..~~` already stripped to a
// strikethrough entity, exactly as telegram-format.ts's markdownToTelegramHtml
// + Telegram's own round trip would produce it (see checklist.ts's module
// doc comment: checked-state lives in the BUTTON label, never in the text
// itself). `built.text` (the pre-send markdown SOURCE, still carrying literal
// `~~`) is what gets sent, not what comes back — feeding it straight back in
// for a second toggle would simulate the wrong thing. This helper reproduces
// the real round trip for multi-toggle tests.
function telegramPlainText(built: { header: string; items: ChecklistItem[] }): string {
  return renderChecklistSource(built.header, built.items.map(i => ({ ...i, checked: false })))
}

describe('buildChecklist — render', () => {
  test('N items produce N single-button rows, all unchecked', () => {
    const built = buildChecklist('🎒 Packing:', ['helmet', 'gloves', 'boots'])
    expect(built.keyboard.length).toBe(3)
    for (const row of built.keyboard) expect(row.length).toBe(1)
    expect(built.keyboard[0][0].text).toBe(`${CHECKLIST_MARKS.unchecked} helmet`)
    expect(built.keyboard[1][0].text).toBe(`${CHECKLIST_MARKS.unchecked} gloves`)
    expect(built.keyboard[2][0].text).toBe(`${CHECKLIST_MARKS.unchecked} boots`)
  })

  test('callback_data is chk:<index>, in item order', () => {
    const built = buildChecklist('', ['a', 'b', 'c'])
    expect(built.keyboard.map(r => r[0].callback_data)).toEqual(['chk:0', 'chk:1', 'chk:2'])
  })

  test('header + items joined with a blank separator line in the source text', () => {
    const built = buildChecklist('Shopping list', ['milk', 'eggs'])
    expect(built.text).toBe('Shopping list\n\nmilk\neggs')
  })

  test('blank/whitespace header is omitted entirely (no stray separator line)', () => {
    const built = buildChecklist('   ', ['milk', 'eggs'])
    expect(built.text).toBe('milk\neggs')
  })

  test('empty checklist array throws', () => {
    expect(() => buildChecklist('title', [])).toThrow(/at least one item/)
  })

  test('more than MAX_ITEMS throws', () => {
    const many = Array.from({ length: MAX_ITEMS + 1 }, (_, i) => `item ${i}`)
    expect(() => buildChecklist('', many)).toThrow(/exceeds Telegram's/)
  })

  test('an item that is empty after trimming throws (points at the offending index)', () => {
    expect(() => buildChecklist('', ['ok', '   ', 'also ok'])).toThrow(/item 1 is empty/)
  })

  test('embedded newlines in an item are flattened to a single line', () => {
    const built = buildChecklist('', ['line one\nline two'])
    expect(built.items[0].text).toBe('line one line two')
    expect(built.text.split('\n').length).toBe(1)
  })
})

describe('buttonLabel — truncation', () => {
  test('short text is not truncated', () => {
    expect(buttonLabel('milk', false)).toBe('☐ milk')
    expect(buttonLabel('milk', true)).toBe('✅ milk')
  })

  test('a label over 64 chars is truncated with an ellipsis, never exceeding the cap', () => {
    const long = 'x'.repeat(100)
    const label = buttonLabel(long, false)
    expect(label.length).toBeLessThanOrEqual(64)
    expect(label.endsWith('…')).toBe(true)
    expect(label.startsWith('☐ ')).toBe(true)
  })

  test('truncateForButton is deterministic (same input → same output, used by both render and parse)', () => {
    const a = truncateForButton('✅', 'y'.repeat(90))
    const b = truncateForButton('✅', 'y'.repeat(90))
    expect(a).toBe(b)
  })
})

describe('toggle on / toggle off (via applyToggle, the cold re-parse path)', () => {
  test('toggling an unchecked item checks it: button mark flips, text line gets struck through', () => {
    const built = buildChecklist('List', ['buy milk', 'buy eggs'])
    const r1 = applyToggle(built.text, built.keyboard, 0)
    expect(r1.ok).toBe(true)
    if (!r1.ok) return
    expect(r1.built.items[0].checked).toBe(true)
    expect(r1.built.items[1].checked).toBe(false)
    expect(r1.built.keyboard[0][0].text).toBe('✅ buy milk')
    expect(r1.built.text).toContain('~~buy milk~~')
    expect(r1.built.text).toContain('buy eggs') // untouched, not wrapped
    expect(r1.built.text).not.toContain('~~buy eggs~~')
  })

  test('toggling an already-checked item unchecks it (round trip back to the original render)', () => {
    const built = buildChecklist('List', ['buy milk'])
    const r1 = applyToggle(built.text, built.keyboard, 0)
    expect(r1.ok).toBe(true)
    if (!r1.ok) return
    // Simulate Telegram handing the SECOND tap's update back to us — the
    // strikethrough is an entity, not literal `~~`, by the time it round-trips.
    const r2 = applyToggle(telegramPlainText(r1.built), r1.built.keyboard, 0)
    expect(r2.ok).toBe(true)
    if (!r2.ok) return
    expect(r2.built.items[0].checked).toBe(false)
    expect(r2.built.text).toBe(built.text)
    expect(r2.built.keyboard).toEqual(built.keyboard)
  })

  test('CONTRACT: feeding the pre-send markdown source (still carrying literal ~~) back in fails safe rather than corrupting the item text', () => {
    // Documents why telegramPlainText() above is necessary: applyToggle's
    // `text` argument must be Telegram's OWN post-round-trip plain text.
    const built = buildChecklist('List', ['buy milk'])
    const r1 = applyToggle(built.text, built.keyboard, 0)
    expect(r1.ok).toBe(true)
    if (!r1.ok) return
    const wrong = applyToggle(r1.built.text, r1.built.keyboard, 0) // r1.built.text, NOT telegramPlainText()
    expect(wrong.ok).toBe(false)
  })

  test('toggling one item leaves every other item and the header untouched', () => {
    const built = buildChecklist('🎒 Packing', ['helmet', 'gloves', 'boots'])
    const r = applyToggle(built.text, built.keyboard, 1)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.built.header).toBe('🎒 Packing')
    expect(r.built.items[0].checked).toBe(false)
    expect(r.built.items[1].checked).toBe(true)
    expect(r.built.items[2].checked).toBe(false)
  })
})

describe('out-of-range / garbage callback data', () => {
  test('parseCallbackData accepts chk:<digits> only', () => {
    expect(parseCallbackData('chk:0')).toBe(0)
    expect(parseCallbackData('chk:12')).toBe(12)
  })

  test('parseCallbackData rejects non-checklist / malformed data', () => {
    expect(parseCallbackData('perm:allow:abcde')).toBeNull()
    expect(parseCallbackData('chk:')).toBeNull()
    expect(parseCallbackData('chk:-1')).toBeNull()
    expect(parseCallbackData('chk:abc')).toBeNull()
    expect(parseCallbackData('chk:1x')).toBeNull()
    expect(parseCallbackData('')).toBeNull()
    expect(parseCallbackData('garbage')).toBeNull()
  })

  test('an out-of-range index fails safe (no throw, no item touched)', () => {
    const built = buildChecklist('', ['only item'])
    const r = applyToggle(built.text, built.keyboard, 5)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toMatch(/out of range/)
  })

  test('a negative or non-integer index fails safe via toggleChecklistItem directly', () => {
    const parsed = parseChecklistMessage('x', [[{ text: '☐ x' }]])
    expect(toggleChecklistItem(parsed, -1).ok).toBe(false)
    expect(toggleChecklistItem(parsed, 1.5).ok).toBe(false)
    expect(toggleChecklistItem(parsed, 99).ok).toBe(false)
  })
})

describe('fail-safe on a message edited out from under us', () => {
  test('a keyboard row with 2 buttons is not recognized as a checklist keyboard', () => {
    const foreign: IncomingKeyboard = [[{ text: 'A' }, { text: 'B' }]]
    const parsed = parseChecklistMessage('A\nB', foreign)
    expect(parsed.ok).toBe(false)
  })

  test('an empty keyboard is not recognized as a checklist keyboard', () => {
    const parsed = parseChecklistMessage('hello', [])
    expect(parsed.ok).toBe(false)
  })

  test('a button label with no recognized mark fails safe', () => {
    const parsed = parseChecklistMessage('milk', [[{ text: 'milk' }]])
    expect(parsed.ok).toBe(false)
  })

  test('fewer text lines than buttons (message text was edited shorter) fails safe', () => {
    const parsed = parseChecklistMessage('', [
      [{ text: '☐ milk' }],
      [{ text: '☐ eggs' }],
    ])
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.reason).toMatch(/fewer text lines/)
  })

  test('an item text line edited to no longer match its button label fails safe', () => {
    // Built normally, then simulate an external edit of the SECOND item's
    // text line without touching the keyboard.
    const built = buildChecklist('', ['milk', 'eggs'])
    const editedText = built.text.replace('eggs', 'SOMETHING ELSE')
    const parsed = parseChecklistMessage(editedText, built.keyboard)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.reason).toMatch(/item 1/)
  })

  test('applyToggle on a corrupted message returns ok:false, never throws', () => {
    expect(() => applyToggle('garbage', [], 0)).not.toThrow()
    const r = applyToggle('garbage', [], 0)
    expect(r.ok).toBe(false)
  })
})

describe('round trip integrity with long items (truncated button labels)', () => {
  test('a very long item still parses and toggles correctly despite its truncated button label', () => {
    const long = 'buy a very long list of groceries that will not fit on a single telegram button label at all'
    const built = buildChecklist('', [long])
    // Sanity: the button really was truncated (source text line was not).
    expect(built.keyboard[0][0].text.length).toBeLessThanOrEqual(64)
    expect(built.text).toContain(long)

    const r = applyToggle(built.text, built.keyboard, 0)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.built.items[0].checked).toBe(true)
    expect(r.built.items[0].text).toBe(long) // full text preserved, not the truncated label
  })
})

describe('sanitizeItemText', () => {
  test('trims leading/trailing whitespace', () => {
    expect(sanitizeItemText('  hello  ')).toBe('hello')
  })

  test('flattens embedded newlines (both \\n and \\r\\n) to a single space', () => {
    expect(sanitizeItemText('a\nb')).toBe('a b')
    expect(sanitizeItemText('a\r\nb')).toBe('a b')
  })
})

describe('renderChecklist — message-size guard', () => {
  test('an over-long rendered message throws rather than silently truncating', () => {
    const items = Array.from({ length: 50 }, () => ({ text: 'x'.repeat(90), checked: false }))
    expect(() => renderChecklist('', items)).toThrow(/exceeds Telegram's/)
  })
})

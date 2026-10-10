// Regression (BACKLOG «БЛОК · ДОРАБОТКИ ПЛАГИНА TELEGRAM» п.2, 09.10): the
// reply_to_text / reply_to_quote snippets were cut with .slice(0, 300) — 300
// UTF-16 code units — and an emoji sitting on unit 300 left a lone high
// surrogate in the envelope; the owner-log night sweep then crashed on it
// (UnicodeEncodeError, msg 29542, 08.10).
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { clipUtf16 } from './text-clip'

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

describe('clipUtf16 — never cuts a character in half', () => {
  test('emoji straddling the limit is dropped whole, not halved (the 08.10 case)', () => {
    const s = 'a'.repeat(299) + '😀' + 'tail' // 😀 = units 299..300
    expect(s.slice(0, 300)).toMatch(LONE_SURROGATE) // the old behaviour, for the record
    const out = clipUtf16(s, 300)
    expect(out).toBe('a'.repeat(299))
    expect(out).not.toMatch(LONE_SURROGATE)
    expect(() => new TextEncoder().encode(out)).not.toThrow()
    expect(new TextDecoder('utf-8', { fatal: true }).decode(new TextEncoder().encode(out))).toBe(out)
  })

  test('emoji ending exactly on the limit is kept', () => {
    const s = 'a'.repeat(298) + '😀' + 'tail'
    expect(clipUtf16(s, 300)).toBe('a'.repeat(298) + '😀')
  })

  test('short text and undefined pass through unchanged', () => {
    expect(clipUtf16('привет 👋', 300)).toBe('привет 👋')
    expect(clipUtf16(undefined, 300)).toBeUndefined()
    expect(clipUtf16('', 300)).toBe('')
  })

  test('every cut point of an emoji-dense string is well-formed and within the limit', () => {
    const s = '👨‍👩‍👧 ok 😀😀 д 🇮🇩'.repeat(40)
    for (let n = 0; n <= 120; n++) {
      const out = clipUtf16(s, n)!
      expect(out.length).toBeLessThanOrEqual(n)
      expect(out).not.toMatch(LONE_SURROGATE)
      expect(s.startsWith(out)).toBe(true)
    }
  })
})

// server.ts has top-level side effects (cannot be imported in a test), so its
// wiring is checked on the source: both reply snippets go through clipUtf16,
// and the inbound envelope spreads forwardDateMeta.
describe('server.ts wiring', () => {
  const src = readFileSync(join(import.meta.dir, 'server.ts'), 'utf8')

  test('no reply snippet is cut with a raw .slice(0, 300)', () => {
    expect(src).not.toMatch(/\?\.slice\(0, 300\)/)
    expect(src).toContain('clipUtf16(safeName(repliedTo.text ?? repliedTo.caption), 300)')
    expect(src).toContain('clipUtf16(safeName(ctx.message?.quote?.text), 300)')
  })

  test('the inbound envelope carries forwardDateMeta for every forward', () => {
    expect(src).toContain('...forwardDateMeta(ctx.message?.forward_origin)')
    expect(src).toMatch(/\.\.\.forwardMeta,/)
  })
})

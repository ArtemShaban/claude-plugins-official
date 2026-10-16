// D-528(b) AC-10 at the call sites: in locked mode the owner id for the secretary and for
// voice trust comes only from the lock (lockOwnerId), never from config.json's id read at
// start (OWNER_TG_ID). The helper has its own tests (access-lock.test.ts); these source-text
// checks pin the two server.ts lines that wire it, in the style of no-old-name.test.ts.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const SRC = readFileSync(join(import.meta.dir, 'server.ts'), 'utf8')
const LOCK_CALL = 'lockOwnerId(ACCESS_LOCK, readLockedAccess, OWNER_TG_ID)'

function block(start: string, end: string): string {
  const i = SRC.indexOf(start)
  expect(i).toBeGreaterThanOrEqual(0)
  const j = SRC.indexOf(end, i)
  expect(j).toBeGreaterThan(i)
  return SRC.slice(i, j)
}

describe('owner id call sites in server.ts (AC-10)', () => {
  test('the secretary gets its ownerId from lockOwnerId', () => {
    const b = block('const secretary = createSecretary({', '\n})')
    const lines = b.split('\n').filter(l => /^\s*ownerId\s*:/.test(l))
    expect(lines.map(l => l.trim())).toEqual([`ownerId: ${LOCK_CALL},`])
  })

  test('voiceOwnerId returns lockOwnerId', () => {
    const b = block('function voiceOwnerId(): string | undefined {', '\n}')
    expect(b).toContain(`return ${LOCK_CALL}`)
  })

  test('the voice branch takes its owner id from voiceOwnerId()', () => {
    const b = block("if (attachment?.kind === 'voice') {", 'const lang =')
    expect(b).toContain('const ownerId = voiceOwnerId()')
    expect(b).toContain('const ownerSent = ownerId != null && String(from.id) === ownerId')
    expect(b).toMatch(/voiceAuthor\(\{[^}]*\}, ownerId\)/)
  })

  test('OWNER_TG_ID is used only in its declaration, the !OWNER_TG_ID warning and lockOwnerId calls', () => {
    const rest = SRC
      .split(LOCK_CALL).join('')
      .replace('const { chatId: OWNER_TG_ID,', '')
      .replace('if (!OWNER_TG_ID) {', '')
    const left = rest.split('\n').map((l, i) => [i + 1, l] as const).filter(([, l]) => l.includes('OWNER_TG_ID'))
    expect(left).toEqual([])
  })
})

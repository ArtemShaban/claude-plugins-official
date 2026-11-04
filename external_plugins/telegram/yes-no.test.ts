// «Да / Нет» buttons (D-890; spec sam-data dev/analysis/2026-11-01-yes-no-buttons-spec.md).
// Unit tests of yes-no.ts + source-text pins of its two server.ts call sites (style of
// access-lock.callsites.test.ts). STATE ISOLATION: config.json lives in a mkdtemp HOME.

import { describe, expect, test } from 'bun:test'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir, tmpdir } from 'os'
import {
  answeredKeyboard,
  handleYesNoPress,
  parseCoOwners,
  parseYesNoData,
  readCoOwners,
  wantsYesNo,
  yesNoButtonsOn,
  yesNoKeyboard,
  type PressDeps,
  type PressInput,
} from './yes-no'

const OWNER = 111222333
const OTHER = 444555666
const CO = 777888999

function home(overrides: unknown): string {
  const h = mkdtempSync(join(tmpdir(), 'yn-home-'))
  const d = join(h, 'Workspace', 'ClaudeProjects', 'sam-data')
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, 'config.json'), JSON.stringify({ user: { telegram_chat_id: String(OWNER) }, overrides }))
  return h
}

// The switch is the core setting `yes-no-buttons`: core default (tools/config-defaults.json)
// ⊕ the person's override, resolved by core itself (`tools/sam_data.py config-get`; owner tg
// 41857). The tests run the REAL sam_data.py, copied into a temp core next to a crafted defaults
// file, under a temp HOME — never the live sam-data. Source of sam_data.py: SAM_CORE_DIR, else
// ~/Workspace/ClaudeProjects/sam-core; neither present → the block is skipped (named reason).
const REAL_CORE = Bun.env.SAM_CORE_DIR || join(homedir(), 'Workspace', 'ClaudeProjects', 'sam-core')
const REAL_SAM_DATA = join(REAL_CORE, 'tools', 'sam_data.py')
const HAVE_CORE = existsSync(REAL_SAM_DATA)
if (!HAVE_CORE) console.warn(`yes-no.test: SKIP switch block — no core sam_data.py at ${REAL_SAM_DATA}`)

/** temp HOME with sam-data config.json (`overrides`) and a temp core whose default is `def`
 * (`'broken'` → an invalid defaults file; `'none'` → no core at all). */
function install(overrides: unknown, def: boolean | 'broken' | 'none'): string {
  const h = home(overrides)
  if (def === 'none') return h
  const tools = join(h, 'Workspace', 'ClaudeProjects', 'sam-core', 'tools')
  mkdirSync(tools, { recursive: true })
  copyFileSync(REAL_SAM_DATA, join(tools, 'sam_data.py'))
  const defaults = def === 'broken'
    ? '{not json'
    : JSON.stringify({ defaults: { 'yes-no-buttons': { value: def, what: 'w', why: 'w' } }, known_exceptions: [] })
  writeFileSync(join(tools, 'config-defaults.json'), defaults)
  return h
}

describe.skipIf(!HAVE_CORE)('switch = core default ⊕ override (AC-1/AC-2 inputs; tg 41857)', () => {
  test('no override + default on → buttons (the client case)', () => {
    expect(yesNoButtonsOn(install({}, true))).toBe(true)
    expect(yesNoButtonsOn(install(undefined, true))).toBe(true)
  })
  test('override false wins over default on → no buttons', () => {
    expect(yesNoButtonsOn(install({ 'yes-no-buttons': false }, true))).toBe(false)
  })
  test('override true wins over default off → buttons', () => {
    expect(yesNoButtonsOn(install({ 'yes-no-buttons': true }, false))).toBe(true)
  })
  test('no override + default off → no buttons', () => {
    expect(yesNoButtonsOn(install({}, false))).toBe(false)
  })
  test('an invalid override is ignored the way core ignores it → the default applies', () => {
    expect(yesNoButtonsOn(install({ 'yes-no-buttons': 'false' }, true))).toBe(true)
  })
  test('resolution error → no buttons (plain text): defaults unreadable, no core, no sam-data', () => {
    expect(yesNoButtonsOn(install({ 'yes-no-buttons': true }, 'broken'))).toBe(false)
    expect(yesNoButtonsOn(install({ 'yes-no-buttons': true }, 'none'))).toBe(false)
    expect(yesNoButtonsOn(mkdtempSync(join(tmpdir(), 'yn-empty-')))).toBe(false)
  })
})

describe('keyboard (AC-1)', () => {
  test('one row, exactly «Да» «Нет»', () => {
    expect(yesNoKeyboard()).toEqual([[{ text: 'Да', callback_data: 'yn:y' }, { text: 'Нет', callback_data: 'yn:n' }]])
  })
  test('answered = one inert button', () => {
    expect(answeredKeyboard('y')).toEqual([[{ text: '✅ Да', callback_data: 'yn:x' }]])
    expect(answeredKeyboard('n')).toEqual([[{ text: '❌ Нет', callback_data: 'yn:x' }]])
  })
  test('callback data', () => {
    expect(parseYesNoData('yn:y')).toBe('y')
    expect(parseYesNoData('yn:n')).toBe('n')
    expect(parseYesNoData('yn:x')).toBe('x')
    expect(parseYesNoData('chk:1')).toBeNull()
    expect(parseYesNoData('yn:yy')).toBeNull()
  })
})

describe('wantsYesNo (AC-3)', () => {
  test('absent / false → no buttons', () => {
    expect(wantsYesNo({})).toBe(false)
    expect(wantsYesNo({ yes_no: false, files: ['/x.png'] })).toBe(false)
  })
  test('true alone → buttons', () => {
    expect(wantsYesNo({ yes_no: true, files: [], checklist: [] })).toBe(true)
  })
  test('with checklist → refused', () => {
    expect(() => wantsYesNo({ yes_no: true, checklist: ['a'] })).toThrow(/checklist/)
  })
  test('with files → refused', () => {
    expect(() => wantsYesNo({ yes_no: true, files: ['/a.png'] })).toThrow(/files/)
  })
  test('with voice → refused', () => {
    expect(() => wantsYesNo({ yes_no: true, voice: true })).toThrow(/voice/)
  })
  test('with secretary → refused', () => {
    expect(() => wantsYesNo({ yes_no: true, as_owner_to: '777' })).toThrow(/as_owner_to/)
  })
  test('non-boolean → refused', () => {
    expect(() => wantsYesNo({ yes_no: 'true' })).toThrow(/boolean/)
  })
})

function deps(ownerId: string | undefined = String(OWNER), coOwners: () => ReadonlySet<string> = () => new Set()) {
  const calls = { answer: [] as string[], edit: [] as unknown[], notify: [] as { content: string; meta: Record<string, string> }[], errors: [] as string[] }
  const d: PressDeps = {
    ownerId,
    coOwners,
    answer: async t => { calls.answer.push(t) },
    editMarkup: async k => { calls.edit.push(k) },
    notify: async n => { calls.notify.push(n) },
    now: () => new Date('2026-11-01T10:00:00.000Z'),
    logError: l => { calls.errors.push(l) },
  }
  return { d, calls }
}

function press(data: string, fromId: number, chat: { id: number; type: string } | null, messageId = 501): PressInput {
  return { data, from: { id: fromId, username: 'artem' }, ...(chat ? { message: { message_id: messageId, chat } } : {}) }
}

describe('press acceptance (AC-4)', () => {
  const cases: [string, PressInput, string | undefined][] = [
    ['another allowlisted DM id', press('yn:y', OTHER, { id: OTHER, type: 'private' }), String(OWNER)],
    ['the owner pressing in a group', press('yn:y', OWNER, { id: -100123, type: 'supergroup' }), String(OWNER)],
    ['an unknown id in the owner DM', press('yn:y', OTHER, { id: OWNER, type: 'private' }), String(OWNER)],
    ['missing message', press('yn:y', OWNER, null), String(OWNER)],
    ['no owner configured', press('yn:y', OWNER, { id: OWNER, type: 'private' }), ''],
  ]
  for (const [name, p, owner] of cases) {
    test(`${name} → toast, no notification, no edit`, async () => {
      const { d, calls } = deps(owner)
      expect(await handleYesNoPress(p, d)).toBe(true)
      expect(calls.notify).toEqual([])
      expect(calls.edit).toEqual([])
      expect(calls.answer.length).toBe(1)
    })
  }
  test('non-yes/no data → not handled, nothing called', async () => {
    const { d, calls } = deps()
    expect(await handleYesNoPress(press('chk:0', OWNER, { id: OWNER, type: 'private' }), d)).toBe(false)
    expect(calls).toEqual({ answer: [], edit: [], notify: [], errors: [] })
  })
})

describe('accepted press (AC-5)', () => {
  for (const [data, glyph, label, inert] of [
    ['yn:y', '👍', 'Да', '✅ Да'],
    ['yn:n', '👎', 'Нет', '❌ Нет'],
  ] as const) {
    test(`${label} → one reaction envelope with via=button, keyboard → inert`, async () => {
      const { d, calls } = deps()
      expect(await handleYesNoPress(press(data, OWNER, { id: OWNER, type: 'private' }), d)).toBe(true)
      expect(calls.notify).toEqual([
        {
          content: `(button on message 501: ${label})`,
          meta: {
            event: 'reaction',
            chat_id: String(OWNER),
            message_id: '501',
            user: 'artem',
            user_id: String(OWNER),
            ts: '2026-11-01T10:00:00.000Z',
            reaction_added: glyph,
            via: 'button',
          },
        },
      ])
      expect(calls.edit).toEqual([[[{ text: inert, callback_data: 'yn:x' }]]])
      expect(calls.answer).toEqual([inert])
    })
  }
  test('tap on the inert button → toast only', async () => {
    const { d, calls } = deps()
    await handleYesNoPress(press('yn:x', OWNER, { id: OWNER, type: 'private' }), d)
    expect(calls.notify).toEqual([])
    expect(calls.edit).toEqual([])
    expect(calls.answer).toEqual(['Already answered.'])
  })
  test('edit failure never blocks the event', async () => {
    const { d, calls } = deps()
    d.editMarkup = async () => { throw new Error('400 message is not modified') }
    await handleYesNoPress(press('yn:y', OWNER, { id: OWNER, type: 'private' }), d)
    expect(calls.notify.length).toBe(1)
    expect(calls.errors.length).toBe(1)
  })
})

// Co-owner press (spec sam-data dev/analysis/2026-11-04-yes-no-co-owner-spec.md). The admin's file
// lives in a mkdtemp dir; read fresh per press through the real reader. Fixture ids only (AC-6).
function coFile(content: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'yn-co-'))
  const f = join(dir, 'co-owners')
  if (content != null) writeFileSync(f, content)
  return f
}
function fileDeps(f: string, ownerId: string | undefined = String(OWNER)) {
  const errors: string[] = []
  const r = deps(ownerId, () => readCoOwners(f, l => { errors.push(l) }))
  return { d: r.d, calls: r.calls, readerErrors: errors }
}

describe('parseCoOwners (CLAUDE.md §4 rules, mirror of status Mini App parse_co_owners)', () => {
  test('one id per line, trimmed, trailing newline ok', () => {
    expect([...parseCoOwners(` ${CO} \n${OTHER}\n`).ids].sort()).toEqual([String(OTHER), String(CO)].sort())
  })
  test('empty file → none, no fault', () => {
    expect(parseCoOwners('')).toEqual({ ids: new Set(), fault: null })
  })
  for (const bad of ['0123456', 'abc', '1234', '123456789012345678901', `${CO} ${OTHER}`, '']) {
    test(`a bad line ${JSON.stringify(bad)} next to a valid one → none at all`, () => {
      const r = parseCoOwners(`${CO}\n${bad}\n${OTHER}\n`)
      expect(r.ids.size).toBe(0)
      expect(r.fault).toBe('co_owners_bad_line')
    })
  }
  test('5 and 20 digits are valid', () => {
    expect(parseCoOwners('12345\n12345678901234567890').ids.size).toBe(2)
  })
})

describe('co-owner press (spec 2026-11-04 AC-1..AC-4)', () => {
  for (const [data, glyph, label, inert] of [
    ['yn:y', '👍', 'Да', '✅ Да'],
    ['yn:n', '👎', 'Нет', '❌ Нет'],
  ] as const) {
    test(`AC-1: listed co-owner pressing ${label} in his own DM → one reaction event`, async () => {
      const { d, calls } = fileDeps(coFile(`${CO}\n`))
      expect(await handleYesNoPress(press(data, CO, { id: CO, type: 'private' }), d)).toBe(true)
      expect(calls.notify).toEqual([
        {
          content: `(button on message 501: ${label})`,
          meta: {
            event: 'reaction',
            chat_id: String(CO),
            message_id: '501',
            user: 'artem',
            user_id: String(CO),
            ts: '2026-11-01T10:00:00.000Z',
            reaction_added: glyph,
            via: 'button',
          },
        },
      ])
      expect(calls.edit).toEqual([[[{ text: inert, callback_data: 'yn:x' }]]])
      expect(calls.answer).toEqual([inert])
    })
  }
  test('AC-2: owner still accepted when the file is absent (owner install: no /etc dir)', async () => {
    const { d, calls, readerErrors } = fileDeps(coFile(null))
    await handleYesNoPress(press('yn:y', OWNER, { id: OWNER, type: 'private' }), d)
    expect(calls.notify.length).toBe(1)
    expect(readerErrors).toEqual([])
  })
  test('AC-2: owner still accepted when the file is malformed', async () => {
    const { d, calls } = fileDeps(coFile('abc\n'))
    await handleYesNoPress(press('yn:y', OWNER, { id: OWNER, type: 'private' }), d)
    expect(calls.notify.length).toBe(1)
  })
  const own = { id: CO, type: 'private' }
  const refused: [string, string | Buffer | null, PressInput][] = [
    ['an allowlisted DM id not in the file', `${CO}\n`, press('yn:y', OTHER, { id: OTHER, type: 'private' })],
    ['a co-owner pressing in a group', `${CO}\n`, press('yn:y', CO, { id: -100123, type: 'supergroup' })],
    ["a co-owner pressing in another person's DM", `${CO}\n`, press('yn:y', CO, { id: OWNER, type: 'private' })],
    ['file absent', null, press('yn:y', CO, own)],
    ['file empty', '', press('yn:y', CO, own)],
    ['bad line 0123456 next to the co-owner', `${CO}\n0123456\n`, press('yn:y', CO, own)],
    ['bad line abc next to the co-owner', `${CO}\nabc\n`, press('yn:y', CO, own)],
    ['bad line 1234 next to the co-owner', `${CO}\n1234\n`, press('yn:y', CO, own)],
    ['a 21-digit id next to the co-owner', `${CO}\n123456789012345678901\n`, press('yn:y', CO, own)],
    ['two ids on one line', `${CO} ${OTHER}\n`, press('yn:y', CO, own)],
    ['not UTF-8', Buffer.from([0x37, 0x37, 0xff, 0xfe, 0x0a]), press('yn:y', CO, own)],
    ['larger than 4096 bytes (a cut line could read as another id)', `${CO}\n`.repeat(500), press('yn:y', CO, own)],
  ]
  for (const [name, content, p] of refused) {
    test(`AC-3: ${name} → «Not authorized.», no event, no edit`, async () => {
      const f = coFile(null)
      if (content != null) writeFileSync(f, content)
      const { d, calls } = fileDeps(f)
      expect(await handleYesNoPress(p, d)).toBe(true)
      expect(calls.notify).toEqual([])
      expect(calls.edit).toEqual([])
      expect(calls.answer).toEqual(['Not authorized.'])
    })
  }
  test('AC-3: file unreadable → refused + one stderr line', async () => {
    const f = coFile(null)
    mkdirSync(f) // a directory where the file should be: reading fails (EISDIR) even as root
    const { d, calls, readerErrors } = fileDeps(f)
    await handleYesNoPress(press('yn:y', CO, own), d)
    expect(calls.notify).toEqual([])
    expect(calls.answer).toEqual(['Not authorized.'])
    expect(readerErrors.length).toBe(1)
  })
  test('AC-4: fresh read — refused, accepted after add, refused after remove, same deps', async () => {
    const f = coFile('')
    const { d, calls } = fileDeps(f)
    const p = press('yn:y', CO, own)
    await handleYesNoPress(p, d)
    writeFileSync(f, `${CO}\n`)
    await handleYesNoPress(p, d)
    writeFileSync(f, '')
    await handleYesNoPress(p, d)
    expect(calls.notify.length).toBe(1)
    expect(calls.answer).toEqual(['Not authorized.', '✅ Да', 'Not authorized.'])
  })
})

// Source pins: the wiring in server.ts (the handler itself is unit-tested above).
const SRC = readFileSync(join(import.meta.dir, 'server.ts'), 'utf8')
function block(start: string, end: string): string {
  const i = SRC.indexOf(start)
  expect(i).toBeGreaterThanOrEqual(0)
  const j = SRC.indexOf(end, i)
  expect(j).toBeGreaterThan(i)
  return SRC.slice(i, j)
}

describe('server.ts call sites', () => {
  test('AC-6: the press branch reaches neither the secretary nor the signed approval channel', () => {
    const b = block('const yesNoHandled = await handleYesNoPress(', 'if (yesNoHandled) return')
    expect(b).not.toContain('secretary')
    expect(b).not.toContain('emitApprovalSignal')
    expect(b).toContain('ownerId: lockOwnerId(ACCESS_LOCK, readLockedAccess, OWNER_TG_ID)')
    expect(b).toContain('coOwners: () => readCoOwners(CO_OWNERS_FILE,')
  })
  test('AC-6: the press branch runs before the checklist branch, inside the callback handler', () => {
    const b = block("bot.on('callback_query:data'", 'parseChecklistCallbackData(data)')
    expect(b).toContain('if (yesNoHandled) return')
  })
  test('AC-1: the keyboard goes on the last chunk only, and only when the switch is on', () => {
    expect(SRC).toContain('...(yesNoOn && i === chunks.length - 1 ? { reply_markup: { inline_keyboard: yesNoKeyboard() } } : {}),')
    expect(SRC).toContain('const yesNoOn = yesNo && yesNoButtonsOn(homedir())')
  })
  test('AC-3: the arg check runs before the secretary and checklist branches', () => {
    const i = SRC.indexOf('const yesNo = wantsYesNo(')
    expect(i).toBeGreaterThan(0)
    expect(i).toBeLessThan(SRC.indexOf('if (args.as_owner_to != null) {'))
    expect(i).toBeLessThan(SRC.indexOf('if (args.checklist != null) {'))
  })
  test('AC-2: the result names the switch state; result still starts with "sent"', () => {
    expect(SRC).toContain('const yesNoNote = yesNo ? (yesNoOn ? SUFFIX_ON : SUFFIX_OFF) : \'\'')
    expect(SRC).toContain("text: result + voiceNote + yesNoNote")
  })
})

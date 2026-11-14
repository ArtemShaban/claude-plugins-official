// «Да / Нет» buttons (D-890; spec sam-data dev/analysis/2026-11-01-yes-no-buttons-spec.md).
// Unit tests of yes-no.ts + source-text pins of its two server.ts call sites (style of
// access-lock.callsites.test.ts). STATE ISOLATION: config.json lives in a mkdtemp HOME.

import { describe, expect, test } from 'bun:test'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir, tmpdir } from 'os'
import {
  answeredKeyboard,
  buttonsCanCount,
  createButtonsLog,
  doneKeyboard,
  pressCounts,
  SUFFIX_DONE_NOT_HERE,
  SUFFIX_NOT_HERE,
  type ButtonLineFields,
  type PressAccess,
  handleYesNoPress,
  SUFFIX_DONE_OFF,
  SUFFIX_DONE_ON,
  wantsDoneButton,
  parseCoOwners,
  parseYesNoData,
  readCoOwners,
  wantsYesNo,
  yesNoButtonsOn,
  yesNoKeyboard,
  type PressDeps,
  type PressInput,
} from './yes-no'
import { UI_CAPTIONS, type UiLang, uiLang, uiLangOf } from './ui-lang'

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
    expect(yesNoKeyboard('ru')).toEqual([[{ text: 'Да', callback_data: 'yn:y' }, { text: 'Нет', callback_data: 'yn:n' }]])
  })
  test('answered = one inert button', () => {
    expect(answeredKeyboard('y', 'ru')).toEqual([[{ text: '✅ Да', callback_data: 'yn:x' }]])
    expect(answeredKeyboard('n', 'ru')).toEqual([[{ text: '❌ Нет', callback_data: 'yn:x' }]])
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

function deps(ownerId: string | undefined = String(OWNER), coOwners: () => ReadonlySet<string> = () => new Set(), lang: UiLang = 'ru',
              access: PressAccess = { groups: {} }) {
  const calls = { answer: [] as string[], edit: [] as unknown[], notify: [] as { content: string; meta: Record<string, string> }[], errors: [] as string[] }
  const d: PressDeps = {
    ownerId,
    lang,
    coOwners,
    access: () => access,
    answer: async t => { calls.answer.push(t) },
    editMarkup: async k => { calls.edit.push(k) },
    notify: async n => { calls.notify.push(n) },
    now: () => new Date('2026-11-01T10:00:00.000Z'),
    logError: l => { calls.errors.push(l) },
  }
  return { d, calls }
}

// The message as Telegram returns it with the press: it carries the keyboard that was sent (default «Да» «Нет»).
function press(data: string, fromId: number, chat: { id: number; type: string } | null, messageId = 501,
               keyboard: { text: string; callback_data?: string }[][] | null = yesNoKeyboard('ru')): PressInput {
  return {
    data,
    from: { id: fromId, username: 'artem' },
    ...(chat ? { message: { message_id: messageId, chat, ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}) } } : {}),
  }
}

describe('press acceptance (AC-4)', () => {
  const cases: [string, PressInput, string | undefined][] = [
    ['another allowlisted DM id', press('yn:y', OTHER, { id: OTHER, type: 'private' }), String(OWNER)],
    ['the owner pressing in a group not in the access list', press('yn:y', OWNER, { id: -100999, type: 'supergroup' }), String(OWNER)],
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
    expect(calls.answer).toEqual(['Уже ответили.'])
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
    ['a co-owner pressing in a group not in the access list', `${CO}\n`, press('yn:y', CO, { id: -100999, type: 'supergroup' })],
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
      expect(calls.answer).toEqual(['Нет доступа.'])
    })
  }
  test('AC-3: file unreadable → refused + one stderr line', async () => {
    const f = coFile(null)
    mkdirSync(f) // a directory where the file should be: reading fails (EISDIR) even as root
    const { d, calls, readerErrors } = fileDeps(f)
    await handleYesNoPress(press('yn:y', CO, own), d)
    expect(calls.notify).toEqual([])
    expect(calls.answer).toEqual(['Нет доступа.'])
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
    expect(calls.answer).toEqual(['Нет доступа.', '✅ Да', 'Нет доступа.'])
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
    expect(SRC).toContain('...(yesNoOn && i === chunks.length - 1 ? { reply_markup: { inline_keyboard: yesNoKeyboard(uiLangOf(homedir())) } } : {}),')
    expect(SRC).toContain('const yesNoHere = yesNo && buttonsCountIn(chat_id)')
    expect(SRC).toContain('const yesNoOn = yesNoHere && yesNoButtonsOn(homedir())')
  })
  test('AC-3: the arg check runs before the secretary and checklist branches', () => {
    const i = SRC.indexOf('const yesNo = wantsYesNo(')
    expect(i).toBeGreaterThan(0)
    expect(i).toBeLessThan(SRC.indexOf('if (args.as_owner_to != null) {'))
    expect(i).toBeLessThan(SRC.indexOf('if (args.checklist != null) {'))
  })
  test('AC-2: the result names the switch state; result still starts with "sent"', () => {
    expect(SRC).toContain('const yesNoNote = yesNo ? (yesNoOn ? SUFFIX_ON : !yesNoHere ? SUFFIX_NOT_HERE : SUFFIX_OFF) : \'\'')
    expect(SRC).toContain("text: result + voiceNote + yesNoNote")
  })
})

// «Готово» button (buttons spec sam-data dev/analysis/2026-11-08-buttons-da-gotovo-spec.md §2.4, §5, AC-06):
// one button under a «do X, tell me» message; a press = ✅ via=button, never 👍.
describe('done_button: args (AC-06)', () => {
  test('absent → no button', () => {
    expect(wantsDoneButton({})).toBeNull()
    expect(wantsDoneButton({ done_button: undefined })).toBeNull()
  })
  test('a label → one row, one button with that label', () => {
    expect(wantsDoneButton({ done_button: 'Готово' })).toBe('Готово')
    expect(doneKeyboard('Оплатил')).toEqual([[{ text: 'Оплатил', callback_data: 'yn:d' }]])
  })
  for (const [name, extra] of [
    ['yes_no', { yes_no: true }],
    ['checklist', { checklist: ['a'] }],
    ['files', { files: ['/tmp/x.png'] }],
    ['voice', { voice: true }],
    ['as_owner_to', { as_owner_to: '123' }],
  ] as const) {
    test(`with ${name} → error`, () => {
      expect(() => wantsDoneButton({ done_button: 'Готово', ...extra })).toThrow(new RegExp(name))
    })
  }
  for (const [name, v] of [
    ['empty', ''],
    ['spaces only', '   '],
    ['a newline', 'Гото\nво'],
    ['a carriage return', 'Гото\rво'],
    // buttons-da-gotovo r1 f4: every other line breaker
    ['a vertical tab (U+000B)', 'Гото\u000bво'],
    ['a form feed (U+000C)', 'Гото\u000cво'],
    ['a next-line (U+0085)', 'Гото\u0085во'],
    ['a line separator (U+2028)', 'Гото\u2028во'],
    ['a paragraph separator (U+2029)', 'Гото\u2029во'],
    ['over 32 characters', 'Г'.repeat(33)],
    ['33 code points, mixed scripts', 'Selesai 完成 ✅ ' + 'ab'.repeat(9) + 'éé'],
    ['not a string', true],
  ] as const) {
    test(`${name} → error`, () => {
      expect(() => wantsDoneButton({ done_button: v })).toThrow()
    })
  }
  test('exactly 32 characters (code points) → ok', () => {
    expect(wantsDoneButton({ done_button: 'Г'.repeat(32) })).toBe('Г'.repeat(32))
  })
  for (const label of ['Готово', 'Selesai', 'Done', 'Оплатил ✅', '完成了', 'Вошёл в Gojek', '✅'.repeat(32), 'Я'.repeat(31) + '😀']) {
    test(`ordinary one-line label ${JSON.stringify(label)} → ok (r1 f4)`, () => {
      expect([...label].length).toBeLessThanOrEqual(32)
      expect(wantsDoneButton({ done_button: label })).toBe(label)
    })
  }
  test('switch off → the result line says «button off, answer by text»', () => {
    expect(SUFFIX_DONE_OFF).toContain('button off, answer by text')
    expect(SUFFIX_DONE_ON).not.toContain('off')
  })
})

function donePress(fromId: number, chat: { id: number; type: string } | null, label: string | null = 'Вошёл', data = 'yn:d'): PressInput {
  const kb = label == null ? undefined : { inline_keyboard: [[{ text: label, callback_data: 'yn:d' }]] }
  return {
    data,
    from: { id: fromId, username: 'artem' },
    ...(chat ? { message: { message_id: 502, chat, ...(kb ? { reply_markup: kb } : {}) } } : {}),
  }
}

describe('done_button: press (AC-06)', () => {
  test('owner in his DM → one envelope with ✅ + via=button + that message id; keyboard → inert ✅ <label>', async () => {
    const { d, calls } = deps()
    expect(await handleYesNoPress(donePress(OWNER, { id: OWNER, type: 'private' }), d)).toBe(true)
    expect(calls.notify).toEqual([
      {
        content: '(button on message 502: Вошёл)',
        meta: {
          event: 'reaction',
          chat_id: String(OWNER),
          message_id: '502',
          user: 'artem',
          user_id: String(OWNER),
          ts: '2026-11-01T10:00:00.000Z',
          reaction_added: '✅',
          via: 'button',
        },
      },
    ])
    expect(calls.edit).toEqual([[[{ text: '✅ Вошёл', callback_data: 'yn:x' }]]])
    expect(calls.answer).toEqual(['✅ Вошёл'])
  })
  test('the «Готово» button with an empty label in the returned message → «Готово»', async () => {
    const { d, calls } = deps()
    await handleYesNoPress(donePress(OWNER, { id: OWNER, type: 'private' }, ' '), d)
    expect(calls.notify[0].content).toBe('(button on message 502: Готово)')
    expect(calls.edit).toEqual([[[{ text: '✅ Готово', callback_data: 'yn:x' }]]])
  })
  test('co-owner in their own DM → the same envelope with their user_id', async () => {
    const { d, calls } = fileDeps(coFile(`${CO}\n`))
    await handleYesNoPress(donePress(CO, { id: CO, type: 'private' }), d)
    expect(calls.notify.length).toBe(1)
    expect(calls.notify[0].meta.user_id).toBe(String(CO))
    expect(calls.notify[0].meta.chat_id).toBe(String(CO))
    expect(calls.notify[0].meta.reaction_added).toBe('✅')
    expect(calls.notify[0].meta.via).toBe('button')
  })
  for (const [name, p] of [
    ['another id', donePress(OTHER, { id: OTHER, type: 'private' })],
    ['an unknown id in the owner DM', donePress(OTHER, { id: OWNER, type: 'private' })],
    ['the owner in a group not in the access list', donePress(OWNER, { id: -100999, type: 'supergroup' })],
    ['a vanished message', donePress(OWNER, null)],
  ] as const) {
    test(`${name} → toast only, no envelope`, async () => {
      const { d, calls } = deps()
      expect(await handleYesNoPress(p, d)).toBe(true)
      expect(calls.notify).toEqual([])
      expect(calls.edit).toEqual([])
      expect(calls.answer.length).toBe(1)
    })
  }
  test('press after the swap → «Already answered.», no envelope', async () => {
    const { d, calls } = deps()
    await handleYesNoPress(donePress(OWNER, { id: OWNER, type: 'private' }, '✅ Вошёл', 'yn:x'), d)
    expect(calls.notify).toEqual([])
    expect(calls.answer).toEqual(['Уже ответили.'])
  })
  test('no done case yields 👍 (or 👎)', async () => {
    const { d, calls } = fileDeps(coFile(`${CO}\n`))
    for (const p of [donePress(OWNER, { id: OWNER, type: 'private' }), donePress(CO, { id: CO, type: 'private' }),
                     donePress(OWNER, { id: OWNER, type: 'private' }, 'Готово'), donePress(OWNER, { id: OWNER, type: 'private' }, '👍')]) {
      await handleYesNoPress(p, d)
    }
    expect(calls.notify.length).toBe(4)
    for (const n of calls.notify) {
      expect(n.meta.reaction_added).toBe('✅')
      expect(n.meta.reaction_added).not.toContain('👍')
      expect(n.meta.reaction_added).not.toContain('👎')
    }
  })
})

describe('press bound to a button on that message (buttons-da-gotovo r1 f3)', () => {
  const own = { id: OWNER, type: 'private' }
  for (const [name, p] of [
    ['yn:y on a message with only «Готово» (yn:d)', press('yn:y', OWNER, own, 501, doneKeyboard('Готово'))],
    ['yn:n on a message with only «Готово» (yn:d)', press('yn:n', OWNER, own, 501, doneKeyboard('Готово'))],
    ['yn:d on a «Да / Нет» keyboard', press('yn:d', OWNER, own, 501, yesNoKeyboard('ru'))],
    ['yn:y with no keyboard on the message', press('yn:y', OWNER, own, 501, null)],
    ['yn:d with no keyboard on the message', press('yn:d', OWNER, own, 501, null)],
    ['yn:y after the swap (only the inert button left)', press('yn:y', OWNER, own, 501, answeredKeyboard('n', 'ru'))],
  ] as const) {
    test(`${name} → refused toast, no envelope, no edit`, async () => {
      const { d, calls } = deps()
      expect(await handleYesNoPress(p, d)).toBe(true)
      expect(calls.notify).toEqual([])
      expect(calls.edit).toEqual([])
      expect(calls.answer).toEqual(['Вопрос уже неактуален.'])
    })
  }
  for (const [name, p, glyph] of [
    ['«Да» on a «Да / Нет» keyboard', press('yn:y', OWNER, own), '👍'],
    ['«Нет» on a «Да / Нет» keyboard', press('yn:n', OWNER, own), '👎'],
    ['«Готово» on a «Готово» keyboard', press('yn:d', OWNER, own, 501, doneKeyboard('Готово')), '✅'],
  ] as const) {
    test(`genuine ${name} → its glyph`, async () => {
      const { d, calls } = deps()
      await handleYesNoPress(p, d)
      expect(calls.notify.length).toBe(1)
      expect(calls.notify[0].meta.reaction_added).toBe(glyph)
      expect(calls.notify[0].meta.via).toBe('button')
    })
  }
})

describe('done_button: server.ts call sites (AC-06)', () => {
  test('the arg check runs before the secretary and checklist branches', () => {
    const i = SRC.indexOf('const doneLabel = wantsDoneButton(')
    expect(i).toBeGreaterThan(0)
    expect(i).toBeLessThan(SRC.indexOf('if (args.as_owner_to != null) {'))
    expect(i).toBeLessThan(SRC.indexOf('if (args.checklist != null) {'))
  })
  test('same switch as «Да / Нет»; the keyboard goes on the last chunk only', () => {
    expect(SRC).toContain('const doneHere = doneLabel != null && buttonsCountIn(chat_id)')
    expect(SRC).toContain('const doneOn = doneHere && yesNoButtonsOn(homedir())')
    expect(SRC).toContain('...(doneOn && i === chunks.length - 1 ? { reply_markup: { inline_keyboard: doneKeyboard(doneLabel as string) } } : {}),')
  })
  test('the result names the switch state; result still starts with "sent"', () => {
    expect(SRC).toContain("const doneNote = doneLabel != null ? (doneOn ? SUFFIX_DONE_ON : !doneHere ? SUFFIX_DONE_NOT_HERE : SUFFIX_DONE_OFF) : ''")
    expect(SRC).toContain('text: result + voiceNote + yesNoNote + doneNote')
  })
  test('the tool schema offers done_button; yes_no no longer bans a press for every 👍 question', () => {
    expect(SRC).toContain('done_button: {')
    expect(SRC).not.toContain('Never for a question that needs his own 👍')
  })
})

// Captions in the person's language (owner tg 46811: an English message got a Russian «✅ Да» button).
// Only what the person sees changes; callback data and the envelope stay byte-identical.
describe('ui language (tg 46811)', () => {
  test('uiLang: ru / en / id and their regional forms; unknown, auto, absent → en', () => {
    for (const [raw, want] of [['ru', 'ru'], ['RU', 'ru'], ['ru-RU', 'ru'], ['en', 'en'], ['en_US', 'en'], ['id', 'id'], ['id-ID', 'id'],
                               ['auto', 'en'], ['', 'en'], ['de', 'en'], [undefined, 'en'], [7, 'en']] as const) {
      expect(uiLang(raw)).toBe(want)
    }
  })
  for (const [lang, yes, no, done] of [['ru', 'Да', 'Нет', 'Готово'], ['en', 'Yes', 'No', 'Done'], ['id', 'Ya', 'Tidak', 'Selesai']] as const) {
    test(`${lang}: keyboard «${yes} / ${no}», data unchanged; inert ✅ ${yes} / ❌ ${no}`, () => {
      expect(yesNoKeyboard(lang)).toEqual([[{ text: yes, callback_data: 'yn:y' }, { text: no, callback_data: 'yn:n' }]])
      expect(answeredKeyboard('y', lang)).toEqual([[{ text: `✅ ${yes}`, callback_data: 'yn:x' }]])
      expect(answeredKeyboard('n', lang)).toEqual([[{ text: `❌ ${no}`, callback_data: 'yn:x' }]])
      expect(answeredKeyboard('d', lang)).toEqual([[{ text: `✅ ${done}`, callback_data: 'yn:x' }]])
    })
    test(`${lang}: «Да» press → the SAME envelope as in Russian (content «Да», 👍, via=button); keyboard + toast in ${lang}`, async () => {
      const { d, calls } = deps(String(OWNER), () => new Set(), lang)
      await handleYesNoPress(press('yn:y', OWNER, { id: OWNER, type: 'private' }, 501, yesNoKeyboard(lang)), d)
      expect(calls.notify.length).toBe(1)
      expect(calls.notify[0].content).toBe('(button on message 501: Да)')
      expect(calls.notify[0].meta.reaction_added).toBe('👍')
      expect(calls.notify[0].meta.via).toBe('button')
      expect(calls.edit).toEqual([[[{ text: `✅ ${yes}`, callback_data: 'yn:x' }]]])
      expect(calls.answer).toEqual([`✅ ${yes}`])
    })
    test(`${lang}: «done» press with no label on the message → «${done}»; toasts in ${lang}`, async () => {
      const { d, calls } = deps(String(OWNER), () => new Set(), lang)
      await handleYesNoPress(donePress(OWNER, { id: OWNER, type: 'private' }, ' '), d)
      expect(calls.notify[0].content).toBe(`(button on message 502: ${done})`)
      expect(calls.notify[0].meta.reaction_added).toBe('✅')
      const t = deps(String(OWNER), () => new Set(), lang)
      await handleYesNoPress(press('yn:y', OTHER, { id: OTHER, type: 'private' }), t.d)
      await handleYesNoPress(press('yn:x', OWNER, { id: OWNER, type: 'private' }), t.d)
      expect(t.calls.answer).toEqual([UI_CAPTIONS[lang].notAuthorized, UI_CAPTIONS[lang].alreadyAnswered])
    })
  }
  test('server.ts: the language is resolved at the keyboard and at the press, never once at start (review F1)', () => {
    const SRC = readFileSync(join(import.meta.dir, 'server.ts'), 'utf8')
    expect(SRC).toContain('inline_keyboard: yesNoKeyboard(uiLangOf(homedir())) }')
    expect(SRC).toContain('      lang: uiLangOf(homedir()),\n')
    expect(SRC).not.toContain('UI_LANG')
    expect(SRC).not.toContain('yesNoKeyboard()')
  })
  test('language written mid-session (onboarding step 0) → the next keyboard and press use it, no restart (review F1)', async () => {
    const h = mkdtempSync(join(tmpdir(), 'ui-lang-home-'))
    const dataDir = join(h, 'Workspace', 'ClaudeProjects', 'sam-data')
    mkdirSync(dataDir, { recursive: true })
    const cfg = join(dataDir, 'config.json')
    writeFileSync(cfg, JSON.stringify({ user: { telegram_chat_id: String(OWNER) } }))
    expect(yesNoKeyboard(uiLangOf(h))).toEqual([[{ text: 'Yes', callback_data: 'yn:y' }, { text: 'No', callback_data: 'yn:n' }]])
    writeFileSync(cfg, JSON.stringify({ user: { telegram_chat_id: String(OWNER), language: 'ru' } }))
    const kb = yesNoKeyboard(uiLangOf(h))
    expect(kb).toEqual([[{ text: 'Да', callback_data: 'yn:y' }, { text: 'Нет', callback_data: 'yn:n' }]])
    const { d, calls } = deps(String(OWNER), () => new Set(), uiLangOf(h))
    await handleYesNoPress(press('yn:y', OWNER, { id: OWNER, type: 'private' }, 501, kb), d)
    expect(calls.answer).toEqual(['✅ Да'])
    expect(calls.notify[0].content).toBe('(button on message 501: Да)')
    expect(calls.notify[0].meta.reaction_added).toBe('👍')
    expect(calls.notify[0].meta.via).toBe('button')
    expect(uiLangOf(join(h, 'no-such-home'))).toBe('en')
  })
})

// ── Buttons in an allowlisted group work exactly as in DM (D-1049; spec sam-data
// dev/specs/2026-11-14-buttons-in-groups-spec.md AC-1, AC-2, AC-4, AC-5) ─────────────────────
describe('buttons in groups (D-1049)', () => {
  const G_OPEN = -100123 // allowlisted, allowFrom empty
  const G_NAMED = -100124 // allowlisted, allowFrom names the owner and the co-owner
  const G_OMIT = -100125 // allowlisted, allowFrom names someone else only
  const G_QUIET = -100126 // allowlisted, wakeOnMention:false
  const G_NONE = -100999 // not in the access list
  const ACCESS: PressAccess = {
    groups: {
      [String(G_OPEN)]: {},
      [String(G_NAMED)]: { allowFrom: [String(OWNER), String(CO)] },
      [String(G_OMIT)]: { allowFrom: [String(OTHER)] },
      [String(G_QUIET)]: { wakeOnMention: false },
    },
  }
  const sg = (id: number) => ({ id, type: 'supergroup' })
  const dm = (id: number) => ({ id, type: 'private' })
  const coSet = () => new Set([String(CO)])
  function run(presser: number, chat: { id: number; type: string }, data: 'yn:y' | 'yn:d', access: PressAccess = ACCESS) {
    const lines: ButtonLineFields[] = []
    const r = deps(String(OWNER), coSet, 'ru', access)
    r.d.buttonsLog = f => { lines.push({ ...f }) }
    const kb = data === 'yn:d' ? doneKeyboard('Готово') : yesNoKeyboard('ru')
    return { ...r, lines, p: press(data, presser, chat, 233, kb) }
  }

  // AC-1: [name, presser, chat, accepted?, refused outcome]
  const TABLE: [string, number, { id: number; type: string }, boolean, string][] = [
    ['owner in own DM', OWNER, dm(OWNER), true, 'accepted'],
    ['co-owner in own DM', CO, dm(CO), true, 'accepted'],
    ['owner in an allowlisted group with empty allowFrom', OWNER, sg(G_OPEN), true, 'accepted'],
    ['owner in an allowlisted group whose allowFrom names him', OWNER, sg(G_NAMED), true, 'accepted'],
    ['co-owner in an allowlisted group that lets them in', CO, sg(G_NAMED), true, 'accepted'],
    ['another member in that group', OTHER, sg(G_OPEN), false, 'refused:not-owner'],
    ['owner in a group not in the access list', OWNER, sg(G_NONE), false, 'refused:not-here'],
    ['owner in an allowlisted group whose allowFrom omits him', OWNER, sg(G_OMIT), false, 'refused:not-here'],
    ['owner in a wakeOnMention:false group', OWNER, sg(G_QUIET), false, 'refused:not-here'],
    ["owner in another person's DM", OWNER, dm(OTHER), false, 'refused:not-here'],
    ["co-owner in the owner's DM", CO, dm(OWNER), false, 'refused:not-here'],
  ]
  for (const data of ['yn:y', 'yn:d'] as const) {
    for (const [name, presser, chat, ok, outcome] of TABLE) {
      test(`AC-1 ${data}: ${name} → ${ok ? 'accepted' : 'refused «Нет доступа.»'}`, async () => {
        const { d, calls, lines, p } = run(presser, chat, data)
        expect(await handleYesNoPress(p, d)).toBe(true)
        if (ok) {
          expect(calls.notify.length).toBe(1)
          expect(calls.notify[0].meta.chat_id).toBe(String(chat.id))
          expect(calls.notify[0].meta.message_id).toBe('233')
          expect(calls.notify[0].meta.user_id).toBe(String(presser))
          expect(calls.notify[0].meta.via).toBe('button')
          expect(calls.notify[0].meta.reaction_added).toBe(data === 'yn:y' ? '👍' : '✅')
          expect(calls.edit.length).toBe(1)
          expect(calls.answer).toEqual([data === 'yn:y' ? '✅ Да' : '✅ Готово'])
        } else {
          expect(calls.notify).toEqual([])
          expect(calls.edit).toEqual([])
          expect(calls.answer).toEqual(['Нет доступа.'])
        }
        expect(lines.length).toBe(1)
        expect(lines[0].outcome).toBe(outcome)
      })
    }
  }

  // AC-2: one check, both halves — the send puts buttons ⇔ a press by the owner or a co-owner is accepted.
  test('AC-2: buttonsCanCount ⇔ a press by the owner or a co-owner is accepted, over every AC-1 chat', async () => {
    const chats = [dm(OWNER), dm(CO), dm(OTHER), sg(G_OPEN), sg(G_NAMED), sg(G_OMIT), sg(G_QUIET), sg(G_NONE)]
    const seen = new Set<boolean>()
    for (const chat of chats) {
      let accepted = false
      for (const presser of [OWNER, CO]) {
        for (const data of ['yn:y', 'yn:d'] as const) {
          const { d, calls, p } = run(presser, chat, data)
          await handleYesNoPress(p, d)
          if (calls.notify.length === 1) accepted = true
        }
      }
      const send = buttonsCanCount(chat.id, ACCESS, String(OWNER), coSet())
      expect({ chat: chat.id, send }).toEqual({ chat: chat.id, send: accepted })
      seen.add(send)
    }
    expect([...seen].sort()).toEqual([false, true]) // the table has both kinds of chat
  })

  test('pressCounts: unit cases (own DM, lock groups only, no prototype keys, no empty id)', () => {
    expect(pressCounts(OWNER, String(OWNER), { groups: {} })).toBe(true)
    expect(pressCounts(String(G_OPEN), String(OWNER), ACCESS)).toBe(true)
    expect(pressCounts(G_OPEN, String(OWNER), { groups: {} })).toBe(false) // deny-all lock → only DM
    expect(pressCounts('__proto__', String(OWNER), ACCESS)).toBe(false)
    expect(pressCounts('', '', ACCESS)).toBe(false)
    expect(buttonsCanCount(G_OPEN, ACCESS, undefined, new Set())).toBe(false)
    expect(buttonsCanCount(G_NAMED, ACCESS, undefined, coSet())).toBe(true)
  })

  // R2: message ids are per chat — the envelope always carries both chat_id and message_id.
  test('«that very message» = the same chat_id AND message_id: equal ids in DM and group give distinct envelopes', async () => {
    const a = run(OWNER, dm(OWNER), 'yn:y')
    const b = run(OWNER, sg(G_OPEN), 'yn:y')
    await handleYesNoPress(a.p, a.d)
    await handleYesNoPress(b.p, b.d)
    expect(a.calls.notify[0].meta.message_id).toBe(b.calls.notify[0].meta.message_id)
    expect(a.calls.notify[0].meta.chat_id).toBe(String(OWNER))
    expect(b.calls.notify[0].meta.chat_id).toBe(String(G_OPEN))
  })

  // AC-5: an accepted group press has the same meta keys as a DM press.
  test('AC-5: group envelope = DM envelope keys; chat_id = group id, user_id = presser, via=button', async () => {
    const a = run(OWNER, dm(OWNER), 'yn:y')
    const b = run(OWNER, sg(G_OPEN), 'yn:y')
    await handleYesNoPress(a.p, a.d)
    await handleYesNoPress(b.p, b.d)
    expect(Object.keys(b.calls.notify[0].meta).sort()).toEqual(Object.keys(a.calls.notify[0].meta).sort())
    expect(Object.keys(b.calls.notify[0].meta).sort()).toEqual(['chat_id', 'event', 'message_id', 'reaction_added', 'ts', 'user', 'user_id', 'via'])
    expect(b.calls.notify[0].meta).toMatchObject({ event: 'reaction', chat_id: String(G_OPEN), user_id: String(OWNER), via: 'button' })
    expect(b.calls.notify[0].content).toBe(a.calls.notify[0].content)
  })

  // AC-4: buttons.log — one line per outcome, failure classes, nothing private.
  describe('AC-4 buttons.log', () => {
    function logged(): { dir: string; read: () => string[]; write: (f: ButtonLineFields) => void } {
      const dir = mkdtempSync(join(tmpdir(), 'yn-buttons-log-'))
      const write = createButtonsLog({ stateDir: dir, pid: 42, nowMs: () => Date.parse('2026-11-14T06:00:00.000Z') })
      return { dir, write, read: () => (existsSync(join(dir, 'buttons.log')) ? readFileSync(join(dir, 'buttons.log'), 'utf8').split('\n').filter(Boolean) : []) }
    }
    async function one(p: PressInput, over: Partial<PressDeps> = {}): Promise<string[]> {
      const L = logged()
      const r = deps(String(OWNER), coSet, 'ru', ACCESS)
      Object.assign(r.d, { buttonsLog: L.write }, over)
      await handleYesNoPress(p, r.d)
      return L.read()
    }
    const cases: [string, PressInput, string][] = [
      ['accepted', press('yn:y', OWNER, sg(G_OPEN), 233), 'outcome=accepted'],
      ['refused:not-owner', press('yn:y', OTHER, sg(G_OPEN), 233), 'outcome=refused:not-owner'],
      ['refused:not-here', press('yn:y', OWNER, sg(G_NONE), 233), 'outcome=refused:not-here'],
      ['refused:no-message', press('yn:y', OWNER, null), 'outcome=refused:no-message'],
      ['refused:answered', press('yn:x', OWNER, dm(OWNER), 233, answeredKeyboard('y', 'ru')), 'outcome=refused:answered'],
      ['refused:not-carried', press('yn:y', OWNER, dm(OWNER), 233, doneKeyboard('Готово')), 'outcome=refused:not-carried'],
    ]
    for (const [name, p, want] of cases) {
      test(`${name} → exactly one line`, async () => {
        const lines = await one(p)
        expect(lines.length).toBe(1)
        expect(lines[0]).toContain(want)
        expect(lines[0]).toContain(' answer=ok')
        expect(lines[0]).not.toContain('artem') // username
      })
    }
    test('line shape: ts pid chat chat_id topic msg data who outcome answer', async () => {
      const p = press('yn:y', OWNER, sg(G_OPEN), 233)
      p.message!.is_topic_message = true
      p.message!.message_thread_id = 7
      expect(await one(p)).toEqual([
        '2026-11-14T06:00:00.000Z pid=42 chat=supergroup chat_id=-100123 topic=y msg=233 data=yn:y who=owner outcome=accepted answer=ok',
      ])
      expect(await one(press('yn:d', CO, dm(CO), 9, doneKeyboard('Готово')))).toEqual([
        '2026-11-14T06:00:00.000Z pid=42 chat=private chat_id=777888999 topic=n msg=9 data=yn:d who=co-owner outcome=accepted answer=ok',
      ])
    })
    test("another person's id never lands in a line (their DM id = their user id)", async () => {
      const lines = await one(press('yn:y', OTHER, dm(OTHER), 233))
      expect(lines).toEqual(['2026-11-14T06:00:00.000Z pid=42 chat=private chat_id=- topic=n msg=233 data=yn:y who=other outcome=refused:not-owner answer=ok'])
      const g = await one(press('yn:y', OTHER, sg(G_OPEN), 233))
      expect(g[0]).not.toContain(String(OTHER))
      expect(g[0]).toContain('who=other')
    })
    test('a throwing answer / editMarkup / notify → answer= / edit= / notify=failed:<class>, no message text', async () => {
      class GrammyError extends Error { error_code = 400; constructor() { super('Bad Request: query is too old SECRET-TEXT'); this.name = 'GrammyError' } }
      const lines = await one(press('yn:y', OWNER, sg(G_OPEN), 233), {
        answer: async () => { throw new GrammyError() },
        editMarkup: async () => { throw new TypeError('boom SECRET-TEXT') },
        notify: async () => { throw new Error('closed SECRET-TEXT') },
      })
      expect(lines.length).toBe(1)
      expect(lines[0]).toContain('outcome=accepted answer=failed:GrammyError_400 edit=failed:TypeError notify=failed:Error')
      expect(lines[0]).not.toContain('SECRET')
      const refused = await one(press('yn:y', OWNER, sg(G_NONE), 233), { answer: async () => { throw new GrammyError() } })
      expect(refused).toEqual([expect.stringContaining('outcome=refused:not-here answer=failed:GrammyError_400')])
    })
    test('non-yes/no data → no line', async () => {
      expect(await one(press('chk:0', OWNER, dm(OWNER)))).toEqual([])
    })
  })

  test('AC-3 texts: the two new suffixes say a press would not count here; result still starts with "sent"', () => {
    expect(SUFFIX_NOT_HERE).toContain('a press would not count in this chat')
    expect(SUFFIX_DONE_NOT_HERE).toContain('a press would not count in this chat')
    expect(SRC).toContain('buttonsLog,')
    expect(SRC).toContain('access: () => loadAccess(),')
  })
})

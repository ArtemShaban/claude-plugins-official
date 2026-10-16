// access-lock.test.ts — D-528(b) locked mode (spec sam-data dev/analysis/2026-10-10-row25-d528-spec.md
// AC-1, AC-6, AC-7; AC-10 from dev/analysis/2026-10-16-row25-tg-access-lock-container-spec.md). Fixtures only, in mkdtemp dirs; nothing under ~/.claude/channels/telegram.

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, statSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  chooseAccess,
  denyAll,
  detectLockMode,
  LOCK_DIR,
  lockOwnerId,
  lockedAccessReader,
  ownerGate,
  parseLock,
  readLock,
} from './access-lock'
import { checkOutboundAllowed, groupMessageDecision, groupReactionAllowed } from './group-access'
import { readSecretaryConfig } from './secretary'

const OWNER = '111222333'
const X = '777000111' // the «friend»: allowed by the HOME copy only
const G = '-1001234567'

function lockJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    dmPolicy: 'allowlist',
    allowFrom: [OWNER],
    groups: { [G]: { requireMention: false, allowFrom: [OWNER] } },
    ownerChatId: OWNER,
    ...over,
  })
}

// The home copy the agent can write: lets X in everywhere, pairing on.
const HOME_ACCESS = {
  dmPolicy: 'pairing' as const,
  allowFrom: [OWNER, X],
  groups: { [G]: { requireMention: false, allowFrom: [] as string[] } },
  pending: {},
}

// The four gate paths of server.ts, on the access loadAccess() returned.
type A = { dmPolicy: string; allowFrom: string[]; groups: Record<string, any> }
function dmDelivered(a: A, id: string) {
  return a.dmPolicy !== 'disabled' && a.allowFrom.includes(id)
}
function groupDelivered(a: A, id: string) {
  if (a.dmPolicy === 'disabled') return false
  const p = a.groups[G]
  return !!p && groupMessageDecision(p, id, () => true) === 'deliver'
}
function reactionPasses(a: A, id: string) {
  if (a.dmPolicy === 'disabled') return false
  const dm = a.allowFrom.includes(id)
  const p = a.groups[G]
  return dm || (!!p && groupReactionAllowed(p, id))
}
function outboundAllowed(a: A, chat: string) {
  return checkOutboundAllowed(a as any, chat).allowed
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'tg-lock-'))
  const lockDir = join(dir, 'etc-sam-telegram-access')
  mkdirSync(lockDir)
  const home = join(dir, 'home-channel')
  mkdirSync(home)
  writeFileSync(join(home, 'access.json'), JSON.stringify(HOME_ACCESS))
  return { dir, lockDir, home }
}

function snapshot(d: string) {
  return readdirSync(d)
    .sort()
    .map(n => {
      const st = statSync(join(d, n))
      return `${n}:${st.size}:${st.mtimeMs}`
    })
}

describe('detectLockMode — decided by the real platform and the fixed path only', () => {
  test('the fixed path is /etc/sam-telegram-access', () => {
    expect(LOCK_DIR).toBe('/etc/sam-telegram-access')
  })

  test('linux + folder → locked; linux + no folder → off; darwin + folder → off (AC-6)', () => {
    const f = fixture()
    try {
      expect(detectLockMode('linux', f.lockDir)).toEqual({ locked: true, file: join(f.lockDir, 'access.json') })
      expect(detectLockMode('linux', join(f.dir, 'absent'))).toEqual({ locked: false })
      expect(detectLockMode('darwin', f.lockDir)).toEqual({ locked: false })
    } finally {
      rmSync(f.dir, { recursive: true, force: true })
    }
  })

  test('a FILE at the path on linux fails closed (locked; its access.json then reads as missing)', () => {
    const f = fixture()
    try {
      const file = join(f.dir, 'plain-file')
      writeFileSync(file, 'x')
      const m = detectLockMode('linux', file)
      expect(m.locked).toBe(true)
      expect(readLock((m as any).file).ok).toBe(false)
    } finally {
      rmSync(f.dir, { recursive: true, force: true })
    }
  })

  test('TELEGRAM_STATE_DIR / TELEGRAM_ACCESS_MODE never switch it', () => {
    const f = fixture()
    const saved = { s: process.env.TELEGRAM_STATE_DIR, m: process.env.TELEGRAM_ACCESS_MODE }
    try {
      process.env.TELEGRAM_STATE_DIR = f.home
      process.env.TELEGRAM_ACCESS_MODE = 'static'
      expect(detectLockMode('linux', f.lockDir).locked).toBe(true)
      expect(detectLockMode('darwin', f.lockDir).locked).toBe(false)
      // the real call (no parameters): real platform + the fixed path
      expect(detectLockMode()).toEqual(detectLockMode(process.platform, '/etc/sam-telegram-access'))
    } finally {
      if (saved.s === undefined) delete process.env.TELEGRAM_STATE_DIR
      else process.env.TELEGRAM_STATE_DIR = saved.s
      if (saved.m === undefined) delete process.env.TELEGRAM_ACCESS_MODE
      else process.env.TELEGRAM_ACCESS_MODE = saved.m
      rmSync(f.dir, { recursive: true, force: true })
    }
  })
})

describe('AC-1: in locked mode the home copy never decides who gets in', () => {
  function run(lockContent: string | null) {
    const f = fixture()
    if (lockContent !== null) writeFileSync(join(f.lockDir, 'access.json'), lockContent)
    const mode = detectLockMode('linux', f.lockDir)
    const logs: string[] = []
    const reader = lockedAccessReader((mode as any).file, l => logs.push(l))
    let homeCalls = 0
    const homeRead = () => {
      homeCalls++
      return HOME_ACCESS
    }
    const before = { lock: snapshot(f.lockDir), home: snapshot(f.home) }
    const accesses = [0, 1, 2].map(() => chooseAccess(mode, reader, homeRead) as A)
    const after = { lock: snapshot(f.lockDir), home: snapshot(f.home) }
    rmSync(f.dir, { recursive: true, force: true })
    return { a: accesses[0]!, accesses, logs, homeCalls, before, after }
  }

  test('valid lock: X (home-only) dropped on DM, group, reaction and outbound; the owner passes', () => {
    const r = run(lockJson())
    expect(r.homeCalls).toBe(0)
    expect(dmDelivered(r.a, X)).toBe(false)
    expect(groupDelivered(r.a, X)).toBe(false)
    expect(reactionPasses(r.a, X)).toBe(false)
    expect(outboundAllowed(r.a, X)).toBe(false)
    expect(dmDelivered(r.a, OWNER)).toBe(true)
    expect(groupDelivered(r.a, OWNER)).toBe(true)
    expect(reactionPasses(r.a, OWNER)).toBe(true)
    expect(outboundAllowed(r.a, OWNER)).toBe(true)
    expect(outboundAllowed(r.a, G)).toBe(true)
    expect(r.logs).toEqual([])
  })

  test('«pairing» in the lock counts as allowlist; pending is always empty', () => {
    const r = run(lockJson({ dmPolicy: 'pairing', pending: { abc123: { senderId: X } } }))
    expect(r.a.dmPolicy).toBe('allowlist')
    expect((r.a as any).pending).toEqual({})
  })

  test('a group with allowFrom ["none"] (the seed\'s support group) is valid and lets no member in', () => {
    const r = run(lockJson({ groups: { [G]: { requireMention: true, allowFrom: ['none'] } } }))
    expect(r.a.dmPolicy).toBe('allowlist')
    expect(r.a.allowFrom).toEqual([OWNER])
    for (const id of [X, OWNER]) expect(groupDelivered(r.a, id)).toBe(false)
    expect(parseLock(lockJson({ groups: { [G]: { allowFrom: ['none', OWNER] } } })).ok).toBe(false)
  })

  for (const [label, content] of [
    ['missing', null],
    ['not JSON', '{oops'],
    ['no ownerChatId', JSON.stringify({ allowFrom: [OWNER], groups: {} })],
    ['allowFrom not ids', lockJson({ allowFrom: ['@friend'] })],
    ['bad group id', lockJson({ groups: { '12345': {} } })],
    ['group allowFrom not ids', lockJson({ groups: { [G]: { allowFrom: [42] } } })],
  ] as const) {
    test(`lock ${label}: all four paths refused for everyone, home never read, one stderr line`, () => {
      const r = run(content)
      expect(r.homeCalls).toBe(0)
      for (const a of r.accesses) expect(a).toEqual(denyAll())
      for (const id of [X, OWNER]) {
        expect(dmDelivered(r.a, id)).toBe(false)
        expect(groupDelivered(r.a, id)).toBe(false)
        expect(reactionPasses(r.a, id)).toBe(false)
        expect(outboundAllowed(r.a, id)).toBe(false)
      }
      expect(outboundAllowed(r.a, G)).toBe(false)
      expect(r.logs.length).toBe(1) // three reads, one line
      expect(r.logs[0]).toContain('delivering nothing')
    })
  }

  test('no access file is created or changed in locked mode (lock folder and home folder)', () => {
    for (const content of [lockJson(), null]) {
      const r = run(content)
      expect(r.after).toEqual(r.before)
    }
  })

  test('the admin\'s change applies on the next call, no restart (re-read every call)', () => {
    const f = fixture()
    try {
      const file = join(f.lockDir, 'access.json')
      writeFileSync(file, lockJson())
      const reader = lockedAccessReader(file, () => {})
      const mode = detectLockMode('linux', f.lockDir)
      expect(dmDelivered(chooseAccess(mode, reader, () => HOME_ACCESS) as A, X)).toBe(false)
      writeFileSync(file, lockJson({ allowFrom: [OWNER, X] }))
      expect(dmDelivered(chooseAccess(mode, reader, () => HOME_ACCESS) as A, X)).toBe(true)
    } finally {
      rmSync(f.dir, { recursive: true, force: true })
    }
  })

  test('off mode: the home reader decides, exactly as today', () => {
    let calls = 0
    const a = chooseAccess({ locked: false }, null, () => {
      calls++
      return HOME_ACCESS
    })
    expect(calls).toBe(1)
    expect(a).toBe(HOME_ACCESS)
  })
})

describe('AC-7: owner id comes from the lock; a changed config number makes the agent deaf', () => {
  const ok = parseLock(lockJson())
  test('config id equal to ownerChatId → pass', () => {
    expect(ownerGate(OWNER, ok)).toEqual({ pass: true })
  })
  test('config id edited to the «friend» → drop', () => {
    const g = ownerGate(X, ok)
    expect(g.pass).toBe(false)
  })
  test('config unreadable / unset → drop', () => {
    expect(ownerGate(undefined, ok).pass).toBe(false)
  })
  test('invalid lock → drop', () => {
    expect(ownerGate(OWNER, parseLock('{}')).pass).toBe(false)
  })
  test('ownerChatId is returned for voice trust', () => {
    expect(ok.ok && ok.ownerChatId).toBe(OWNER)
  })
})

describe('AC-10: the secretary owner is the lock ownerChatId, never the config id', () => {
  const CONFIG_ID = X // an edited config.json id — must never become the secretary's owner in locked mode
  const silent = () => {}
  function lockedReaderFor(content: string | null) {
    const { lockDir } = fixture()
    const file = join(lockDir, 'access.json')
    if (content !== null) writeFileSync(file, content)
    return { mode: { locked: true as const, file }, read: lockedAccessReader(file, silent) }
  }
  test('locked + valid lock → ownerChatId', () => {
    const { mode, read } = lockedReaderFor(lockJson())
    expect(lockOwnerId(mode, read, CONFIG_ID)).toBe(OWNER)
  })
  test('locked + lock missing → undefined, secretary off', () => {
    const { mode, read } = lockedReaderFor(null)
    const id = lockOwnerId(mode, read, CONFIG_ID)
    expect(id).toBeUndefined()
    const home = mkdtempSync(join(tmpdir(), 'tg-sec-home-'))
    expect(readSecretaryConfig(home, id, [OWNER], silent).on).toBe(false)
  })
  test('locked + lock unreadable / invalid → undefined, never the config id', () => {
    for (const bad of ['not json', '{}', lockJson({ ownerChatId: 'abc' })]) {
      const { mode, read } = lockedReaderFor(bad)
      expect(lockOwnerId(mode, read, CONFIG_ID)).toBeUndefined()
    }
    expect(lockOwnerId({ locked: true, file: '/nonexistent/x' }, null, CONFIG_ID)).toBeUndefined()
  })
  test('off mode → the config id, as today', () => {
    expect(lockOwnerId({ locked: false }, null, CONFIG_ID)).toBe(CONFIG_ID)
  })
})

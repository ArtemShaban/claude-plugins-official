// access-lock.server.test.ts — D-528(b) end to end through the REAL server.ts (AC-1, AC-7):
// a child `bun server.ts` in locked mode against a fake Bot API.
//
// server.ts itself reads neither an env var nor a setting to switch locked mode on, so the TEST — never
// server.ts — makes the child believe it runs in a client container: a bun --preload sets
// process.platform to 'linux' and rewrites access-lock.ts's LOCK_DIR constant to a temp
// folder as the module loads. Production code has no seam for this. (The same bun --preload
// lever, planted deliberately, can turn locked mode OFF — the known limit in access-lock.ts.)
//
// STATE ISOLATION: HOME, TELEGRAM_STATE_DIR and the lock folder all live in a mkdtemp dir.

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const OWNER = 111222333
const FRIEND = 777000111 // allowed by the home copy only
const G = -1001234567

function preloadSource(lockDir: string, callsLog: string, updates: unknown[]): string {
  return /* ts */ `
import { appendFileSync } from 'fs'
import { plugin } from 'bun'
Object.defineProperty(process, 'platform', { value: 'linux' })
plugin({
  name: 'test-lock-dir',
  setup(build) {
    build.onLoad({ filter: /access-lock\\.ts$/ }, async args => {
      const src = await Bun.file(args.path).text()
      const out = src.replace("'/etc/sam-telegram-access'", ${JSON.stringify(JSON.stringify(lockDir))})
      if (out === src) throw new Error('test preload: LOCK_DIR constant not found')
      return { contents: out, loader: 'ts' }
    })
  },
})
const CALLS_LOG = ${JSON.stringify(callsLog)}
let served = false
const fake = async (url: any, init?: any) => {
  const method = String(url).split('/').pop()!
  appendFileSync(CALLS_LOG, method + '\\n')
  let result: unknown = true
  if (method === 'getMe') result = { id: 1, is_bot: true, first_name: 'bot', username: 'test_bot' }
  else if (method === 'getUpdates') {
    if (!served) { served = true; result = ${JSON.stringify(updates)} }
    else { await new Promise(r => setTimeout(r, 300)); result = [] }
  } else if (method.startsWith('send')) result = { message_id: 99, date: 0, chat: { id: 1, type: 'private' } }
  return new Response(JSON.stringify({ ok: true, result }), { headers: { 'content-type': 'application/json' } })
}
globalThis.fetch = fake as any
require('node-fetch').default = fake
`
}

function dm(updateId: number, from: number, text: string) {
  return {
    update_id: updateId,
    message: {
      message_id: 10 + updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: from, type: 'private' },
      from: { id: from, is_bot: false, first_name: 'u', username: 'u' + from },
      text,
    },
  }
}

function groupMsg(updateId: number, from: number, text: string) {
  return {
    update_id: updateId,
    message: {
      message_id: 10 + updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: G, type: 'supergroup', title: 'g' },
      from: { id: from, is_bot: false, first_name: 'u', username: 'u' + from },
      text,
    },
  }
}

function reaction(updateId: number, from: number) {
  return {
    update_id: updateId,
    message_reaction: {
      chat: { id: from, type: 'private' },
      message_id: 5,
      user: { id: from, is_bot: false, first_name: 'u' },
      date: Math.floor(Date.now() / 1000),
      old_reaction: [],
      new_reaction: [{ type: 'emoji', emoji: '👍' }],
    },
  }
}

async function runLocked(opts: {
  lock: Record<string, unknown> | null
  configOwner: string
  updates: unknown[]
}): Promise<{ notifications: string[]; stderr: string; homeBefore: string; homeAfter: string; lockFiles: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), 'tg-locked-'))
  try {
    const lockDir = join(dir, 'lock')
    mkdirSync(lockDir)
    if (opts.lock) writeFileSync(join(lockDir, 'access.json'), JSON.stringify(opts.lock))
    const stateDir = join(dir, 'state')
    mkdirSync(stateDir)
    const home = JSON.stringify({
      dmPolicy: 'pairing',
      allowFrom: [String(OWNER), String(FRIEND)],
      groups: { [String(G)]: { requireMention: false, allowFrom: [] } },
      pending: {},
    })
    writeFileSync(join(stateDir, 'access.json'), home)
    const data = join(dir, 'Workspace', 'ClaudeProjects', 'sam-data')
    mkdirSync(data, { recursive: true })
    writeFileSync(join(data, 'config.json'), JSON.stringify({ user: { telegram_chat_id: opts.configOwner } }))
    const callsLog = join(dir, 'calls.log')
    writeFileSync(callsLog, '')
    const preload = join(dir, 'preload.ts')
    writeFileSync(preload, preloadSource(lockDir, callsLog, opts.updates))
    const child = Bun.spawn(['bun', '--preload', preload, join(import.meta.dir, 'server.ts')], {
      cwd: import.meta.dir,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: dir,
        // both are ignored in locked mode (spec AC-1)
        TELEGRAM_STATE_DIR: stateDir,
        TELEGRAM_ACCESS_MODE: 'static',
        TELEGRAM_BOT_TOKEN: '1:test',
      },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    await new Promise(r => setTimeout(r, 2500))
    child.kill()
    const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    const notifications: string[] = []
    for (const line of out.split('\n')) {
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line)
        if (msg.method === 'notifications/claude/channel') notifications.push(msg.params.content)
      } catch {}
    }
    expect(readFileSync(callsLog, 'utf8'), `server never polled: ${err}`).toContain('getUpdates')
    return {
      notifications,
      stderr: err,
      homeBefore: home,
      homeAfter: readFileSync(join(stateDir, 'access.json'), 'utf8'),
      lockFiles: readdirSync(lockDir).sort(),
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const LOCK = {
  dmPolicy: 'allowlist',
  allowFrom: [String(OWNER)],
  groups: { [String(G)]: { requireMention: false, allowFrom: [String(OWNER)] } },
  ownerChatId: String(OWNER),
}

describe('server.ts in locked mode (D-528(b))', () => {
  test('the lock decides: the home-only friend is dropped (DM, group, reaction); the owner gets through', async () => {
    const r = await runLocked({
      lock: LOCK,
      configOwner: String(OWNER),
      updates: [
        dm(1, FRIEND, 'friend dm'),
        groupMsg(2, FRIEND, 'friend group'),
        reaction(3, FRIEND),
        dm(4, OWNER, 'owner dm'),
        groupMsg(5, OWNER, 'owner group'),
      ],
    })
    expect(r.stderr).toContain('access locked by the host')
    expect(r.notifications).toContain('owner dm')
    expect(r.notifications).toContain('owner group')
    expect(r.notifications.join('\n')).not.toContain('friend')
    expect(r.notifications.length).toBe(2) // the friend's reaction did not get through either
    expect(r.homeAfter).toBe(r.homeBefore) // the home copy is never written (no prune / seenGroups)
    expect(r.lockFiles).toEqual(['access.json'])
  }, 15000)

  test('no lock file → nothing delivered, not even the owner; one stderr line', async () => {
    const r = await runLocked({ lock: null, configOwner: String(OWNER), updates: [dm(1, OWNER, 'owner dm'), dm(2, FRIEND, 'f')] })
    expect(r.notifications).toEqual([])
    expect(r.stderr).toContain('delivering nothing')
    expect(r.homeAfter).toBe(r.homeBefore)
    expect(r.lockFiles).toEqual([])
  }, 15000)

  test('config owner edited to the friend → every update dropped, one stderr line (AC-7)', async () => {
    const r = await runLocked({
      lock: { ...LOCK, allowFrom: [String(OWNER), String(FRIEND)] },
      configOwner: String(FRIEND),
      updates: [dm(1, OWNER, 'owner dm'), dm(2, FRIEND, 'friend dm')],
    })
    expect(r.notifications).toEqual([])
    expect(r.stderr.split('\n').filter(l => l.includes('update dropped')).length).toBe(1)
  }, 15000)
})

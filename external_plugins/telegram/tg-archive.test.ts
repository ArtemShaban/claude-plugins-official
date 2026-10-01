/**
 * D-520 inbound archive — spec sam-data dev/analysis/2026-10-01-tg-inbound-archive-spec.md §3, criteria 1-8.
 *
 * Unit tests drive tg-archive.ts directly; the end-to-end tests run the REAL server.ts against a fake
 * Bot API (the same preload pattern as server.test.ts «DM /start ...»), feeding a batch of updates.
 *
 * STATE ISOLATION (dev-rules §1.2): HOME and TELEGRAM_STATE_DIR point into a mkdtemp dir per run; the
 * archive lands under that temp HOME's sam-data. Nothing under the real ~/.claude/channels/telegram or the
 * real sam-data is read or written; the last test checks the live archive dir's mtime is unchanged.
 */

import { describe, test, expect } from 'bun:test'
import { spawnSync } from 'child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { appendArchive, archiveFilePath, archiveRoot, type ArchiveLine } from './tg-archive'

const LIVE_ARCHIVE = join(homedir(), 'Workspace', 'ClaudeProjects', 'sam-data', 'state', 'tg-archive')
const liveStamp = () => (existsSync(LIVE_ARCHIVE) ? statSync(LIVE_ARCHIVE).mtimeMs : null)
const LIVE_BEFORE = liveStamp()

function line(over: Partial<ArchiveLine> = {}): ArchiveLine {
  return {
    ts: '2026-10-01T10:00:00.000Z',
    chat_id: '-1001',
    msg_id: 1,
    sender_id: '333',
    senderName: 'u333',
    kind: 'text',
    text: 'hi',
    ...over,
  }
}

function readLines(path: string): any[] {
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
}

describe('tg-archive.ts (unit)', () => {
  test('archiveRoot: from HOME only; no sam-data folder => undefined (criterion 8)', () => {
    const home = mkdtempSync(join(tmpdir(), 'tga-home-'))
    try {
      expect(archiveRoot(home)).toBeUndefined()
      mkdirSync(join(home, 'Workspace', 'ClaudeProjects', 'sam-data'), { recursive: true })
      expect(archiveRoot(home)).toBe(join(home, 'Workspace', 'ClaudeProjects', 'sam-data', 'state', 'tg-archive'))
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('the module source has no hard-coded user path (criterion 8)', () => {
    const src = readFileSync(join(import.meta.dir, 'tg-archive.ts'), 'utf8')
    expect(src).not.toContain('/Users/')
    expect(src).not.toMatch(/process\.env\.(USER|LOGNAME)/)
  })

  test('two months -> two files; 300 messages in one chat -> 300 lines, nothing trimmed (criterion 5)', () => {
    const root = join(mkdtempSync(join(tmpdir(), 'tga-')), 'tg-archive')
    try {
      for (let i = 0; i < 300; i++) appendArchive(root, line({ msg_id: i, text: `m${i}` }))
      appendArchive(root, line({ ts: '2026-09-30T23:59:59.000Z', msg_id: 999, text: 'september' }))
      const oct = readLines(archiveFilePath(root, '-1001', '2026-10-01T10:00:00.000Z'))
      expect(oct.length).toBe(300)
      expect(oct[0].text).toBe('m0')
      expect(oct[299].text).toBe('m299')
      expect(readLines(archiveFilePath(root, '-1001', '2026-09-30T23:59:59.000Z')).map(l => l.text)).toEqual(['september'])
      expect(readdirSync(join(root, '-1001')).sort()).toEqual(['2026-09.jsonl', '2026-10.jsonl'])
    } finally {
      rmSync(join(root, '..'), { recursive: true, force: true })
    }
  })

  test('modes 0700/0600 and a self-ignoring folder (criterion 6)', () => {
    const base = mkdtempSync(join(tmpdir(), 'tga-'))
    const root = join(base, 'tg-archive')
    try {
      appendArchive(root, line({ chat_id: 'odd/../id' }))
      const chatDir = join(root, 'odd____id')
      expect(statSync(root).mode & 0o777).toBe(0o700)
      expect(statSync(chatDir).mode & 0o777).toBe(0o700)
      expect(statSync(join(chatDir, '2026-10.jsonl')).mode & 0o777).toBe(0o600)
      expect(readFileSync(join(root, '.gitignore'), 'utf8').trim()).toBe('*')
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  test('U+2028 stays inside one physical line (readers split on \\n only)', () => {
    const base = mkdtempSync(join(tmpdir(), 'tga-'))
    const root = join(base, 'tg-archive')
    try {
      appendArchive(root, line({ text: 'a b\nc' }))
      const raw = readFileSync(archiveFilePath(root, '-1001', line().ts), 'utf8')
      expect(raw.split('\n').filter(Boolean).length).toBe(1)
      expect(JSON.parse(raw.trim()).text).toBe('a b\nc')
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})

// ── end-to-end through the real server.ts ─────────────────────────────────────

const TOKEN = '1:ARCHTOKENsecretXYZ'
const ENV_SECRET = 'envsecretVALUE123'
const NOW = Math.floor(Date.UTC(2026, 9, 1, 10, 0, 0) / 1000) // 2026-10-01 UTC
const JAN = Math.floor(Date.UTC(2026, 0, 15, 10, 0, 0) / 1000)

type RunOpts = {
  access: Record<string, unknown>
  updates: unknown[]
  samData?: 'yes' | 'no' | 'readonly'
  ideaInbox?: boolean
}
type RunResult = {
  notifications: { content: string; meta: Record<string, string> }[]
  calls: string[]
  stderr: string
  archiveFiles: Record<string, any[]> // "<chatDir>/<file>" -> lines
  archiveRootExists: boolean
  gitStatus: string
  modes: Record<string, number>
  rawArchive: string
  buffer: (chatId: string) => any[]
  ideas: any[]
}

let updateSeq = 0
function msg(chat: { id: number; type: string }, fromId: number, text: string, extra: Record<string, unknown> = {}) {
  return {
    update_id: ++updateSeq,
    message: {
      message_id: 100 + updateSeq,
      date: NOW,
      chat: chat.type === 'private' ? chat : { ...chat, title: 'g' },
      from: { id: fromId, is_bot: false, first_name: 'u', username: 'u' + fromId },
      text,
      ...extra,
    },
  }
}
const dm = (id: number) => ({ id, type: 'private' })
const grp = (id: number) => ({ id, type: 'supergroup' })

async function runServer(o: RunOpts): Promise<RunResult> {
  const dir = mkdtempSync(join(tmpdir(), 'tg-archive-e2e-'))
  try {
    const stateDir = join(dir, 'state')
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, 'access.json'), JSON.stringify(o.access))
    writeFileSync(join(stateDir, '.env'), `OTHER_SECRET=${ENV_SECRET}\n`)
    const samData = join(dir, 'Workspace', 'ClaudeProjects', 'sam-data')
    const root = join(samData, 'state', 'tg-archive')
    if ((o.samData ?? 'yes') !== 'no') {
      mkdirSync(samData, { recursive: true })
      spawnSync('git', ['init', '-q'], { cwd: samData })
    }
    if (o.samData === 'readonly') {
      mkdirSync(root, { recursive: true })
      chmodSync(root, 0o500)
    }
    const callsLog = join(dir, 'calls.log')
    const preload = join(dir, 'fake-bot-api.ts')
    writeFileSync(callsLog, '')
    writeFileSync(preload, /* ts */ `
import { appendFileSync } from 'fs'
const CALLS_LOG = ${JSON.stringify(callsLog)}
let served = false
const fake = async (url: any, init?: any) => {
  const method = String(url).split('/').pop()!
  appendFileSync(CALLS_LOG, method + '\\n')
  let result: unknown = true
  if (method === 'getMe') result = { id: 1, is_bot: true, first_name: 'bot', username: 'test_bot' }
  else if (method === 'getUpdates') {
    if (!served) { served = true; result = ${JSON.stringify(o.updates)} }
    else { await new Promise(r => setTimeout(r, 300)); result = [] }
  } else if (method === 'getFile') result = { file_id: 'x', file_unique_id: 'x' }
  else if (method.startsWith('send')) result = { message_id: 99, date: 0, chat: { id: 1, type: 'private' } }
  return new Response(JSON.stringify({ ok: true, result }), { headers: { 'content-type': 'application/json' } })
}
globalThis.fetch = fake as any
require('node-fetch').default = fake
`)
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: dir,
      TELEGRAM_STATE_DIR: stateDir,
      TELEGRAM_BOT_TOKEN: TOKEN,
    }
    if (o.ideaInbox) env.IDEA_INBOX_DIR = join(dir, 'ideas')
    const child = Bun.spawn(['bun', '--preload', preload, join(import.meta.dir, 'server.ts')], {
      cwd: import.meta.dir,
      env,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    await new Promise(r => setTimeout(r, 3000))
    child.kill()
    const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    const notifications: RunResult['notifications'] = []
    for (const l of out.split('\n')) {
      if (!l.trim()) continue
      try {
        const m = JSON.parse(l)
        if (m.method === 'notifications/claude/channel') notifications.push(m.params)
      } catch {}
    }
    if (o.samData === 'readonly') chmodSync(root, 0o700)
    const archiveFiles: Record<string, any[]> = {}
    const modes: Record<string, number> = {}
    let rawArchive = ''
    if (existsSync(root)) {
      modes['.'] = statSync(root).mode & 0o777
      for (const chatDir of readdirSync(root)) {
        if (chatDir === '.gitignore') continue
        modes[chatDir] = statSync(join(root, chatDir)).mode & 0o777
        for (const f of readdirSync(join(root, chatDir))) {
          const p = join(root, chatDir, f)
          modes[`${chatDir}/${f}`] = statSync(p).mode & 0o777
          rawArchive += readFileSync(p, 'utf8')
          archiveFiles[`${chatDir}/${f}`] = readLines(p)
        }
      }
    }
    const gitStatus = existsSync(samData)
      ? spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: samData, encoding: 'utf8' }).stdout
      : ''
    const bufferSnap: Record<string, any[]> = {}
    const bufDir = join(stateDir, 'group-buffer')
    if (existsSync(bufDir)) for (const f of readdirSync(bufDir)) bufferSnap[f] = readLines(join(bufDir, f))
    const ideasPath = join(dir, 'ideas', 'inbox.jsonl')
    return {
      notifications,
      calls: readFileSync(callsLog, 'utf8').split('\n').filter(Boolean),
      stderr: err,
      archiveFiles,
      archiveRootExists: existsSync(root),
      gitStatus,
      modes,
      rawArchive,
      buffer: (chatId: string) => bufferSnap[`${chatId}.jsonl`] ?? [],
      ideas: existsSync(ideasPath) ? readLines(ideasPath) : [],
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const allLines = (r: RunResult) => Object.values(r.archiveFiles).flat()
const linesWith = (r: RunResult, text: string) => allLines(r).filter(l => l.text === text)

describe('server.ts archives every allowed inbound message (end-to-end)', () => {
  const access = {
    dmPolicy: 'allowlist',
    allowFrom: ['111'],
    pending: {},
    groups: {
      '-1001': { requireMention: false, allowFrom: [] }, // wakes
      '-1002': { requireMention: true, contextBuffer: true }, // buffered
      '-1003': { requireMention: true }, // allowed, not mentioned, no buffer
      '-1004': { requireMention: false, allowFrom: ['111'] }, // 222 is outside
      '-1005': { requireMention: false, asyncThreads: ['7'] }, // idea-inbox async topic
    },
  }
  const updates = [
    msg(dm(111), 111, 'dm allowed'),
    msg(dm(222), 222, 'dm stranger'),
    msg(grp(-1001), 333, 'group wake'),
    msg(grp(-1002), 333, 'group buffered'),
    msg(grp(-1003), 333, 'group quiet'),
    msg(grp(-1004), 222, 'group outsider'),
    msg(grp(-1009), 333, 'group unconfigured'),
    msg(grp(-1005), 333, 'idea text', { message_thread_id: 7, is_topic_message: true }),
    msg(dm(111), 111, 'dm january', { date: JAN }),
    (() => {
      const u: any = msg(dm(111), 111, '')
      delete u.message.text
      u.message.caption = 'photo caption'
      u.message.photo = [{ file_id: 'PHOTO_FID', file_unique_id: 'pu', width: 1, height: 1, file_size: 10 }]
      return u
    })(),
  ]
  let r: RunResult
  const get = async () => (r ??= await runServer({ access, updates, ideaInbox: true }))

  test('criterion 1: the five allowed cases each leave exactly one line', async () => {
    const res = await get()
    expect(res.calls, res.stderr).toContain('getUpdates')
    for (const t of ['dm allowed', 'group wake', 'group buffered', 'group quiet', 'idea text']) {
      expect(linesWith(res, t).length, `${t}: ${JSON.stringify(res.archiveFiles)} ${res.stderr}`).toBe(1)
    }
  }, 20000)

  test('criterion 1: delivery is unchanged — woken ones notify, quiet/buffered/idea do not; idea persisted; buffer kept', async () => {
    const res = await get()
    const contents = res.notifications.map(n => n.content)
    expect(contents).toContain('dm allowed')
    expect(contents).toContain('group wake')
    expect(contents).not.toContain('group quiet')
    expect(contents).not.toContain('group buffered')
    expect(contents).not.toContain('idea text')
    expect(res.ideas.map(i => i.text)).toEqual(['idea text'])
    expect(res.buffer('-1002').map(b => b.text)).toEqual(['group buffered'])
  }, 20000)

  test('criterion 2: stranger DM (allowlist), unconfigured group, outsider in a configured group -> 0 lines', async () => {
    const res = await get()
    for (const t of ['dm stranger', 'group unconfigured', 'group outsider']) expect(linesWith(res, t)).toEqual([])
    expect(Object.keys(res.archiveFiles).some(k => k.startsWith('-1009/') || k.startsWith('-1004/') || k.startsWith('222/'))).toBe(false)
  }, 20000)

  test('criterion 4: fields — ts/senderName/text equal the buffer entry; chat_id, msg_id, sender_id, kind; optional thread_id/file_id', async () => {
    const res = await get()
    const [buffered] = linesWith(res, 'group buffered')
    const [bufEntry] = res.buffer('-1002')
    expect({ ts: buffered.ts, senderName: buffered.senderName, text: buffered.text }).toEqual(bufEntry)
    expect(buffered).toMatchObject({ chat_id: '-1002', sender_id: '333', kind: 'text' })
    expect(typeof buffered.msg_id).toBe('number')
    expect('thread_id' in buffered).toBe(false)
    expect('file_id' in buffered).toBe(false)
    const [idea] = linesWith(res, 'idea text')
    expect(idea.thread_id).toBe(7)
    const [photo] = linesWith(res, 'photo caption')
    expect(photo).toMatchObject({ kind: 'photo', file_id: 'PHOTO_FID', chat_id: '111', sender_id: '111', senderName: 'u111' })
    expect(photo.ts).toBe(new Date(NOW * 1000).toISOString())
  }, 20000)

  test('criterion 5: a message from another month lands in its own file', async () => {
    const res = await get()
    expect(res.archiveFiles['111/2026-01.jsonl'].map(l => l.text)).toEqual(['dm january'])
    expect(res.archiveFiles['111/2026-10.jsonl'].map(l => l.text)).toEqual(['dm allowed', 'photo caption'])
  }, 20000)

  test('criterion 6: modes, self-ignoring folder, nothing in git status, no token or .env value', async () => {
    const res = await get()
    expect(res.modes['.']).toBe(0o700)
    expect(res.modes['111']).toBe(0o700)
    expect(res.modes['111/2026-10.jsonl']).toBe(0o600)
    expect(res.gitStatus).not.toContain('tg-archive')
    expect(res.rawArchive.length).toBeGreaterThan(0)
    expect(res.rawArchive).not.toContain(TOKEN)
    expect(res.rawArchive).not.toContain(ENV_SECRET)
  }, 20000)
})

describe('criterion 2: pairing and disabled policies archive nothing', () => {
  test('dmPolicy pairing: a stranger gets a pairing reply, no archive file is created', async () => {
    const r = await runServer({
      access: { dmPolicy: 'pairing', allowFrom: ['111'], groups: {}, pending: {} },
      updates: [msg(dm(222), 222, 'pair me')],
    })
    expect(r.calls, r.stderr).toContain('sendMessage')
    expect(r.archiveRootExists).toBe(false)
  }, 20000)

  test('dmPolicy disabled: even an allowFrom sender leaves no archive file', async () => {
    const r = await runServer({
      access: { dmPolicy: 'disabled', allowFrom: ['111'], groups: {}, pending: {} },
      updates: [msg(dm(111), 111, 'disabled dm')],
    })
    expect(r.calls, r.stderr).toContain('getUpdates')
    expect(r.notifications).toEqual([])
    expect(r.archiveRootExists).toBe(false)
  }, 20000)
})

describe('criterion 3: archive failure never touches delivery (fail-open)', () => {
  test('read-only archive dir: DM still delivered, group message still buffered, one stderr line each', async () => {
    const r = await runServer({
      samData: 'readonly',
      access: {
        dmPolicy: 'allowlist',
        allowFrom: ['111'],
        pending: {},
        groups: { '-1002': { requireMention: true, contextBuffer: true } },
      },
      updates: [msg(dm(111), 111, 'still delivered'), msg(grp(-1002), 333, 'still buffered')],
    })
    expect(r.notifications.map(n => n.content)).toEqual(['still delivered'])
    expect(r.buffer('-1002').map(b => b.text)).toEqual(['still buffered'])
    const fails = r.stderr.split('\n').filter(l => l.includes('tg-archive append failed'))
    expect(fails.length, r.stderr).toBe(2)
    expect(fails[0]).toContain('tg-archive')
    expect(allLines(r)).toEqual([])
  }, 20000)

  test('no sam-data folder: archive off with ONE startup line, delivery unchanged', async () => {
    const r = await runServer({
      samData: 'no',
      access: { dmPolicy: 'allowlist', allowFrom: ['111'], groups: {}, pending: {} },
      updates: [msg(dm(111), 111, 'one'), msg(dm(111), 111, 'two')],
    })
    expect(r.notifications.map(n => n.content)).toEqual(['one', 'two'])
    expect(r.stderr.split('\n').filter(l => l.includes('tg-archive')).length, r.stderr).toBe(1)
    expect(r.archiveRootExists).toBe(false)
  }, 20000)
})

test('live archive dir untouched by this file (mtime)', () => {
  expect(liveStamp()).toBe(LIVE_BEFORE)
})

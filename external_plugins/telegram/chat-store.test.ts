/**
 * D-883 — the chat store keeps both sides and the files (chat-store.ts).
 * Spec: sam-data dev/analysis/2026-10-29-d883-store-timeline-door-spec.md §3 criteria 1, 2, 4.
 *
 * STATE ISOLATION: every test runs on a fresh mkdtemp HOME (its own sam-data folder) and a
 * fake Bot API; no network, nothing under the real ~/Workspace or ~/.claude is touched.
 */
import { describe, test, expect, beforeEach } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  appendOut,
  catchUp,
  createKeeper,
  createOutStore,
  isOutMethod,
  isOwnDeliveredMedia,
  keptFilePath,
  outLinesFor,
  storeErrorLine,
  type Download,
  type OutLine,
} from './chat-store'
import { appendArchive, archiveChatDir, outFilePath } from './tg-archive'
import { createSecretary, loadSecretaryState, saveSecretaryState, secretaryRoot, type SecretaryApi } from './secretary'
import { samDataDir } from './voice-delivery'

const OWNER = '111111111'
const MAXIM = '222222222'
const GROUP = '-1001234567890'
const CONN = 'conn-owner'
const DATE = 1_791_000_000 // 2026-10-04 UTC
const MONTH = new Date(DATE * 1000).toISOString().slice(0, 7)

let home: string
let archive: string
let business: string
let logs: string[]

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'chat-store-test-'))
  mkdirSync(samDataDir(home), { recursive: true })
  archive = join(samDataDir(home), 'state', 'tg-archive')
  business = secretaryRoot(home)
  logs = []
})

function outLines(root: string, chat: string): OutLine[] {
  const dir = archiveChatDir(root, chat)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(n => n.endsWith('.out.jsonl'))
    .flatMap(n => readFileSync(join(dir, n), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)))
}

/** A fake Bot API behind the transformer: `call(method, payload)` → the ApiResponse the caller sees. */
function fakeBot(opts: { fail?: string[]; throwOn?: string[] } = {}) {
  let next = 500
  const raw: { method: string; payload: any }[] = []
  const store = createOutStore({
    roots: { archive, business },
    log: l => logs.push(l),
    onFile: (root, line) => files.push({ root, line }),
  })
  const files: { root: string; line: OutLine }[] = []
  const prev = async (method: string, payload: any) => {
    raw.push({ method, payload })
    if (opts.throwOn?.includes(method)) throw new Error('network down')
    if (opts.fail?.includes(method)) return { ok: false, error_code: 400, description: 'Bad Request' }
    const chat = { id: Number(payload.chat_id), type: 'private' }
    const base = { message_id: next++, date: DATE, chat }
    let result: unknown = true
    if (method === 'sendMessage') result = { ...base, text: payload.text }
    else if (method === 'sendDocument') result = { ...base, caption: payload.caption, document: { file_id: 'DOC1', file_name: 'a.pdf' } }
    else if (method === 'sendPhoto') result = { ...base, photo: [{ file_id: 'P-small' }, { file_id: 'P-big' }] }
    else if (method === 'sendVoice') result = { ...base, voice: { file_id: 'VOICE1' } }
    else if (method === 'sendMediaGroup') result = [{ ...base, photo: [{ file_id: 'G1' }] }, { ...base, message_id: next++, photo: [{ file_id: 'G2' }] }]
    else if (method === 'editMessageText') result = { message_id: payload.message_id, date: DATE, edit_date: DATE + 60, chat, text: payload.text }
    else if (method === 'getFile') result = { file_id: payload.file_id, file_path: 'x.oga' }
    return { ok: true, result }
  }
  const call = (method: string, payload: any) => store.transformer(prev as any, method as any, payload, undefined as any) as Promise<any>
  const secretaryApi: SecretaryApi = {
    getBusinessConnection: async () => ({ user: { id: Number(OWNER) }, is_enabled: true }),
    sendMessage: async (chatId, text, o) => (await call('sendMessage', { chat_id: chatId, text, ...o })).result,
  }
  return { call, raw, files, secretaryApi }
}

describe('D-883 criterion 1 — every send we make lands once in the right .out.jsonl (OB-01, OB-08)', () => {
  test('reply text to his DM → one out line in tg-archive, via bot', async () => {
    const b = fakeBot()
    const r = await b.call('sendMessage', { chat_id: OWNER, text: 'Готово.' })
    const lines = outLines(archive, OWNER)
    expect(lines).toEqual([
      { ts: new Date(DATE * 1000).toISOString(), chat_id: OWNER, msg_id: r.result.message_id, direction: 'out', via: 'bot', kind: 'text', text: 'Готово.' },
    ])
    expect(existsSync(outFilePath(archive, OWNER, `${MONTH}-01`))).toBe(true)
    expect(outLines(business, OWNER)).toEqual([])
  })

  test('checklist (a text message with buttons) → kind text', async () => {
    const b = fakeBot()
    await b.call('sendMessage', { chat_id: OWNER, text: 'Купить:\n☐ молоко', reply_markup: { inline_keyboard: [[{ text: '☐ молоко', callback_data: 'x' }]] } })
    expect(outLines(archive, OWNER).map(l => [l.kind, l.text])).toEqual([['text', 'Купить:\n☐ молоко']])
  })

  test('file, photo and voice bubble → kind + file_id, and the file is handed to keep', async () => {
    const b = fakeBot()
    await b.call('sendDocument', { chat_id: OWNER, document: '/tmp/x', caption: 'отчёт' })
    await b.call('sendPhoto', { chat_id: OWNER, photo: '/tmp/y' })
    await b.call('sendVoice', { chat_id: OWNER, voice: '/tmp/z' })
    const lines = outLines(archive, OWNER)
    expect(lines.map(l => [l.kind, l.text, l.file_id])).toEqual([
      ['document', 'отчёт', 'DOC1'],
      ['photo', '(photo)', 'P-big'],
      ['voice', '(voice message)', 'VOICE1'],
    ])
    expect(b.files.map(f => [f.root, f.line.file_id])).toEqual([[archive, 'DOC1'], [archive, 'P-big'], [archive, 'VOICE1']])
  })

  test('idea echo and a plugin report into a group topic → the group chat file', async () => {
    const b = fakeBot()
    await b.call('sendMessage', { chat_id: GROUP, text: '🎤 Транскрипт:\nидея', message_thread_id: 7 })
    await b.call('sendMessage', { chat_id: GROUP, text: '⚠️ идея НЕ сохранена (ошибка записи) — пришли ещё раз' })
    expect(outLines(archive, GROUP).map(l => l.text)).toEqual(['🎤 Транскрипт:\nидея', '⚠️ идея НЕ сохранена (ошибка записи) — пришли ещё раз'])
  })

  test('sendMediaGroup → one line per message', async () => {
    const b = fakeBot()
    await b.call('sendMediaGroup', { chat_id: OWNER, media: [] })
    expect(outLines(archive, OWNER).map(l => l.file_id)).toEqual(['G1', 'G2'])
  })

  test('editMessageText → one line with of_msg_id and the edit time', async () => {
    const b = fakeBot()
    await b.call('editMessageText', { chat_id: OWNER, message_id: 42, text: 'правка' })
    const [l] = outLines(archive, OWNER)
    expect(l).toMatchObject({ msg_id: 42, of_msg_id: 42, text: 'правка', ts: new Date((DATE + 60) * 1000).toISOString() })
  })

  test('secretary: preview to his DM, approval (business send + his report), D-876 direct send', async () => {
    const dir = samDataDir(home)
    const cfg = (preview: boolean) =>
      writeFileSync(join(dir, 'config.json'), JSON.stringify({
        user: { telegram_chat_id: OWNER },
        overrides: { 'telegram-secretary': true, 'telegram-secretary-preview': preview },
        telegram_secretary_chats: { [MAXIM]: 'Максим' },
      }))
    cfg(true)
    const b = fakeBot()
    const s = createSecretary({ home, ownerId: OWNER, allowFrom: () => [OWNER], api: b.secretaryApi, log: l => logs.push(l) })
    await s.onBusinessMessage({ business_connection_id: CONN, message_id: 1, date: DATE, chat: { id: Number(MAXIM) }, from: { id: Number(MAXIM) }, text: 'привет' })
    const previewId = await s.draft({ chat_id: OWNER, text: 'Завтра в 10 ок', as_owner_to: MAXIM })
    expect(outLines(archive, OWNER).map(l => l.msg_id)).toEqual([previewId])
    expect(outLines(archive, OWNER)[0].text).toContain('Завтра в 10 ок')
    await s.onReaction({ fromId: OWNER, chatId: OWNER, messageId: previewId, added: ['👍'] })
    const toMaxim = outLines(business, MAXIM)
    expect(toMaxim.map(l => [l.via, l.text])).toEqual([['secretary', 'Завтра в 10 ок']])
    expect(outLines(archive, OWNER).map(l => l.text)).toEqual([expect.stringContaining('Завтра в 10 ок'), 'Отправил: Максим.'])
    cfg(false)
    const directId = await s.draft({ chat_id: OWNER, text: 'Прямо', as_owner_to: MAXIM })
    expect(outLines(business, MAXIM).map(l => [l.msg_id, l.text])).toEqual([
      [toMaxim[0].msg_id, 'Завтра в 10 ок'],
      [directId, 'Прямо'],
    ])
    // the business line never goes to tg-archive, and the inbound month file is untouched by out lines
    expect(outLines(archive, MAXIM)).toEqual([])
    const inbound = readFileSync(join(archiveChatDir(business, MAXIM), `${MONTH}.jsonl`), 'utf8').trim().split('\n')
    expect(inbound.length).toBe(1)
  })

  test('invite payloads are redacted on out lines', async () => {
    const b = fakeBot()
    await b.call('sendMessage', { chat_id: MAXIM, text: 'Держи: https://t.me/samdoesbot?start=AbCdEfGhIjKlMnOpQrStUv', business_connection_id: CONN })
    expect(outLines(business, MAXIM)[0].text).toBe('Держи: https://t.me/samdoesbot?start=<INVITE>')
  })

  test('a failed send (ok:false) or a thrown send → no line; the throw reaches the caller unchanged', async () => {
    const b = fakeBot({ fail: ['sendMessage'], throwOn: ['sendVoice'] })
    const r = await b.call('sendMessage', { chat_id: OWNER, text: 'x' })
    expect(r.ok).toBe(false)
    await expect(b.call('sendVoice', { chat_id: OWNER, voice: 'v' })).rejects.toThrow('network down')
    expect(outLines(archive, OWNER)).toEqual([])
    expect(logs).toEqual([])
  })

  test('sendChatAction, getFile, setMessageReaction → no line', async () => {
    const b = fakeBot()
    await b.call('sendChatAction', { chat_id: OWNER, action: 'typing' })
    await b.call('getFile', { file_id: 'f' })
    await b.call('setMessageReaction', { chat_id: OWNER, message_id: 1 })
    expect(outLines(archive, OWNER)).toEqual([])
    expect(isOutMethod('sendChatAction')).toBe(false)
    expect(isOutMethod('editMessageCaption')).toBe(true)
    expect(isOutMethod('editMessageReplyMarkup')).toBe(false)
  })

  test('a throwing append → the tool result is the same object, one stderr line, no text in it', async () => {
    writeFileSync(join(samDataDir(home), 'state'), 'not a dir') // every mkdir under state/ now fails
    const result = { message_id: 9, date: DATE, chat: { id: Number(OWNER) }, text: 'секретный текст' }
    const response = { ok: true, result }
    const store = createOutStore({ roots: { archive, business }, log: l => logs.push(l) })
    const got = await store.transformer((async () => response) as any, 'sendMessage' as any, { chat_id: OWNER, text: 'x' } as any, undefined as any)
    expect(got).toBe(response)
    expect(JSON.stringify(got)).toBe(JSON.stringify({ ok: true, result: { message_id: 9, date: DATE, chat: { id: Number(OWNER) }, text: 'секретный текст' } }))
    expect(logs.length).toBe(1)
    const parsed = JSON.parse(logs[0])
    expect(Object.keys(parsed).sort()).toEqual(['action_taken', 'component', 'error_class', 'ts'])
    expect(parsed.component).toBe('tg-out-store')
    expect(logs[0]).not.toContain('секретный')
  })

  test('store root off (no sam-data) → nothing written, nothing logged', async () => {
    const store = createOutStore({ roots: {}, log: l => logs.push(l) })
    const res = { ok: true, result: { message_id: 1, date: DATE, chat: { id: 1 }, text: 'x' } }
    expect(await store.transformer((async () => res) as any, 'sendMessage' as any, {} as any, undefined as any)).toBe(res)
    expect(existsSync(archive)).toBe(false)
    expect(logs).toEqual([])
  })

  test('modes: root and chat dir 0700, out file 0600, root ignores itself in git', () => {
    appendOut(archive, { ts: '2026-10-04T00:00:00.000Z', chat_id: OWNER, msg_id: 1, direction: 'out', via: 'bot', kind: 'text', text: 'x' })
    expect(statSync(archive).mode & 0o777).toBe(0o700)
    expect(statSync(archiveChatDir(archive, OWNER)).mode & 0o777).toBe(0o700)
    expect(statSync(outFilePath(archive, OWNER, '2026-10')).mode & 0o777).toBe(0o600)
    expect(readFileSync(join(archive, '.gitignore'), 'utf8')).toBe('*\n')
  })

  test('archiveAllows: a bot send to a chat outside the allowlist writes nothing; business sends are not filtered', async () => {
    const store = createOutStore({ roots: { archive, business }, log: l => logs.push(l), archiveAllows: c => c === OWNER })
    const ok = (chat: string) => async () => ({ ok: true, result: { message_id: 1, date: DATE, chat: { id: Number(chat) }, text: 'x' } })
    await store.transformer(ok('555') as any, 'sendMessage' as any, { chat_id: '555' } as any, undefined as any)
    await store.transformer(ok(OWNER) as any, 'sendMessage' as any, { chat_id: OWNER } as any, undefined as any)
    await store.transformer(ok(MAXIM) as any, 'sendMessage' as any, { chat_id: MAXIM, business_connection_id: CONN } as any, undefined as any)
    expect(existsSync(archiveChatDir(archive, '555'))).toBe(false)
    expect(outLines(archive, OWNER).length).toBe(1)
    expect(outLines(business, MAXIM).length).toBe(1)
  })

  test('outLinesFor: a non-message result (true) → no line', () => {
    expect(outLinesFor('editMessageText', { inline_message_id: 'x' }, true, new Date())).toEqual([])
  })
})

// ── criterion 2 — keepFile ─────────────────────────────────────────────────

function fakeDownload(over: Partial<{ result: Awaited<ReturnType<Download>>; throws: Error; delayMs: number }> = {}) {
  const calls: string[] = []
  const download: Download = async fileId => {
    calls.push(fileId)
    if (over.delayMs) await new Promise(r => setTimeout(r, over.delayMs))
    if (over.throws) throw over.throws
    return 'result' in over ? over.result : { bytes: new TextEncoder().encode(`bytes of ${fileId}`), ext: 'oga' }
  }
  return { download, calls }
}

describe('D-883 criterion 2 — keepFile (OB-01)', () => {
  test('a stored line with file_id → files/<msg_id>.<ext>, 0600, dir 0700', async () => {
    const d = fakeDownload()
    const k = createKeeper({ download: d.download, log: l => logs.push(l) })
    const p = await k.keep(archive, MAXIM, 77, 'F77')
    expect(p).toBe(join(archiveChatDir(archive, MAXIM), 'files', '77.oga'))
    expect(readFileSync(p!, 'utf8')).toBe('bytes of F77')
    expect(statSync(p!).mode & 0o777).toBe(0o600)
    expect(statSync(join(archiveChatDir(archive, MAXIM), 'files')).mode & 0o777).toBe(0o700)
    expect(readdirSync(join(archiveChatDir(archive, MAXIM), 'files'))).toEqual(['77.oga']) // no tmp left
    expect(keptFilePath(archive, MAXIM, 77)).toBe(p)
  })

  test('second call → no second download; two concurrent calls → one download', async () => {
    const d = fakeDownload({ delayMs: 20 })
    const k = createKeeper({ download: d.download, log: l => logs.push(l) })
    const [a, b] = await Promise.all([k.keep(archive, MAXIM, 5, 'F5'), k.keep(archive, MAXIM, 5, 'F5')])
    expect(a).toBe(b)
    expect(await k.keep(archive, MAXIM, 5, 'F5')).toBe(a)
    expect(d.calls).toEqual(['F5'])
  })

  test('> 20 MB by size hint → no download, no file, one stderr line', async () => {
    const d = fakeDownload()
    const k = createKeeper({ download: d.download, log: l => logs.push(l) })
    expect(await k.keep(archive, MAXIM, 6, 'F6', 21 * 1024 * 1024)).toBeUndefined()
    expect(d.calls).toEqual([])
    expect(keptFilePath(archive, MAXIM, 6)).toBeUndefined()
    expect(logs.length).toBe(1)
    expect(JSON.parse(logs[0]).error_class).toBe('too_big')
  })

  test('> 20 MB found at download time (getFile size, or the bytes) → no file, one stderr line each', async () => {
    const k1 = createKeeper({ download: fakeDownload({ result: 'too_big' }).download, log: l => logs.push(l) })
    expect(await k1.keep(archive, MAXIM, 7, 'F7')).toBeUndefined()
    const k2 = createKeeper({ download: fakeDownload().download, log: l => logs.push(l), maxBytes: 3 })
    expect(await k2.keep(archive, MAXIM, 8, 'F8')).toBeUndefined()
    expect(keptFilePath(archive, MAXIM, 7)).toBeUndefined()
    expect(keptFilePath(archive, MAXIM, 8)).toBeUndefined()
    expect(logs.map(l => JSON.parse(l).error_class)).toEqual(['too_big', 'too_big'])
  })

  test('no file path (undefined) → no file, no line', async () => {
    const k = createKeeper({ download: fakeDownload({ result: undefined }).download, log: l => logs.push(l) })
    expect(await k.keep(archive, MAXIM, 9, 'F9')).toBeUndefined()
    expect(logs).toEqual([])
  })

  test('a download error → undefined, never throws, the line names only the class (no URL, no token)', async () => {
    const err = Object.assign(new Error('fetch https://api.telegram.org/file/bot123:SECRET/x failed'), { code: 'HTTP_404' })
    const k = createKeeper({ download: fakeDownload({ throws: err }).download, log: l => logs.push(l) })
    expect(await k.keep(archive, MAXIM, 10, 'F10')).toBeUndefined()
    expect(logs.length).toBe(1)
    expect(logs[0]).not.toContain('SECRET')
    expect(JSON.parse(logs[0])).toMatchObject({ component: 'tg-keep-file', error_class: 'HTTP_404' })
  })

  test('an unlisted business chat stores nothing, so there is nothing to keep (onBusinessMessage returns undefined)', async () => {
    writeFileSync(join(samDataDir(home), 'config.json'), JSON.stringify({
      user: { telegram_chat_id: OWNER },
      overrides: { 'telegram-secretary': true },
      telegram_secretary_chats: { [MAXIM]: 'Максим' },
    }))
    const b = fakeBot()
    const s = createSecretary({ home, ownerId: OWNER, allowFrom: () => [OWNER], api: b.secretaryApi, log: l => logs.push(l) })
    const listed = await s.onBusinessMessage({ business_connection_id: CONN, message_id: 3, date: DATE, chat: { id: Number(MAXIM) }, from: { id: Number(MAXIM) }, voice: { file_id: 'V3' } })
    expect(listed).toMatchObject({ chat_id: MAXIM, msg_id: 3, kind: 'voice', file_id: 'V3' })
    const unlisted = await s.onBusinessMessage({ business_connection_id: CONN, message_id: 4, date: DATE, chat: { id: 555 }, from: { id: 555 }, voice: { file_id: 'V4' } })
    expect(unlisted).toBeUndefined()
  })

  test('his own voice / photo in a bot chat is delivery\'s (not kept); anyone else\'s, and his documents, are', () => {
    expect(isOwnDeliveredMedia('voice', OWNER, OWNER)).toBe(true)
    expect(isOwnDeliveredMedia('photo', OWNER, OWNER)).toBe(true)
    expect(isOwnDeliveredMedia('document', OWNER, OWNER)).toBe(false)
    expect(isOwnDeliveredMedia('voice', MAXIM, OWNER)).toBe(false)
    expect(isOwnDeliveredMedia('voice', OWNER, undefined)).toBe(false)
  })

  test('storeErrorLine: closed class only', () => {
    const l = JSON.parse(storeErrorLine('c', new Error('anything 123:ABC'), 'a', new Date(0)))
    expect(l).toEqual({ ts: '1970-01-01T00:00:00.000Z', component: 'c', error_class: 'Error', action_taken: 'a' })
  })
})

// ── criterion 4 — start-up catch-up ────────────────────────────────────────

describe('D-883 criterion 4 — start-up catch-up (OB-01)', () => {
  const NOW = new Date('2026-10-29T06:00:00Z')
  const line = (chat: string, msg: number, ts: string, kind = 'voice', sender = chat, file_id: string | null = `F${msg}`) => ({
    ts, chat_id: chat, msg_id: msg, sender_id: sender, senderName: sender, kind, text: '(voice message)', ...(file_id ? { file_id } : {}),
  })

  function seed() {
    appendArchive(archive, line(MAXIM, 1, '2026-10-27T08:00:00.000Z'))               // keep
    appendArchive(archive, line(MAXIM, 2, '2026-07-01T08:00:00.000Z'))               // > 90 days → no
    appendArchive(archive, line(MAXIM, 3, '2026-10-27T09:00:00.000Z', 'text', MAXIM, null)) // no file
    appendArchive(archive, line(OWNER, 4, '2026-10-27T10:00:00.000Z', 'voice', OWNER)) // his own voice in a bot chat → no
    appendArchive(archive, line(OWNER, 5, '2026-10-27T10:05:00.000Z', 'document', OWNER)) // his document → keep
    appendArchive(business, line(MAXIM, 6, '2026-10-27T11:00:00.000Z'))              // secretary line → keep
    appendArchive(business, line(MAXIM, 7, '2026-10-27T11:05:00.000Z', 'voice', OWNER)) // his voice in a business chat → keep (not delivered anywhere)
  }

  function drafts(n: number) {
    const st = loadSecretaryState(home)
    for (let i = 0; i < n; i++) {
      const key = i % 2 ? String(9000 + i) : `direct:${MAXIM}:${8000 + i}`
      st.drafts[key] = {
        chat_id: MAXIM, text: `отправка ${i} start=AbCdEfGhIjKlMnOpQrStUv`, created: `2026-10-2${i % 9}T00:00:00.000Z`, status: 'sent',
        approval: { kind: i % 2 ? '👍' : 'direct', at: `2026-10-2${i % 9}T00:01:00.000Z` }, sent_msg_id: 100 + i,
      }
    }
    st.drafts['9999'] = { chat_id: MAXIM, text: 'ждёт', created: '2026-10-28T00:00:00.000Z', status: 'pending' }
    st.drafts['9998'] = { chat_id: MAXIM, text: 'не ушло', created: '2026-10-28T00:00:00.000Z', status: 'failed', error: 'x' }
    saveSecretaryState(home, st)
  }

  const run = (keeper = createKeeper({ download: fakeDownload().download, log: l => logs.push(l) })) =>
    catchUp({ archiveRoot: archive, businessRoot: business, ownerId: OWNER, drafts: () => loadSecretaryState(home).drafts, keeper, log: l => logs.push(l), now: () => NOW })

  test('missing kept files for lines ≤ 90 days are fetched; his own bot-chat voice and old lines are not', async () => {
    seed()
    const d = fakeDownload()
    const r = await run(createKeeper({ download: d.download, log: l => logs.push(l) }))
    expect(d.calls.sort()).toEqual(['F1', 'F5', 'F6', 'F7'])
    expect(r.kept).toBe(4)
    expect(keptFilePath(archive, MAXIM, 1)).toBeDefined()
    expect(keptFilePath(archive, MAXIM, 2)).toBeUndefined()
    expect(keptFilePath(archive, OWNER, 4)).toBeUndefined()
    expect(keptFilePath(business, MAXIM, 6)).toBeDefined()
  })

  test('the 12 sent drafts appear once each with backfilled:true; pending/failed do not; a second start adds nothing', async () => {
    drafts(12)
    const r1 = await run()
    expect(r1.backfilled).toBe(12)
    const lines = outLines(business, MAXIM)
    expect(lines.length).toBe(12)
    expect(lines.every(l => l.backfilled === true && l.via === 'secretary' && l.direction === 'out')).toBe(true)
    expect(lines.map(l => l.msg_id).sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, i) => 100 + i))
    expect(lines.every(l => l.text.endsWith('start=<INVITE>'))).toBe(true)
    const d = fakeDownload()
    const r2 = await run(createKeeper({ download: d.download, log: l => logs.push(l) }))
    expect(r2).toEqual({ kept: 0, backfilled: 0 })
    expect(outLines(business, MAXIM).length).toBe(12)
    expect(d.calls).toEqual([])
    expect(logs).toEqual([])
  })

  test('a send already recorded live is not backfilled again', async () => {
    drafts(2)
    appendOut(business, { ts: '2026-10-20T00:01:00.000Z', chat_id: MAXIM, msg_id: 100, direction: 'out', via: 'secretary', kind: 'text', text: 'live' })
    const r = await run()
    expect(r.backfilled).toBe(1)
    expect(outLines(business, MAXIM).map(l => l.msg_id).sort()).toEqual([100, 101])
  })

  test('an unreadable state.json → one line, the file part still runs; never throws', async () => {
    seed()
    mkdirSync(business, { recursive: true })
    writeFileSync(join(business, 'state.json'), '{broken')
    const r = await run()
    expect(r.kept).toBe(4)
    expect(logs.length).toBe(1)
    expect(JSON.parse(logs[0]).component).toBe('tg-store-catch-up')
  })
})

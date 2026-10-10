// secretary.ts — the secretary bot in the owner's personal Telegram (Telegram
// Business). Spec: sam-data dev/analysis/2026-10-10-secretary-bot-spec.md;
// owner decisions D-637 (tg 30618/30619/30620), build order tg 30623.
//
// What it does, and nothing more:
//   (B) a business_message that arrives on HIS Business connection from a chat
//       on his list → one line in <sam-data>/state/tg-business/<chat>/<YYYY-MM>.jsonl
//       (the tg-archive line shape); an unlisted chat → only a breadcrumb
//       {name, first_seen}. No session wake, no reply, no read mark.
//   (C) the `reply` tool's `as_owner_to` option → one literal preview in his DM
//       + a pending draft keyed by the preview message id.
//   (D) his 👍 on the preview, or his own non-forwarded «да» replying to it →
//       the plugin sends the draft text byte-for-byte in his name, ONCE, and
//       tells him «Отправил» / «Не ушло».
//
// Safety:
// - OFF unless sam-data config.json `overrides["telegram-secretary"] === true`,
//   read on every event (switching off needs no restart).
// - A Business connection is accepted only when Telegram itself says it belongs
//   to the owner (getBusinessConnection: user.id == owner id, enabled). Our bot
//   is public: anyone can connect it to their own account, and their chat with
//   the same person has the same chat id.
// - Every Bot API call of this path goes through `SecretaryApi`, which has
//   exactly two methods: getBusinessConnection and sendMessage (OB-11).
// - Other people's messages are stored as DATA; nothing here acts on them.
//
// Pure fs + injected effects (no grammy import), so it is unit-testable.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { appendArchive, archiveFilePath, type ArchiveLine } from './tg-archive'
import { samDataDir, serialize } from './voice-delivery'

export const SECRETARY_SWITCH = 'telegram-secretary'
export const SECRETARY_CHATS_KEY = 'telegram_secretary_chats'
/** One Telegram text message (Bot API cap, UTF-16 units — same as MAX_CHUNK_LIMIT in server.ts). */
export const PREVIEW_MAX = 4096
export const APPROVE_EMOJI = '👍'

export type SecretaryConfig = { on: boolean; chats: Map<string, string> }

export type Draft = {
  chat_id: string
  text: string
  created: string
  status: 'pending' | 'sending' | 'sent' | 'failed'
  approval?: { kind: '👍' | 'да'; at: string }
  sent_msg_id?: number
  error?: string
}

export type SecretaryState = {
  connection?: { id: string; verified_at: string }
  drafts: Record<string, Draft>
  unlisted: Record<string, { name: string; first_seen: string }>
}

/** The ONLY Bot API surface of the business path (spec criterion 12). */
export type SecretaryApi = {
  getBusinessConnection(id: string): Promise<{ user: { id: number }; is_enabled: boolean }>
  sendMessage(
    chatId: string,
    text: string,
    opts?: { business_connection_id?: string; reply_parameters?: { message_id: number } },
  ): Promise<{ message_id: number }>
}

export type SecretaryDeps = {
  home: string
  ownerId: string | undefined
  /** access.json allowFrom — the chats where I take orders (D-460); never a target. */
  allowFrom: () => string[]
  api: SecretaryApi
  log: (line: string) => void
  now?: () => Date
}

/** The minimal business-message shape this module reads (a grammY Message fits it). */
export type BusinessMessage = {
  business_connection_id?: string
  message_id: number
  date: number
  chat: { id: number; type?: string; first_name?: string; last_name?: string; username?: string; title?: string }
  from?: { id: number; username?: string }
  text?: string
  caption?: string
  photo?: { file_id: string }[]
  document?: { file_id: string; file_name?: string }
  voice?: { file_id: string }
  audio?: { file_id: string; file_name?: string; title?: string }
  video?: { file_id: string }
  video_note?: { file_id: string }
  sticker?: { file_id: string; emoji?: string }
  location?: { latitude: number; longitude: number }
  contact?: { first_name: string; last_name?: string; phone_number: string }
  poll?: { question: string; options: { text: string }[] }
}

export function secretaryRoot(home: string): string {
  return join(samDataDir(home), 'state', 'tg-business')
}

export function secretaryStatePath(home: string): string {
  return join(secretaryRoot(home), 'state.json')
}

/** Store-file path of one message (for readers and tests). */
export function secretaryLinePath(home: string, chatId: string, ts: string): string {
  return archiveFilePath(secretaryRoot(home), chatId, ts)
}

// ── config ───────────────────────────────────────────────────────────────

function readConfigJson(home: string): Record<string, unknown> | undefined {
  try {
    const cfg = JSON.parse(readFileSync(join(samDataDir(home), 'config.json'), 'utf8'))
    return cfg != null && typeof cfg === 'object' ? (cfg as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** Switch ON only for exactly boolean `true` in overrides; the list keeps only safe targets. */
export function readSecretaryConfig(
  home: string,
  ownerId: string | undefined,
  allowFrom: string[],
  logDrop: (line: string) => void,
): SecretaryConfig {
  const off: SecretaryConfig = { on: false, chats: new Map() }
  if (!ownerId) return off
  const cfg = readConfigJson(home)
  const ov = cfg?.overrides
  if (ov == null || typeof ov !== 'object' || (ov as Record<string, unknown>)[SECRETARY_SWITCH] !== true) return off
  const chats = new Map<string, string>()
  const raw = cfg?.[SECRETARY_CHATS_KEY]
  if (raw != null && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [id, name] of Object.entries(raw as Record<string, unknown>)) {
      let why = ''
      if (!/^[1-9][0-9]{0,19}$/.test(id)) why = 'not a positive integer chat id'
      else if (id === ownerId) why = "the owner's own id"
      else if (allowFrom.includes(id)) why = 'an allowFrom id (a chat where I take orders)'
      else if (typeof name !== 'string' || name.trim() === '') why = 'no name'
      if (why) {
        logDrop(`telegram secretary: list entry ${JSON.stringify(id)} dropped: ${why}`)
        continue
      }
      chats.set(id, (name as string).trim())
    }
  }
  return { on: true, chats }
}

// ── state file ───────────────────────────────────────────────────────────

function ensureRoot(home: string): string {
  const root = secretaryRoot(home)
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const ignore = join(root, '.gitignore')
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n', { mode: 0o600 })
  return root
}

/** Missing file → empty state. An unreadable file THROWS (callers decide fail-open/closed). */
export function loadSecretaryState(home: string): SecretaryState {
  const p = secretaryStatePath(home)
  if (!existsSync(p)) return { drafts: {}, unlisted: {} }
  const s = JSON.parse(readFileSync(p, 'utf8')) as Partial<SecretaryState>
  return { connection: s.connection, drafts: s.drafts ?? {}, unlisted: s.unlisted ?? {} }
}

/** Atomic replace (tmp 0600 + rename). */
export function saveSecretaryState(home: string, state: SecretaryState): void {
  ensureRoot(home)
  const p = secretaryStatePath(home)
  const tmp = `${p}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, p)
}

// ── inbound helpers ──────────────────────────────────────────────────────

/** Kind / text label / file id — the same labels the plugin's message:* handlers use. */
export function labelOf(m: BusinessMessage): { kind: string; text: string; file_id?: string } {
  if (m.text != null) return { kind: 'text', text: m.text }
  if (m.photo?.length) return { kind: 'photo', text: m.caption ?? '(photo)', file_id: m.photo[m.photo.length - 1].file_id }
  if (m.document) return { kind: 'document', text: m.caption ?? `(document: ${m.document.file_name ?? 'file'})`, file_id: m.document.file_id }
  if (m.voice) return { kind: 'voice', text: m.caption ?? '(voice message)', file_id: m.voice.file_id }
  if (m.audio) return { kind: 'audio', text: m.caption ?? `(audio: ${m.audio.title ?? m.audio.file_name ?? 'audio'})`, file_id: m.audio.file_id }
  if (m.video) return { kind: 'video', text: m.caption ?? '(video)', file_id: m.video.file_id }
  if (m.video_note) return { kind: 'video_note', text: '(video note)', file_id: m.video_note.file_id }
  if (m.sticker) return { kind: 'sticker', text: `(sticker${m.sticker.emoji ? ` ${m.sticker.emoji}` : ''})`, file_id: m.sticker.file_id }
  if (m.location) return { kind: 'location', text: `(location: ${m.location.latitude}, ${m.location.longitude})` }
  if (m.contact) {
    const c = m.contact
    return { kind: 'contact', text: `(contact: ${[c.first_name, c.last_name].filter(Boolean).join(' ')}, ${c.phone_number})` }
  }
  if (m.poll) return { kind: 'poll', text: `(poll: ${m.poll.question} — ${m.poll.options.map(o => o.text).join(' | ')})` }
  return { kind: 'other', text: '(unsupported message)' }
}

function displayName(chat: BusinessMessage['chat']): string {
  const n = [chat.first_name, chat.last_name].filter(Boolean).join(' ')
  return n || chat.title || (chat.username ? `@${chat.username}` : String(chat.id))
}

/** «да» / «Да» / «да.» / « да! » → true; «да, но…» → false. */
export function isYes(text: string): boolean {
  return text.trim().replace(/[.!]$/, '').trim().toLowerCase() === 'да'
}

export function previewText(name: string, text: string): string {
  return `Отправить от твоего имени → ${name}:\n\n${text}\n\n👍 или ответь «да» на это сообщение — отправлю. Без этого не уйдёт.`
}

// ── the secretary (one per plugin process) ──────────────────────────────

export type DraftArgs = {
  chat_id: string
  text: string
  as_owner_to: string
  files?: string[]
  checklist?: unknown
  voice?: unknown
}

export function createSecretary(deps: SecretaryDeps) {
  const now = deps.now ?? (() => new Date())
  // getBusinessConnection once per id per process: owner's → true; another
  // user's → false (permanent). A DISABLED connection is not cached — he may
  // re-enable it; a lookup failure is not cached either.
  const connCache = new Map<string, boolean>()
  const loggedDrops = new Set<string>()
  const logDrop = (line: string) => {
    if (loggedDrops.has(line)) return
    loggedDrops.add(line)
    deps.log(line)
  }
  const config = () => readSecretaryConfig(deps.home, deps.ownerId, deps.allowFrom(), logDrop)

  async function isOwnersConnection(id: string): Promise<boolean> {
    const cached = connCache.get(id)
    if (cached !== undefined) return cached
    let conn: { user: { id: number }; is_enabled: boolean }
    try {
      conn = await deps.api.getBusinessConnection(id)
    } catch (err) {
      deps.log(`telegram secretary: getBusinessConnection failed, message not stored: ${err}`)
      return false
    }
    if (String(conn.user?.id) !== deps.ownerId) {
      connCache.set(id, false)
      return false
    }
    if (conn.is_enabled !== true) return false
    connCache.set(id, true)
    const st = loadSecretaryState(deps.home)
    if (st.connection?.id !== id) {
      st.connection = { id, verified_at: now().toISOString() }
      saveSecretaryState(deps.home, st)
    }
    return true
  }

  /** (B) inbound. Never throws: a failure is one stderr line (fail-open, the channel keeps working). */
  async function onBusinessMessage(m: BusinessMessage): Promise<void> {
    try {
      const cfg = config()
      if (!cfg.on) return
      const connId = m.business_connection_id
      if (!connId) return
      if (!(await isOwnersConnection(connId))) return
      const chatId = String(m.chat.id)
      if (cfg.chats.has(chatId)) {
        const label = labelOf(m)
        const from = m.from
        const line: ArchiveLine = {
          ts: new Date(m.date * 1000).toISOString(),
          chat_id: chatId,
          msg_id: m.message_id,
          sender_id: from ? String(from.id) : chatId,
          senderName: from ? (from.username ?? String(from.id)) : chatId,
          kind: label.kind,
          text: label.text,
          ...(label.file_id ? { file_id: label.file_id } : {}),
        }
        appendArchive(secretaryRoot(deps.home), line)
        return
      }
      const st = loadSecretaryState(deps.home)
      if (!st.unlisted[chatId]) {
        st.unlisted[chatId] = { name: displayName(m.chat), first_seen: now().toISOString() }
        saveSecretaryState(deps.home, st)
      }
    } catch (err) {
      deps.log(`telegram secretary: business message not stored: ${err}`)
    }
  }

  /** (C) draft. Throws on every refusal (nothing sent, no draft). Returns the preview message id. */
  async function draft(a: DraftArgs): Promise<number> {
    const cfg = config()
    if (!cfg.on) throw new Error('telegram-secretary is off')
    if (!deps.ownerId || a.chat_id !== deps.ownerId) throw new Error("as_owner_to: chat_id must be the owner's DM")
    const name = cfg.chats.get(String(a.as_owner_to))
    if (name === undefined) throw new Error('as_owner_to: chat is not on the secretary list')
    if ((a.files?.length ?? 0) > 0 || a.checklist != null || a.voice === true) {
      throw new Error('as_owner_to: cannot be combined with files, checklist or voice')
    }
    if (typeof a.text !== 'string' || a.text.trim() === '') throw new Error('as_owner_to: empty text')
    const preview = previewText(name, a.text)
    if (preview.length > PREVIEW_MAX) throw new Error('as_owner_to: the preview is longer than one Telegram message')
    const st = loadSecretaryState(deps.home)
    if (!st.connection?.id) throw new Error('as_owner_to: no verified Business connection yet (no message from it has arrived)')
    const sent = await deps.api.sendMessage(deps.ownerId, preview)
    st.drafts[String(sent.message_id)] = {
      chat_id: String(a.as_owner_to),
      text: a.text,
      created: now().toISOString(),
      status: 'pending',
    }
    saveSecretaryState(deps.home, st)
    return sent.message_id
  }

  async function approve(previewId: number, kind: '👍' | 'да'): Promise<void> {
    // One approval at a time: a second 👍 / «да» waits and then sees `sending`/`sent`.
    await serialize('telegram-secretary-approve', async () => {
      const cfg = config()
      if (!cfg.on || !deps.ownerId) return
      const st = loadSecretaryState(deps.home)
      const d = st.drafts[String(previewId)]
      if (!d || d.status !== 'pending') return
      const name = cfg.chats.get(d.chat_id)
      if (name === undefined) return // delisted since the draft: nothing goes out
      d.status = 'sending'
      d.approval = { kind, at: now().toISOString() }
      saveSecretaryState(deps.home, st) // BEFORE the call: a restart or 2nd approval never sends twice
      let report: string
      try {
        if (!st.connection?.id) throw new Error('no verified Business connection')
        const sent = await deps.api.sendMessage(d.chat_id, d.text, { business_connection_id: st.connection.id })
        d.status = 'sent'
        d.sent_msg_id = sent.message_id
        report = `Отправил: ${name}.`
      } catch (err) {
        d.status = 'failed'
        d.error = (err as { description?: string })?.description ?? String(err)
        report = `Не ушло: ${d.error}. Ничего не отправлено.`
      }
      saveSecretaryState(deps.home, st)
      try {
        await deps.api.sendMessage(deps.ownerId, report, { reply_parameters: { message_id: previewId } })
      } catch (err) {
        deps.log(`telegram secretary: outcome reply failed (${d.status}): ${err}`)
      }
    })
  }

  /** (D) 👍: his own DM, his own reaction, a net-added 👍. Never throws. */
  async function onReaction(r: { fromId: string; chatId: string; messageId: number; added: string[] }): Promise<void> {
    try {
      if (!deps.ownerId || r.fromId !== deps.ownerId || r.chatId !== deps.ownerId) return
      if (!r.added.includes(APPROVE_EMOJI)) return
      await approve(r.messageId, '👍')
    } catch (err) {
      deps.log(`telegram secretary: approval failed: ${err}`)
    }
  }

  /** (D) «да»: his own non-forwarded text in his DM, replying to the preview. Never throws. */
  async function onOwnerText(t: {
    fromId: string
    chatId: string
    text: string
    replyToId: number | undefined
    forwarded: boolean
  }): Promise<void> {
    try {
      if (!deps.ownerId || t.fromId !== deps.ownerId || t.chatId !== deps.ownerId) return
      if (t.forwarded || t.replyToId == null || !isYes(t.text)) return
      await approve(t.replyToId, 'да')
    } catch (err) {
      deps.log(`telegram secretary: approval failed: ${err}`)
    }
  }

  /** edit_message guard: a draft's preview is never edited (fail-closed when state is unreadable). */
  function isDraftPreview(chatId: string, messageId: number): boolean {
    if (!deps.ownerId || chatId !== deps.ownerId) return false
    if (!existsSync(secretaryStatePath(deps.home))) return false
    try {
      return loadSecretaryState(deps.home).drafts[String(messageId)] !== undefined
    } catch {
      return true
    }
  }

  return { onBusinessMessage, draft, onReaction, onOwnerText, isDraftPreview }
}

export type Secretary = ReturnType<typeof createSecretary>

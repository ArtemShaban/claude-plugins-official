// tg-archive.ts — the inbound ARCHIVE (D-520): one JSON line per incoming
// message from an allowed DM person or an allowed group member, kept for good.
//
// Owner (tg 25504): «просто надо хранить "в архиве" все входящие из все
// разрешенных групп/людей из телеграмма». Spec: sam-data
// dev/analysis/2026-10-01-tg-inbound-archive-spec.md.
//
// Store: <sam-data>/state/tg-archive/<safeChatId>/<YYYY-MM>.jsonl (month of the
// message ts, UTC). Append-only — one appendFileSync per message, never a
// read-modify-write, so there is no cap and nothing is ever trimmed. Dir 0700,
// file 0600 (same modes as the group buffer). The folder ignores itself in git
// (a `.gitignore` holding `*`): the lines are other people's verbatim text,
// which no scrubber here cleans — it must never reach a git history.
//
// Who is "allowed" is decided by gate() in server.ts (the ONE allowlist); this
// module only writes. Pure fs, no grammy import, so it is unit-testable.

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import { groupBufferPath } from './group-buffer'
import { samDataDir } from './voice-delivery'

export type ArchiveLine = {
  /** ISO UTC of the message date — the group buffer's exact value. */
  ts: string
  chat_id: string
  msg_id?: number
  sender_id: string
  /** username, else the numeric id — the group buffer's exact value. */
  senderName: string
  /** 'text' or the attachment kind (photo, document, voice, ...). */
  kind: string
  /** text / caption / kind label — the group buffer's exact value. */
  text: string
  thread_id?: number
  file_id?: string
}

/** <sam-data>/state/tg-archive, or undefined when the install has no sam-data folder. */
export function archiveRoot(home: string): string | undefined {
  const data = samDataDir(home)
  return existsSync(data) ? join(data, 'state', 'tg-archive') : undefined
}

/** The buffer's safeChatId, reused through its exported path helper (group-buffer.ts stays untouched). */
export function archiveChatDir(root: string, chatId: string): string {
  return join(root, basename(groupBufferPath('', chatId), '.jsonl'))
}

export function archiveFilePath(root: string, chatId: string, ts: string): string {
  return join(archiveChatDir(root, chatId), `${ts.slice(0, 7)}.jsonl`)
}

/** Append one line. Throws on a real fs failure — the caller (server.ts) logs and carries on. */
export function appendArchive(root: string, line: ArchiveLine): void {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const ignore = join(root, '.gitignore')
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n', { mode: 0o600 })
  mkdirSync(archiveChatDir(root, line.chat_id), { recursive: true, mode: 0o700 })
  appendFileSync(archiveFilePath(root, line.chat_id, line.ts), JSON.stringify(line) + '\n', { mode: 0o600 })
}

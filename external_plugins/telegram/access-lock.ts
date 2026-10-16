// access-lock.ts — D-528(b): the Telegram access list of a CLIENT container comes from a
// read-only lock the host binds at /etc/sam-telegram-access (on the Mac:
// /Users/clients/host-state/tg-access/<id>/, on a share the VM mounts read-only), never from
// the home copy the client's agent can write (spec sam-data
// dev/analysis/2026-10-10-row25-d528-spec.md §2 C, OB-01 / OB-04; store moved by
// dev/analysis/2026-10-16-row25-tg-access-lock-container-spec.md A′/B′).
//
// Locked mode is decided once, at start: the REAL platform is linux AND something exists at
// LOCK_DIR. detectLockMode() itself reads no environment variable and no setting — its two
// parameters exist for the unit tests only and server.ts calls it with none (scar B-1,
// sam-data dev/analysis/2026-10-10-container-passwd-2-security.md).
//
// KNOWN LIMIT (security review F1, sam-data dev/analysis/2026-10-10-row25-security.md): this
// is not airtight against bun itself. bun's own BUN_OPTIONS (--preload) or a bunfig.toml
// `preload` in the plugin's working directory — which sits in the writable plugin cache of
// a client container — can rewrite process.platform before this module loads and turn
// locked mode OFF. That needs an agent that deliberately plants a bun config or env to get
// around the gate: the same deliberate-bypass class as patching the plugin in its writable
// cache or running its own poller. It is accepted and not closed here; closing it means a
// host relay (spec §4 E).
//
// In locked mode:
//  * the list is the lock file, re-read on every call (the admin's change applies live);
//  * a missing, unreadable or invalid lock delivers NOTHING (deny-all access) and writes one
//    stderr line per new reason — never a fall-back to the home copy or to «pairing»
//    (dev-rules §6: fail closed, security class);
//  * dmPolicy is never «pairing» (pairing counts as allowlist), `pending` is always empty;
//  * the owner id is the lock's `ownerChatId`; ownerGate() drops every update while the
//    client's config.json `user.telegram_chat_id` differs (an edited number makes the
//    agent deaf, never makes a new owner).
// Off mode (not linux, or nothing at LOCK_DIR) = today's behaviour, unchanged.
//
// Pure apart from the reads it is asked to make (same style as group-access.ts).

import { lstatSync, readFileSync } from 'fs'
import { join } from 'path'

export const LOCK_DIR = '/etc/sam-telegram-access'
export const LOCK_FILE_NAME = 'access.json'

export type LockMode = { locked: false } | { locked: true; file: string }

/**
 * Locked when the platform is linux and ANYTHING exists at `dir` (a folder normally; a file
 * or an unreadable entry fails closed — the lock file under it then reads as missing).
 * Server.ts passes nothing: process.platform and LOCK_DIR.
 */
export function detectLockMode(platform: string = process.platform, dir: string = LOCK_DIR): LockMode {
  if (platform !== 'linux') return { locked: false }
  try {
    lstatSync(dir)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { locked: false }
    // EACCES and the like: something is there and we cannot tell what — fail closed.
  }
  return { locked: true, file: join(dir, LOCK_FILE_NAME) }
}

/** The plugin's Access shape (server.ts) — only the fields the lock may carry. */
export type LockedAccess = {
  dmPolicy: 'allowlist' | 'disabled'
  allowFrom: string[]
  groups: Record<string, Record<string, unknown>>
  pending: Record<string, never>
  mentionPatterns?: string[]
  ackReaction?: string
  replyToMode?: 'off' | 'first' | 'all'
  textChunkLimit?: number
  chunkMode?: 'length' | 'newline'
}

export type LockRead =
  | { ok: true; access: LockedAccess; ownerChatId: string }
  | { ok: false; reason: string }

const USER_ID = /^[0-9]{1,20}$/
const OWNER_ID = /^[0-9]{5,20}$/
const GROUP_ID = /^-[0-9]{1,20}$/
const NOBODY = 'none'

/** Deny-all: dmPolicy disabled, nobody in allowFrom, no group — every inbound and outbound path refuses. */
export function denyAll(): LockedAccess {
  return { dmPolicy: 'disabled', allowFrom: [], groups: {}, pending: {} }
}

function isStringList(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(x => typeof x === 'string')
}

function isIdList(v: unknown, re: RegExp): v is string[] {
  return isStringList(v) && v.every(x => re.test(x))
}

/** Validate the lock's JSON text. Anything unexpected → { ok:false } (the caller denies all). */
export function parseLock(raw: string): LockRead {
  let j: unknown
  try {
    j = JSON.parse(raw)
  } catch {
    return { ok: false, reason: 'not JSON' }
  }
  if (j == null || typeof j !== 'object' || Array.isArray(j)) return { ok: false, reason: 'not a JSON object' }
  const o = j as Record<string, unknown>
  if (typeof o.ownerChatId !== 'string' || !OWNER_ID.test(o.ownerChatId)) {
    return { ok: false, reason: 'ownerChatId missing or not a Telegram user id' }
  }
  if (!isIdList(o.allowFrom, USER_ID)) return { ok: false, reason: 'allowFrom is not a list of user ids' }
  const groupsIn = o.groups ?? {}
  if (groupsIn == null || typeof groupsIn !== 'object' || Array.isArray(groupsIn)) {
    return { ok: false, reason: 'groups is not an object' }
  }
  const groups: Record<string, Record<string, unknown>> = {}
  for (const [gid, pol] of Object.entries(groupsIn as Record<string, unknown>)) {
    if (!GROUP_ID.test(gid)) return { ok: false, reason: `group id ${JSON.stringify(gid)} is not a group chat id` }
    if (pol == null || typeof pol !== 'object' || Array.isArray(pol)) {
      return { ok: false, reason: `group ${gid}: policy is not an object` }
    }
    const p = pol as Record<string, unknown>
    // ["none"] = no member (the seed's support group, kit `--people none`): it matches no sender id.
    const nobody = Array.isArray(p.allowFrom) && p.allowFrom.length === 1 && p.allowFrom[0] === NOBODY
    if (p.allowFrom !== undefined && !nobody && !isIdList(p.allowFrom, USER_ID)) {
      return { ok: false, reason: `group ${gid}: allowFrom is not a list of user ids` }
    }
    groups[gid] = { ...p }
  }
  const access: LockedAccess = {
    // «pairing» (or anything else) counts as allowlist; only an explicit «disabled» is kept.
    dmPolicy: o.dmPolicy === 'disabled' ? 'disabled' : 'allowlist',
    allowFrom: [...o.allowFrom],
    groups,
    pending: {},
  }
  if (isStringList(o.mentionPatterns)) access.mentionPatterns = [...o.mentionPatterns]
  if (typeof o.ackReaction === 'string') access.ackReaction = o.ackReaction
  if (o.replyToMode === 'off' || o.replyToMode === 'first' || o.replyToMode === 'all') access.replyToMode = o.replyToMode
  if (typeof o.textChunkLimit === 'number') access.textChunkLimit = o.textChunkLimit
  if (o.chunkMode === 'length' || o.chunkMode === 'newline') access.chunkMode = o.chunkMode
  return { ok: true, access, ownerChatId: o.ownerChatId }
}

/** Read + validate the lock file. Never throws. */
export function readLock(file: string, read: (p: string) => string = p => readFileSync(p, 'utf8')): LockRead {
  let raw: string
  try {
    raw = read(file)
  } catch (err) {
    return { ok: false, reason: `unreadable (${(err as NodeJS.ErrnoException).code ?? 'error'})` }
  }
  return parseLock(raw)
}

/**
 * The access to use in locked mode: the lock's list, or deny-all with one stderr line per NEW
 * reason (a broken lock does not flood the log on every update; a fixed lock re-arms it).
 */
export function lockedAccessReader(
  file: string,
  log: (line: string) => void,
  read?: (p: string) => string,
): () => LockRead & { access: LockedAccess } {
  let lastReason: string | null = null
  return () => {
    const r = readLock(file, read)
    if (r.ok) {
      lastReason = null
      return r
    }
    if (r.reason !== lastReason) {
      log(`telegram channel: access lock ${file} ${r.reason} — delivering nothing (D-528)\n`)
      lastReason = r.reason
    }
    return { ...r, access: denyAll() }
  }
}

/**
 * Owner check on every inbound update in locked mode (OB-04): pass only when the lock is valid
 * and the client's config.json owner id equals the lock's ownerChatId.
 */
export function ownerGate(configChatId: string | undefined, lock: LockRead): { pass: true } | { pass: false; reason: string } {
  if (!lock.ok) return { pass: false, reason: `the access lock is invalid (${lock.reason})` }
  if (configChatId === undefined) return { pass: false, reason: 'config.json user.telegram_chat_id unreadable or unset' }
  if (configChatId !== lock.ownerChatId) {
    return { pass: false, reason: 'config.json user.telegram_chat_id differs from the owner the admin set' }
  }
  return { pass: true }
}

/**
 * The owner id in force (voice trust per call; the secretary once at start — AC-10). Off → the
 * config.json id. Locked → the lock's ownerChatId; a lock missing, unreadable or invalid →
 * undefined (no owner: voices are data, the secretary stays off) — never the config id.
 */
export function lockOwnerId(
  mode: LockMode,
  lockedRead: (() => LockRead) | null,
  configChatId: string | undefined,
): string | undefined {
  if (!mode.locked) return configChatId
  if (!lockedRead) return undefined
  const r = lockedRead()
  return r.ok ? r.ownerChatId : undefined
}

/**
 * The one place that picks the access source (server.ts loadAccess). Locked → the lock reader
 * ONLY (deny-all when it fails); the home reader is never called. Off → the home reader.
 */
export function chooseAccess<H>(
  mode: LockMode,
  lockedRead: (() => { access: LockedAccess }) | null,
  homeRead: () => H,
): LockedAccess | H {
  if (mode.locked) return lockedRead ? lockedRead().access : denyAll()
  return homeRead()
}

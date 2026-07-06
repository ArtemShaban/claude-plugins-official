// group-access.ts — pure, unit-testable helpers for ONBOARDING + GATING
// Telegram groups. Two independent concerns (both additive — neither touches
// the DM path or any group's existing behaviour unless a NEW field is set):
//
//  1. Discovery (recordSeenGroup). gate() drops every message from a group
//     that isn't yet in access.groups (existing behaviour, unchanged). This
//     adds a breadcrumb — chat title + last sender + timestamp + hit count —
//     into access.seenGroups so the owner can find a brand-new group's
//     chat_id via `/telegram:access` without installing a third-party bot
//     (@RawDataBot) or interrupting the live poller (there is only one
//     getUpdates consumer per token — stopping it to inspect the queue would
//     risk the DM lifeline channel). Bounded (MAX_SEEN_GROUPS, LRU-ish evict)
//     so an unapproved/spammy group can't grow state without bound.
//
//  2. Post-gating (checkOutboundAllowed). A configured group MAY carry
//     postPolicy:'gated' on its GroupPolicy — the group becomes READ-ONLY
//     from the tools' perspective: inbound messages still reach the session
//     exactly as before, but reply/react/edit_message refuse to send there
//     until the owner explicitly flips it to 'open' via /telegram:access.
//     Default (field absent) is 'open' — every group configured before this
//     field existed (e.g. the live Семён Group / idea-inbox flow) keeps
//     posting exactly as it does today. This exists because a group with a
//     third party in it (the assistant reading a friend's group) must never
//     let the session autonomously post to that third party — per
//     CLAUDE.md's always-gated "real-channel outreach" class, enforced here
//     structurally (a code-level block) rather than left to the model's own
//     judgment, since group message CONTENT is untrusted input and a prompt
//     injection inside it must not be able to talk the session into posting.

export type SeenGroup = {
  title?: string
  lastSenderId: string
  lastSenderName?: string
  lastSeenAt: string // ISO
  hits: number
}

const MAX_SEEN_GROUPS = 20

/**
 * Record a breadcrumb for a message from an UNCONFIGURED group. Pure: takes
 * the existing seenGroups map (or undefined) and returns the NEW map; the
 * caller (gate()) is responsible for persisting it (saveAccess) — this
 * function does no I/O so it's trivially unit-testable.
 *
 * Bounded to MAX_SEEN_GROUPS entries: once full, evicts the entry with the
 * oldest lastSeenAt (not the current one, which is always the newest).
 */
export function recordSeenGroup(
  existing: Record<string, SeenGroup> | undefined,
  chatId: string,
  info: { title?: string; senderId: string; senderName?: string; now?: string },
): Record<string, SeenGroup> {
  const now = info.now ?? new Date().toISOString()
  const map: Record<string, SeenGroup> = { ...(existing ?? {}) }
  const prev = map[chatId]
  map[chatId] = {
    ...(info.title ?? prev?.title ? { title: info.title ?? prev?.title } : {}),
    lastSenderId: info.senderId,
    ...(info.senderName ? { lastSenderName: info.senderName } : {}),
    lastSeenAt: now,
    hits: (prev?.hits ?? 0) + 1,
  }
  const keys = Object.keys(map)
  if (keys.length > MAX_SEEN_GROUPS) {
    const oldestKey = keys.reduce((a, b) => (map[a]!.lastSeenAt <= map[b]!.lastSeenAt ? a : b))
    // Never evict the entry we just touched (it's always the newest, but
    // guard anyway in case of a clock skew edge case).
    if (oldestKey !== chatId) delete map[oldestKey]
  }
  return map
}

export type PostGateResult = { allowed: true } | { allowed: false; reason: string }

/** Minimal shape checkOutboundAllowed needs from the channel Access config. */
export type PostGateAccess = {
  allowFrom: string[]
  groups: Record<string, { postPolicy?: 'open' | 'gated' }>
}

/**
 * Decide whether an OUTBOUND tool call (reply/react/edit_message) may target
 * chat_id. Mirrors the inbound allowlist check (a DM in allowFrom, or a
 * configured group) and ADDS one more gate on top: a group whose policy
 * carries postPolicy:'gated' is blocked for every outbound tool until the
 * owner sets it back to 'open'.
 */
export function checkOutboundAllowed(access: PostGateAccess, chat_id: string): PostGateResult {
  if (access.allowFrom.includes(chat_id)) return { allowed: true }
  const group = access.groups[chat_id]
  if (!group) {
    return { allowed: false, reason: `chat ${chat_id} is not allowlisted — add via /telegram:access` }
  }
  if (group.postPolicy === 'gated') {
    return {
      allowed: false,
      reason:
        `chat ${chat_id} is read-only (postPolicy:"gated") — the owner must set it to ` +
        `"open" via /telegram:access before Sam can post here`,
    }
  }
  return { allowed: true }
}

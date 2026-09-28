// Unit tests for group-access.ts — group discovery breadcrumbs + the
// post-gating decision. Pure functions, no fs/bot/network involved.

import { describe, expect, test } from 'bun:test'
import {
  checkOutboundAllowed,
  groupMessageDecision,
  groupReactionAllowed,
  recordSeenGroup,
  type GroupGatePolicy,
  type PostGateAccess,
  type SeenGroup,
} from './group-access'

describe('recordSeenGroup (discovery breadcrumb)', () => {
  test('first sighting of an unconfigured group creates one entry', () => {
    const map = recordSeenGroup(undefined, '-1009999', {
      title: 'MAG & HIU взаимозачёт',
      senderId: '55512',
      senderName: 'timur',
      now: '2026-07-06T10:00:00.000Z',
    })
    expect(map['-1009999']).toEqual({
      title: 'MAG & HIU взаимозачёт',
      lastSenderId: '55512',
      lastSenderName: 'timur',
      lastSeenAt: '2026-07-06T10:00:00.000Z',
      hits: 1,
    })
  })

  test('a second sighting bumps hits + updates lastSender/lastSeenAt, keeps title if omitted', () => {
    const first = recordSeenGroup(undefined, '-1009999', {
      title: 'MAG & HIU взаимозачёт',
      senderId: '378650081',
      senderName: 'artem',
      now: '2026-07-06T10:00:00.000Z',
    })
    const second = recordSeenGroup(first, '-1009999', {
      senderId: '55512',
      senderName: 'timur',
      now: '2026-07-06T11:00:00.000Z',
    })
    expect(second['-1009999']).toEqual({
      title: 'MAG & HIU взаимозачёт', // carried over, not lost
      lastSenderId: '55512',
      lastSenderName: 'timur',
      lastSeenAt: '2026-07-06T11:00:00.000Z',
      hits: 2,
    })
  })

  test('an unrelated group is untouched by a sighting in a different group', () => {
    const map = recordSeenGroup(
      { '-1001': { lastSenderId: 'x', lastSeenAt: '2026-01-01T00:00:00.000Z', hits: 5 } },
      '-1002',
      { senderId: 'y', now: '2026-07-06T00:00:00.000Z' },
    )
    expect(map['-1001']!.hits).toBe(5)
    expect(map['-1002']!.hits).toBe(1)
  })

  test('bounded: once over the cap, the OLDEST entry (by lastSeenAt) is evicted, not the newest', () => {
    let map: Record<string, SeenGroup> | undefined = undefined
    // Fill exactly to the documented cap (20) with strictly increasing timestamps.
    const ids = Array.from({ length: 20 }, (_, i) => `-100-${String(i).padStart(2, '0')}`)
    for (let i = 0; i < ids.length; i++) {
      const ts = `2026-07-06T00:${String(i).padStart(2, '0')}:00.000Z`
      map = recordSeenGroup(map, ids[i]!, { senderId: 'u', now: ts })
    }
    expect(Object.keys(map!).length).toBe(20)
    // One more, newer sighting of a 21st group must push the total back down
    // to the cap by evicting the OLDEST (ids[0], ts :00:00).
    map = recordSeenGroup(map, '-100new', { senderId: 'u', now: '2026-07-06T01:00:00.000Z' })
    expect(Object.keys(map!).length).toBe(20)
    expect(map![ids[0]!]).toBeUndefined() // oldest, evicted
    expect(map!['-100new']).toBeDefined() // newest, kept
    expect(map![ids[19]!]).toBeDefined() // second-oldest survivor, still kept
  })
})

describe('checkOutboundAllowed (post-gating)', () => {
  test('a DM in allowFrom is always allowed (unaffected by any group policy)', () => {
    const access: PostGateAccess = { allowFrom: ['378650081'], groups: {} }
    expect(checkOutboundAllowed(access, '378650081')).toEqual({ allowed: true })
  })

  test('an unconfigured chat (neither DM nor group) is refused', () => {
    const access: PostGateAccess = { allowFrom: ['378650081'], groups: {} }
    const result = checkOutboundAllowed(access, '-100999')
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.reason).toContain('not allowlisted')
  })

  test('a configured group with NO postPolicy field (pre-existing groups, e.g. Sam Group) is allowed — zero regression', () => {
    const access: PostGateAccess = { allowFrom: [], groups: { '-1004348136128': {} } }
    expect(checkOutboundAllowed(access, '-1004348136128')).toEqual({ allowed: true })
  })

  test('a group with postPolicy:"open" is allowed', () => {
    const access: PostGateAccess = { allowFrom: [], groups: { '-100777': { postPolicy: 'open' } } }
    expect(checkOutboundAllowed(access, '-100777')).toEqual({ allowed: true })
  })

  test('a group with postPolicy:"gated" is refused with a clear, actionable reason', () => {
    const access: PostGateAccess = { allowFrom: [], groups: { '-100777': { postPolicy: 'gated' } } }
    const result = checkOutboundAllowed(access, '-100777')
    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      expect(result.reason).toContain('read-only')
      expect(result.reason).toContain('/telegram:access')
    }
  })

  test('gated group + the OWNER also being in allowFrom (edge case) still allows via the DM path', () => {
    // Sanity: allowFrom is checked first — if the SAME id is both a DM allow
    // and a gated group id (impossible in practice, chat_id spaces don't
    // collide, but the precedence must be deterministic), the DM allow wins.
    const access: PostGateAccess = { allowFrom: ['-100777'], groups: { '-100777': { postPolicy: 'gated' } } }
    expect(checkOutboundAllowed(access, '-100777')).toEqual({ allowed: true })
  })
})

describe('groupMessageDecision / groupReactionAllowed (wakeOnMention:false — never-wake group)', () => {
  const yes = () => true
  const no = () => false
  // The feedback-group shape: any member, mention required, buffer on, never wake.
  const noWake: GroupGatePolicy = { requireMention: true, allowFrom: [], contextBuffer: true, wakeOnMention: false }

  test('flag set: an @mention is buffered, not delivered (no wake)', () => {
    expect(groupMessageDecision(noWake, '555', yes)).toBe('buffer')
  })

  test('flag set: a reply-to-bot (isMentioned true via reply) is buffered, not delivered', () => {
    // isMentioned() counts a reply to the bot as a mention — same boolean in.
    expect(groupMessageDecision(noWake, '555', yes)).toBe('buffer')
  })

  test('flag set: a plain non-mention message is still buffered (unchanged)', () => {
    expect(groupMessageDecision(noWake, '555', no)).toBe('buffer')
  })

  test('flag set + requireMention:false: still never delivers', () => {
    expect(groupMessageDecision({ ...noWake, requireMention: false }, '555', no)).toBe('buffer')
  })

  test('flag set without contextBuffer: a mention is dropped (buffer semantics stay tied to contextBuffer)', () => {
    expect(groupMessageDecision({ requireMention: true, allowFrom: [], wakeOnMention: false }, '555', yes)).toBe('drop')
  })

  test('flag set: the allowFrom gate still runs first — a non-listed sender is dropped, not buffered', () => {
    expect(groupMessageDecision({ ...noWake, allowFrom: ['111'] }, '555', yes)).toBe('drop')
  })

  test('flag set: a reaction is refused (null path)', () => {
    expect(groupReactionAllowed(noWake, '555')).toBe(false)
  })

  test('no flag: mention delivers, non-mention buffers/drops, reactions pass — unchanged', () => {
    const buf: GroupGatePolicy = { requireMention: true, allowFrom: [], contextBuffer: true }
    const plain: GroupGatePolicy = { requireMention: true, allowFrom: [] }
    expect(groupMessageDecision(buf, '555', yes)).toBe('deliver')
    expect(groupMessageDecision(buf, '555', no)).toBe('buffer')
    expect(groupMessageDecision(plain, '555', no)).toBe('drop')
    expect(groupMessageDecision({ requireMention: false, allowFrom: [] }, '555', no)).toBe('deliver')
    expect(groupMessageDecision({ requireMention: true, allowFrom: ['111'] }, '555', yes)).toBe('drop')
    expect(groupReactionAllowed(buf, '555')).toBe(true)
    expect(groupReactionAllowed({ requireMention: true, allowFrom: ['111'] }, '555')).toBe(false)
    expect(groupReactionAllowed({ requireMention: true, allowFrom: ['111'] }, '111')).toBe(true)
  })

  test('wakeOnMention:true is the same as absent', () => {
    const p: GroupGatePolicy = { requireMention: true, allowFrom: [], contextBuffer: true, wakeOnMention: true }
    expect(groupMessageDecision(p, '555', yes)).toBe('deliver')
    expect(groupReactionAllowed(p, '555')).toBe(true)
  })

  test('requireMention absent defaults to true (matches gate())', () => {
    expect(groupMessageDecision({ allowFrom: [] }, '555', no)).toBe('drop')
    expect(groupMessageDecision({ allowFrom: [] }, '555', yes)).toBe('deliver')
  })

  test('isMentioned is not evaluated when the sender is dropped by allowFrom (lazy, as before)', () => {
    let called = false
    groupMessageDecision({ requireMention: true, allowFrom: ['111'] }, '555', () => { called = true; return true })
    expect(called).toBe(false)
  })
})

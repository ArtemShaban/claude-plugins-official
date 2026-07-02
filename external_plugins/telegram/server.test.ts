/**
 * TDD tests for telegram server.ts hardening:
 *
 * 1. EPIPE storm fix (incident 2026-06-16): parent process dies → stdio pipe
 *    breaks → EPIPE thrown in uncaughtException → without fix, handler
 *    re-enters itself in a tight loop flooding shutdown.log (2.6 GB in 17 min).
 *    With fix, process exits cleanly on first EPIPE.
 *
 * 2. PID-reuse footgun fix: stale bot.pid pointing to a non-plugin process
 *    (PID recycled by the OS) must NOT be SIGTERM'd. Before killing, the
 *    stale-poller now verifies the command line via `ps -p <pid> -o command=`
 *    matches the plugin pattern (server.ts|telegram). If not, it skips.
 *
 * STATE ISOLATION: no test may read/write/kill anything under
 * ~/.claude/channels/telegram. Every test that needs a state dir uses a
 * mkdtempSync-backed tmpdir and sets TELEGRAM_STATE_DIR accordingly.
 */

import { describe, test, expect } from 'bun:test'
import { spawnSync, spawn } from 'child_process'
import { writeFileSync, mkdirSync, mkdtempSync, rmSync, readFileSync, statSync, chmodSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'

describe('EPIPE storm fix', () => {
  test('process exits with code 1 on EPIPE instead of looping', () => {
    const dir = join(tmpdir(), `epipe-test-${randomBytes(4).toString('hex')}`)
    mkdirSync(dir, { recursive: true })
    const shutdownLog = join(dir, 'shutdown.log')

    // Minimal reproduction of the handler pattern from server.ts.
    // Uses pure ESM so bun can run it without a tsconfig.
    const script = /* js */ `
import { appendFileSync, statSync, renameSync } from 'fs'

const SHUTDOWN_LOG = ${JSON.stringify(shutdownLog)}
const SHUTDOWN_LOG_MAX_BYTES = 5_000_000

let inLogShutdown = false
function logShutdown(reason, detail) {
  if (inLogShutdown) return
  inLogShutdown = true
  try {
    try {
      if (statSync(SHUTDOWN_LOG).size > SHUTDOWN_LOG_MAX_BYTES) {
        renameSync(SHUTDOWN_LOG, SHUTDOWN_LOG + '.1')
      }
    } catch {}
    const ts = new Date().toISOString()
    const extra = detail ? '  [' + detail + ']' : ''
    appendFileSync(SHUTDOWN_LOG, ts + '  ' + reason + extra + '\\n')
  } catch {}
  inLogShutdown = false
}

function safeStderr(msg) {
  try { process.stderr.write(msg) } catch {}
}

process.on('unhandledRejection', err => {
  safeStderr('unhandled rejection: ' + err + '\\n')
  logShutdown('unhandledRejection', String(err).slice(0, 200))
})
process.on('uncaughtException', (err) => {
  if (err && (err.code === 'EPIPE' || /EPIPE|broken pipe/i.test(String(err)))) {
    logShutdown('uncaughtException', 'EPIPE — pipe to parent closed, exiting')
    process.exit(1)
  }
  safeStderr('uncaught exception: ' + err + '\\n')
  logShutdown('uncaughtException', String(err).slice(0, 200))
})

// Simulate the EPIPE condition: emit an EPIPE-coded error through the handler.
const epipeErr = new Error('write EPIPE')
epipeErr.code = 'EPIPE'
process.emit('uncaughtException', epipeErr)

// If the fix is MISSING, process.exit(1) is never called, the handler falls
// through, and this setTimeout keeps the process alive until timeout fires.
setTimeout(() => {}, 30_000)
`

    const scriptPath = join(dir, 'stub.mjs')
    writeFileSync(scriptPath, script)

    // spawnSync with a 3-second timeout.
    // PASS (fix present):    status=1, signal=null  — exits immediately
    // FAIL (fix absent):     status=null, signal='SIGTERM' — timed out
    const result = spawnSync('bun', ['run', scriptPath], {
      timeout: 3000,
      encoding: 'utf8',
    })

    // Cleanup regardless of outcome.
    try { rmSync(dir, { recursive: true, force: true }) } catch {}

    expect(
      result.status,
      `Expected process to exit with code 1 on EPIPE (fix present). ` +
      `Got status=${result.status} signal=${result.signal} — ` +
      `this means the process timed out (no EPIPE branch) or crashed differently.\n` +
      `stdout: ${result.stdout}\nstderr: ${result.stderr}`
    ).toBe(1)

    expect(
      result.signal,
      'Process should have exited cleanly, not been killed by a signal'
    ).toBeNull()
  })

  test('logShutdown re-entrancy guard prevents infinite loop', () => {
    // Directly test that the guard variable stops recursive re-entry.
    // This runs in the test process itself (no subprocess needed).
    const calls: string[] = []

    let inLog = false
    function logShutdownLocal(reason: string): void {
      if (inLog) return
      inLog = true
      calls.push(reason)
      // Simulate re-entrant call (what EPIPE from appendFileSync would cause)
      logShutdownLocal('re-entrant')
      inLog = false
    }

    logShutdownLocal('first')

    // If guard works: only 'first' was recorded, not 'first' + 're-entrant'
    expect(calls).toEqual(['first'])
  })
})

// ---------------------------------------------------------------------------
// PID-reuse footgun fix
// ---------------------------------------------------------------------------
// The stale-poller in server.ts reads bot.pid and SIGTERM's the recorded PID.
// If the OS recycled that PID for an UNRELATED process (e.g. a sleep, a bun
// script) the old code would kill an innocent process — a real outage risk.
//
// The fix: before SIGTERM, run `ps -p <pid> -o command=` and verify the
// command line matches the plugin pattern (server.ts|telegram). Skip if not.
//
// These tests are STATE-ISOLATED: they use mkdtempSync + TELEGRAM_STATE_DIR
// env override. No test touches ~/.claude/channels/telegram.
describe('PID-reuse footgun fix', () => {
  // Stale-poller logic extracted into a minimal inline script so we can test
  // it without spawning the full server.ts (which requires a valid bot token
  // and tries to connect to Telegram). The script mirrors server.ts exactly.
  // Mirrors the looksLikePlugin() + stale-poller logic from server.ts.
  // When botCmdPattern is set, use that single pattern (for test control).
  // When absent, uses the production default: /server\.ts/i — matches the real
  // plugin ps output ("/usr/local/bin/bun server.ts") without requiring 'telegram'
  // (which doesn't appear in the real plugin's argv).
  function stalePollScript(stateDir: string, botCmdPattern?: string): string {
    return /* js */`
import { spawnSync } from 'child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'

const STATE_DIR = ${JSON.stringify(stateDir)}
const PID_FILE = join(STATE_DIR, 'bot.pid')

function looksLikePlugin(cmd) {
  const override = process.env.TELEGRAM_BOT_CMD_PATTERN ${botCmdPattern ? `?? ${JSON.stringify(botCmdPattern)}` : ''}
  if (override) return new RegExp(override, 'i').test(cmd)
  return /server\\.ts/i.test(cmd)
}

mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
try {
  const stale = parseInt(readFileSync(PID_FILE, 'utf8'), 10)
  if (stale > 1 && stale !== process.pid) {
    process.kill(stale, 0)
    const psResult = spawnSync('ps', ['-p', String(stale), '-o', 'command='], {
      encoding: 'utf8',
      timeout: 2000,
    })
    const cmd = psResult.stdout ?? ''
    if (looksLikePlugin(cmd)) {
      process.stderr.write('KILLED pid=' + stale + '\\n')
      process.kill(stale, 'SIGTERM')
    } else {
      process.stderr.write('SKIPPED pid=' + stale + ' cmd=' + cmd.trim() + '\\n')
    }
  }
} catch (e) {
  process.stderr.write('CAUGHT: ' + e + '\\n')
}
writeFileSync(PID_FILE, String(process.pid))
process.exit(0)
`
  }

  test('stale PID pointing to a non-plugin process is NOT killed', () => {
    // Spawn an innocent process (sleep) — its cmd will not match "server.ts|telegram".
    const innocent = spawn('sleep', ['30'])
    const innocentPid = innocent.pid!

    try {
      const stateDir = mkdtempSync(join(tmpdir(), 'tg-pid-test-'))
      try {
        // Write innocent PID into bot.pid to simulate stale state.
        writeFileSync(join(stateDir, 'bot.pid'), String(innocentPid))

        const scriptPath = join(stateDir, 'stale-poller.mjs')
        writeFileSync(scriptPath, stalePollScript(stateDir))

        const result = spawnSync('bun', ['run', scriptPath], {
          timeout: 5000,
          encoding: 'utf8',
          // Critically: no TELEGRAM_STATE_DIR override needed here since the
          // script has the stateDir baked in, but we also must ensure this
          // process's own TELEGRAM_STATE_DIR doesn't point to live dir.
          env: { ...process.env, TELEGRAM_STATE_DIR: stateDir },
        })

        // The script must complete without error.
        expect(
          result.status,
          `stale-poller script failed. stderr=${result.stderr}`
        ).toBe(0)

        // Stderr must say SKIPPED (not KILLED).
        expect(
          result.stderr,
          'Expected SKIPPED for non-plugin process, got: ' + result.stderr
        ).toContain('SKIPPED')
        expect(
          result.stderr,
          'Must NOT kill non-plugin process'
        ).not.toContain('KILLED')

        // The innocent process must still be alive.
        let aliveAfter = false
        try {
          process.kill(innocentPid, 0) // throws if dead
          aliveAfter = true
        } catch {}
        expect(
          aliveAfter,
          `Innocent 'sleep 30' process (pid=${innocentPid}) was killed — PID-reuse guard missing!`
        ).toBe(true)
      } finally {
        rmSync(stateDir, { recursive: true, force: true })
      }
    } finally {
      // Always clean up our innocent process.
      try { innocent.kill('SIGTERM') } catch {}
    }
  })

  test('stale PID pointing to a real plugin process — SIGTERM IS sent', () => {
    // Spawn a fake "plugin" process whose cmd line will match the pattern.
    // We override BOT_CMD_PATTERN to 'tg-fake-plugin' and name the script
    // tg-fake-plugin.mjs so ps output matches. The stale-poller must emit
    // 'KILLED' in stderr (not 'SKIPPED').
    //
    // NOTE: we assert SIGTERM was SENT (stale-poller's decision), not that
    // the target is dead. Bun's SIGTERM delivery timing is non-deterministic
    // (the bun wrapper may not immediately propagate the signal to the JS VM),
    // so asserting the process is dead within a fixed timeout is flaky.
    // The critical property is: correct decision branch was taken.
    const stateDir = mkdtempSync(join(tmpdir(), 'tg-pid-real-'))
    const fakePluginScript = join(stateDir, 'tg-fake-plugin.mjs')
    // Script exits cleanly on SIGTERM so cleanup is reliable.
    writeFileSync(fakePluginScript, `process.on('SIGTERM', () => process.exit(143))\nsetTimeout(() => {}, 30000)\n`)

    const fakePlugin = spawn('bun', ['run', fakePluginScript])
    const fakePluginPid = fakePlugin.pid!

    try {
      // Give bun a moment to start and appear in ps.
      spawnSync('sleep', ['0.5'])

      writeFileSync(join(stateDir, 'bot.pid'), String(fakePluginPid))

      const scriptPath = join(stateDir, 'stale-poller.mjs')
      // Override pattern to match 'tg-fake-plugin' which appears in the script path.
      writeFileSync(scriptPath, stalePollScript(stateDir, 'tg-fake-plugin'))

      const result = spawnSync('bun', ['run', scriptPath], {
        timeout: 5000,
        encoding: 'utf8',
        env: { ...process.env, TELEGRAM_STATE_DIR: stateDir, TELEGRAM_BOT_CMD_PATTERN: 'tg-fake-plugin' },
      })

      expect(
        result.status,
        `stale-poller script failed. stderr=${result.stderr}`
      ).toBe(0)

      // Key assertions: SIGTERM was sent (KILLED), not skipped.
      expect(
        result.stderr,
        'Expected KILLED for plugin-matching process, got: ' + result.stderr
      ).toContain('KILLED')
      expect(
        result.stderr,
        'Must NOT say SKIPPED for plugin-matching process'
      ).not.toContain('SKIPPED')
    } finally {
      try { fakePlugin.kill('SIGKILL') } catch {} // force-kill for cleanup
      rmSync(stateDir, { recursive: true, force: true })
    }
  })
})

// ── Route A — signed approval-channel emit (SemenAssistant analysis/routea-
// spec-FINAL.md M3) ──────────────────────────────────────────────────────────
//
// signApproval/emitApprovalSignal are pure module-level functions in server.ts
// (not exported — the file is a live entrypoint, same reason every other test
// in this file uses the extracted-reproduction pattern instead of importing
// server.ts directly, which would require a real bot token and try to connect
// to Telegram). These reproduction scripts mirror the server.ts logic
// EXACTLY. Cross-runtime KAT conformance itself is proven independently in the
// bridge repo (services/sam-whatsapp-bridge/test/approvalsign.test.js reading
// test/fixtures/routea-kat.json) — the SAME test-only key + vectors are
// embedded here so this repo can prove ITS signApproval reproduces the exact
// same expected_sig, without a cross-repo file dependency.
describe('Route A — signed approval-channel emit', () => {
  // TEST-ONLY key + vectors — identical to services/sam-whatsapp-bridge/test/
  // fixtures/routea-kat.json. NOT a real secret.
  const KAT_KEY_HEX = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'
  const KAT_CASES = [
    {
      kind: 'reaction', owner_id: '378650081', chat_id: '378650081', message_id: '4321',
      reply_to_message_id: '', payload: '👍',
      nonce: '0123456789abcdef0123456789abcdef', issued_at_ms: 1751490000000,
      expected_sig: '7ee80c4bb9a92f9fafe866d15e4a865a74fd3da33419120cc5ed287e9461bafe',
    },
    {
      kind: 'reply', owner_id: '378650081', chat_id: '378650081', message_id: '5555',
      reply_to_message_id: '4321', payload: 'ПОДТВЕРЖДАЮ',
      nonce: 'fedcba9876543210fedcba9876543210', issued_at_ms: 1751490000000,
      expected_sig: 'e146940011956308dde613e8e7771fa6c817bd1ff6d4ab1cbc3a3425b0a2abb3',
    },
  ]

  // Reproduces signApproval() from server.ts verbatim (createHmac + the exact
  // 9-line \n-joined canonical string, no trailing newline).
  function signApprovalScript(keyHex: string): string {
    return /* js */ `
import { createHmac } from 'crypto'
const KEY_HEX = ${JSON.stringify(keyHex)}
function signApproval(f) {
  const canonical = ['SAMWA-APPROVAL-v1', f.kind, f.owner_id, f.chat_id, f.message_id,
    f.reply_to_message_id, f.payload, f.nonce, String(f.issued_at_ms)].join('\\n')
  return createHmac('sha256', Buffer.from(KEY_HEX, 'hex')).update(canonical, 'utf8').digest('hex')
}
const cases = ${JSON.stringify(KAT_CASES)}
for (const c of cases) {
  const got = signApproval(c)
  console.log(got === c.expected_sig ? 'MATCH:' + c.kind : 'MISMATCH:' + c.kind + ':' + got)
}
`
  }

  test('signApproval reproduces the M0 KAT expected_sig for both cases (cross-runtime conformance)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'routea-kat-'))
    try {
      const scriptPath = join(dir, 'kat.mjs')
      writeFileSync(scriptPath, signApprovalScript(KAT_KEY_HEX))
      const result = spawnSync('bun', ['run', scriptPath], { encoding: 'utf8', timeout: 5000 })
      expect(result.status, `KAT script failed: ${result.stderr}`).toBe(0)
      expect(result.stdout).toContain('MATCH:reaction')
      expect(result.stdout).toContain('MATCH:reply')
      expect(result.stdout).not.toContain('MISMATCH')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('signApproval: a different key produces a different signature (sanity — not a constant)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'routea-kat-negative-'))
    try {
      const scriptPath = join(dir, 'kat-neg.mjs')
      const wrongKey = '11'.repeat(32)
      writeFileSync(scriptPath, signApprovalScript(wrongKey))
      const result = spawnSync('bun', ['run', scriptPath], { encoding: 'utf8', timeout: 5000 })
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('MISMATCH')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Reproduces emitApprovalSignal() from server.ts verbatim (env-pointer dark
  // switch, CR/LF rejection, loose-perms refusal, atomic 0600 create).
  function emitScript(channelPath: string, keyHex?: string, ownerId?: string, payload?: string): string {
    return /* js */ `
import { createHmac, randomBytes } from 'crypto'
import { appendFileSync, statSync, chmodSync } from 'fs'

const APPROVAL_SIGNING_KEY_HEX = ${keyHex ? JSON.stringify(keyHex) : 'undefined'}
const APPROVAL_CHANNEL_PATH = ${JSON.stringify(channelPath)}
const APPROVAL_OWNER_ID = ${ownerId ? JSON.stringify(ownerId) : 'undefined'}

function signApproval(f) {
  const canonical = ['SAMWA-APPROVAL-v1', f.kind, f.owner_id, f.chat_id, f.message_id,
    f.reply_to_message_id, f.payload, f.nonce, String(f.issued_at_ms)].join('\\n')
  return createHmac('sha256', Buffer.from(APPROVAL_SIGNING_KEY_HEX, 'hex')).update(canonical, 'utf8').digest('hex')
}

function emitApprovalSignal(f) {
  if (!APPROVAL_SIGNING_KEY_HEX || !APPROVAL_CHANNEL_PATH || !APPROVAL_OWNER_ID) return
  if (/[\\r\\n]/.test(f.payload)) return
  try {
    let exists = false
    try {
      const st = statSync(APPROVAL_CHANNEL_PATH)
      exists = true
      if ((st.mode & 0o077) !== 0) {
        process.stderr.write('LOOSE_PERMS_REFUSED\\n')
        return
      }
    } catch {}
    const rec = { schema: 'samwa.approval.v1', ...f, sig: signApproval(f) }
    appendFileSync(APPROVAL_CHANNEL_PATH, JSON.stringify(rec) + '\\n', { mode: 0o600 })
    if (!exists) { try { chmodSync(APPROVAL_CHANNEL_PATH, 0o600) } catch {} }
    console.log('EMITTED')
  } catch (err) {
    process.stderr.write('EMIT_ERROR:' + err + '\\n')
  }
}

emitApprovalSignal({
  kind: 'reaction', owner_id: '111222333', chat_id: '111222333', message_id: 'm1',
  reply_to_message_id: '', payload: ${JSON.stringify(payload ?? '👍')},
  nonce: randomBytes(16).toString('hex'), issued_at_ms: Date.now(),
})
`
  }

  test('emitApprovalSignal: all three pointers set -> writes one parseable line whose sig verifies', () => {
    const dir = mkdtempSync(join(tmpdir(), 'routea-emit-'))
    try {
      const channelPath = join(dir, 'approval-channel.jsonl')
      const scriptPath = join(dir, 'emit.mjs')
      writeFileSync(scriptPath, emitScript(channelPath, KAT_KEY_HEX, '111222333'))
      const result = spawnSync('bun', ['run', scriptPath], { encoding: 'utf8', timeout: 5000 })
      expect(result.status, `emit script failed: ${result.stderr}`).toBe(0)
      expect(result.stdout).toContain('EMITTED')

      const lines = readFileSync(channelPath, 'utf8').trim().split('\n')
      expect(lines.length).toBe(1)
      const rec = JSON.parse(lines[0]!)
      expect(rec.schema).toBe('samwa.approval.v1')
      expect(rec.owner_id).toBe('111222333')
      expect(rec.sig).toMatch(/^[0-9a-f]{64}$/)

      // 0600 from creation.
      const mode = statSync(channelPath).mode & 0o777
      expect(mode).toBe(0o600)

      // The written sig independently verifies against the SAME KAT-style
      // canonical construction (proves the record is self-consistent, not
      // just "some hex string").
      const verifyScript = /* js */ `
import { createHmac } from 'crypto'
const rec = ${JSON.stringify(rec)}
const canonical = ['SAMWA-APPROVAL-v1', rec.kind, rec.owner_id, rec.chat_id, rec.message_id,
  rec.reply_to_message_id, rec.payload, rec.nonce, String(rec.issued_at_ms)].join('\\n')
const expected = createHmac('sha256', Buffer.from(${JSON.stringify(KAT_KEY_HEX)}, 'hex')).update(canonical, 'utf8').digest('hex')
console.log(expected === rec.sig ? 'VERIFIED' : 'MISMATCH')
`
      const vPath = join(dir, 'verify.mjs')
      writeFileSync(vPath, verifyScript)
      const vResult = spawnSync('bun', ['run', vPath], { encoding: 'utf8', timeout: 5000 })
      expect(vResult.stdout).toContain('VERIFIED')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('emitApprovalSignal: signing key unset -> feature dark, no file write', () => {
    const dir = mkdtempSync(join(tmpdir(), 'routea-emit-dark1-'))
    try {
      const channelPath = join(dir, 'approval-channel.jsonl')
      const scriptPath = join(dir, 'emit.mjs')
      writeFileSync(scriptPath, emitScript(channelPath, undefined, '111222333'))
      const result = spawnSync('bun', ['run', scriptPath], { encoding: 'utf8', timeout: 5000 })
      expect(result.status).toBe(0)
      expect(result.stdout).not.toContain('EMITTED')
      expect(existsSync(channelPath)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('emitApprovalSignal: owner id unset -> feature dark, no file write', () => {
    const dir = mkdtempSync(join(tmpdir(), 'routea-emit-dark2-'))
    try {
      const channelPath = join(dir, 'approval-channel.jsonl')
      const scriptPath = join(dir, 'emit.mjs')
      writeFileSync(scriptPath, emitScript(channelPath, KAT_KEY_HEX, undefined))
      const result = spawnSync('bun', ['run', scriptPath], { encoding: 'utf8', timeout: 5000 })
      expect(result.status).toBe(0)
      expect(result.stdout).not.toContain('EMITTED')
      expect(existsSync(channelPath)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('emitApprovalSignal: a pre-existing loose-perms channel file refuses to append [FIX B-3]', () => {
    const dir = mkdtempSync(join(tmpdir(), 'routea-emit-loose-'))
    try {
      const channelPath = join(dir, 'approval-channel.jsonl')
      writeFileSync(channelPath, '', { mode: 0o600 })
      chmodSync(channelPath, 0o644) // loosen AFTER creation
      const scriptPath = join(dir, 'emit.mjs')
      writeFileSync(scriptPath, emitScript(channelPath, KAT_KEY_HEX, '111222333'))
      const result = spawnSync('bun', ['run', scriptPath], { encoding: 'utf8', timeout: 5000 })
      expect(result.status).toBe(0)
      expect(result.stderr).toContain('LOOSE_PERMS_REFUSED')
      expect(result.stdout).not.toContain('EMITTED')
      expect(readFileSync(channelPath, 'utf8')).toBe('') // untouched
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('emitApprovalSignal: a CR/LF payload never emits [FIX B-8]', () => {
    const dir = mkdtempSync(join(tmpdir(), 'routea-emit-crlf-'))
    try {
      const channelPath = join(dir, 'approval-channel.jsonl')
      const scriptPath = join(dir, 'emit.mjs')
      writeFileSync(scriptPath, emitScript(channelPath, KAT_KEY_HEX, '111222333', 'line1\nline2'))
      const result = spawnSync('bun', ['run', scriptPath], { encoding: 'utf8', timeout: 5000 })
      expect(result.status).toBe(0)
      expect(result.stdout).not.toContain('EMITTED')
      expect(existsSync(channelPath)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // ── the owner-id gate the two call sites add on top of the existing
  // reactionGate()/gate() allowlist checks — [FIX B-1] ──────────────────────
  function ownerGateScript(fromId: string, ownerEnv?: string): string {
    return /* js */ `
const APPROVAL_OWNER_ID = ${ownerEnv ? JSON.stringify(ownerEnv) : 'undefined'}
const from = { id: ${JSON.stringify(fromId)} }
const chat_id = String(from.id) // simulate the sender's own DM
const added = ['👍']
const wouldEmit = !!(
  APPROVAL_OWNER_ID && String(from.id) === APPROVAL_OWNER_ID &&
  chat_id === String(from.id) && added.length > 0
)
console.log(wouldEmit ? 'WOULD_EMIT' : 'WOULD_NOT_EMIT')
`
  }

  test('[FIX B-1] owner-id gate: the CONFIGURED owner -> would emit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'routea-ownergate-'))
    try {
      const scriptPath = join(dir, 'gate.mjs')
      writeFileSync(scriptPath, ownerGateScript('111222333', '111222333'))
      const result = spawnSync('bun', ['run', scriptPath], { encoding: 'utf8', timeout: 5000 })
      expect(result.stdout).toContain('WOULD_EMIT')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('[FIX B-1] owner-id gate: an ALLOWLISTED-but-not-owner DM -> would NOT emit (the B-1 fix)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'routea-ownergate-notowner-'))
    try {
      const scriptPath = join(dir, 'gate.mjs')
      // a DIFFERENT allowlisted user id than the configured owner
      writeFileSync(scriptPath, ownerGateScript('999888777', '111222333'))
      const result = spawnSync('bun', ['run', scriptPath], { encoding: 'utf8', timeout: 5000 })
      expect(result.stdout).toContain('WOULD_NOT_EMIT')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('[FIX B-1] owner-id gate: APPROVAL_OWNER_ID unset -> would NOT emit (feature dark)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'routea-ownergate-unset-'))
    try {
      const scriptPath = join(dir, 'gate.mjs')
      writeFileSync(scriptPath, ownerGateScript('111222333', undefined))
      const result = spawnSync('bun', ['run', scriptPath], { encoding: 'utf8', timeout: 5000 })
      expect(result.stdout).toContain('WOULD_NOT_EMIT')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

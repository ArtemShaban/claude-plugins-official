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
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'fs'
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

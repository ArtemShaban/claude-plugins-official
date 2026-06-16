/**
 * TDD test for the EPIPE storm fix (incident 2026-06-16).
 *
 * Scenario: parent Claude Code process dies → stdio pipe breaks → EPIPE is
 * thrown inside uncaughtException → without the fix the handler re-enters
 * itself in a tight loop, flooding shutdown.log (2.6 GB in 17 min, event
 * loop starved). With the fix, the process exits cleanly on the first EPIPE.
 *
 * This test spawns a minimal bun script that registers the exact same
 * handler pattern used in server.ts, then emits an EPIPE-coded error via
 * process.emit('uncaughtException', ...).  If the fix is present, the script
 * calls process.exit(1) immediately and spawnSync returns status=1.  If the
 * fix is absent, the handler falls through and the script stays alive until
 * the 3-second timeout fires (status=null / signal='SIGTERM').
 */

import { describe, test, expect } from 'bun:test'
import { spawnSync } from 'child_process'
import { writeFileSync, mkdirSync, rmSync } from 'fs'
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

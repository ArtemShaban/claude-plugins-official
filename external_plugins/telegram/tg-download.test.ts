// The one Telegram file download (D-1066, spec sam-data dev/analysis/2026-11-16-tg-file-download-fix-spec.md
// criteria 1–3 + the token rule). Hermetic: a local fake Bot API on 127.0.0.1, a fake token, no live state.
// It also proves on this Bun (RCA Verification Queue) that aborting the losing attempt really closes its socket.
import { afterEach, describe, expect, test } from 'bun:test'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { createTelegramDownloader, DOWNLOAD_CAP_MS, HEDGE_MS, TelegramDownloadError } from './tg-download'
import { voiceErrorClass } from './voice-delivery'

const TOKEN = '123456789:AAH-SECRET-fake-token-for-tests'
const SECRET = 'SECRET-fake-token'
const FILE = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])

type Handler = (kind: 'getfile' | 'file', n: number, req: IncomingMessage, res: ServerResponse) => void

interface Fake {
  origin: string
  server: Server
  sockets: Socket[]
  closed: Set<Socket>
  requests: { kind: 'getfile' | 'file'; socket: Socket }[]
}

const fakes: Fake[] = []

async function fakeApi(handler: Handler): Promise<Fake> {
  const sockets: Socket[] = []
  const closed = new Set<Socket>()
  const requests: Fake['requests'] = []
  const counts = { getfile: 0, file: 0 }
  const server = createServer((req, res) => {
    const url = req.url ?? ''
    expect(url.includes(TOKEN)).toBe(true) // the token travels only in the URL, to this server
    const kind = url.includes('/getFile') ? 'getfile' : 'file'
    counts[kind]++
    requests.push({ kind, socket: req.socket })
    handler(kind, counts[kind], req, res)
  })
  server.on('connection', s => {
    sockets.push(s)
    s.on('close', () => closed.add(s))
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  const { port } = server.address() as AddressInfo
  const f = { origin: `http://127.0.0.1:${port}`, server, sockets, closed, requests }
  fakes.push(f)
  return f
}

afterEach(() => {
  for (const f of fakes.splice(0)) {
    f.server.closeAllConnections()
    f.server.close()
  }
})

const okGetFile = (res: ServerResponse, extra: Record<string, unknown> = {}) => {
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ ok: true, result: { file_id: 'F', file_unique_id: 'AgAD-uniq', file_size: FILE.length, file_path: 'voice/file_7.oga', ...extra } }))
}
const okFile = (res: ServerResponse) => res.end(Buffer.from(FILE))
const never = () => {}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const probe = async () => 12

async function waitClosed(f: Fake, s: Socket, ms = 2_000) {
  const t0 = Date.now()
  while (!f.closed.has(s) && Date.now() - t0 < ms) await sleep(20)
  return f.closed.has(s)
}

describe('defaults', () => {
  test('hedge 8 s, hard cap 180 s', () => {
    expect(HEDGE_MS).toBe(8_000)
    expect(DOWNLOAD_CAP_MS).toBe(180_000)
  })
})

describe('criterion 1 — attempt 1 stalls, attempt 2 at 8 s on a second connection wins', () => {
  test('case g: getFile never answers on attempt 1', async () => {
    const f = await fakeApi((kind, n, _req, res) => {
      if (kind === 'getfile' && n === 1) return never()
      if (kind === 'getfile') return okGetFile(res)
      okFile(res)
    })
    const dl = createTelegramDownloader({ token: TOKEN, origin: f.origin, probe })
    const t0 = Date.now()
    const got = await dl.downloadTelegramFile('F', { maxBytes: 1_000 })
    const took = Date.now() - t0
    expect(got.status).toBe('ok')
    if (got.status === 'ok') expect([...got.bytes]).toEqual([...FILE])
    expect(took).toBeGreaterThanOrEqual(HEDGE_MS - 50)
    expect(took).toBeLessThanOrEqual(10_000)
    expect(f.sockets.length).toBeGreaterThanOrEqual(2) // the hedge went out on a second connection
    const stalled = f.requests[0].socket
    expect(f.requests.filter(r => r.socket !== stalled).length).toBeGreaterThanOrEqual(2)
    expect(await waitClosed(f, stalled)).toBe(true) // the loser's abort closed its socket (Bun)
    expect(got.journal).toMatchObject({ dl_att: 2, dl_win: 2, dl_phase: 'done', probe_ms: 12 })
    expect(dl.inflightCount()).toBe(0)
  }, 15_000)

  test('case h: file GET sends no headers on attempt 1', async () => {
    const f = await fakeApi((kind, n, _req, res) => {
      if (kind === 'getfile') return okGetFile(res)
      if (n === 1) return never()
      okFile(res)
    })
    const dl = createTelegramDownloader({ token: TOKEN, origin: f.origin, probe })
    const t0 = Date.now()
    const got = await dl.downloadTelegramFile('F', { maxBytes: 1_000 })
    const took = Date.now() - t0
    expect(got.status).toBe('ok')
    expect(took).toBeGreaterThanOrEqual(HEDGE_MS - 50)
    expect(took).toBeLessThanOrEqual(10_000)
    const stalledFile = f.requests.find(r => r.kind === 'file')!.socket
    const second = f.requests.filter(r => r.kind === 'file')[1].socket
    expect(second).not.toBe(stalledFile)
    expect(await waitClosed(f, stalledFile)).toBe(true)
    expect(got.journal.dl_win).toBe(2)
    expect(got.journal.dl_att).toBe(2)
  }, 15_000)
})

describe('criterion 2 — first complete answer wins (scaled: hedge 100 ms, attempt 1 done at 1 s)', () => {
  test('attempt 1 slow but complete, attempt 2 stalls → attempt 1 wins, attempt 2 aborted', async () => {
    const f = await fakeApi((kind, n, _req, res) => {
      if (kind === 'getfile' && n === 1) return void setTimeout(() => okGetFile(res), 1_000)
      if (kind === 'getfile') return never()
      okFile(res)
    })
    const dl = createTelegramDownloader({ token: TOKEN, origin: f.origin, probe, hedgeMs: 100 })
    const t0 = Date.now()
    const got = await dl.downloadTelegramFile('F', { maxBytes: 1_000 })
    const took = Date.now() - t0
    expect(got.status).toBe('ok')
    expect(took).toBeGreaterThanOrEqual(950)
    expect(took).toBeLessThan(2_000)
    expect(got.journal).toMatchObject({ dl_att: 2, dl_win: 1, dl_phase: 'done' })
    expect(got.journal.gf_ms).toBeGreaterThanOrEqual(950)
    const second = f.requests.filter(r => r.kind === 'getfile')[1].socket
    expect(await waitClosed(f, second)).toBe(true)
  })

  test('no hedge once attempt 1 has headers (a streaming body is never fetched twice)', async () => {
    const f = await fakeApi((kind, _n, _req, res) => {
      if (kind === 'getfile') return okGetFile(res)
      res.writeHead(200)
      res.write(Buffer.from(FILE.slice(0, 4)))
      setTimeout(() => res.end(Buffer.from(FILE.slice(4))), 400)
    })
    const dl = createTelegramDownloader({ token: TOKEN, origin: f.origin, probe, hedgeMs: 100 })
    const got = await dl.downloadTelegramFile('F', { maxBytes: 1_000 })
    expect(got.status).toBe('ok')
    if (got.status === 'ok') expect([...got.bytes]).toEqual([...FILE])
    expect(f.requests.length).toBe(2)
    expect(got.journal.dl_att).toBe(1)
    expect(got.journal.probe_ms).toBeUndefined() // never on the happy path
  })

  test('fast happy path: one attempt, no probe', async () => {
    let probed = 0
    const f = await fakeApi((kind, _n, _req, res) => (kind === 'getfile' ? okGetFile(res) : okFile(res)))
    const dl = createTelegramDownloader({ token: TOKEN, origin: f.origin, probe: async () => (probed++, 1) })
    const got = await dl.downloadTelegramFile('F', { maxBytes: 1_000 })
    expect(got).toMatchObject({ status: 'ok', ext: 'oga', uniqueId: 'AgAD-uniq' })
    expect(got.journal).toMatchObject({ dl_att: 1, dl_win: 1, dl_phase: 'done' })
    await sleep(50)
    expect(probed).toBe(0)
  })
})

describe('criterion 3 — single-flight per file_id', () => {
  test('a second call while in flight (also after the first caller stopped waiting) joins: one request, same bytes', async () => {
    let release: () => void = () => {}
    const f = await fakeApi((kind, _n, _req, res) => {
      if (kind === 'getfile') return void (release = () => okGetFile(res))
      okFile(res)
    })
    const dl = createTelegramDownloader({ token: TOKEN, origin: f.origin, probe, hedgeMs: 60_000 })
    const first = dl.downloadTelegramFile('F', { maxBytes: 1_000 })
    // The voice gives up waiting (its own bound); the shared download goes on.
    const voiceWait = await Promise.race([first.then(() => 'got'), sleep(150).then(() => 'gave-up')])
    expect(voiceWait).toBe('gave-up')
    let joinedJournal: unknown
    const second = dl.downloadTelegramFile('F', { maxBytes: 1_000, onStart: j => (joinedJournal = j) })
    expect(dl.inflightCount()).toBe(1)
    release()
    const [a, b] = await Promise.all([first, second])
    expect(a).toBe(b)
    if (b.status === 'ok') expect([...b.bytes]).toEqual([...FILE])
    expect(joinedJournal).toBe(a.journal)
    expect(f.requests.filter(r => r.kind === 'getfile').length).toBe(1)
    expect(f.requests.filter(r => r.kind === 'file').length).toBe(1)
    expect(dl.inflightCount()).toBe(0)
  })

  test('after a failed download the next call fetches anew', async () => {
    const f = await fakeApi((kind, n, _req, res) => {
      if (kind === 'getfile') return okGetFile(res)
      if (n === 1) {
        res.statusCode = 500
        return res.end('boom')
      }
      okFile(res)
    })
    const dl = createTelegramDownloader({ token: TOKEN, origin: f.origin, probe })
    const err = await dl.downloadTelegramFile('F', { maxBytes: 1_000 }).catch(e => e)
    expect(err).toBeInstanceOf(TelegramDownloadError)
    expect(voiceErrorClass(err)).toBe('http_500')
    expect(dl.inflightCount()).toBe(0)
    const again = await dl.downloadTelegramFile('F', { maxBytes: 1_000 })
    expect(again.status).toBe('ok')
    expect(f.requests.filter(r => r.kind === 'getfile').length).toBe(2)
  })

  test('different file_ids do not join', async () => {
    const f = await fakeApi((kind, _n, _req, res) => (kind === 'getfile' ? okGetFile(res) : okFile(res)))
    const dl = createTelegramDownloader({ token: TOKEN, origin: f.origin, probe })
    await Promise.all([dl.downloadTelegramFile('A', { maxBytes: 1_000 }), dl.downloadTelegramFile('B', { maxBytes: 1_000 })])
    expect(f.requests.filter(r => r.kind === 'getfile').length).toBe(2)
  })
})

describe('bounds and results', () => {
  test('hard cap: both attempts stalled → timed out, all sockets closed, entry dropped', async () => {
    const f = await fakeApi(() => never())
    const dl = createTelegramDownloader({ token: TOKEN, origin: f.origin, probe, hedgeMs: 50, capMs: 300 })
    const err = await dl.downloadTelegramFile('F', { maxBytes: 1_000 }).catch(e => e)
    expect(voiceErrorClass(err)).toBe('timeout')
    expect(dl.inflightCount()).toBe(0)
    expect(f.sockets.length).toBe(2)
    for (const s of f.sockets) expect(await waitClosed(f, s)).toBe(true)
  })

  test('attempt 1 fails before the hedge → fails at once, no second attempt (no retry)', async () => {
    const f = await fakeApi((_k, _n, _req, res) => {
      res.statusCode = 400
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: invalid file_id' }))
    })
    const dl = createTelegramDownloader({ token: TOKEN, origin: f.origin, probe, hedgeMs: 200 })
    const err = await dl.downloadTelegramFile('F', { maxBytes: 1_000 }).catch(e => e)
    expect(voiceErrorClass(err)).toBe('http_400')
    await sleep(300)
    expect(f.requests.length).toBe(1)
  })

  test('no file_path → no_file; over maxBytes → too_big (no file GET)', async () => {
    const f1 = await fakeApi((_k, _n, _req, res) => okGetFile(res, { file_path: undefined }))
    const a = await createTelegramDownloader({ token: TOKEN, origin: f1.origin, probe }).downloadTelegramFile('F', { maxBytes: 1_000 })
    expect(a.status).toBe('no_file')
    const f2 = await fakeApi((_k, _n, _req, res) => okGetFile(res, { file_size: 5_000 }))
    const b = await createTelegramDownloader({ token: TOKEN, origin: f2.origin, probe }).downloadTelegramFile('F', { maxBytes: 1_000 })
    expect(b.status).toBe('too_big')
    expect(f2.requests.length).toBe(1)
  })
})

describe('the bot token never leaves in an error or the journal', () => {
  const leaks = (x: unknown) => {
    const e = x as Error & Record<string, unknown>
    const all = [String(e), e?.message, e?.stack, JSON.stringify(e), JSON.stringify(Object.entries(e ?? {}))].join('\n')
    return all.includes(SECRET) || all.includes(TOKEN)
  }

  test('connection refused, HTTP error with the token in the body, getFile description, cap timeout', async () => {
    // refused: a port nobody listens on
    const tmp = await fakeApi(() => never())
    const deadOrigin = tmp.origin
    tmp.server.close()
    fakes.splice(fakes.indexOf(tmp), 1)
    const errs: unknown[] = []
    errs.push(await createTelegramDownloader({ token: TOKEN, origin: deadOrigin, probe }).downloadTelegramFile('F', { maxBytes: 9 }).catch(e => e))
    const f = await fakeApi((kind, _n, req, res) => {
      if (kind === 'getfile') {
        res.statusCode = 401
        res.setHeader('content-type', 'application/json')
        return res.end(JSON.stringify({ ok: false, error_code: 401, description: `Unauthorized ${req.url}` }))
      }
    })
    errs.push(await createTelegramDownloader({ token: TOKEN, origin: f.origin, probe }).downloadTelegramFile('F', { maxBytes: 9 }).catch(e => e))
    const g = await fakeApi((kind, _n, req, res) => {
      if (kind === 'getfile') return okGetFile(res)
      res.statusCode = 404
      res.end(`not found ${req.url}`)
    })
    errs.push(await createTelegramDownloader({ token: TOKEN, origin: g.origin, probe }).downloadTelegramFile('F', { maxBytes: 9 }).catch(e => e))
    const h = await fakeApi(() => never())
    let journal: unknown
    errs.push(
      await createTelegramDownloader({ token: TOKEN, origin: h.origin, probe, hedgeMs: 30, capMs: 120 })
        .downloadTelegramFile('F', { maxBytes: 9, onStart: j => (journal = j) })
        .catch(e => e),
    )
    expect(errs.map(e => voiceErrorClass(e))).toEqual(['network', 'http_401', 'http_404', 'timeout'])
    for (const e of errs) {
      expect(e).toBeInstanceOf(TelegramDownloadError)
      expect(leaks(e)).toBe(false)
    }
    expect(JSON.stringify(journal)).not.toContain(SECRET)
  })
})

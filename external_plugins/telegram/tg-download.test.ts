// The one Telegram file download (D-1066, spec sam-data dev/analysis/2026-11-16-tg-file-download-fix-spec.md
// criteria 1–3 + the token rule; D-1087 spec dev/analysis/2026-11-18-tg-voice-late-fetch-spec.md criterion 2: ONE
// attempt — the 8 s second attempt is gone, the 8 s TCP probe stays). Hermetic: a local fake Bot API on 127.0.0.1, a
// fake token, no live state. It also proves on this Bun that aborting a stalled download really closes its socket.
import { afterEach, describe, expect, test } from 'bun:test'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { createTelegramDownloader, DOWNLOAD_CAP_MS, PROBE_AFTER_MS, TelegramDownloadError, TRANSFER_CEILING_BYTES } from './tg-download'
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
  test('probe at 8 s, hard cap 180 s', () => {
    expect(PROBE_AFTER_MS).toBe(8_000)
    expect(DOWNLOAD_CAP_MS).toBe(180_000)
  })
})

const getFiles = (f: Fake) => f.requests.filter(r => r.kind === 'getfile').length

// D-1087 criterion 2 (owner tg 49565 «вырежи повтор в 8 сек, если он бесполезен»; RCA M1: 0 of 14 wins).
describe('D-1087 criterion 2 — a stalled getFile gets no second attempt; the 8 s probe stays', () => {
  test('real 8 s mark: getFile never answers → still exactly 1 getFile after 8 s, probe_ms filled, dl_att=1', async () => {
    const f = await fakeApi(() => never())
    const dl = createTelegramDownloader({ token: TOKEN, origin: f.origin, probe, capMs: 9_000 })
    let journal: { dl_att: number; probe_ms?: unknown } | undefined
    const p = dl.downloadTelegramFile('F', { onStart: j => (journal = j) }).catch(e => e)
    await sleep(PROBE_AFTER_MS + 500)
    expect(getFiles(f)).toBe(1)
    expect(f.sockets.length).toBe(1)
    expect(journal).toMatchObject({ dl_att: 1, dl_phase: 'getfile', probe_ms: 12 })
    const err = await p
    expect(voiceErrorClass(err)).toBe('timeout')
    expect(getFiles(f)).toBe(1)
    expect(await waitClosed(f, f.sockets[0])).toBe(true)
    expect(dl.inflightCount()).toBe(0)
  }, 15_000)

  test('scaled (probe 100 ms ≙ 8 s, cap 2.25 s ≙ 180 s): 1 getFile at the probe mark, at ≙30 s and at the cap', async () => {
    const f = await fakeApi(() => never())
    const dl = createTelegramDownloader({ token: TOKEN, origin: f.origin, probe, probeAfterMs: 100, capMs: 2_250 })
    let journal: { dl_att: number; probe_ms?: unknown } | undefined
    const p = dl.downloadTelegramFile('F', { onStart: j => (journal = j) }).catch(e => e)
    await sleep(150)
    expect(getFiles(f)).toBe(1)
    expect(journal?.probe_ms).toBe(12)
    await sleep(375 - 150)
    expect(getFiles(f)).toBe(1)
    const err = await p
    expect(voiceErrorClass(err)).toBe('timeout')
    expect(getFiles(f)).toBe(1)
    expect(journal?.dl_att).toBe(1)
  })

  test('file GET sends no headers → no second file GET either; probe filled; cap ends it', async () => {
    const f = await fakeApi((kind, _n, _req, res) => (kind === 'getfile' ? okGetFile(res) : never()))
    const dl = createTelegramDownloader({ token: TOKEN, origin: f.origin, probe, probeAfterMs: 100, capMs: 600 })
    let journal: { dl_att: number; dl_phase: string; probe_ms?: unknown } | undefined
    const err = await dl.downloadTelegramFile('F', { onStart: j => (journal = j) }).catch(e => e)
    expect(voiceErrorClass(err)).toBe('timeout')
    expect(f.requests.map(r => r.kind)).toEqual(['getfile', 'file'])
    expect(journal).toMatchObject({ dl_att: 1, dl_phase: 'headers', probe_ms: 12 })
  })
})

describe('criterion 2 — a slow but complete answer (scaled: probe 100 ms, getFile done at 1 s)', () => {
  test('getFile slow but complete → one attempt wins, probe filled, no second getFile', async () => {
    const f = await fakeApi((kind, _n, _req, res) => {
      if (kind === 'getfile') return void setTimeout(() => okGetFile(res), 1_000)
      okFile(res)
    })
    const dl = createTelegramDownloader({ token: TOKEN, origin: f.origin, probe, probeAfterMs: 100 })
    const t0 = performance.now()
    const got = await dl.downloadTelegramFile('F')
    const took = performance.now() - t0
    expect(got.status).toBe('ok')
    expect(took).toBeGreaterThanOrEqual(950)
    expect(took).toBeLessThan(2_000)
    expect(got.journal).toMatchObject({ dl_att: 1, dl_win: 1, dl_phase: 'done', probe_ms: 12 })
    expect(got.journal.gf_ms).toBeGreaterThanOrEqual(950)
    expect(getFiles(f)).toBe(1)
  })

  test('no probe once the file GET has headers (a streaming body is not a stall)', async () => {
    const f = await fakeApi((kind, _n, _req, res) => {
      if (kind === 'getfile') return okGetFile(res)
      res.writeHead(200)
      res.write(Buffer.from(FILE.slice(0, 4)))
      setTimeout(() => res.end(Buffer.from(FILE.slice(4))), 400)
    })
    const dl = createTelegramDownloader({ token: TOKEN, origin: f.origin, probe, probeAfterMs: 100 })
    const got = await dl.downloadTelegramFile('F')
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
    const got = await dl.downloadTelegramFile('F')
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
    const dl = createTelegramDownloader({ token: TOKEN, origin: f.origin, probe, probeAfterMs: 60_000 })
    const first = dl.downloadTelegramFile('F')
    // The voice gives up waiting (its own bound); the shared download goes on.
    const voiceWait = await Promise.race([first.then(() => 'got'), sleep(150).then(() => 'gave-up')])
    expect(voiceWait).toBe('gave-up')
    let joinedJournal: unknown
    const second = dl.downloadTelegramFile('F', { onStart: j => (joinedJournal = j) })
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
    const err = await dl.downloadTelegramFile('F').catch(e => e)
    expect(err).toBeInstanceOf(TelegramDownloadError)
    expect(voiceErrorClass(err)).toBe('http_500')
    expect(dl.inflightCount()).toBe(0)
    const again = await dl.downloadTelegramFile('F')
    expect(again.status).toBe('ok')
    expect(f.requests.filter(r => r.kind === 'getfile').length).toBe(2)
  })

  test('different file_ids do not join', async () => {
    const f = await fakeApi((kind, _n, _req, res) => (kind === 'getfile' ? okGetFile(res) : okFile(res)))
    const dl = createTelegramDownloader({ token: TOKEN, origin: f.origin, probe })
    await Promise.all([dl.downloadTelegramFile('A'), dl.downloadTelegramFile('B')])
    expect(f.requests.filter(r => r.kind === 'getfile').length).toBe(2)
  })
})

describe('bounds and results', () => {
  test('hard cap: the one attempt stalled → timed out, its socket closed, entry dropped', async () => {
    const f = await fakeApi(() => never())
    const dl = createTelegramDownloader({ token: TOKEN, origin: f.origin, probe, probeAfterMs: 50, capMs: 300 })
    const err = await dl.downloadTelegramFile('F').catch(e => e)
    expect(voiceErrorClass(err)).toBe('timeout')
    expect(dl.inflightCount()).toBe(0)
    expect(f.sockets.length).toBe(1)
    for (const s of f.sockets) expect(await waitClosed(f, s)).toBe(true)
  })

  test('the attempt fails before the probe mark → fails at once, no second attempt (no retry)', async () => {
    const f = await fakeApi((_k, _n, _req, res) => {
      res.statusCode = 400
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: invalid file_id' }))
    })
    const dl = createTelegramDownloader({ token: TOKEN, origin: f.origin, probe, probeAfterMs: 200 })
    const err = await dl.downloadTelegramFile('F').catch(e => e)
    expect(voiceErrorClass(err)).toBe('http_400')
    await sleep(300)
    expect(f.requests.length).toBe(1)
  })

  test('no file_path → no_file; file_size over the 20 MiB ceiling → too_big (no file GET)', async () => {
    const f1 = await fakeApi((_k, _n, _req, res) => okGetFile(res, { file_path: undefined }))
    const a = await createTelegramDownloader({ token: TOKEN, origin: f1.origin, probe }).downloadTelegramFile('F')
    expect(a.status).toBe('no_file')
    const f2 = await fakeApi((_k, _n, _req, res) => okGetFile(res, { file_size: TRANSFER_CEILING_BYTES + 1 }))
    const b = await createTelegramDownloader({ token: TOKEN, origin: f2.origin, probe }).downloadTelegramFile('F')
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
    errs.push(await createTelegramDownloader({ token: TOKEN, origin: deadOrigin, probe }).downloadTelegramFile('F').catch(e => e))
    const f = await fakeApi((kind, _n, req, res) => {
      if (kind === 'getfile') {
        res.statusCode = 401
        res.setHeader('content-type', 'application/json')
        return res.end(JSON.stringify({ ok: false, error_code: 401, description: `Unauthorized ${req.url}` }))
      }
    })
    errs.push(await createTelegramDownloader({ token: TOKEN, origin: f.origin, probe }).downloadTelegramFile('F').catch(e => e))
    const g = await fakeApi((kind, _n, req, res) => {
      if (kind === 'getfile') return okGetFile(res)
      res.statusCode = 404
      res.end(`not found ${req.url}`)
    })
    errs.push(await createTelegramDownloader({ token: TOKEN, origin: g.origin, probe }).downloadTelegramFile('F').catch(e => e))
    const h = await fakeApi(() => never())
    let journal: unknown
    errs.push(
      await createTelegramDownloader({ token: TOKEN, origin: h.origin, probe, probeAfterMs: 30, capMs: 120 })
        .downloadTelegramFile('F', { onStart: j => (journal = j) })
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

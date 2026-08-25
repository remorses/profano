// Capture a V8 CPU profile of one fetch against a local wrangler Worker.

export type CdpResult = {
  profile?: {
    nodes?: object[]
    samples?: number[]
  }
}

export interface CdpClient {
  send(method: string, params?: object): Promise<CdpResult>
  close(): void
}

export interface ProfileWorkerRequestArgs {
  url: string
  inspector?: string
  outfile?: string
  interval?: number
  warm?: boolean
  fetchImpl?: typeof fetch
  connect?: (wsUrl: string) => Promise<CdpClient>
  writeFile: (path: string, data: string) => Promise<void>
}

export interface ProfileWorkerRequestResult {
  outfile: string
  status: number
  samples: number
}

const DEFAULT_INSPECTOR = 'http://127.0.0.1:9230'
const DEFAULT_OUTFILE = './req.cpuprofile'
const DEFAULT_INTERVAL_US = 100

export async function resolveInspectorWebSocket(
  inspector: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  if (inspector.startsWith('ws://') || inspector.startsWith('wss://')) {
    return inspector
  }

  const base = inspector.replace(/\/$/, '')
  const listUrl = base.endsWith('/json/list') || base.endsWith('/json')
    ? base
    : `${base}/json/list`

  const res = await fetchImpl(listUrl)
  if (!res.ok) {
    throw new Error(`Inspector ${listUrl} returned HTTP ${res.status}`)
  }
  const targets = (await res.json()) as Array<{ webSocketDebuggerUrl?: string }>
  const ws = targets.find((t) => t.webSocketDebuggerUrl)?.webSocketDebuggerUrl
  if (!ws) {
    throw new Error(
      'Inspector has no worker target. Start wrangler with --inspector-port 9230.',
    )
  }
  return ws
}

export async function connectCdp(wsUrl: string): Promise<CdpClient> {
  const ws = new WebSocket(wsUrl)
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true })
    ws.addEventListener('error', () => {
      reject(new Error(`Could not connect to inspector at ${wsUrl}`))
    }, { once: true })
  })

  let nextId = 1
  const pending = new Map<number, {
    resolve: (v: CdpResult) => void
    reject: (e: Error) => void
  }>()
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(String(ev.data)) as {
      id?: number
      result?: CdpResult
      error?: { message?: string }
    }
    if (msg.id == null) return
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)))
    else p.resolve(msg.result ?? {})
  })

  return {
    send(method, params) {
      const id = nextId++
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        ws.send(JSON.stringify({ id, method, params }))
      })
    },
    close: () => {
      ws.close()
    },
  }
}

export async function profileWorkerRequest(
  args: ProfileWorkerRequestArgs,
): Promise<ProfileWorkerRequestResult> {
  const fetchImpl = args.fetchImpl ?? fetch
  const inspector = args.inspector ?? DEFAULT_INSPECTOR
  const outfile = args.outfile ?? DEFAULT_OUTFILE
  const interval = args.interval ?? DEFAULT_INTERVAL_US
  const connect = args.connect ?? connectCdp

  if (args.warm) {
    const warm = await fetchImpl(args.url)
    await warm.arrayBuffer()
  }

  const wsUrl = await resolveInspectorWebSocket(inspector, fetchImpl)
  const cdp = await connect(wsUrl)
  try {
    await cdp.send('Profiler.enable')
    await cdp.send('Profiler.setSamplingInterval', { interval })
    await cdp.send('Profiler.start')
    const res = await fetchImpl(args.url)
    await res.arrayBuffer()
    const stopped = await cdp.send('Profiler.stop')
    const profile = stopped.profile
    if (!profile) {
      throw new Error('Profiler.stop returned no profile')
    }
    await args.writeFile(outfile, JSON.stringify(profile))
    return {
      outfile,
      status: res.status,
      samples: profile.samples?.length ?? 0,
    }
  } finally {
    cdp.close()
  }
}

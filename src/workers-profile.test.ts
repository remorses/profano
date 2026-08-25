// Tests for the Cloudflare Workers request profiler.
// Injects fetch + CDP so we cover the protocol without a live wrangler.

import { describe, expect, it } from 'vitest'
import {
  profileWorkerRequest,
  resolveInspectorWebSocket,
  type CdpClient,
} from './workers-profile.ts'

function jsonResponse(body: object, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('resolveInspectorWebSocket', () => {
  it('returns a ws URL unchanged', async () => {
    const ws = await resolveInspectorWebSocket('ws://127.0.0.1:9230/ws', fetch)
    expect(ws).toBe('ws://127.0.0.1:9230/ws')
  })

  it('discovers the debugger URL from /json/list', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      expect(String(input)).toBe('http://127.0.0.1:9230/json/list')
      return jsonResponse([
        { webSocketDebuggerUrl: 'ws://127.0.0.1:9230/ws' },
      ])
    }
    const ws = await resolveInspectorWebSocket('http://127.0.0.1:9230', fetchImpl)
    expect(ws).toBe('ws://127.0.0.1:9230/ws')
  })

  it('throws when the inspector has no worker target', async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse([])
    await expect(
      resolveInspectorWebSocket('http://127.0.0.1:9230', fetchImpl),
    ).rejects.toThrow(/no worker/i)
  })
})

describe('profileWorkerRequest', () => {
  it('starts the profiler, fetches the URL, then writes the profile', async () => {
    const methods: string[] = []
    const urls: string[] = []
    let written = ''

    const cdp: CdpClient = {
      send: async (method) => {
        methods.push(method)
        if (method === 'Profiler.stop') {
          return { profile: { nodes: [], samples: [1, 2, 3] } }
        }
        return {}
      },
      close: () => {
        methods.push('close')
      },
    }

    const result = await profileWorkerRequest({
      url: 'http://127.0.0.1:8788/login',
      inspector: 'ws://127.0.0.1:9230/ws',
      outfile: './req.cpuprofile',
      fetchImpl: async (input) => {
        urls.push(String(input))
        return new Response('ok', { status: 200 })
      },
      connect: async (wsUrl) => {
        expect(wsUrl).toBe('ws://127.0.0.1:9230/ws')
        return cdp
      },
      writeFile: async (_path, data) => {
        written = data
      },
    })

    expect(methods).toEqual([
      'Profiler.enable',
      'Profiler.setSamplingInterval',
      'Profiler.start',
      'Profiler.stop',
      'close',
    ])
    expect(urls).toEqual(['http://127.0.0.1:8788/login'])
    expect(result).toEqual({
      outfile: './req.cpuprofile',
      status: 200,
      samples: 3,
    })
    expect(JSON.parse(written)).toEqual({ nodes: [], samples: [1, 2, 3] })
  })

  it('warms the URL before Profiler.start', async () => {
    const methods: string[] = []
    const urls: string[] = []

    const cdp: CdpClient = {
      send: async (method) => {
        methods.push(method)
        if (method === 'Profiler.stop') return { profile: { samples: [] } }
        return {}
      },
      close: () => {},
    }

    await profileWorkerRequest({
      url: 'http://127.0.0.1:8788/',
      inspector: 'ws://127.0.0.1:9230/ws',
      warm: true,
      fetchImpl: async (input) => {
        urls.push(`${String(input)}@${methods.join(',')}`)
        return new Response('ok')
      },
      connect: async () => cdp,
      writeFile: async () => {},
    })

    expect(urls[0]).toBe('http://127.0.0.1:8788/@')
    expect(urls[1]).toBe(
      'http://127.0.0.1:8788/@Profiler.enable,Profiler.setSamplingInterval,Profiler.start',
    )
  })
})

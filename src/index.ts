import makeWASocket, { createAuthenticationState } from '@oxidezap/baileyrs/host'
import type { HostWASocket } from '@oxidezap/baileyrs/host'
import wasm from './bridge.wasm'
import { initSync } from '@oxidezap/whatsapp-rust-bridge/host'
import { DurableObject } from 'cloudflare:workers'
import { createStore } from './persistence'
import { handleMessages } from './bot'

interface Env {
  BOT: DurableObjectNamespace<SukunaBot>
  ADMIN_TOKEN: string
  PHONE_NUMBER: string
}
let wasmInitialized = false

type Status = { state: 'stopped' | 'connecting' | 'waiting_for_pair' | 'connected' | 'logged_out' | 'closed'; pairingCode?: string; error?: string }

export class SukunaBot extends DurableObject<Env> {
  private socket?: HostWASocket
  private status: Status = { state: 'stopped' }
  private starting?: Promise<void>
  private retryAt = 0

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'POST' && url.pathname === '/start') {
      await this.start(true)
      return Response.json(this.status)
    }
    if (request.method === 'GET' && url.pathname === '/status') {
      if (!this.socket && Date.now() >= this.retryAt) {
        try { await this.start(false) } catch { /* status below reports failure */ }
      }
      return Response.json(this.status)
    }
    return new Response('Not found', { status: 404 })
  }

  private start(allowPairing: boolean): Promise<void> {
    if (this.socket) return Promise.resolve()
    if (this.starting) return this.starting
    if (this.status.state === 'closed' && Date.now() < this.retryAt) return Promise.resolve()
    const task = this.openSocket(allowPairing).catch(error => {
      this.status = { state: 'closed', error: error instanceof Error ? error.message : 'Connection failed' }
      this.retryAt = Date.now() + 30_000
    })
    this.starting = task
    return task.finally(() => { if (this.starting === task) this.starting = undefined })
  }

  private async openSocket(allowPairing: boolean) {
    if (!wasmInitialized) {
      initSync({ module: wasm })
      wasmInitialized = true
    }
    const auth = await createAuthenticationState(createStore(this.ctx.storage))
    if (!allowPairing && !auth.creds.registered) {
      this.status = { state: 'stopped' }
      return
    }

    const socket = makeWASocket({ auth, version: [2, 3000, 1043857760], logger: undefined })
    let pairingRequested = false
    this.socket = socket

    socket.ev.on('connection.update', async ({ connection, qr, lastDisconnect }) => {
      if (qr && allowPairing && !auth.creds.registered && !pairingRequested) {
        pairingRequested = true
        this.status = { state: 'waiting_for_pair' }
        try {
          const phone = (this.env.PHONE_NUMBER ?? '').replace(/\D/g, '')
          if (!phone) throw new Error('PHONE_NUMBER secret is not configured')
          const code = await socket.requestPairingCode(phone)
          this.status = { state: 'waiting_for_pair', pairingCode: code }
        } catch (e) {
          pairingRequested = false
          this.status = { state: 'closed', error: e instanceof Error ? e.message : 'Pairing code request failed' }
          this.retryAt = Date.now() + 30_000
        }
      }
      if (connection === 'open') {
        this.status = { state: 'connected' }
        this.retryAt = 0
      } else if (connection === 'connecting') {
        this.status = { state: 'connecting' }
      } else if (connection === 'close') {
        const code = (lastDisconnect?.error as any)?.output?.statusCode
        this.socket = undefined
        if (code === 401) {
          this.status = { state: 'logged_out' }
          await this.ctx.storage.deleteAll()
        } else {
          this.status = { state: 'closed', error: 'WhatsApp connection closed' }
          this.retryAt = Date.now() + 30_000
        }
      }
    })

    socket.ev.on('messages.upsert', event => {
      void handleMessages(socket, event, this.ctx.storage).catch(err => {
        console.error('Command handler error', err instanceof Error ? err.message : 'unknown')
      })
    })
    this.status = { state: 'connecting' }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname !== '/start' && url.pathname !== '/status') {
      return new Response('SUKUNA BOT | Use /start or /status', { status: 200 })
    }
    if (!env.ADMIN_TOKEN) return new Response('ADMIN_TOKEN is not configured', { status: 503 })
    if (request.headers.get('authorization') !== `Bearer ${env.ADMIN_TOKEN}`) {
      return new Response('Unauthorized', { status: 401 })
    }
    const id = env.BOT.idFromName('sukuna-main')
    return env.BOT.get(id).fetch(`https://sukuna${url.pathname}`, { method: request.method })
  }
} satisfies ExportedHandler<Env>

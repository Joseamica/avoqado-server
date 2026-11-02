/** 🔴 DINERO — Parte 2 (1-nov): la cuenta del renglón por peso y quién sigue con la vieja. */
import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { requestLoggerMiddleware } from '@/middlewares/requestLogger'
import { runWithContext } from '@/observability/executionContext'
import {
  cuentaDePesoDeLaPeticion,
  esIosConPrecioTruncado,
  importePorPesoCents,
  importePorPesoViejoCents,
  marcarRutaDeLaTpv,
} from '@/services/shared/importePorPeso'

describe('las dos cuentas', () => {
  it.each([
    // [precio, kg, apps, vieja]
    [100.05, 0.3, 3002, 3001],
    [100.5, 0.57, 5728, 5729],
    [182.5, 0.102, 1861, 1861],
    [128.45, 0.3, 3854, 3853],
  ])('$%d × %d kg ⇒ apps %d ¢ · vieja %d ¢', (precio, kg, apps, vieja) => {
    expect(importePorPesoCents(precio, kg)).toBe(apps)
    expect(importePorPesoViejoCents(precio, kg)).toBe(vieja)
  })
})

describe('esIosConPrecioTruncado', () => {
  it.each([
    ['IOS', '1.15.0', true],
    ['IOS', '1.15.1', true],
    ['ios', '1.14.9', true],
    ['IOS', undefined, true], // sin versión legible: la vieja, como hasta hoy
    ['IOS', '1.15.2', false], // 1fe8f56: ya redondea el precio por kilo
    ['IOS', '1.15.10', false],
    ['ANDROID', '2.22.2', false],
    [undefined, '1.15.0', false],
  ])('%s %s ⇒ %s', (plataforma, version, esperado) => {
    expect(esIosConPrecioTruncado(plataforma, version)).toBe(esperado)
  })
})

describe('cuentaDePesoDeLaPeticion', () => {
  const en = (entrypoint: string, cliente?: { plataforma?: string; version?: string }, rutaDeLaTpv?: true) =>
    runWithContext({ correlationId: 'c', source: 'http', entrypoint, cliente, rutaDeLaTpv }, cuentaDePesoDeLaPeticion)

  it('sin contexto (scripts, pruebas) ⇒ la de las apps', () => expect(cuentaDePesoDeLaPeticion()).toBe('apps'))
  it('lo que entró por el montaje /tpv ⇒ la vieja, aunque diga ANDROID', () =>
    expect(en('POST /api/v1/tpv/venues/:id/sync/intents', { plataforma: 'ANDROID', version: '2.25.22' }, true)).toBe('vieja'))
  it('tablet ANDROID ⇒ apps', () =>
    expect(en('POST /api/v1/mobile/venues/:id/orders', { plataforma: 'ANDROID', version: '2.22.2' })).toBe('apps'))
  it('iOS 1.15.1 ⇒ vieja', () =>
    expect(en('POST /api/v1/mobile/venues/:id/area-tickets', { plataforma: 'IOS', version: '1.15.1' })).toBe('vieja'))
  it('iOS 1.15.6 ⇒ apps', () => expect(en('POST /api/v1/mobile/venues/:id/orders', { plataforma: 'IOS', version: '1.15.6' })).toBe('apps'))
  it('sin encabezados ⇒ apps', () => expect(en('POST /api/v1/mobile/venues/:id/orders')).toBe('apps'))
})

describe('marcarRutaDeLaTpv con Express de verdad (Codex parte2 r2 #1)', () => {
  // El mismo montaje que `src/routes/index.ts`: lo que Express manda a /tpv queda marcado, escriba como escriba la URL.
  const app = express()
  app.use(requestLoggerMiddleware)
  const api = express.Router()
  const responde = (_req: express.Request, res: express.Response) => res.json({ cuenta: cuentaDePesoDeLaPeticion() })
  api.use('/tpv', marcarRutaDeLaTpv, responde)
  api.use('/mobile', responde)
  app.use('/api/v1', api)
  let server: Server
  let base: string
  beforeAll(done => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      done()
    })
  })
  afterAll(done => {
    server.close(() => done())
  })
  const cuenta = async (ruta: string) => (await (await fetch(base + ruta, { method: 'POST' })).json()).cuenta

  it.each([
    ['/api/v1/tpv/venues/v/orders/o/items', 'vieja'],
    ['/API/V1/TPV/venues/v/sync/intents', 'vieja'],
    ['/api/v1/mobile/venues/v/orders', 'apps'],
  ])('%s ⇒ %s', async (ruta, esperada) => {
    expect(await cuenta(ruta)).toBe(esperada)
  })
})

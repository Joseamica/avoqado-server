/**
 * 🔴 27-sep (medido en vivo con /full-testing): los webhooks se montan ANTES de `configureCoreMiddlewares` —el body crudo de
 * las firmas— y ahí vive el logger. El POST de AngelPay contestaba sin `X-Correlation-ID`, no dejaba `Request End`, y sus
 * líneas 🚨/✅ salían sin correlationId: quien investigara una aprobación perdida no tenía con qué unirlas.
 *
 * Contra la app REAL (el orden de montaje es justo lo que se prueba), no contra un express armado a mano.
 */
import crypto from 'crypto'

import request from 'supertest'

import app from '../../../src/app'
import logger from '@/config/logger'
import { getContext, type ExecutionContext } from '@/observability/executionContext'
import { primeVenueNames } from '@/observability/venueNames'
import * as angelpayService from '@/services/tpv/angelpay-webhook.service'
import prisma from '@/utils/prismaClient'
import { newWebhookToken } from '@/services/aggregators/core/credentials'

jest.mock('@/services/aggregators/core/eventProcessor.service', () => ({ processInboundEvent: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/services/tpv/angelpay-webhook.service', () => ({
  ...jest.requireActual('@/services/tpv/angelpay-webhook.service'),
  processAngelPayWebhook: jest.fn(),
}))

const mockedFindFirst = (prisma as unknown as { merchantAccount: { findFirst: jest.Mock } }).merchantAccount.findFirst
const mockedProcess = angelpayService.processAngelPayWebhook as jest.Mock

const MERCHANT_ID = 'cmerchantctx00000000000001' // forma de cuid: el entrypoint lo normaliza a `:id`
const SECRETO = 'whsec_contexto'
// Espacios y orden raros A PROPÓSITO: si algo re-serializara el cuerpo antes de la firma, el HMAC dejaría de coincidir.
const CUERPO = '{ "event_type":"send_transaction",   "payload":{"status":"approved","amount":10000, "integratorReference":"ref-ctx"} }'

/** Las líneas `Request End` de una ruta (el logger está mockeado globalmente: se leen sus llamadas). */
const cierresDe = (ruta: string): Array<[string, string, Record<string, unknown>]> =>
  (logger.log as jest.Mock).mock.calls.filter(([, mensaje]) => String(mensaje).startsWith('Request End:') && String(mensaje).includes(ruta))

describe('🔴 los webhooks llevan contexto de ejecución', () => {
  it('🔴 AngelPay: X-Correlation-ID, el controlador corre DENTRO del contexto, y la firma sigue viendo los bytes exactos', async () => {
    mockedFindFirst.mockResolvedValue({ id: MERCHANT_ID, externalMerchantId: '351', angelpayWebhookSecret: SECRETO })
    let visto: ExecutionContext | undefined
    mockedProcess.mockImplementation(async () => {
      const ctx = getContext()
      visto = ctx && { ...ctx }
      return { action: 'MATCHED', eventLogId: 'evt_ctx' }
    })

    const res = await request(app)
      .post(`/api/v1/webhooks/angelpay/${MERCHANT_ID}`)
      .set('Content-Type', 'application/json')
      .set('X-Webhook-Event-Id', 'evt_ctx')
      .set('X-Webhook-Signature', crypto.createHmac('sha256', SECRETO).update(CUERPO).digest('hex'))
      .send(CUERPO)

    expect(res.status).toBe(200) // la firma validó: nadie tocó el cuerpo crudo
    const correlationId = res.headers['x-correlation-id']
    expect(correlationId).toBeTruthy()
    expect(visto).toMatchObject({ correlationId, source: 'http', entrypoint: 'POST /api/v1/webhooks/angelpay/:id' })

    const cierres = cierresDe(`/api/v1/webhooks/angelpay/${MERCHANT_ID}`)
    expect(cierres).toHaveLength(1)
    expect(cierres[0][1]).toMatch(new RegExp(`^Request End: POST /api/v1/webhooks/angelpay/${MERCHANT_ID} - 200 `))
    expect(cierres[0][2]).toMatchObject({ correlationId, statusCode: 200 })
  })

  it('🔴 el Request End del aviso lleva el NEGOCIO del comercio: logger y controlador comparten el contexto', async () => {
    const VENUE_ID = 'cvenuectx000000000000001'
    ;(prisma as unknown as { venue: { findMany: jest.Mock } }).venue.findMany.mockResolvedValue([{ id: VENUE_ID, name: 'FULLTEST Cafe' }])
    await primeVenueNames()
    mockedFindFirst.mockResolvedValue({
      id: MERCHANT_ID,
      externalMerchantId: '351',
      angelpayWebhookSecret: SECRETO,
      angelpayUserAccount: { venueId: VENUE_ID },
    })
    mockedProcess.mockResolvedValue({ action: 'MATCHED', eventLogId: 'evt_ctx' })
    let enElCierre: ExecutionContext | undefined
    ;(logger.log as jest.Mock).mockImplementation((_nivel: string, mensaje: string) => {
      if (String(mensaje).startsWith('Request End:')) enElCierre = { ...getContext()! }
    })

    const res = await request(app)
      .post(`/api/v1/webhooks/angelpay/${MERCHANT_ID}`)
      .set('Content-Type', 'application/json')
      .set('X-Webhook-Event-Id', 'evt_ctx_negocio')
      .set('X-Webhook-Signature', crypto.createHmac('sha256', SECRETO).update(CUERPO).digest('hex'))
      .send(CUERPO)

    expect(res.status).toBe(200)
    expect(enElCierre).toMatchObject({
      correlationId: res.headers['x-correlation-id'],
      venueId: VENUE_ID,
      venueName: 'FULLTEST Cafe',
    })
  })

  it.each([
    ['Stripe', '/api/v1/webhooks/stripe'],
    ['Mercado Pago', '/api/v1/webhooks/mercadopago'],
    ['Facturapi', '/api/v1/webhooks/facturapi/cemisorctx0000000000000001'],
    ['Google Calendar', '/api/v1/webhooks/google-calendar'],
  ])('%s también contesta con X-Correlation-ID y deja UNA línea Request End', async (_nombre, ruta) => {
    const res = await request(app).post(ruta).set('Content-Type', 'application/json').send('{}')
    const correlationId = res.headers['x-correlation-id']
    expect(correlationId).toBeTruthy()
    const cierres = cierresDe(ruta)
    expect(cierres).toHaveLength(1)
    expect(cierres[0][2]).toMatchObject({ correlationId, url: ruta })
  })

  it('una ruta de webhook que no existe cae al logger general y aun así deja UNA sola línea, con el id de la respuesta', async () => {
    const res = await request(app).post('/api/v1/webhooks/no-existe-wh').set('Content-Type', 'application/json').send('{}')
    // Por el sufijo, no por la ruta completa: una línea con la URL recortada (sin el prefijo) también cuenta.
    const cierres = cierresDe('no-existe-wh')
    expect(cierres).toHaveLength(1)
    expect(cierres[0][2]).toMatchObject({ correlationId: res.headers['x-correlation-id'], url: '/api/v1/webhooks/no-existe-wh' })
  })

  it('🔴 el token de verificación de WhatsApp (viaja en el query) nunca llega al log', async () => {
    await request(app).get('/api/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=secreto-de-meta&hub.challenge=42')
    const cierres = cierresDe('/api/v1/webhooks/whatsapp')
    expect(cierres).toHaveLength(1)
    expect(JSON.stringify(cierres[0])).not.toContain('secreto-de-meta')
  })
})

describe('🔴 conector de pases: el secreto de la URL nunca llega al log', () => {
  const TOKEN = newWebhookToken()
  const RUTA = `/api/v1/webhooks/aggregators/totalpass/${TOKEN}/booking`
  const prismaAgg = prisma as unknown as {
    aggregatorConnection: { findUnique: jest.Mock }
    aggregatorInboundEvent: { create: jest.Mock }
  }

  it('token desconocido ⇒ 404; ni el mensaje, ni la meta, ni el entrypoint del contexto traen el token', async () => {
    prismaAgg.aggregatorConnection.findUnique.mockResolvedValueOnce(null)
    const contextos: Array<ExecutionContext | undefined> = []
    const capturar = (..._args: unknown[]) => {
      const ctx = getContext()
      contextos.push(ctx && { ...ctx })
    }
    ;(logger.log as jest.Mock).mockImplementation(capturar)
    ;(logger.info as jest.Mock).mockImplementation(capturar)
    ;(logger.warn as jest.Mock).mockImplementation(capturar)

    const res = await request(app).post(RUTA).set('Content-Type', 'application/json').send('{}')

    expect(res.status).toBe(404)
    const cierres = cierresDe('/api/v1/webhooks/aggregators/totalpass/')
    expect(cierres).toHaveLength(1)
    expect(cierres[0][1]).toMatch(/^Request End: POST \/api\/v1\/webhooks\/aggregators\/totalpass\/\[redactado\]\/booking - 404 /)
    expect(cierres[0][2]).toMatchObject({ url: '/api/v1/webhooks/aggregators/totalpass/[redactado]/booking' })
    for (const metodo of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      expect(JSON.stringify((logger[metodo] as jest.Mock).mock.calls)).not.toContain(TOKEN)
    }
    expect(contextos.length).toBeGreaterThan(0)
    for (const ctx of contextos) {
      expect(JSON.stringify(ctx)).not.toContain(TOKEN)
      expect(ctx?.entrypoint).toBe('POST /api/v1/webhooks/aggregators/totalpass/:token/booking')
    }
  })

  it('🔴 un Content-Type que no es JSON llega igual como bytes crudos y se guarda (raw propio antes del router genérico)', async () => {
    prismaAgg.aggregatorConnection.findUnique.mockResolvedValueOnce({
      id: 'cconnctx000000000000000001',
      venueId: 'cvenuectx000000000000001',
      provider: 'TOTALPASS',
      webhookToken: TOKEN,
      status: 'ACTIVE',
    })
    prismaAgg.aggregatorInboundEvent.create.mockResolvedValueOnce({ id: 'cevtctx0000000000000000001' })

    const res = await request(app).post(RUTA).set('Content-Type', 'text/plain').send('{"slot":{"id":"s-1"}}')

    expect(res.status).toBe(200)
    expect(prismaAgg.aggregatorInboundEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ kind: 'BOOKING', payload: { slot: { id: 's-1' } } }) }),
    )
    for (const metodo of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      expect(JSON.stringify((logger[metodo] as jest.Mock).mock.calls)).not.toContain(TOKEN)
    }
  })
})

describe('regresión · un logger montado con prefijo (como el de /api/v1/public) registra la URL COMPLETA, una sola vez', () => {
  it('Express quita el prefijo de `req.url` dentro de un app.use con ruta: el log usa la URL original', async () => {
    const res = await request(app).get('/api/v1/public/no-existe-ctx')
    const cierres = cierresDe('no-existe-ctx') // por el sufijo: la línea con la URL recortada también cuenta
    expect(cierres).toHaveLength(1)
    expect(cierres[0][2]).toMatchObject({ correlationId: res.headers['x-correlation-id'], url: '/api/v1/public/no-existe-ctx' })
  })
})

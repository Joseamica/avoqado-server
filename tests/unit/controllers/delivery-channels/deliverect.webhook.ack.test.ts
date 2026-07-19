import type { Request, Response } from 'express'

// ── Mocks ────────────────────────────────────────────────────────────────────
// Mirrors tests/unit/controllers/tpv/blumon-webhook.controller.ack.test.ts: the
// ACK contract (persist-first, only 200 once the DeliveryOrderEvent row is
// durably stored) is asserted against mocked collaborators, not real Prisma.

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    deliveryChannelLink: {
      findUnique: jest.fn(),
    },
  },
}))

jest.mock('@/services/delivery-channels/providers/deliverect/deliverect.hmac', () => ({
  ...jest.requireActual('@/services/delivery-channels/providers/deliverect/deliverect.hmac'),
  verifyDeliverectHmac: jest.fn(),
}))

jest.mock('@/services/delivery-channels/providers/deliverect/deliverect.mapper', () => ({
  ...jest.requireActual('@/services/delivery-channels/providers/deliverect/deliverect.mapper'),
  parseDeliverectOrder: jest.fn(),
}))

jest.mock('@/services/delivery-channels/core/deliveryOrderIngestion.service', () => ({
  ingestDeliveryOrder: jest.fn(),
}))

jest.mock('@/services/delivery-channels/core/deliveryWebhookEvent.service', () => ({
  persistDeliveryEvent: jest.fn(),
  markEventResult: jest.fn(),
}))

import prisma from '@/utils/prismaClient'
import { verifyDeliverectHmac, DELIVERECT_HMAC_HEADER } from '@/services/delivery-channels/providers/deliverect/deliverect.hmac'
import { parseDeliverectOrder } from '@/services/delivery-channels/providers/deliverect/deliverect.mapper'
import { ingestDeliveryOrder } from '@/services/delivery-channels/core/deliveryOrderIngestion.service'
import { persistDeliveryEvent, markEventResult } from '@/services/delivery-channels/core/deliveryWebhookEvent.service'
import { handleDeliverectOrderWebhook, deliverectWebhookHealthCheck } from '@/controllers/delivery-channels/deliverect.webhook.controller'

const mockedFindUnique = (prisma as any).deliveryChannelLink.findUnique as jest.Mock
const mockedVerifyHmac = verifyDeliverectHmac as jest.Mock
const mockedParse = parseDeliverectOrder as jest.Mock
const mockedIngest = ingestDeliveryOrder as jest.Mock
const mockedPersist = persistDeliveryEvent as jest.Mock
const mockedMarkResult = markEventResult as jest.Mock

// ── Request / Response builders ───────────────────────────────────────────────

function mkReq(opts: {
  bodyBuf?: Buffer
  /** Overrides bodyBuf — for simulating a NON-Buffer body (raw-body mounting misconfig) */
  rawBody?: unknown
  headers?: Record<string, string>
  params?: Record<string, string>
}): Request {
  return {
    body: 'rawBody' in opts ? opts.rawBody : (opts.bodyBuf ?? Buffer.from('{}')),
    params: opts.params ?? { channelLinkId: 'link_1' },
    header(name: string) {
      return opts.headers?.[name.toLowerCase()]
    },
  } as unknown as Request
}

function mkRes(): Response & { __status?: number; __body?: unknown } {
  const res: any = {}
  res.status = (n: number) => {
    res.__status = n
    return res
  }
  res.json = (b: unknown) => {
    res.__body = b
    return res
  }
  return res
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const activeLink = {
  id: 'link_1',
  venueId: 'venue_1',
  status: 'ACTIVE',
  webhookSecret: 'secret_1',
  provider: 'DELIVERECT',
}

const disabledLink = { ...activeLink, status: 'DISABLED' }

const normalizedOrder = {
  externalId: 'ext_order_1',
  displayId: '#100',
  raw: { channelOrderId: 'ext_order_1', items: [] },
}

describe('Task 5 — Deliverect webhook ACK contract (persist-first)', () => {
  beforeEach(() => {
    mockedFindUnique.mockReset()
    mockedVerifyHmac.mockReset()
    mockedParse.mockReset()
    mockedIngest.mockReset()
    mockedPersist.mockReset()
    mockedMarkResult.mockReset()
  })

  it('404 when channelLinkId does not exist', async () => {
    mockedFindUnique.mockResolvedValue(null)
    const res = mkRes()

    await handleDeliverectOrderWebhook(mkReq({ params: { channelLinkId: 'unknown' } }), res)

    expect(res.__status).toBe(404)
    expect(mockedVerifyHmac).not.toHaveBeenCalled()
    expect(mockedPersist).not.toHaveBeenCalled()
  })

  it('404 when the channel link is DISABLED', async () => {
    mockedFindUnique.mockResolvedValue(disabledLink)
    const res = mkRes()

    await handleDeliverectOrderWebhook(mkReq({}), res)

    expect(res.__status).toBe(404)
    expect(mockedVerifyHmac).not.toHaveBeenCalled()
    expect(mockedPersist).not.toHaveBeenCalled()
  })

  it('401 when HMAC is invalid', async () => {
    mockedFindUnique.mockResolvedValue(activeLink)
    mockedVerifyHmac.mockReturnValue(false)
    const res = mkRes()

    await handleDeliverectOrderWebhook(mkReq({ headers: { [DELIVERECT_HMAC_HEADER]: 'bad-sig' } }), res)

    expect(res.__status).toBe(401)
    expect(mockedPersist).not.toHaveBeenCalled()
  })

  it('400 when the payload is invalid (mapper throws)', async () => {
    mockedFindUnique.mockResolvedValue(activeLink)
    mockedVerifyHmac.mockReturnValue(true)
    mockedParse.mockImplementation(() => {
      throw new Error('Deliverect: payload sin channelOrderId/items')
    })
    const res = mkRes()

    await handleDeliverectOrderWebhook(mkReq({ headers: { [DELIVERECT_HMAC_HEADER]: 'ok-sig' } }), res)

    expect(res.__status).toBe(400)
    expect(mockedPersist).not.toHaveBeenCalled()
  })

  it('200 only after the event is durably persisted and ingestion succeeds', async () => {
    mockedFindUnique.mockResolvedValue(activeLink)
    mockedVerifyHmac.mockReturnValue(true)
    mockedParse.mockReturnValue(normalizedOrder)
    mockedPersist.mockResolvedValue({ event: { id: 'evt_1' }, duplicate: false })
    mockedIngest.mockResolvedValue({ order: { id: 'order_1' }, created: true })
    const res = mkRes()

    await handleDeliverectOrderWebhook(mkReq({ headers: { [DELIVERECT_HMAC_HEADER]: 'ok-sig' } }), res)

    expect(mockedPersist).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'DELIVERECT',
        externalEventId: normalizedOrder.externalId,
        channelLinkId: activeLink.id,
        venueId: activeLink.venueId,
      }),
    )
    expect(mockedIngest).toHaveBeenCalledWith(normalizedOrder, activeLink)
    expect(mockedMarkResult).toHaveBeenCalledWith('evt_1', 'PROCESSED', 'order_1')
    expect(res.__status).toBe(200)
    expect((res.__body as any).status).toBe('PROCESSED')
  })

  it('DUPLICATE event → 200 without re-processing (ingestion NOT called)', async () => {
    mockedFindUnique.mockResolvedValue(activeLink)
    mockedVerifyHmac.mockReturnValue(true)
    mockedParse.mockReturnValue(normalizedOrder)
    mockedPersist.mockResolvedValue({ event: { id: 'evt_dup' }, duplicate: true })
    const res = mkRes()

    await handleDeliverectOrderWebhook(mkReq({ headers: { [DELIVERECT_HMAC_HEADER]: 'ok-sig' } }), res)

    expect(res.__status).toBe(200)
    expect((res.__body as any).status).toBe('DUPLICATE')
    expect(mockedIngest).not.toHaveBeenCalled()
    expect(mockedMarkResult).not.toHaveBeenCalled()
  })

  it('503 when persisting the event fails (Deliverect should retry — event may not be stored)', async () => {
    mockedFindUnique.mockResolvedValue(activeLink)
    mockedVerifyHmac.mockReturnValue(true)
    mockedParse.mockReturnValue(normalizedOrder)
    mockedPersist.mockRejectedValue(new Error('db down'))
    const res = mkRes()

    await handleDeliverectOrderWebhook(mkReq({ headers: { [DELIVERECT_HMAC_HEADER]: 'ok-sig' } }), res)

    expect(res.__status).toBe(503)
    expect(mockedIngest).not.toHaveBeenCalled()
    expect(mockedMarkResult).not.toHaveBeenCalled()
  })

  it('ingestion failure AFTER persistence → 200 with event marked FAILED (reconciliation picks it up, not the provider retry)', async () => {
    mockedFindUnique.mockResolvedValue(activeLink)
    mockedVerifyHmac.mockReturnValue(true)
    mockedParse.mockReturnValue(normalizedOrder)
    mockedPersist.mockResolvedValue({ event: { id: 'evt_2' }, duplicate: false })
    mockedIngest.mockRejectedValue(new Error('venue not found'))
    const res = mkRes()

    await handleDeliverectOrderWebhook(mkReq({ headers: { [DELIVERECT_HMAC_HEADER]: 'ok-sig' } }), res)

    expect(mockedMarkResult).toHaveBeenCalledWith('evt_2', 'FAILED', undefined, 'venue not found')
    expect(res.__status).toBe(200)
    expect((res.__body as any).status).toBe('FAILED_WILL_RETRY')
  })

  it('markEventResult(PROCESSED) failure after successful ingestion → still 200 PROCESSED with orderId (bookkeeping never changes the ACK truth)', async () => {
    mockedFindUnique.mockResolvedValue(activeLink)
    mockedVerifyHmac.mockReturnValue(true)
    mockedParse.mockReturnValue(normalizedOrder)
    mockedPersist.mockResolvedValue({ event: { id: 'evt_3' }, duplicate: false })
    mockedIngest.mockResolvedValue({ order: { id: 'order_3' }, created: true })
    mockedMarkResult.mockRejectedValue(new Error('db hiccup on bookkeeping'))
    const res = mkRes()

    await handleDeliverectOrderWebhook(mkReq({ headers: { [DELIVERECT_HMAC_HEADER]: 'ok-sig' } }), res)

    // Ingestion succeeded — the response must say PROCESSED, never FAILED_WILL_RETRY nor 503.
    expect(mockedIngest).toHaveBeenCalledTimes(1)
    expect(res.__status).toBe(200)
    expect((res.__body as any).status).toBe('PROCESSED')
    expect((res.__body as any).orderId).toBe('order_3')
  })

  it('ingestion fails AND markEventResult(FAILED) also fails → still 200 FAILED_WILL_RETRY (never escalates to 503: the event IS persisted)', async () => {
    mockedFindUnique.mockResolvedValue(activeLink)
    mockedVerifyHmac.mockReturnValue(true)
    mockedParse.mockReturnValue(normalizedOrder)
    mockedPersist.mockResolvedValue({ event: { id: 'evt_4' }, duplicate: false })
    mockedIngest.mockRejectedValue(new Error('venue not found'))
    mockedMarkResult.mockRejectedValue(new Error('db hiccup on bookkeeping'))
    const res = mkRes()

    await handleDeliverectOrderWebhook(mkReq({ headers: { [DELIVERECT_HMAC_HEADER]: 'ok-sig' } }), res)

    expect(res.__status).toBe(200)
    expect((res.__body as any).status).toBe('FAILED_WILL_RETRY')
  })

  it('non-Buffer req.body (raw-body mounting misconfig) → 503 without HMAC check nor ingestion', async () => {
    mockedFindUnique.mockResolvedValue(activeLink)
    const res = mkRes()

    await handleDeliverectOrderWebhook(
      mkReq({ rawBody: { channelOrderId: 'ext_1', items: [] }, headers: { [DELIVERECT_HMAC_HEADER]: 'ok-sig' } }),
      res,
    )

    // 503 (transitorio, fuerza retry mientras se arregla la config) — JAMÁS 401,
    // que haría a Deliverect descartar el pedido como firma inválida.
    expect(res.__status).toBe(503)
    expect(mockedVerifyHmac).not.toHaveBeenCalled()
    expect(mockedPersist).not.toHaveBeenCalled()
    expect(mockedIngest).not.toHaveBeenCalled()
  })

  it('health check returns 200', () => {
    const res = mkRes()

    deliverectWebhookHealthCheck({} as Request, res)

    expect(res.__status).toBe(200)
    expect((res.__body as any).status).toBe('healthy')
  })

  // ============================================================
  // Fix C5 (audit, spec §10.1.8): Deliverect manda cancelaciones con el MISMO
  // channelOrderId y status 100, sobre el MISMO webhook de orders (doc:
  // create-channel-order). Antes: TODO se persistía hardcoded eventType 'order' →
  // el dedup (@@unique([provider, externalEventId, eventType])) clasificaba la
  // cancelación como DUPLICATE del pedido original y la ACKeaba sin re-procesar —
  // el pedido local quedaba CONFIRMED/PAID para siempre.
  // ============================================================
  describe('Fix C5 — clasificación de eventType (order/cancel/status)', () => {
    it('payload con status 100 → persiste eventType "cancel" (NO "order"), no se traga como duplicado del pedido original', async () => {
      mockedFindUnique.mockResolvedValue(activeLink)
      mockedVerifyHmac.mockReturnValue(true)
      mockedParse.mockReturnValue({ ...normalizedOrder, raw: { channelOrderId: 'ext_order_1', items: [], status: 100 } })
      mockedPersist.mockResolvedValue({ event: { id: 'evt_cancel' }, duplicate: false })
      const res = mkRes()

      await handleDeliverectOrderWebhook(mkReq({ headers: { [DELIVERECT_HMAC_HEADER]: 'ok-sig' } }), res)

      expect(mockedPersist).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'cancel', externalEventId: normalizedOrder.externalId }),
      )
      // El cancel NO pasa por el pipeline de ingesta normal (crearía/actualizaría la
      // orden como si fuera un pedido nuevo/confirmado — el revert real queda para
      // staging, ver REVALIDAR EN STAGING en el controller).
      expect(mockedIngest).not.toHaveBeenCalled()
      // El evento se marca PROCESSED (terminal) de inmediato — si quedara RECIBIDO,
      // delivery-webhook-reconciliation.job (que barre RECEIVED/FAILED sin distinguir
      // eventType) lo recogería 10 min después y correría ingestDeliveryOrder sobre él
      // como si fuera un pedido nuevo, deshaciendo esta misma protección.
      expect(mockedMarkResult).toHaveBeenCalledWith('evt_cancel', 'PROCESSED')
      expect(res.__status).toBe(200)
    })

    it('evento "cancel": si markEventResult(PROCESSED) falla, igual responde 200 CANCEL_RECEIVED (bookkeeping no cambia el ACK)', async () => {
      mockedFindUnique.mockResolvedValue(activeLink)
      mockedVerifyHmac.mockReturnValue(true)
      mockedParse.mockReturnValue({ ...normalizedOrder, raw: { channelOrderId: 'ext_order_1', items: [], status: 100 } })
      mockedPersist.mockResolvedValue({ event: { id: 'evt_cancel_2' }, duplicate: false })
      mockedMarkResult.mockRejectedValue(new Error('db hiccup'))
      const res = mkRes()

      await handleDeliverectOrderWebhook(mkReq({ headers: { [DELIVERECT_HMAC_HEADER]: 'ok-sig' } }), res)

      expect(res.__status).toBe(200)
      expect((res.__body as any).status).toBe('CANCEL_RECEIVED')
    })

    it('DUPLICATE de un evento "cancel" ya persistido → 200 DUPLICATE igual que "order" (el dedup solo cambia de key, no de contrato)', async () => {
      mockedFindUnique.mockResolvedValue(activeLink)
      mockedVerifyHmac.mockReturnValue(true)
      mockedParse.mockReturnValue({ ...normalizedOrder, raw: { channelOrderId: 'ext_order_1', items: [], status: 100 } })
      mockedPersist.mockResolvedValue({ event: { id: 'evt_cancel_dup' }, duplicate: true })
      const res = mkRes()

      await handleDeliverectOrderWebhook(mkReq({ headers: { [DELIVERECT_HMAC_HEADER]: 'ok-sig' } }), res)

      expect(res.__status).toBe(200)
      expect((res.__body as any).status).toBe('DUPLICATE')
      expect(mockedIngest).not.toHaveBeenCalled()
    })

    it('REGRESIÓN: payload SIN status (pedido normal) → eventType sigue siendo "order", la ingesta corre igual que antes', async () => {
      mockedFindUnique.mockResolvedValue(activeLink)
      mockedVerifyHmac.mockReturnValue(true)
      mockedParse.mockReturnValue(normalizedOrder) // raw sin campo status
      mockedPersist.mockResolvedValue({ event: { id: 'evt_normal' }, duplicate: false })
      mockedIngest.mockResolvedValue({ order: { id: 'order_1' }, created: true })
      const res = mkRes()

      await handleDeliverectOrderWebhook(mkReq({ headers: { [DELIVERECT_HMAC_HEADER]: 'ok-sig' } }), res)

      expect(mockedPersist).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'order' }))
      expect(mockedIngest).toHaveBeenCalledWith(normalizedOrder, activeLink)
      expect(res.__status).toBe(200)
      expect((res.__body as any).status).toBe('PROCESSED')
    })

    it('REGRESIÓN: payload con status 0 (pedido nuevo sin confirmar) → sigue siendo "order", NUNCA "cancel"', async () => {
      mockedFindUnique.mockResolvedValue(activeLink)
      mockedVerifyHmac.mockReturnValue(true)
      mockedParse.mockReturnValue({ ...normalizedOrder, raw: { channelOrderId: 'ext_order_1', items: [], status: 0 } })
      mockedPersist.mockResolvedValue({ event: { id: 'evt_new' }, duplicate: false })
      mockedIngest.mockResolvedValue({ order: { id: 'order_1' }, created: true })
      const res = mkRes()

      await handleDeliverectOrderWebhook(mkReq({ headers: { [DELIVERECT_HMAC_HEADER]: 'ok-sig' } }), res)

      expect(mockedPersist).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'order' }))
      expect(mockedIngest).toHaveBeenCalled()
    })
  })
})

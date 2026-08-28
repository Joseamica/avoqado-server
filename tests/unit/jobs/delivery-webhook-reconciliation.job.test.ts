import { DeliveryOrderEventStatus } from '@prisma/client'

// ── Mocks ────────────────────────────────────────────────────────────────────
// prisma.deliveryOrderEvent is already registered as a mock model by the global
// setup (tests/__helpers__/setup.ts) — no local jest.mock('@/utils/prismaClient')
// needed (pattern: tests/unit/services/delivery-channels/deliveryOrderIngestion.test.ts).

jest.mock('@/utils/retry', () => ({
  __esModule: true,
  retry: jest.fn((fn: () => Promise<any>) => fn()),
  shouldRetryDbConnectionError: jest.fn(),
}))

jest.mock('@/services/delivery-channels/providers/deliverect/deliverect.mapper', () => ({
  parseDeliverectOrder: jest.fn(),
}))

jest.mock('@/services/delivery-channels/core/deliveryOrderIngestion.service', () => ({
  ingestDeliveryOrder: jest.fn(),
}))

jest.mock('@/services/delivery-channels/core/deliveryWebhookEvent.service', () => ({
  markEventResult: jest.fn(),
}))

jest.mock('@/services/delivery-channels/providers/uber-eats/uber.eventProcessor', () => ({
  processUberEvent: jest.fn(),
}))

import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { retry, shouldRetryDbConnectionError } from '@/utils/retry'
import { parseDeliverectOrder } from '@/services/delivery-channels/providers/deliverect/deliverect.mapper'
import { ingestDeliveryOrder } from '@/services/delivery-channels/core/deliveryOrderIngestion.service'
import { markEventResult } from '@/services/delivery-channels/core/deliveryWebhookEvent.service'
import { processUberEvent } from '@/services/delivery-channels/providers/uber-eats/uber.eventProcessor'
import { DeliveryWebhookReconciliationJob } from '@/jobs/delivery-webhook-reconciliation.job'

const mockedFindMany = (prisma as any).deliveryOrderEvent.findMany as jest.Mock
const mockedUpdateMany = (prisma as any).deliveryOrderEvent.updateMany as jest.Mock
const mockedUpdate = (prisma as any).deliveryOrderEvent.update as jest.Mock
const mockedRetry = retry as jest.Mock
const mockedParse = parseDeliverectOrder as jest.Mock
const mockedIngest = ingestDeliveryOrder as jest.Mock
const mockedMarkEventResult = markEventResult as jest.Mock
const mockedProcessUber = processUberEvent as jest.Mock

// ── Fixtures ──────────────────────────────────────────────────────────────────

const NOW = new Date('2026-07-18T12:00:00.000Z').getTime()
const activeLink: any = { id: 'link_1', venueId: 'venue_1', provider: 'DELIVERECT' }

function makeEvent(overrides: Partial<any> = {}) {
  return {
    id: 'evt_1',
    provider: 'DELIVERECT',
    externalEventId: 'ext_1',
    eventType: 'order',
    status: DeliveryOrderEventStatus.FAILED,
    error: 'some previous ingestion error',
    channelLinkId: 'link_1',
    channelLink: activeLink,
    venueId: 'venue_1',
    payload: { channelOrderId: 'ext_1', items: [] },
    orderId: null,
    receivedAt: new Date(NOW - 3600_000), // 1h ago — within both FAILED and RECEIVED windows
    processedAt: null,
    attemptCount: 0,
    nextAttemptAt: null,
    ...overrides,
  }
}

describe('DeliveryWebhookReconciliationJob', () => {
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW)
    ;[
      mockedFindMany,
      mockedUpdateMany,
      mockedUpdate,
      mockedRetry,
      mockedParse,
      mockedIngest,
      mockedMarkEventResult,
      mockedProcessUber,
    ].forEach(m => m.mockReset())
    mockedRetry.mockImplementation((fn: () => Promise<any>) => fn())
    mockedUpdateMany.mockResolvedValue({ count: 0 })
    mockedUpdate.mockResolvedValue({})
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  // ── New behavior ─────────────────────────────────────────────────────────

  it('reprocesses a FAILED event younger than 24h: re-parses the payload, re-ingests, marks PROCESSED with the resulting orderId', async () => {
    const event = makeEvent({ id: 'evt_failed', status: DeliveryOrderEventStatus.FAILED })
    mockedFindMany.mockResolvedValueOnce([event]).mockResolvedValueOnce([])
    const normalized = { externalId: 'ext_1', raw: event.payload }
    mockedParse.mockReturnValue(normalized)
    mockedIngest.mockResolvedValue({ order: { id: 'order_1' }, created: false })

    const result = await new DeliveryWebhookReconciliationJob().runOnce()

    expect(mockedParse).toHaveBeenCalledWith(Buffer.from(JSON.stringify(event.payload)), activeLink)
    expect(mockedIngest).toHaveBeenCalledWith(normalized, activeLink)
    expect(mockedMarkEventResult).toHaveBeenCalledWith('evt_failed', DeliveryOrderEventStatus.PROCESSED, 'order_1')
    expect(result).toEqual({ reprocessed: 1, orphaned: 0 })
  })

  it('reprocesses a stuck RECEIVED event older than 10min: idempotent re-ingest recovers the Task 5 bookkeeping failure → PROCESSED, no duplicate', async () => {
    const event = makeEvent({
      id: 'evt_received_stuck',
      status: DeliveryOrderEventStatus.RECEIVED,
      error: null,
      receivedAt: new Date(NOW - 15 * 60_000), // 15 min ago, > 10 min threshold
    })
    mockedFindMany.mockResolvedValueOnce([event]).mockResolvedValueOnce([])
    mockedParse.mockReturnValue({ externalId: 'ext_1', raw: event.payload })
    // The order already exists (ingestDeliveryOrder upserts by venueId_externalId) —
    // this is exactly the recovery path: re-ingest is a no-op on the Order/Payment,
    // and the job's markEventResult(PROCESSED) writes the bookkeeping that failed originally.
    mockedIngest.mockResolvedValue({ order: { id: 'order_existing' }, created: false })

    const result = await new DeliveryWebhookReconciliationJob().runOnce()

    expect(mockedIngest).toHaveBeenCalledTimes(1)
    expect(mockedMarkEventResult).toHaveBeenCalledWith('evt_received_stuck', DeliveryOrderEventStatus.PROCESSED, 'order_existing')
    expect(result.reprocessed).toBe(1)
  })

  it('does NOT touch a RECEIVED event younger than 10 minutes — the scan query excludes it via the receivedAt upper bound', async () => {
    mockedFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([])

    await new DeliveryWebhookReconciliationJob().runOnce()

    const scanWhere = mockedFindMany.mock.calls[0][0].where
    const statusOr = scanWhere.AND.find((c: any) => Array.isArray(c.OR) && c.OR[0].status).OR
    const receivedClause = statusOr.find((c: any) => c.status === DeliveryOrderEventStatus.RECEIVED)
    expect(receivedClause.receivedAt.lt).toEqual(new Date(NOW - 10 * 60_000))
    // A 2-minute-old RECEIVED event would NOT satisfy `receivedAt < now-10min` —
    // excluded by construction, proving it can never be returned by this query.
    const freshReceivedAt = new Date(NOW - 2 * 60_000)
    expect(freshReceivedAt.getTime() < receivedClause.receivedAt.lt.getTime()).toBe(false)
    expect(mockedIngest).not.toHaveBeenCalled()
    expect(mockedMarkEventResult).not.toHaveBeenCalled()
  })

  it('the scan query only ever targets FAILED and RECEIVED (never DUPLICATE/PROCESSED)', async () => {
    mockedFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([])

    await new DeliveryWebhookReconciliationJob().runOnce()

    const scanWhere = mockedFindMany.mock.calls[0][0].where
    const statusOr = scanWhere.AND.find((c: any) => Array.isArray(c.OR) && c.OR[0].status).OR
    expect(statusOr).toHaveLength(2)
    expect(statusOr.map((c: any) => c.status).sort()).toEqual([DeliveryOrderEventStatus.FAILED, DeliveryOrderEventStatus.RECEIVED].sort())
  })

  it('🔴 el scan sólo selecciona proveedores que este job SABE reconciliar', async () => {
    // Regresión real (2026-08-20): sin filtro, eventos UBER_EATS entraban a
    // `parseDeliverectOrder`, fallaban con "payload sin channelOrderId/items", reintentaban
    // cada 2 min por 24 h y se descartaban. Un pedido REAL de Uber se perdería en silencio.
    // El filtro NO es la lista de proveedores que existen: es la de los que tienen camino
    // propio abajo. Uno seleccionado sin camino cae al parser equivocado; uno con camino y
    // sin seleccionar se queda sin ningún reintento. Los dos lados se amplían JUNTOS.
    mockedFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([])

    await new DeliveryWebhookReconciliationJob().runOnce()

    const scanWhere = mockedFindMany.mock.calls[0][0].where
    const filtroProveedor = scanWhere.AND.find((c: any) => c.provider !== undefined)
    expect(filtroProveedor).toBeDefined()
    expect(filtroProveedor.provider.in.sort()).toEqual(['DELIVERECT', 'UBER_EATS'])
  })

  it('channelLinkId null (channel link deleted) → marked ORPHANED immediately, regardless of age, WITH the per-event 🚨 ops alert', async () => {
    const event = makeEvent({
      id: 'evt_orphan_immediate',
      channelLink: null,
      channelLinkId: null,
      receivedAt: new Date(NOW - 5 * 60_000), // fresh — immediate orphan doesn't wait for the 24h TTL
    })
    mockedFindMany.mockResolvedValueOnce([event]).mockResolvedValueOnce([])
    ;(logger.error as jest.Mock).mockClear()

    const result = await new DeliveryWebhookReconciliationJob().runOnce()

    expect(mockedParse).not.toHaveBeenCalled()
    expect(mockedIngest).not.toHaveBeenCalled()
    expect(mockedMarkEventResult).toHaveBeenCalledWith('evt_orphan_immediate', DeliveryOrderEventStatus.FAILED, undefined, 'ORPHANED')
    // BetterStack alerts on the '🚨 [Delivery recon] ORPHANED' pattern — the immediate
    // orphan (deleted channel link) must fire the SAME per-event alert as the 24h sweep,
    // otherwise a venue disabling its integration orphans events with zero ops visibility.
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('🚨 [Delivery recon] ORPHANED'),
      expect.objectContaining({
        eventId: 'evt_orphan_immediate',
        provider: 'DELIVERECT',
        externalEventId: 'ext_1',
        venueId: 'venue_1',
        reason: 'CHANNEL_LINK_DELETED',
      }),
    )
    expect(result).toEqual({ reprocessed: 0, orphaned: 1 })
  })

  it('an event that fails again during reprocessing is left FAILED (no markEventResult write) but its attemptCount/backoff bookkeeping IS updated, so the next pass retries it later', async () => {
    const event = makeEvent({ id: 'evt_throws' })
    mockedFindMany.mockResolvedValueOnce([event]).mockResolvedValueOnce([])
    mockedParse.mockReturnValue({ externalId: 'ext_1', raw: event.payload })
    mockedIngest.mockRejectedValue(new Error('venue not found'))

    const result = await new DeliveryWebhookReconciliationJob().runOnce()

    expect(mockedMarkEventResult).not.toHaveBeenCalled()
    expect(mockedUpdate).toHaveBeenCalledWith({
      where: { id: 'evt_throws' },
      data: { attemptCount: 1, nextAttemptAt: expect.any(Date) },
    })
    expect(result).toEqual({ reprocessed: 0, orphaned: 0 })
  })

  // ── Fix B2 (audit §10.2): backoff + skip-poison ─────────────────────────

  it('Fix B2: agenda un nextAttemptAt FUTURO al fallar — el evento no vuelve a ser seleccionable de inmediato (backoff exponencial)', async () => {
    const event = makeEvent({ id: 'evt_backoff', attemptCount: 2 })
    mockedFindMany.mockResolvedValueOnce([event]).mockResolvedValueOnce([])
    mockedParse.mockReturnValue({ externalId: 'ext_1', raw: event.payload })
    mockedIngest.mockRejectedValue(new Error('boom'))

    await new DeliveryWebhookReconciliationJob().runOnce()

    const call = mockedUpdate.mock.calls[0][0]
    expect(call.where).toEqual({ id: 'evt_backoff' })
    expect(call.data.attemptCount).toBe(3)
    expect(call.data.nextAttemptAt).toBeInstanceOf(Date)
    expect(call.data.nextAttemptAt.getTime()).toBeGreaterThan(NOW)
  })

  it('Fix B2: un evento con attemptCount >= MAX_ATTEMPTS (10) NO se selecciona — poison events nunca vuelven a intentarse', async () => {
    mockedFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([])

    await new DeliveryWebhookReconciliationJob().runOnce()

    const scanWhere = mockedFindMany.mock.calls[0][0].where
    expect(scanWhere.AND).toContainEqual({ attemptCount: { lt: 10 } })
  })

  it('Fix B2: el query de selección respeta la ventana de backoff — solo nextAttemptAt <= now O null', async () => {
    mockedFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([])

    await new DeliveryWebhookReconciliationJob().runOnce()

    const scanWhere = mockedFindMany.mock.calls[0][0].where
    expect(scanWhere.AND).toContainEqual({ OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date(NOW) } }] })
  })

  it('Fix B2: un evento que llega a MAX_ATTEMPTS (10) al fallar se vuelve poison — queda FAILED, nextAttemptAt null, se loguea UNA vez con el patrón 🚨 POISON', async () => {
    const event = makeEvent({ id: 'evt_poison', attemptCount: 9 }) // this failure is the 10th attempt
    mockedFindMany.mockResolvedValueOnce([event]).mockResolvedValueOnce([])
    mockedParse.mockReturnValue({ externalId: 'ext_1', raw: event.payload })
    mockedIngest.mockRejectedValue(new Error('permanently broken payload'))
    ;(logger.error as jest.Mock).mockClear()

    const result = await new DeliveryWebhookReconciliationJob().runOnce()

    expect(mockedUpdate).toHaveBeenCalledWith({ where: { id: 'evt_poison' }, data: { attemptCount: 10, nextAttemptAt: null } })
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('🚨 [Delivery recon] POISON'),
      expect.objectContaining({ eventId: 'evt_poison', attemptCount: 10 }),
    )
    expect(result).toEqual({ reprocessed: 0, orphaned: 0 })
  })

  it('Fix B2: si el bookkeeping de attemptCount/nextAttemptAt falla, NO tumba el resto del batch (misma garantía de aislamiento por-evento)', async () => {
    const bad = makeEvent({ id: 'evt_bad_bookkeeping' })
    const good = makeEvent({ id: 'evt_good' })
    mockedFindMany.mockResolvedValueOnce([bad, good]).mockResolvedValueOnce([])
    mockedParse.mockReturnValue({ externalId: 'ext_1', raw: {} })
    mockedIngest.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ order: { id: 'order_good' }, created: false })
    mockedUpdate.mockRejectedValueOnce(new Error('DB write failed'))

    const result = await new DeliveryWebhookReconciliationJob().runOnce()

    expect(mockedMarkEventResult).toHaveBeenCalledWith('evt_good', DeliveryOrderEventStatus.PROCESSED, 'order_good')
    expect(result.reprocessed).toBe(1)
  })

  it('one event failing does not break the rest of the batch (per-event catch)', async () => {
    const bad = makeEvent({ id: 'evt_bad' })
    const good = makeEvent({ id: 'evt_good' })
    mockedFindMany.mockResolvedValueOnce([bad, good]).mockResolvedValueOnce([])
    mockedParse.mockReturnValue({ externalId: 'ext_1', raw: {} })
    mockedIngest.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ order: { id: 'order_good' }, created: false })

    const result = await new DeliveryWebhookReconciliationJob().runOnce()

    expect(mockedMarkEventResult).toHaveBeenCalledTimes(1)
    expect(mockedMarkEventResult).toHaveBeenCalledWith('evt_good', DeliveryOrderEventStatus.PROCESSED, 'order_good')
    expect(result.reprocessed).toBe(1)
  })

  it('sweeps a FAILED event older than 24h to ORPHANED, excluded from the scan by age (never handed to parse/ingest)', async () => {
    const staleEvent = {
      id: 'evt_stale',
      provider: 'DELIVERECT',
      externalEventId: 'ext_stale',
      status: DeliveryOrderEventStatus.FAILED,
      venueId: 'venue_1',
      receivedAt: new Date(NOW - 25 * 3600_000), // 25h ago
    }
    mockedFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([staleEvent])
    mockedUpdateMany.mockResolvedValue({ count: 1 })

    const result = await new DeliveryWebhookReconciliationJob().runOnce()

    expect(mockedParse).not.toHaveBeenCalled()
    // Fix 4 (audit): the cutoff/exclusion + take-cap now live on the FETCH (markOrphaned's
    // own findMany, the 2nd findMany call in the pass) — the bulk update is scoped to
    // exactly the fetched batch's ids (see below), not this broader where.
    const orphanFetchWhere = mockedFindMany.mock.calls[1][0].where
    expect(orphanFetchWhere.OR).toEqual([{ error: null }, { error: { notIn: ['ORPHANED', 'PEDIDO_YA_NO_ACTIVO'] } }])
    expect(orphanFetchWhere.receivedAt.lt).toEqual(new Date(NOW - 24 * 3600_000))
    expect(mockedFindMany.mock.calls[1][0].take).toBe(50)
    // The bulk flip is scoped to EXACTLY the fetched (and logged) batch — never the broader
    // orphanWhere — so a row is never marked ORPHANED without first getting its per-event alert.
    const orphanUpdateWhere = mockedUpdateMany.mock.calls[0][0].where
    expect(orphanUpdateWhere).toEqual({ id: { in: ['evt_stale'] } })
    expect(mockedUpdateMany.mock.calls[0][0].data).toMatchObject({ status: DeliveryOrderEventStatus.FAILED, error: 'ORPHANED' })
    expect(result.orphaned).toBe(1)
  })

  it('Fix 4 (audit): caps the orphan sweep fetch at BATCH_SIZE, and scopes the bulk update to exactly that fetched batch (never the wider backlog)', async () => {
    const batch = Array.from({ length: 50 }, (_, i) => ({
      id: `evt_stale_${i}`,
      provider: 'DELIVERECT',
      externalEventId: `ext_stale_${i}`,
      status: DeliveryOrderEventStatus.FAILED,
      venueId: 'venue_1',
      receivedAt: new Date(NOW - 25 * 3600_000),
    }))
    mockedFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce(batch)
    mockedUpdateMany.mockResolvedValue({ count: 50 })

    const result = await new DeliveryWebhookReconciliationJob().runOnce()

    // The fetch that feeds the sweep is capped at BATCH_SIZE, same as the rest of the job —
    // an unbounded findMany here would load the ENTIRE expired backlog into memory in one
    // pass (possible memory burst) and emit one logger.error per row in one shot.
    expect(mockedFindMany.mock.calls[1][0].take).toBe(50)
    // The bulk flip never targets more than what was actually fetched/logged this pass —
    // a backlog bigger than BATCH_SIZE finishes across subsequent 2-minute passes instead
    // of being swept unbounded in one shot.
    expect(mockedUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: batch.map(row => row.id) } } }))
    expect(result.orphaned).toBe(50)
  })

  it('never re-touches a row already marked ORPHANED — both the scan and the sweep exclude error:"ORPHANED" (no infinite loop)', async () => {
    mockedFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([])

    await new DeliveryWebhookReconciliationJob().runOnce()

    const scanWhere = mockedFindMany.mock.calls[0][0].where
    const nullSafeErrorGuard = scanWhere.AND.find((c: any) => Array.isArray(c.OR) && 'error' in (c.OR[0] ?? {}))
    expect(nullSafeErrorGuard.OR).toEqual([{ error: null }, { error: { notIn: ['ORPHANED', 'PEDIDO_YA_NO_ACTIVO'] } }])
    // markOrphaned's own lookup query is the second findMany call in the pass.
    const orphanLookupWhere = mockedFindMany.mock.calls[1][0].where
    expect(orphanLookupWhere.OR).toEqual([{ error: null }, { error: { notIn: ['ORPHANED', 'PEDIDO_YA_NO_ACTIVO'] } }])
  })

  it('scans oldest-first and caps the batch at 50', async () => {
    mockedFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([])

    await new DeliveryWebhookReconciliationJob().runOnce()

    const args = mockedFindMany.mock.calls[0][0]
    expect(args.take).toBe(50)
    expect(args.orderBy).toEqual({ receivedAt: 'asc' })
    expect(args.include).toEqual({ channelLink: true })
  })

  it('wraps the initial scan read in retry(shouldRetryDbConnectionError)', async () => {
    mockedFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([])

    await new DeliveryWebhookReconciliationJob().runOnce()

    expect(mockedRetry).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ shouldRetry: shouldRetryDbConnectionError, context: 'deliveryWebhookReconciliation.scan' }),
    )
  })

  it('a transient failure on the scan read reports zero counters without crashing the cron', async () => {
    mockedRetry.mockRejectedValueOnce(new Error('connection lost'))

    await expect(new DeliveryWebhookReconciliationJob().runOnce()).resolves.toEqual({ reprocessed: 0, orphaned: 0 })
  })

  it('quiet pass when there is nothing to reconcile (no updateMany call on the empty-orphan early return)', async () => {
    mockedFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([])

    const result = await new DeliveryWebhookReconciliationJob().runOnce()

    expect(result).toEqual({ reprocessed: 0, orphaned: 0 })
    expect(mockedUpdateMany).not.toHaveBeenCalled()
  })

  // ── Regression / lifecycle ───────────────────────────────────────────────

  it('uses the anti-stampede cron pattern (45 */2 * * * *, never :00) and a 50-row batch', () => {
    const job = new DeliveryWebhookReconciliationJob()
    expect((job as any).CRON_PATTERN).toBe('45 */2 * * * *')
    expect((job as any).BATCH_SIZE).toBe(50)
  })

  it('stop() is safe to call before start(), and start()/stop() are idempotent', () => {
    const job = new DeliveryWebhookReconciliationJob()
    expect(() => job.stop()).not.toThrow()
    expect(() => {
      job.start()
      job.start()
      job.stop()
      job.stop()
    }).not.toThrow()
  })
  // ── UBER: reconciliación por su propio camino ────────────────────────────────────────
  //
  // El webhook de Uber contesta 200 y procesa en segundo plano (`void processUberEvent`),
  // así que ante un fallo NADIE lo reintentaba: el pedido ya estaba ACEPTADO en Uber —el
  // cliente esperando su comida— pero nunca llegaba a la cocina. Este job es el único
  // reintento que existe, y hasta ahora sólo miraba a Deliverect.
  describe('Uber Eats', () => {
    const uberLink: any = { id: 'link_u', venueId: 'venue_u', provider: 'UBER_EATS', externalLocationId: 'store_u' }

    const eventoUber = (overrides: Partial<any> = {}) =>
      makeEvent({
        id: 'evt_uber',
        provider: 'UBER_EATS',
        externalEventId: 'ev-uber-1',
        eventType: 'orders.notification',
        channelLinkId: 'link_u',
        channelLink: uberLink,
        venueId: 'venue_u',
        payload: { event_type: 'orders.notification', meta: { user_id: 'store_u' } },
        ...overrides,
      })

    it('🔴 lo reprocesa por SU camino, nunca con el parser de Deliverect', async () => {
      // Pasarlo por `parseDeliverectOrder` reventaría con "payload sin channelOrderId" y
      // el pedido moriría reintentando hasta el barrido de 24 h.
      mockedFindMany.mockResolvedValueOnce([eventoUber()]).mockResolvedValueOnce([])
      mockedProcessUber.mockResolvedValueOnce({ outcome: 'PROCESSED', orderId: 'ord_u', accepted: true })

      const result = await new DeliveryWebhookReconciliationJob().runOnce()

      expect(mockedProcessUber).toHaveBeenCalledWith('evt_uber')
      expect(mockedParse).not.toHaveBeenCalled()
      expect(result.reprocessed).toBe(1)
    })

    it('🔴 pedido que Uber YA CANCELÓ: es terminal, no se reintenta más', async () => {
      // Medido el 2026-08-20: pasado el plazo Uber responde "The order is no longer active".
      // Reintentar no lo resucita — sólo ocuparía un lugar del lote cada 2 minutos.
      mockedFindMany.mockResolvedValueOnce([eventoUber()]).mockResolvedValueOnce([])
      mockedProcessUber.mockResolvedValueOnce({ outcome: 'FAILED', accepted: false, error: 'PEDIDO_YA_NO_ACTIVO' })

      const result = await new DeliveryWebhookReconciliationJob().runOnce()

      expect(result.reprocessed).toBe(0)
      expect(mockedUpdate).not.toHaveBeenCalled() // ni siquiera agenda backoff: es definitivo
    })

    it('un fallo TRANSITORIO sí agenda backoff, como cualquier otro proveedor', async () => {
      mockedFindMany.mockResolvedValueOnce([eventoUber()]).mockResolvedValueOnce([])
      mockedProcessUber.mockResolvedValueOnce({ outcome: 'FAILED', error: 'ECONNRESET al traer el pedido' })

      await new DeliveryWebhookReconciliationJob().runOnce()

      expect(mockedProcessUber).toHaveBeenCalledWith('evt_uber') // por SU camino, no por el ajeno
      expect(mockedParse).not.toHaveBeenCalled()
      expect(mockedUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'evt_uber' },
          data: expect.objectContaining({ attemptCount: 1, nextAttemptAt: expect.any(Date) }),
        }),
      )
    })

    it('🔴 el barrido de 24 h también alcanza a Uber: nada se queda colgado para siempre', async () => {
      // Antes el barrido excluía a Uber a propósito, porque el scan no lo procesaba y
      // descartarlo habría sido perder la venta. Ahora que SÍ se procesa, tiene que poder
      // caducar como todos: si no, un payload roto vive eternamente en la cola.
      mockedFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([eventoUber({ receivedAt: new Date(NOW - 25 * 3600_000) })])
      mockedUpdateMany.mockResolvedValueOnce({ count: 1 })

      const result = await new DeliveryWebhookReconciliationJob().runOnce()

      // El mock devuelve la fila pase lo que pase, así que lo que de verdad prueba esto es
      // el WHERE: es el filtro —no el mock— lo que decide si Uber caduca o vive para siempre.
      const barridoWhere = mockedFindMany.mock.calls[1][0].where
      expect(barridoWhere.provider.in).toContain('UBER_EATS')
      expect(result.orphaned).toBe(1)
    })
  })
})

describe('🔴 una sola pasada a la vez', () => {
  // El cron dispara cada 2 minutos con `void this.runOnce()`, sin esperar a la anterior. Una
  // pasada lenta se encimaba con la siguiente, las dos tomaban el MISMO evento FAILED y las
  // dos lo reprocesaban: DOS comandas del mismo pedido (`KdsOrder.orderId` no es único) y la
  // cocina preparando la comida dos veces (Codex, 2ª pasada).
  it('el segundo tick se salta mientras el primero sigue corriendo', async () => {
    const job = new DeliveryWebhookReconciliationJob()

    let soltar!: () => void
    const enEspera = new Promise<void>(res => {
      soltar = res
    })
    const espia = jest
      .spyOn(job as unknown as { reprocessStuckEvents: () => Promise<unknown> }, 'reprocessStuckEvents')
      .mockImplementation(async () => {
        await enEspera
        return { reprocessed: 0, orphanedImmediate: 0 }
      })
    jest.spyOn(job as unknown as { markOrphaned: () => Promise<number> }, 'markOrphaned').mockResolvedValue(0)

    const primera = job.runOnce()
    const segunda = await job.runOnce() // no debe entrar

    expect(segunda).toEqual({ reprocessed: 0, orphaned: 0 })
    expect(espia).toHaveBeenCalledTimes(1)

    soltar()
    await primera

    // …y al terminar, el candado se suelta: el siguiente tick SÍ corre.
    await job.runOnce()
    expect(espia).toHaveBeenCalledTimes(2)
  })

  it('🔴 si la pasada REVIENTA, el candado se suelta — si no, el job queda muerto para siempre', async () => {
    const job = new DeliveryWebhookReconciliationJob()
    const espia = jest
      .spyOn(job as unknown as { reprocessStuckEvents: () => Promise<unknown> }, 'reprocessStuckEvents')
      .mockRejectedValueOnce(new Error('la base se cayó'))
      .mockResolvedValue({ reprocessed: 0, orphanedImmediate: 0 })
    jest.spyOn(job as unknown as { markOrphaned: () => Promise<number> }, 'markOrphaned').mockResolvedValue(0)

    await job.runOnce() // truena por dentro, no lanza
    await job.runOnce() // debe poder correr

    expect(espia).toHaveBeenCalledTimes(2)
  })
})

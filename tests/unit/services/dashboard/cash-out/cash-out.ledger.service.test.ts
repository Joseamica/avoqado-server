/**
 * Unit tests (mock-first) — cash-out ledger service.
 * Proves: idempotent materialization of COMPLETED sales into LOCKED escalating
 * entries, saldo = Σ AVAILABLE (pesos), and reconciliation-based clawback.
 */
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: jest.fn() },
    cashOutCommissionRate: { findMany: jest.fn() },
    saleVerification: { findMany: jest.fn() },
    promoterCommissionEntry: {
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      aggregate: jest.fn(),
      updateMany: jest.fn(),
    },
    cashOutScheduleDay: { findMany: jest.fn() },
  },
}))
jest.mock('@/services/modules/module.service', () => ({
  __esModule: true,
  MODULE_CODES: { SERIALIZED_INVENTORY: 'SERIALIZED_INVENTORY' },
  moduleService: { isModuleEnabled: jest.fn() },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { moduleService } from '@/services/modules/module.service'
import { materializeEntries, reconcileClawbacks, getSaldo } from '@/services/dashboard/cash-out/cash-out.ledger.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import { getContext, runWithContext, type RequestCancellation } from '@/observability/executionContext'
import { checkCancellation, endOfWriteUnit, RequestCancelledError } from '@/utils/requestCancellation'

const p = prisma as unknown as {
  venue: { findUnique: jest.Mock }
  cashOutCommissionRate: { findMany: jest.Mock }
  saleVerification: { findMany: jest.Mock }
  promoterCommissionEntry: { findMany: jest.Mock; count: jest.Mock; create: jest.Mock; aggregate: jest.Mock; updateMany: jest.Mock }
  cashOutScheduleDay: { findMany: jest.Mock }
}
const mockEnabled = moduleService.isModuleEnabled as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
  mockEnabled.mockResolvedValue(true)
  p.venue.findUnique.mockResolvedValue({ timezone: 'America/Mexico_City' })
  p.cashOutCommissionRate.findMany.mockResolvedValue([
    { saleType: 'LINEA_NUEVA', minCount: 1, maxCount: 5, amount: new Prisma.Decimal(30) },
    { saleType: 'LINEA_NUEVA', minCount: 6, maxCount: null, amount: new Prisma.Decimal(40) },
    { saleType: 'PORTABILIDAD', minCount: 1, maxCount: null, amount: new Prisma.Decimal(25) },
  ])
  // The 22nd is an active cash-out day by default so the existing materialization tests
  // (sales dated 2026-06-22) still produce entries under the new active-days gate.
  p.cashOutScheduleDay.findMany.mockResolvedValue([{ day: new Date('2026-06-22T00:00:00.000Z') }])
})

describe('cash-out ledger — materializeEntries', () => {
  it('skips sales that already have an entry (idempotent)', async () => {
    p.promoterCommissionEntry.findMany.mockResolvedValue([{ saleVerificationId: 's1' }])
    p.saleVerification.findMany.mockResolvedValue([
      { id: 's1', staffId: 'p1', isPortabilidad: false, createdAt: new Date('2026-06-22T18:00:00Z') },
    ])
    const res = await materializeEntries('v_pt')
    expect(res.created).toBe(0)
    expect(p.promoterCommissionEntry.create).not.toHaveBeenCalled()
  })

  it('materializes new COMPLETED sales with escalating tiers in createdAt order', async () => {
    p.promoterCommissionEntry.findMany.mockResolvedValue([])
    p.promoterCommissionEntry.count.mockResolvedValue(0)
    p.saleVerification.findMany.mockResolvedValue([
      { id: 's1', staffId: 'p1', isPortabilidad: false, createdAt: new Date('2026-06-22T18:00:00Z') },
      { id: 's2', staffId: 'p1', isPortabilidad: false, createdAt: new Date('2026-06-22T19:00:00Z') },
    ])
    const res = await materializeEntries('v_pt')
    expect(res.created).toBe(2)
    const calls = p.promoterCommissionEntry.create.mock.calls
    expect(calls[0][0].data).toMatchObject({ saleVerificationId: 's1', tier: 1 })
    expect(calls[1][0].data).toMatchObject({ saleVerificationId: 's2', tier: 2 })
    expect(p.promoterCommissionEntry.count).toHaveBeenCalledTimes(1) // seeded once, then in-memory counter
  })

  it('is a no-op for a non-CASH_OUT venue (sweep skips it — scalable product untouched)', async () => {
    mockEnabled.mockResolvedValue(false)
    const res = await materializeEntries('v_other')
    expect(res.created).toBe(0)
    expect(p.saleVerification.findMany).not.toHaveBeenCalled()
  })

  it('is a no-op when NO cash-out day is active (retroactive/noise guard) and never scans sales', async () => {
    p.cashOutScheduleDay.findMany.mockResolvedValue([]) // ADMIN has not activated any day yet
    const res = await materializeEntries('v_pt')
    expect(res.created).toBe(0)
    expect(p.saleVerification.findMany).not.toHaveBeenCalled() // early return, no history scan
    expect(p.promoterCommissionEntry.create).not.toHaveBeenCalled()
  })

  it('materializes only sales on an active cash-out day (skips pre-scheme history — no retroactive pay)', async () => {
    p.cashOutScheduleDay.findMany.mockResolvedValue([{ day: new Date('2026-06-22T00:00:00.000Z') }]) // only the 22nd active
    p.promoterCommissionEntry.findMany.mockResolvedValue([])
    p.promoterCommissionEntry.count.mockResolvedValue(0)
    p.saleVerification.findMany.mockResolvedValue([
      { id: 's_active', staffId: 'p1', isPortabilidad: false, createdAt: new Date('2026-06-22T18:00:00Z') }, // active day
      { id: 's_history', staffId: 'p1', isPortabilidad: false, createdAt: new Date('2026-06-15T18:00:00Z') }, // NOT active
    ])
    const res = await materializeEntries('v_pt')
    expect(res.created).toBe(1)
    expect(p.promoterCommissionEntry.create).toHaveBeenCalledTimes(1)
    expect(p.promoterCommissionEntry.create.mock.calls[0][0].data).toMatchObject({ saleVerificationId: 's_active' })
  })

  it('excludes external (outside-TPV) MANUAL_ENTRY sales from the commission ledger (founder directive: ventas/KPIs only, never cash-out)', async () => {
    p.promoterCommissionEntry.findMany.mockResolvedValue([])
    p.promoterCommissionEntry.count.mockResolvedValue(0)

    // Fixture simulates the real DB join (SaleVerification -> Payment -> Order.type):
    // the mock only omits the MANUAL_ENTRY-order sale when the query's `where` actually
    // carries the exclusion clause — same as a real Prisma `where` would filter at the DB.
    // This makes the test fail against today's unfiltered query (both sales come back)
    // and pass once materializeEntries adds the NOT-MANUAL_ENTRY filter.
    const allSales = [
      { id: 's_external', staffId: 'p1', isPortabilidad: false, createdAt: new Date('2026-06-22T18:00:00Z'), _orderType: 'MANUAL_ENTRY' },
      { id: 's_normal', staffId: 'p1', isPortabilidad: false, createdAt: new Date('2026-06-22T19:00:00Z'), _orderType: 'DINE_IN' },
    ]
    p.saleVerification.findMany.mockImplementation(async ({ where }: any) => {
      const excludesManualEntry = where?.NOT?.payment?.order?.type === 'MANUAL_ENTRY'
      return allSales.filter(s => !(excludesManualEntry && s._orderType === 'MANUAL_ENTRY')).map(({ _orderType, ...rest }) => rest)
    })

    const res = await materializeEntries('v_pt')

    // Only the normal (non-MANUAL_ENTRY) sale is materialized.
    expect(res.created).toBe(1)
    expect(p.promoterCommissionEntry.create).toHaveBeenCalledTimes(1)
    expect(p.promoterCommissionEntry.create.mock.calls[0][0].data).toMatchObject({ saleVerificationId: 's_normal' })

    // The query itself must carry the exclusion (not just "happen" to work via fixture luck).
    expect(p.saleVerification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ NOT: { payment: { order: { type: 'MANUAL_ENTRY' } } } }) }),
    )
  })
})

describe('cash-out ledger — getSaldo (Σ AVAILABLE, pesos)', () => {
  it('sums the AVAILABLE entries', async () => {
    p.promoterCommissionEntry.aggregate.mockResolvedValue({ _sum: { amount: new Prisma.Decimal(75) } })
    expect((await getSaldo('v_pt', 'p1')).toString()).toBe('75')
  })

  it('returns 0 when there is no available saldo', async () => {
    p.promoterCommissionEntry.aggregate.mockResolvedValue({ _sum: { amount: null } })
    expect((await getSaldo('v_pt', 'p1')).toString()).toBe('0')
  })
})

describe('cash-out ledger — reconcileClawbacks', () => {
  it('claws back entries whose source sale is no longer COMPLETED', async () => {
    p.promoterCommissionEntry.findMany.mockResolvedValue([
      { id: 'e1', saleVerificationId: 's1' },
      { id: 'e2', saleVerificationId: 's2' },
    ])
    p.saleVerification.findMany.mockResolvedValue([{ id: 's1' }]) // only s1 still COMPLETED
    p.promoterCommissionEntry.updateMany.mockResolvedValue({ count: 1 })
    const res = await reconcileClawbacks('v_pt')
    expect(res.clawedBack).toBe(1)
    expect(p.promoterCommissionEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['e2'] } }, data: expect.objectContaining({ status: 'CLAWED_BACK' }) }),
    )
  })
})

/**
 * Freno del MCP (incidente del 23-sep-2026, Codex ronda 5): `cash_out_org_saldos` recorre las tiendas y, al terminar
 * cada una, `endOfWriteUnit()` vuelve a permitir el corte. La bitácora del clawback queda corriendo sola y, como Prisma
 * difiere la ejecución, su INSERT llega al freno DESPUÉS de ese reinicio: dentro de la cancelación volvía a marcar la
 * unidad como escrita — el recorrido ya no se detenía en las tiendas siguientes — o, con la unidad ya envenenada, se
 * rechazaba y el clawback quedaba sin rastro. Por eso corre fuera del freno, como la bitácora propia del MCP.
 */
describe('cash-out ledger — reconcileClawbacks dentro de una petición del MCP (freno 23-sep)', () => {
  it('la bitácora que llega DESPUÉS de endOfWriteUnit() no vuelve a desactivar el freno, y se escribe igual', async () => {
    const controller = new AbortController()
    const cancellation: RequestCancellation = { signal: controller.signal, hasWritten: false, refused: false }
    p.promoterCommissionEntry.findMany.mockResolvedValue([{ id: 'e1', saleVerificationId: 's1' }])
    p.saleVerification.findMany.mockResolvedValue([]) // s1 ya no está COMPLETED
    p.promoterCommissionEntry.updateMany.mockImplementation(async () => {
      checkCancellation('updateMany', getContext()?.cancellation) // como la extensión: el clawback ESCRIBE
      return { count: 1 }
    })
    let bitacora!: Promise<void>
    ;(logAction as jest.Mock).mockImplementation(() => {
      // Como Prisma: el INSERT de la bitácora llega al freno en un turno posterior, con el contexto en que se lanzó.
      bitacora = new Promise<void>(resolve =>
        setImmediate(() => {
          checkCancellation('create', getContext()?.cancellation)
          resolve()
        }),
      )
      return bitacora
    })

    await runWithContext(
      { correlationId: 'c-cb', source: 'http', entrypoint: 'POST /mcp tools/call cash_out_org_saldos', cancellation },
      async () => {
        await reconcileClawbacks('v_pt')
        endOfWriteUnit() // la tienda quedó completa: el freno puede volver a cortar
      },
    )
    await bitacora

    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'CASH_OUT_CLAWBACK', venueId: 'v_pt' }))
    expect(cancellation.hasWritten).toBe(false)
    // Y el freno SIGUE activo: vence el tope y la lectura de la tienda siguiente se corta.
    controller.abort(new RequestCancelledError('timeout', 25_000))
    expect(() => checkCancellation('findMany', cancellation)).toThrow(RequestCancelledError)
  })

  // REGRESIÓN — fuera de una petición del MCP (dashboard, jobs) la bitácora se escribe igual que siempre
  it('fuera de una petición del MCP la bitácora del clawback se escribe como siempre', async () => {
    p.promoterCommissionEntry.findMany.mockResolvedValue([{ id: 'e1', saleVerificationId: 's1' }])
    p.saleVerification.findMany.mockResolvedValue([])
    p.promoterCommissionEntry.updateMany.mockResolvedValue({ count: 1 })
    ;(logAction as jest.Mock).mockResolvedValue(undefined)
    await expect(reconcileClawbacks('v_pt')).resolves.toEqual({ clawedBack: 1 })
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'CASH_OUT_CLAWBACK', entity: 'PromoterCommissionEntry' }))
  })
})

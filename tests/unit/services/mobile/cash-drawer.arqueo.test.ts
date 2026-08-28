/**
 * El arqueo: inicial + PAY_IN + CASH_SALE − PAY_OUT.
 *
 * Cuando el servidor empezó a crear el `CASH_SALE` de cada venta en efectivo
 * (`postCashSaleToDrawer`), había que comprobar dos cosas a la vez:
 *   1. que la venta AHORA sume — antes el esperado sólo bajaba (PAY_OUT del reembolso)
 *      y el cierre acusaba un faltante inventado;
 *   2. que el reembolso siga restando UNA sola vez.
 *
 * Y la contraparte que evita el doble conteo: los clientes (Android/iOS ya desplegados)
 * empujan su PROPIO `CASH_SALE` a `/cash-drawer/sync`. Con el servidor creándolo también,
 * ese push duplicaría cada venta — un SOBRANTE inventado, el mismo bug al revés. Por eso
 * `syncEvents` deja de aceptar `CASH_SALE` del cliente.
 */

jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

import { getCurrentSession, syncEvents } from '@/services/mobile/cash-drawer.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE = 'venue-1'

const evt = (type: string, amount: number) => ({
  id: `evt-${type}-${amount}`,
  sessionId: 'session-1',
  type,
  amount,
  note: null,
  staffId: 'staff-1',
  staffName: 'Cajero',
  orderId: null,
  createdAt: new Date('2026-08-16T10:00:00.000Z'),
})

describe('arqueo del cajón — la venta suma, el reembolso resta una sola vez', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('🔴 el esperado SUMA las ventas en efectivo: $100 inicial + $250 vendidos = $350', async () => {
    ;(prismaMock as any).cashDrawerSession = {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn().mockResolvedValue({
        id: 'session-1',
        venueId: VENUE,
        status: 'OPEN',
        openedAt: new Date('2026-08-16T08:00:00.000Z'),
        startingAmount: 100,
        closedAt: null,
        actualAmount: null,
        overShort: null,
        events: [evt('OPEN', 100), evt('CASH_SALE', 250)],
      }),
    }

    const session = await getCurrentSession(VENUE, true)

    expect(session?.expectedAmount).toBe(350)
  })

  it('🔴 el reembolso sigue restando UNA vez (su PAY_OUT), no dos', async () => {
    ;(prismaMock as any).cashDrawerSession = {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn().mockResolvedValue({
        id: 'session-1',
        venueId: VENUE,
        status: 'OPEN',
        openedAt: new Date('2026-08-16T08:00:00.000Z'),
        startingAmount: 100,
        closedAt: null,
        actualAmount: null,
        overShort: null,
        // Venta de $250 + entrada de $50 − reembolso de $80 = 100 + 250 + 50 − 80
        events: [evt('OPEN', 100), evt('CASH_SALE', 250), evt('PAY_IN', 50), evt('PAY_OUT', 80)],
      }),
    }

    const session = await getCurrentSession(VENUE, true)

    expect(session?.expectedAmount).toBe(320)
  })
})

describe('syncEvents — el servidor es dueño del CASH_SALE (no hay doble conteo)', () => {
  const sesion = { id: 'session-1', venueId: VENUE, status: 'OPEN' }

  beforeEach(() => {
    jest.clearAllMocks()
    ;(prismaMock as any).cashDrawerSession = {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn().mockResolvedValue(sesion),
    }
    ;(prismaMock as any).cashDrawerEvent = {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockImplementation(async (args: any) => ({
        id: 'evt-db-1',
        ...args.data,
        createdAt: args.data.createdAt ?? new Date(),
      })),
    }
  })

  const evento = (type: string, amount: number, localId?: string) => ({
    localId,
    type,
    amount,
    staffId: 'staff-1',
    staffName: 'Cajero',
  })

  it('🔴 un CASH_SALE empujado por una app YA DESPLEGADA se ignora: el server ya lo creó al cobrar', async () => {
    const res = await syncEvents(VENUE, [evento('CASH_SALE', 250, 'evt-local-1')] as any)

    expect((prismaMock as any).cashDrawerEvent.createMany).not.toHaveBeenCalled()
    expect((prismaMock as any).cashDrawerEvent.create).not.toHaveBeenCalled()
    expect(res.syncedCount).toBe(0)
  })

  it('PAY_IN y PAY_OUT siguen sincronizando igual (el cliente sigue siendo su dueño)', async () => {
    ;(prismaMock as any).cashDrawerEvent.createMany.mockResolvedValue({ count: 2 })
    ;(prismaMock as any).cashDrawerEvent.findMany.mockResolvedValue([
      { ...evt('PAY_IN', 50), localId: 'evt-1' },
      { ...evt('PAY_OUT', 30), localId: 'evt-2' },
    ])

    const res = await syncEvents(VENUE, [evento('PAY_IN', 50, 'evt-1'), evento('PAY_OUT', 30, 'evt-2')] as any)

    expect(res.syncedCount).toBe(2)
    expect((prismaMock as any).cashDrawerEvent.createMany.mock.calls[0][0].data).toHaveLength(2)
  })

  it('lote mixto: se filtra el CASH_SALE y entra el resto', async () => {
    ;(prismaMock as any).cashDrawerEvent.createMany.mockResolvedValue({ count: 1 })
    ;(prismaMock as any).cashDrawerEvent.findMany.mockResolvedValue([{ ...evt('PAY_OUT', 30), localId: 'evt-2' }])

    const res = await syncEvents(VENUE, [evento('CASH_SALE', 250, 'evt-1'), evento('PAY_OUT', 30, 'evt-2')] as any)

    const enviados = (prismaMock as any).cashDrawerEvent.createMany.mock.calls[0][0].data
    expect(enviados).toHaveLength(1)
    expect(enviados[0].type).toBe('PAY_OUT')
    expect(res.syncedCount).toBe(1)
  })
})

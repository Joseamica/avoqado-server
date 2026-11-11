/**
 * H1 (auditoría final del retiro con gerente): `/sync` sólo filtraba el PAY_OUT; un PAY_IN de -50 bajaba el
 * esperado de la caja y dejaba retirar sin permiso. Todo evento manual debe traer un importe finito y > 0; los que
 * no, se descartan, se cuentan en `rechazadosPorImporte` y el lote responde 200 (un 4xx haría reintentar para siempre).
 */
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null) },
}))

import { syncEvents } from '@/services/mobile/cash-drawer.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE = 'venue-1'
const SESSION = 'session-1'
const CAJERO = 'staff-cajero'

function armar() {
  const session = {
    id: SESSION,
    venueId: VENUE,
    status: 'OPEN',
    startingAmount: 1000,
    openedAt: new Date('2026-08-28T14:00:00.000Z'),
    closedAt: null,
  }
  ;(prismaMock as any).cashDrawerSession = {
    findFirst: jest.fn().mockResolvedValue(session),
    findMany: jest.fn(async (args: any) => (args.where?.status === 'CLOSED' ? [] : [session])),
    findUnique: jest.fn().mockResolvedValue(session),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  }
  ;(prismaMock as any).cashDrawerEvent = {
    createManyAndReturn: jest.fn(async (args: any) =>
      args.data.map((row: any, index: number) => ({ id: `evt-${index}`, localId: row.localId, sessionId: row.sessionId })),
    ),
    create: jest.fn().mockImplementation(async (a: any) => ({ id: 'evt-1', ...a.data })),
    findMany: jest.fn().mockResolvedValue([]),
  }
  ;(prismaMock as any).staffVenue = {
    findFirst: jest.fn().mockResolvedValue({ id: 'sv-1' }),
    findMany: jest.fn().mockResolvedValue([{ staffId: CAJERO }]),
  }
  ;(prismaMock as any).$transaction = jest.fn().mockImplementation(async (fn: any) => fn(prismaMock))
}

const mov = (over: Record<string, unknown> = {}) => ({
  type: 'PAY_IN',
  amount: 50,
  staffId: CAJERO,
  staffName: 'Cajero',
  localId: 'local-1',
  sessionId: SESSION,
  ...over,
})

const filasCreadas = () =>
  ((prismaMock as any).cashDrawerEvent.createManyAndReturn as jest.Mock).mock.calls.flatMap((c: any) => c[0]?.data ?? [])

beforeEach(() => jest.clearAllMocks())

describe('/sync descarta los movimientos manuales con importe inválido', () => {
  it('🔴 PAY_IN -50 con puedeRetirar=false: no se crea y se cuenta', async () => {
    armar()
    const r: any = await syncEvents(VENUE, [mov({ amount: -50 })] as never, null, CAJERO, false)
    expect(r.syncedCount).toBe(0)
    expect(r.rechazadosPorImporte).toBe(1)
    expect(filasCreadas()).toHaveLength(0)
  })

  it.each([[0], [Number.NaN], [Number.POSITIVE_INFINITY], ['abc']])('PAY_IN con importe %p tampoco entra', async importe => {
    armar()
    const r: any = await syncEvents(VENUE, [mov({ amount: importe })] as never, null, CAJERO, false)
    expect(r.syncedCount).toBe(0)
    expect(r.rechazadosPorImporte).toBe(1)
    expect(filasCreadas()).toHaveLength(0)
  })

  it('un PAY_OUT negativo con permiso tampoco', async () => {
    armar()
    const r: any = await syncEvents(VENUE, [mov({ type: 'PAY_OUT', amount: -5 })] as never, null, CAJERO, true)
    expect(r.rechazadosPorImporte).toBe(1)
    expect(filasCreadas()).toHaveLength(0)
  })

  it('un PAY_IN 100 en el mismo lote sí entra y el inválido no', async () => {
    armar()
    const r: any = await syncEvents(
      VENUE,
      [mov({ localId: 'bueno', amount: 100 }), mov({ localId: 'malo', amount: -50 })] as never,
      null,
      CAJERO,
      false,
    )
    expect(r.rechazadosPorImporte).toBe(1)
    expect(r.syncedCount).toBeGreaterThan(0)
    const filas = filasCreadas()
    expect(filas.map((f: any) => f.localId)).toEqual(['bueno'])
  })

  it('un lote válido responde rechazadosPorImporte 0', async () => {
    armar()
    const r: any = await syncEvents(VENUE, [mov({ amount: 100 })] as never, null, CAJERO, true)
    expect(r.rechazadosPorImporte).toBe(0)
  })
})

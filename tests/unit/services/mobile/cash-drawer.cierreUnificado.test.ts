/**
 * 🔴 DINERO — Fase 2, Task 5: cerrar la CAJA desde la tablet cierra también el TURNO del negocio.
 *
 * La Task 4 ya unificó la apertura: `POST /mobile/…/cash-drawer/open` abre los dos registros
 * ligados. El cierre seguía partido — `closeSession` no tocaba el `Shift`, cero referencias — y eso
 * dejaba dos cosas mal:
 *
 *   · el turno se quedaba abierto hasta el relevo de la mañana siguiente, así que sus totales
 *     seguían creciendo con las ventas del siguiente cajero;
 *   · la PAX no se enteraba de nada, porque el aviso `shift closed` sólo lo emite el cierre del
 *     turno. Ese es el pendiente declarado del Plan A que aquí se cierra: el cierre pasa por el
 *     claim `OPEN → CLOSING` que ya existe y emite el socket.
 *
 * 🔴 Y el orden importa: la gaveta se cierra PRIMERO y se commitea. Lo que sigue no puede tumbarlo
 * — el cajero ya contó y el dinero ya está firmado.
 */

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/services/shared/turnoDeCaja', () => ({
  __esModule: true,
  abrirTurnoDeCaja: jest.fn(),
  cerrarTurnoDeCaja: jest.fn(),
}))

import { Prisma } from '@prisma/client'
import { cerrarTurnoDeCaja } from '@/services/shared/turnoDeCaja'
import { closeSession } from '@/services/mobile/cash-drawer.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'

const mockCerrar = cerrarTurnoDeCaja as jest.MockedFunction<typeof cerrarTurnoDeCaja>
const VENUE = 'venue-1'
const CAJA = 's-1'
const TURNO = 'turno-1'

const evt = (type: string, amount: number) => ({
  id: `e-${type}-${amount}`,
  sessionId: CAJA,
  type,
  amount,
  createdAt: new Date('2026-09-03T14:00:00Z'),
})

/** Fondo $2,000 + ventas $1,000 − retiro $50 = **$2,950** esperados. */
const EVENTOS = [evt('OPEN', 2000), evt('CASH_SALE', 1000), evt('PAY_OUT', 50)]

const abierta = (over: Record<string, unknown> = {}) => ({
  id: CAJA,
  venueId: VENUE,
  status: 'OPEN',
  deviceName: 'Sunmi D3',
  openedByStaffId: 'staff-1',
  openedByName: 'Viridiana',
  openedAt: new Date('2026-09-03T14:00:00Z'),
  startingAmount: new Prisma.Decimal(2000),
  // La gaveta que la apertura unificada dejó LIGADA a su turno: es el estado normal desde la Task 4.
  shiftId: TURNO,
  closedByStaffId: null,
  closedByName: null,
  closedAt: null,
  actualAmount: null,
  overShort: null,
  closingNote: null,
  events: EVENTOS,
  ...over,
})

function mundo(over: Record<string, unknown> = {}) {
  const p = prismaMock as any
  p.$transaction = jest.fn().mockImplementation(async (fn: any) => fn(p))
  p.cashDrawerSession.findFirst.mockResolvedValue(abierta())
  p.cashDrawerSession.updateMany.mockResolvedValue({ count: 1 })
  p.cashDrawerSession.update.mockResolvedValue({})
  p.cashDrawerSession.findUnique.mockResolvedValue(
    abierta({ status: 'CLOSED', closedAt: new Date('2026-09-04T02:00:00Z'), actualAmount: new Prisma.Decimal(2950), ...over }),
  )
  p.cashDrawerEvent.findMany.mockResolvedValue(EVENTOS)
  p.cashDrawerEvent.create.mockResolvedValue({ id: 'ev-close' })
  p.staff.findUnique.mockResolvedValue({ firstName: 'Viridiana', lastName: 'Soto' })
}

const cerrar = (over: Record<string, unknown> = {}) =>
  closeSession({ venueId: VENUE, staffId: 'staff-1', staffName: 'Viridiana', actualAmount: 2950, ...over })

beforeEach(() => {
  jest.clearAllMocks()
  mundo()
  mockCerrar.mockResolvedValue({ shiftCerradoId: TURNO, conConteo: true } as never)
})

describe('cerrar la caja desde la tablet cierra el turno del negocio', () => {
  it('🔴 el turno se cierra con el MISMO conteo que se acaba de firmar en la gaveta', async () => {
    await cerrar()

    expect(mockCerrar).toHaveBeenCalledTimes(1)
    const p = mockCerrar.mock.calls[0][0]
    expect(p).toMatchObject({ venueId: VENUE, staffId: 'staff-1', source: 'CAJA_MOVIL', yaCerrado: { cashDrawerSessionId: CAJA } })
    expect(Number(p.conteo)).toBe(2950)
  })

  it('🔴 y con el ESPERADO de la gaveta ($2,950, retiro incluido): las dos mitades firman el mismo número', async () => {
    // Sin esto, el turno recalcularía su esperado contra `startingCash + ventas` = $3,000 y le
    // firmaría al cajero un faltante de $50 que la gaveta acaba de decir que no existe.
    await cerrar()

    expect(Number(mockCerrar.mock.calls[0][0].esperadoDelCajon)).toBe(2950)
  })

  it('🔴 contar CERO es un conteo real, no un conteo ausente', async () => {
    // Una gaveta vacía con $2,950 esperados es un faltante de $2,950 — el caso más importante
    // que este cierre tiene que acertar. Un `&&` sobre un `Decimal(0)` lo mandaría a «nadie contó».
    await cerrar({ actualAmount: 0 })

    expect(mockCerrar.mock.calls[0][0].conteo).not.toBeNull()
    expect(Number(mockCerrar.mock.calls[0][0].conteo)).toBe(0)
  })

  it('🔴 un fallo al cerrar el turno NO tumba el cierre de la gaveta, que ya está commiteado', async () => {
    mockCerrar.mockRejectedValue(new Error('el turno está en CLOSING') as never)

    const sesion: any = await cerrar()

    expect(sesion.id).toBe(CAJA)
    expect(sesion.status).toBe('CLOSED')
    expect(sesion.actualAmount).toBe(2950)
  })

  it('la respuesta conserva EXACTAMENTE los campos de hoy, más `shiftId` (aditivo)', async () => {
    const sesion: any = await cerrar()

    // Ninguna app instalada puede notar un campo que falte, cambie de nombre o cambie de tipo.
    expect(Object.keys(sesion).sort()).toEqual(
      [
        'actualAmount',
        'closedAt',
        'closedByName',
        'closedByStaffId',
        'closingNote',
        'deviceName',
        'events',
        'expectedAmount',
        'id',
        'openedAt',
        'openedByName',
        'openedByStaffId',
        'overShort',
        'shiftId',
        'startingAmount',
        'status',
        'venueId',
      ].sort(),
    )
    expect(sesion.shiftId).toBe(TURNO)
  })

  it('si no había turno abierto, `shiftId` viaja en null y la respuesta sigue siendo válida', async () => {
    mockCerrar.mockResolvedValue({ conConteo: false, motivo: 'SIN_PAREJA' } as never)

    const sesion: any = await cerrar()

    expect(sesion.shiftId).toBeNull()
    expect(sesion.status).toBe('CLOSED')
  })

  it('🔴 le dice a qué turno pertenecía la gaveta: sin eso podría cerrar el turno de otro', async () => {
    // El `sessionId` sólo prueba que ésa era la gaveta abierta, no que su turno siga siendo el
    // abierto. Un cierre encolado que se reproduce después de que se abrió un turno nuevo pasa la
    // guarda del 404 y cerraría el turno equivocado con este conteo.
    await cerrar()

    expect(mockCerrar.mock.calls[0][0].shiftIdDeLaGaveta).toBe(TURNO)
    // Y se LEE de la sesión: si el `select` no lo trae, el servicio no puede saberlo.
    const select = (prismaMock as any).cashDrawerSession.findFirst.mock.calls[0][0].select
    expect(select).toMatchObject({ shiftId: true })
  })

  it('🔴 un cierre encolado que llega tarde sigue recibiendo su 404 y NO cierra ningún turno', async () => {
    // P1 del 27-ago: el aparato manda el id de SU caja. Si la abierta ahora es otra, no se cierra
    // la ajena con el conteo de la vieja — y por tanto tampoco se cierra el turno de nadie.
    await expect(cerrar({ sessionId: 'otra-caja' })).rejects.toThrow('No hay una caja abierta')
    expect(mockCerrar).not.toHaveBeenCalled()
  })
})

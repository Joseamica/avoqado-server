/**
 * 🔴 DINERO. El mismo cobro NO puede contar en DOS turnos.
 *
 * El defecto lo introdujo la task 2b (3-sep-2026) al estampar `Order.shiftId` al ABRIR la orden.
 * `getShifts` une dos caminos al mismo dinero —los cobros alcanzables por `Order.shiftId` y los
 * alcanzables por `Payment.shiftId`— y deduplica con un `Map` que sólo ve las filas de UN turno:
 * deduplica DENTRO de un turno, nunca ENTRE turnos.
 *
 * El escenario real, que antes de la task 2b no podía ocurrir porque la orden nacía sin turno:
 *
 *     13:00  se abre la mesa            → la orden se estampa con el turno A
 *     15:00  cierra el turno A
 *     15:30  pagan la mesa              → el `Payment` se resuelve al turno B
 *
 * A alcanzaba ese cobro por su orden y B por `Payment.shiftId`: la pantalla de Turnos sumaba más
 * de lo que el negocio cobró. El dinero pertenece a donde ENTRÓ, que es B.
 *
 * 🔴 Y la otra mitad, que es la que hace que el arreglo no pueda ser «borrar la rama por orden»:
 * las órdenes históricas de pos-sync tienen turno y su `Payment.shiftId` es NULO. Si se quitara
 * ese camino, su dinero desaparecería de la pantalla. Por eso el filtro deja pasar el cobro sin
 * turno — es de esta orden y no lo reclama ningún otro.
 *
 * ⚠️ Los fixtures llevan `status`, `createdAt` y la VENTANA del turno (`startTime`/`endTime`)
 * porque la task 5c (3-sep-2026) le puso techo a ese respaldo: un cobro sin turno sólo es de este
 * turno si ocurrió DENTRO de su ventana, y el reporte pide únicamente cobros `COMPLETED`. Sin esos
 * campos las pruebas de este archivo pasaban por el motivo equivocado — no distinguían un
 * `COMPLETED` de un `FAILED`, ni un cobro histórico legítimo de uno posterior al cierre. Los casos
 * de la ventana y del `status` viven en `shift.reporteNoCuentaLoNoCobrado.test.ts`; aquí sólo se
 * los honra para que este archivo siga midiendo lo que dice medir: la NO duplicación entre turnos.
 */

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    shift: { findMany: jest.fn(), count: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    payment: { findMany: jest.fn() },
    order: { count: jest.fn() },
    orderItem: { findMany: jest.fn() },
    rawMaterialMovement: { findMany: jest.fn() },
    venue: { findUnique: jest.fn() },
    staff: { findFirst: jest.fn() },
    activityLog: { create: jest.fn() },
    $transaction: jest.fn(),
  },
}))

jest.mock('@/config/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/communication/rabbitmq/publisher', () => ({ publishCommand: jest.fn() }))
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn().mockReturnValue(null) } }))
jest.mock('@/services/access/cashReconciliationAccess.service', () => ({ isCashReconciliationEnabled: jest.fn() }))
jest.mock('@/services/dashboard/shift.dashboard.service', () => ({ resolveShiftCashDrawer: jest.fn().mockResolvedValue(null) }))

import prisma from '@/utils/prismaClient'
import { getShifts } from '@/services/tpv/shift.tpv.service'

const mockPrisma = prisma as unknown as { $transaction: jest.Mock }

// La ventana del turno, y un instante DENTRO de ella: así el único motivo por el que un cobro
// entra o no entra es el que cada prueba dice estar midiendo.
const ABRE = new Date('2026-09-03T14:00:00.000Z')
const CIERRA = new Date('2026-09-03T22:00:00.000Z')
const DURANTE = new Date('2026-09-03T18:00:00.000Z')

const turno = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  venueId: 'venue-1',
  staff: null,
  startTime: ABRE,
  endTime: CIERRA,
  orders: [],
  payments: [],
  ...extra,
})

const pago = (extra: Record<string, unknown> = {}) => ({
  id: 'pago-1',
  status: 'COMPLETED',
  amount: 100,
  tipAmount: 15,
  processedById: 'staff-1',
  createdAt: DURANTE,
  allocations: [],
  ...extra,
})

describe('getShifts — un cobro de OTRO turno no suma en éste', () => {
  beforeEach(() => jest.clearAllMocks())

  it('🔴 la mesa abierta en A y pagada en B NO deja su dinero en A', async () => {
    // La orden se estampó con A (se abrió en A), pero su cobro se resolvió a B (se pagó en B).
    const cobroDeB = pago({ shiftId: 'turno-B' })
    mockPrisma.$transaction.mockResolvedValue([[turno('turno-A', { orders: [{ id: 'orden-1', payments: [cobroDeB] }] })], 1])

    const { data } = await getShifts('venue-1', 20, 1)

    // 0, no 100: A no cobró nada. Sin el filtro, ese dinero salía en A **y** en B.
    expect(data[0].paymentSum).toBe(0)
    expect(data[0].tipsSum).toBe(0)
    expect(data[0].tipsCount).toBe(0)
  })

  it('el mismo cobro SÍ suma en el turno donde entró el dinero', async () => {
    // La otra cara: el filtro no puede dejar a B sin su propio cobro.
    const cobroDeB = pago({ shiftId: 'turno-B' })
    mockPrisma.$transaction.mockResolvedValue([[turno('turno-B', { payments: [cobroDeB] })], 1])

    const { data } = await getShifts('venue-1', 20, 1)

    expect(data[0].paymentSum).toBe(100)
    expect(data[0].tipsSum).toBe(15)
  })

  it('🔴 el cobro SIN turno de una orden CON turno sigue contando (pos-sync histórico)', async () => {
    // Es lo que impide «arreglar» esto borrando la rama por orden: a estas órdenes se les
    // borraría el dinero de la pantalla. Ocurrió DENTRO de la ventana del turno — el respaldo
    // tiene techo desde la task 5c, y el histórico legítimo cae de este lado del techo.
    const cobroSinTurno = pago({ shiftId: null, amount: 80, tipAmount: 0 })
    mockPrisma.$transaction.mockResolvedValue([[turno('turno-A', { orders: [{ id: 'orden-pos', payments: [cobroSinTurno] }] })], 1])

    const { data } = await getShifts('venue-1', 20, 1)

    expect(data[0].paymentSum).toBe(80)
  })

  it('el cobro de ESTE turno alcanzable por los dos caminos sigue contando UNA vez', async () => {
    // Regresión de la deduplicación que ya existía: el filtro no la sustituye.
    const cobro = pago({ shiftId: 'turno-A' })
    mockPrisma.$transaction.mockResolvedValue([
      [turno('turno-A', { orders: [{ id: 'orden-1', payments: [cobro] }], payments: [cobro] })],
      1,
    ])

    const { data } = await getShifts('venue-1', 20, 1)

    expect(data[0].paymentSum).toBe(100)
    expect(data[0].tipsCount).toBe(1)
  })
})

/**
 * 🔴 EL FILTRO DE ARRIBA PUEDE VOLVERSE NO-OP EN SILENCIO, Y ÉSTE ES SU CANDADO.
 *
 * Revisión de la task 2b (3-sep-2026): el predicado era `p.shiftId === shift.id || p.shiftId == null`
 * con `==` SUELTO, que además de `null` traga `undefined`. Si alguien estrecha el `include` de los
 * cobros de las órdenes a un `select` sin `shiftId`, TODOS los cobros llegan con `shiftId:
 * undefined`, el filtro deja pasar todo, y el mismo dinero vuelve a contarse en dos turnos — con
 * las cuatro pruebas de arriba EN VERDE, porque sus fixtures sí traen el campo. Es exactamente la
 * trampa que dejó ciega a la suite de dedup vieja.
 *
 * Se cierra por los dos lados: `=== null` en el predicado (un cobro sin el campo ya no pasa) y la
 * aserción de FORMA de aquí abajo, que es la que de verdad ve el estrechamiento del `include`.
 */
describe('getShifts — la consulta tiene que TRAER `shiftId` de los cobros de la orden', () => {
  beforeEach(() => jest.clearAllMocks())

  const findManyDeTurnos = () => (prisma as unknown as { shift: { findMany: jest.Mock } }).shift.findMany

  it('🔴 el `include` de los cobros de las órdenes no puede ser un `select` sin `shiftId`', async () => {
    mockPrisma.$transaction.mockResolvedValue([[], 0])
    ;(prisma as unknown as { shift: { count: jest.Mock } }).shift.count.mockResolvedValue(0)
    ;(prisma as unknown as { venue: { findUnique: jest.Mock } }).venue.findUnique.mockResolvedValue(null)

    await getShifts('venue-1', 20, 1)

    const args = findManyDeTurnos().mock.calls[0][0]
    const cobrosDeLaOrden = args.include.orders.include.payments
    // Sin `select`, Prisma trae la fila entera y `shiftId` viene siempre. Con `select`, tiene que
    // pedirlo explícitamente: si no, el filtro de arriba se queda sin el dato con el que decide.
    if (cobrosDeLaOrden.select) {
      expect(cobrosDeLaOrden.select.shiftId).toBe(true)
    } else {
      expect(cobrosDeLaOrden.select).toBeUndefined()
    }
  })

  it('🔴 un cobro SIN el campo `shiftId` (select estrechado) NO se cuenta: nunca se duplica dinero', async () => {
    // La forma exacta que produciría un `select` sin `shiftId`. Con `==` este cobro pasaba el
    // filtro y sumaba en un turno que no lo cobró; con `===` no pasa. Perder un renglón de la
    // pantalla se nota y se investiga; contar dos veces el mismo dinero, no.
    // 🔴 Trae `createdAt` DENTRO de la ventana a propósito: si el techo de la task 5c fuera el
    // que lo excluye, esta prueba pasaría por el motivo equivocado y dejaría de vigilar el `===`.
    const cobroSinCampo = pago({ amount: 100 })
    delete (cobroSinCampo as Record<string, unknown>).shiftId
    mockPrisma.$transaction.mockResolvedValue([[turno('turno-A', { orders: [{ id: 'orden-1', payments: [cobroSinCampo] }] })], 1])

    const { data } = await getShifts('venue-1', 20, 1)

    expect(data[0].paymentSum).toBe(0)
  })
})

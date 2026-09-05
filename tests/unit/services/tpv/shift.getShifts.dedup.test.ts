/**
 * `getShifts` (lista de turnos de la TPV) contaba CADA COBRO DOS VECES.
 *
 * El servicio arma `allPayments` uniendo dos caminos al mismo dinero: los cobros alcanzables
 * por `Order.shiftId` (`shift.orders[].payments`) y los alcanzables por `Payment.shiftId`
 * (`shift.payments`). Un cobro que tenga las DOS referencias —que es justo lo que produce la
 * fase 1 del «turno de caja del negocio», donde la orden y su cobro se atan al mismo turno—
 * entraba dos veces en `paymentSum`, `tipsSum` y `tipsCount`.
 *
 * Hasta ahora no mordía porque las órdenes históricas quedaron con `shiftId = null`; el script
 * de reatribución las ata, así que sin esta deduplicación la pantalla de turnos de la TPV
 * empezaría a enseñar el doble del dinero real.
 *
 * El servicio del dashboard (`shift.dashboard.service.ts`) NO tiene este defecto: suma sólo
 * `shift.payments`.
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

const pagoFindMany = () => (prisma as unknown as { payment: { findMany: jest.Mock } }).payment.findMany

const ABRE = new Date('2026-09-03T14:00:00.000Z')
const CIERRA = new Date('2026-09-03T22:00:00.000Z')

const turno = (extra: Record<string, unknown> = {}) => ({
  id: 'turno-1',
  venueId: 'venue-1',
  staff: { id: 'staff-1', firstName: 'Ana', lastName: 'P' },
  status: 'CLOSED',
  startTime: ABRE,
  endTime: CIERRA,
  updatedAt: CIERRA,
  ...extra,
})

/**
 * 🔴 `shiftId` es OBLIGATORIO en estos fixtures, y no es cosmético. El `select` real lo pide
 * SIEMPRE —con el id del turno o con `null`—; un fixture sin él modela un estado que la base no
 * puede producir. Cuando faltaba, estas pruebas pasaban con el filtro «el cobro es de este turno o
 * de ninguno» convertido en un no-op, que es justo el defecto que ese filtro existe para impedir
 * (ver `shift.getShifts.cobroDeOtroTurno.test.ts`).
 */
const cobro = (extra: Record<string, unknown> = {}) => ({
  id: 'pago-1',
  shiftId: 'turno-1',
  amount: 100,
  tipAmount: 15,
  processedById: 'staff-1',
  method: 'CASH',
  fundsFlow: null,
  tenderTypeId: null,
  tenderCountsAsCash: null,
  createdAt: new Date('2026-09-03T18:00:00.000Z'),
  order: { shiftId: 'turno-1' },
  ...extra,
})

const correr = async (cobros: Array<Record<string, unknown>>) => {
  mockPrisma.$transaction.mockResolvedValue([[turno()], 1])
  pagoFindMany().mockResolvedValue(cobros)
  const { data } = await getShifts('venue-1', 20, 1)
  return data
}

describe('getShifts — un cobro alcanzable por los dos caminos se cuenta UNA vez', () => {
  beforeEach(() => jest.clearAllMocks())

  it('no dobla el dinero cuando la orden y el cobro cuelgan del mismo turno', async () => {
    // Desde la ronda de arreglo 1 (P1.3) el barrido devuelve UNA fila por cobro y `turnoDelCobro`
    // le asigna EXACTAMENTE un turno, así que la duplicación ya no puede nacer — antes había que
    // deduplicar dos ramas de un `include`. La afirmación de dinero se conserva igual.
    const data = await correr([cobro()])

    expect(data).toHaveLength(1)
    // 100, no 200. Es el defecto que esta prueba guarda.
    expect(data[0].paymentSum).toBe(100)
    expect(data[0].tipsSum).toBe(15)
    expect(data[0].tipsCount).toBe(1)
    expect(data[0].avgTipPercentage).toBe(15)
  })

  it('sigue sumando DOS cobros distintos del mismo turno', async () => {
    // Regresión: agrupar por turno no puede convertirse en «me quedo con uno».
    const data = await correr([
      cobro({ id: 'pago-1', amount: 100, tipAmount: 10 }),
      cobro({ id: 'pago-2', amount: 40, tipAmount: 0, processedById: 'staff-2' }),
    ])

    expect(data[0].paymentSum).toBe(140)
    expect(data[0].tipsSum).toBe(10)
    expect(data[0].tipsCount).toBe(1)
  })

  it('un turno sin cobros no divide entre cero', async () => {
    const data = await correr([])

    expect(data[0].paymentSum).toBe(0)
    expect(data[0].avgTipPercentage).toBe(0)
  })
})

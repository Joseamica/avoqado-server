/**
 * D24 (Testarudo, 22-nov-2026): la terminal necesita saber CUÁL caja del negocio está abierta aunque quien esté dentro sea de
 * Cocina (sin `shifts:read`). La respuesta nueva dice sólo qué caja es: nada de ventas, propinas, órdenes ni efectivo esperado.
 * El fondo inicial sí va: es lo que la terminal necesita para su caja local, y ya lo ve quien abre la caja.
 */

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    shift: { findFirst: jest.fn() },
    payment: { groupBy: jest.fn() },
    order: { count: jest.fn() },
    orderItem: { aggregate: jest.fn() },
  },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/communication/rabbitmq/publisher', () => ({ publishCommand: jest.fn() }))
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn().mockReturnValue(null) } }))
jest.mock('@/services/access/cashReconciliationAccess.service', () => ({ isCashReconciliationEnabled: jest.fn() }))
jest.mock('@/services/dashboard/shift.dashboard.service', () => ({ resolveShiftCashDrawer: jest.fn().mockResolvedValue(null) }))

import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { getShiftIdentity } from '@/services/tpv/shift.tpv.service'

const m = prisma as unknown as {
  shift: { findFirst: jest.Mock }
  payment: { groupBy: jest.Mock }
  order: { count: jest.Mock }
  orderItem: { aggregate: jest.Mock }
}

const VENUE = 'cvenue000000000000000000a'
const HOY = 'cshift000000000000000000b'
const AYER = 'cshift000000000000000000a'

beforeEach(() => jest.clearAllMocks())

describe('getShiftIdentity · cuál caja del negocio está abierta, sin cifras', () => {
  it('devuelve la abierta sólo con su identidad y su fondo, sin ningún total', async () => {
    m.shift.findFirst.mockResolvedValueOnce({
      id: HOY,
      venueId: VENUE,
      status: 'OPEN',
      startTime: new Date('2026-11-22T14:24:00.000Z'),
      staffId: 'cowner0000000000000000000',
      startingCash: new Prisma.Decimal('2000.00'),
      cashDrawerSession: { id: 'cdrawer000000000000000000' },
    })

    const r = await getShiftIdentity(VENUE)

    expect(r.shift).toEqual({
      id: HOY,
      venueId: VENUE,
      status: 'OPEN',
      startTime: new Date('2026-11-22T14:24:00.000Z'),
      staffId: 'cowner0000000000000000000',
      startingCash: new Prisma.Decimal('2000.00'),
      cashDrawerSessionId: 'cdrawer000000000000000000',
    })
    expect(r.known).toBeNull()
    // Ni una consulta de cifras: los totales del turno no se calculan aquí.
    expect(m.payment.groupBy).not.toHaveBeenCalled()
    expect(m.order.count).not.toHaveBeenCalled()
    expect(m.orderItem.aggregate).not.toHaveBeenCalled()
    // La misma regla que GET /shift para elegir la abierta: sin fecha de cierre, la más reciente, de ESTA sucursal.
    const consulta = m.shift.findFirst.mock.calls[0][0]
    expect(consulta.where).toEqual({ venueId: VENUE, endTime: null })
    expect(consulta.orderBy).toEqual({ startTime: 'desc' })
    const campos = Object.keys(consulta.select).sort()
    expect(campos).toEqual(['cashDrawerSession', 'id', 'staffId', 'startTime', 'startingCash', 'status', 'venueId'])
  })

  it('sin caja abierta contesta shift null', async () => {
    m.shift.findFirst.mockResolvedValueOnce(null)
    await expect(getShiftIdentity(VENUE)).resolves.toEqual({ shift: null, known: null })
  })

  it('con known, dice cómo está esa caja, sólo si es de ESTA sucursal', async () => {
    m.shift.findFirst
      .mockResolvedValueOnce({
        id: HOY,
        venueId: VENUE,
        status: 'OPEN',
        startTime: new Date(),
        staffId: 's',
        startingCash: new Prisma.Decimal(0),
        cashDrawerSession: null,
      })
      .mockResolvedValueOnce({ id: AYER, venueId: VENUE, status: 'CLOSED' })

    const r = await getShiftIdentity(VENUE, AYER)

    expect(r.known).toEqual({ id: AYER, venueId: VENUE, status: 'CLOSED' })
    expect(r.shift!.cashDrawerSessionId).toBeNull()
    expect(m.shift.findFirst.mock.calls[1][0]).toEqual({
      where: { id: AYER, venueId: VENUE },
      select: { id: true, venueId: true, status: true },
    })
  })

  it('una caja de otra sucursal no se encuentra: known null', async () => {
    m.shift.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null)
    await expect(getShiftIdentity(VENUE, AYER)).resolves.toEqual({ shift: null, known: null })
  })
})

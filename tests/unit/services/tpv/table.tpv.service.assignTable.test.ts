/**
 * assignTable — no reutilizar un puntero que apunta a una cuenta CERRADA (R2-TABLE-01, auditoría Mesas 40).
 *
 * El hijo de una división nunca recibe `Table.currentOrderId`; al pagar el padre nadie re-apunta, así que la mesa queda
 * OCCUPIED con el puntero en el padre PAID/COMPLETED. `getTablesWithStatus` la pinta libre, pero `assignTable`
 * reutilizaba ese puntero sin mirar su estado: devolvía el padre pagado con `isNewOrder:false` y la ronda siguiente se
 * rechazaba («Cannot add items to a paid order»).
 *
 * Regla: el puntero se reutiliza sólo si esa cuenta sigue abierta; si no, la cuenta viva más antigua de la mesa (y el
 * puntero pasa a ella); si no queda ninguna, se abre una visita nueva.
 */
import { prismaMock } from '../../../__helpers__/setup'

jest.mock('@/services/venueSalesGuard', () => ({
  __esModule: true,
  assertVenueSalesEnabled: jest.fn(),
}))
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn().mockReturnValue(null) },
}))

import { assignTable } from '@/services/tpv/table.tpv.service'

const VENUE = 'venue-1'
const TABLE = 'mesa-1'
const PARENT = { id: 'padre-pagado', orderNumber: 'ORD-PADRE', status: 'COMPLETED', paymentStatus: 'PAID', items: [] }

function mesaOcupadaCon(currentOrder: Record<string, unknown>) {
  prismaMock.table.findFirst.mockResolvedValue({
    id: TABLE,
    number: '4',
    status: 'OCCUPIED',
    currentOrderId: currentOrder.id,
    currentOrder,
  } as any)
}

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.$queryRaw.mockResolvedValue([{ id: TABLE }])
  prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1', staffId: 'staff-1', staff: { firstName: 'A', lastName: 'B' } } as any)
  prismaMock.order.updateMany.mockResolvedValue({ count: 0 } as any)
  prismaMock.order.findFirst.mockResolvedValue(null)
  prismaMock.order.create.mockResolvedValue({ id: 'cuenta-nueva', orderNumber: 'ORD-NUEVA', items: [] } as any)
  prismaMock.table.update.mockResolvedValue({ id: TABLE } as any)
  prismaMock.shift.findFirst.mockResolvedValue(null)
})

describe('assignTable — puntero a una cuenta cerrada (R2-TABLE-01)', () => {
  it('puntero al padre pagado y queda un hijo vivo → devuelve el hijo, re-apunta la mesa y NO crea cuenta', async () => {
    mesaOcupadaCon(PARENT)
    const hijo = { id: 'hijo-vivo', orderNumber: 'ORD-HIJO', status: 'PENDING', paymentStatus: 'PENDING', items: [] }
    prismaMock.order.findFirst.mockResolvedValue(hijo as any)

    const result = await assignTable(VENUE, TABLE, 'staff-1', 2)

    expect(result).toEqual({ order: hijo, isNewOrder: false })
    expect(prismaMock.order.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { venueId: VENUE, tableId: TABLE, status: { notIn: ['COMPLETED', 'CANCELLED', 'DELETED'] } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    )
    expect(prismaMock.table.update).toHaveBeenCalledWith({ where: { id: TABLE }, data: { currentOrderId: 'hijo-vivo' } })
    expect(prismaMock.order.create).not.toHaveBeenCalled()
    expect(prismaMock.order.updateMany).not.toHaveBeenCalled()
  })

  it('puntero al padre pagado y no queda ninguna cuenta viva → abre una visita nueva', async () => {
    mesaOcupadaCon(PARENT)

    const result = await assignTable(VENUE, TABLE, 'staff-1', 2)

    expect(result.isNewOrder).toBe(true)
    expect(result.order.id).toBe('cuenta-nueva')
    expect(prismaMock.order.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.table.update).toHaveBeenCalledWith({
      where: { id: TABLE },
      data: { status: 'OCCUPIED', currentOrderId: 'cuenta-nueva' },
    })
  })

  it('puntero a una cuenta CANCELADA → mismo trato que una pagada', async () => {
    mesaOcupadaCon({ ...PARENT, id: 'cancelada', status: 'CANCELLED', paymentStatus: 'PENDING' })

    const result = await assignTable(VENUE, TABLE, 'staff-1', 2)

    expect(result.isNewOrder).toBe(true)
    expect(result.order.id).toBe('cuenta-nueva')
  })

  it('regresión: puntero a una cuenta ABIERTA → la reutiliza sin buscar otra ni crear', async () => {
    const abierta = { id: 'abierta', orderNumber: 'ORD-ABIERTA', status: 'PENDING', paymentStatus: 'PENDING', items: [] }
    mesaOcupadaCon(abierta)

    const result = await assignTable(VENUE, TABLE, 'staff-1', 2)

    expect(result).toEqual({ order: abierta, isNewOrder: false })
    expect(prismaMock.order.findFirst).not.toHaveBeenCalled()
    expect(prismaMock.order.create).not.toHaveBeenCalled()
    expect(prismaMock.table.update).not.toHaveBeenCalled()
  })

  it('regresión: mesa libre → abre una visita nueva como siempre', async () => {
    prismaMock.table.findFirst.mockResolvedValue({
      id: TABLE,
      number: '4',
      status: 'AVAILABLE',
      currentOrderId: null,
      currentOrder: null,
    } as any)

    const result = await assignTable(VENUE, TABLE, 'staff-1', 2)

    expect(result.isNewOrder).toBe(true)
    expect(prismaMock.order.findFirst).not.toHaveBeenCalled()
    expect(prismaMock.order.create).toHaveBeenCalledTimes(1)
  })
})

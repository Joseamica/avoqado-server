/**
 * Quién recibió la mercancía.
 *
 * El flujo que la pantalla usa de verdad recibe RENGLÓN POR RENGLÓN y después llama a
 * recalcular para cerrar la orden. Ese recálculo sólo escribía `status`, así que en el
 * camino dominante del dashboard `receivedBy` quedaba en NULL: entraba mercancía al
 * almacén y no quedaba constancia de quién la recibió.
 *
 * En producción hay una orden recibida sin responsable por exactamente esto.
 */

import { PurchaseOrderItemStatus, PurchaseOrderStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { recalculatePurchaseOrderStatus } from '@/services/dashboard/purchaseOrder.service'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    purchaseOrder: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
  },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

const mockedPrisma = prisma as unknown as {
  purchaseOrder: { findUnique: jest.Mock; findFirst: jest.Mock; update: jest.Mock }
}

const VENUE = 'venue-1'
const PO = 'po-1'
const STAFF = 'staff-almacen'

function orden(over: Partial<any> = {}) {
  return {
    id: PO,
    venueId: VENUE,
    status: PurchaseOrderStatus.CONFIRMED,
    receivedBy: null,
    receivedDate: null,
    items: [{ receiveStatus: PurchaseOrderItemStatus.RECEIVED }, { receiveStatus: PurchaseOrderItemStatus.RECEIVED }],
    ...over,
  }
}

const datosEscritos = () => mockedPrisma.purchaseOrder.update.mock.calls[0]?.[0]?.data

beforeEach(() => {
  jest.clearAllMocks()
  mockedPrisma.purchaseOrder.findFirst.mockResolvedValue({ id: PO, venueId: VENUE })
  mockedPrisma.purchaseOrder.update.mockResolvedValue({})
})

describe('al cerrar la recepción se sella quién recibió', () => {
  it('🔴 estampa receivedBy cuando la orden queda RECIBIDA', async () => {
    mockedPrisma.purchaseOrder.findUnique.mockResolvedValue(orden())

    await recalculatePurchaseOrderStatus(VENUE, PO, STAFF)

    expect(datosEscritos()).toMatchObject({ status: PurchaseOrderStatus.RECEIVED, receivedBy: STAFF })
    expect(datosEscritos().receivedDate).toBeInstanceOf(Date)
  })

  it('también lo estampa en una recepción PARCIAL', async () => {
    // Recibir la mitad ya metió mercancía al almacén: alguien la recibió.
    mockedPrisma.purchaseOrder.findUnique.mockResolvedValue(
      orden({ items: [{ receiveStatus: PurchaseOrderItemStatus.RECEIVED }, { receiveStatus: PurchaseOrderItemStatus.PENDING }] }),
    )

    await recalculatePurchaseOrderStatus(VENUE, PO, STAFF)

    expect(datosEscritos()).toMatchObject({ status: PurchaseOrderStatus.PARTIAL, receivedBy: STAFF })
  })

  it('NO pisa a quien recibió primero', async () => {
    // Quien cierra una recepción parcial días después no borra al que recibió la
    // primera parte: la primera recepción es la que cuenta.
    mockedPrisma.purchaseOrder.findUnique.mockResolvedValue(
      orden({ status: PurchaseOrderStatus.PARTIAL, receivedBy: 'staff-que-recibio-primero', receivedDate: new Date('2026-08-01') }),
    )

    await recalculatePurchaseOrderStatus(VENUE, PO, 'staff-que-cerro')

    expect(datosEscritos()).not.toHaveProperty('receivedBy')
    expect(datosEscritos()).toMatchObject({ status: PurchaseOrderStatus.RECEIVED })
  })

  it('sin actor no inventa uno', async () => {
    // Rutas que todavía no propagan el actor no deben estampar basura.
    mockedPrisma.purchaseOrder.findUnique.mockResolvedValue(orden())

    await recalculatePurchaseOrderStatus(VENUE, PO)

    expect(datosEscritos()).not.toHaveProperty('receivedBy')
  })

  it('no sella nada si la orden se CANCELA (nada entró al almacén)', async () => {
    mockedPrisma.purchaseOrder.findUnique.mockResolvedValue(
      orden({
        items: [{ receiveStatus: PurchaseOrderItemStatus.DAMAGED }, { receiveStatus: PurchaseOrderItemStatus.NOT_PROCESSED }],
      }),
    )

    await recalculatePurchaseOrderStatus(VENUE, PO, STAFF)

    expect(datosEscritos()).toMatchObject({ status: PurchaseOrderStatus.CANCELLED })
    expect(datosEscritos()).not.toHaveProperty('receivedBy')
  })

  it('no escribe nada si no hay cambio de estado ni sello que poner', async () => {
    // Evita un UPDATE por cada recálculo idempotente.
    mockedPrisma.purchaseOrder.findUnique.mockResolvedValue(
      orden({ status: PurchaseOrderStatus.RECEIVED, receivedBy: 'ya-estaba', receivedDate: new Date() }),
    )

    await recalculatePurchaseOrderStatus(VENUE, PO, STAFF)

    expect(mockedPrisma.purchaseOrder.update).not.toHaveBeenCalled()
  })
})

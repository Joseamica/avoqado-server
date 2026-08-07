/**
 * Rechazar una orden de compra — y poder corregirla y reenviarla.
 *
 * RECHAZAR NO ERA RECHAZAR. El botón del dashboard llamaba a cancelar, así que
 * `rejectedBy`, `rejectedAt` y `rejectionReason` estaban vacíos en TODAS las órdenes de
 * la base: el motivo que el gerente escribía se perdía, y la orden quedaba muerta.
 *
 * La diferencia importa para quien captura: una orden CANCELADA hay que rehacerla desde
 * cero; una RECHAZADA se corrige y se reenvía. Sin esa vuelta, la gente deja de usar la
 * autorización y compra por fuera del sistema.
 */

import { PurchaseOrderStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { rejectPurchaseOrder, submitForApproval, isValidTransition } from '@/services/dashboard/purchaseOrderWorkflow.service'
import AppError from '@/errors/AppError'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    purchaseOrder: { findFirst: jest.fn(), update: jest.fn() },
    purchaseOrderItem: { count: jest.fn() },
  },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

import { logAction } from '@/services/dashboard/activity-log.service'

const mockedPrisma = prisma as unknown as {
  purchaseOrder: { findFirst: jest.Mock; update: jest.Mock }
  purchaseOrderItem: { count: jest.Mock }
}

const VENUE = 'venue-1'
const PO = 'po-1'
const GERENTE = 'staff-gerente'
const COMPRADOR = 'staff-comprador'

beforeEach(() => {
  jest.clearAllMocks()
  mockedPrisma.purchaseOrder.update.mockImplementation(async ({ data }: any) => ({ id: PO, ...data }))
  mockedPrisma.purchaseOrderItem.count.mockResolvedValue(3)
})

describe('rechazar', () => {
  it('🔴 deja la orden en RECHAZADA, no en CANCELADA', async () => {
    mockedPrisma.purchaseOrder.findFirst.mockResolvedValue({ id: PO, status: PurchaseOrderStatus.PENDING_APPROVAL })

    await rejectPurchaseOrder(VENUE, PO, 'El proveedor está más caro que la competencia', GERENTE)

    const data = mockedPrisma.purchaseOrder.update.mock.calls[0][0].data
    expect(data.status).toBe(PurchaseOrderStatus.REJECTED)
    expect(data.status).not.toBe(PurchaseOrderStatus.CANCELLED)
  })

  it('estampa quién rechazó, cuándo y por qué', async () => {
    // Sin las tres cosas el rechazo no sirve: el comprador no sabe qué corregir y
    // nadie puede auditar quién frenó la compra.
    mockedPrisma.purchaseOrder.findFirst.mockResolvedValue({ id: PO, status: PurchaseOrderStatus.PENDING_APPROVAL })

    await rejectPurchaseOrder(VENUE, PO, 'Falta cotización de otro proveedor', GERENTE)

    const data = mockedPrisma.purchaseOrder.update.mock.calls[0][0].data
    expect(data.rejectedBy).toBe(GERENTE)
    expect(data.rejectedAt).toBeInstanceOf(Date)
    expect(data.rejectionReason).toBe('Falta cotización de otro proveedor')
  })

  it('limpia una autorización previa: una orden rechazada no puede quedar marcada como autorizada', async () => {
    mockedPrisma.purchaseOrder.findFirst.mockResolvedValue({ id: PO, status: PurchaseOrderStatus.PENDING_APPROVAL })

    await rejectPurchaseOrder(VENUE, PO, 'motivo', GERENTE)

    const data = mockedPrisma.purchaseOrder.update.mock.calls[0][0].data
    expect(data.approvedBy).toBeNull()
    expect(data.approvedAt).toBeNull()
  })

  it('exige motivo — no acepta vacío ni espacios', async () => {
    mockedPrisma.purchaseOrder.findFirst.mockResolvedValue({ id: PO, status: PurchaseOrderStatus.PENDING_APPROVAL })

    for (const vacio of ['', '   ']) {
      await expect(rejectPurchaseOrder(VENUE, PO, vacio, GERENTE)).rejects.toThrow(AppError)
    }
    expect(mockedPrisma.purchaseOrder.update).not.toHaveBeenCalled()
  })

  it('escribe la bitácora del dueño', async () => {
    mockedPrisma.purchaseOrder.findFirst.mockResolvedValue({ id: PO, status: PurchaseOrderStatus.PENDING_APPROVAL })

    await rejectPurchaseOrder(VENUE, PO, 'muy caro', GERENTE)

    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'PURCHASE_ORDER_REJECTED', staffId: GERENTE }))
  })
})

describe('corregir y reenviar', () => {
  it('🔴 una orden RECHAZADA se puede volver a enviar a autorización', async () => {
    // Sin esto, rechazar es irreversible: el comprador tendría que rehacer la orden
    // desde cero, que es exactamente por lo que la gente abandona el flujo.
    mockedPrisma.purchaseOrder.findFirst.mockResolvedValue({ id: PO, status: PurchaseOrderStatus.REJECTED })

    await submitForApproval(VENUE, PO, COMPRADOR)

    const data = mockedPrisma.purchaseOrder.update.mock.calls[0][0].data
    expect(data.status).toBe(PurchaseOrderStatus.PENDING_APPROVAL)
  })

  it('al reenviar borra el rechazo anterior', async () => {
    // Si no, la orden llega al gerente marcada como rechazada por él mismo.
    mockedPrisma.purchaseOrder.findFirst.mockResolvedValue({ id: PO, status: PurchaseOrderStatus.REJECTED })

    await submitForApproval(VENUE, PO, COMPRADOR)

    const data = mockedPrisma.purchaseOrder.update.mock.calls[0][0].data
    expect(data.rejectedBy).toBeNull()
    expect(data.rejectionReason).toBeNull()
  })

  it('un borrador se sigue pudiendo enviar, como siempre', async () => {
    mockedPrisma.purchaseOrder.findFirst.mockResolvedValue({ id: PO, status: PurchaseOrderStatus.DRAFT })

    await submitForApproval(VENUE, PO, COMPRADOR)

    expect(mockedPrisma.purchaseOrder.update.mock.calls[0][0].data.status).toBe(PurchaseOrderStatus.PENDING_APPROVAL)
  })

  it('no se puede enviar una orden ya autorizada o recibida', async () => {
    for (const estado of [PurchaseOrderStatus.APPROVED, PurchaseOrderStatus.RECEIVED, PurchaseOrderStatus.CANCELLED]) {
      mockedPrisma.purchaseOrder.findFirst.mockResolvedValue({ id: PO, status: estado })
      await expect(submitForApproval(VENUE, PO, COMPRADOR)).rejects.toThrow(AppError)
    }
  })

  it('no se envía una orden sin renglones', async () => {
    mockedPrisma.purchaseOrder.findFirst.mockResolvedValue({ id: PO, status: PurchaseOrderStatus.DRAFT })
    mockedPrisma.purchaseOrderItem.count.mockResolvedValue(0)

    await expect(submitForApproval(VENUE, PO, COMPRADOR)).rejects.toThrow(AppError)
  })
})

describe('la tabla de transiciones acompaña el ciclo', () => {
  it('RECHAZADA puede volver a pendiente de autorización', () => {
    expect(isValidTransition(PurchaseOrderStatus.REJECTED, PurchaseOrderStatus.PENDING_APPROVAL)).toBe(true)
  })

  it('RECHAZADA sigue pudiendo volver a borrador o cancelarse', () => {
    expect(isValidTransition(PurchaseOrderStatus.REJECTED, PurchaseOrderStatus.DRAFT)).toBe(true)
    expect(isValidTransition(PurchaseOrderStatus.REJECTED, PurchaseOrderStatus.CANCELLED)).toBe(true)
  })

  it('pero NO puede saltar directo a autorizada ni a recibida', () => {
    // Reenviar tiene que pasar por la autorización de alguien más, o el ciclo no
    // controla nada.
    expect(isValidTransition(PurchaseOrderStatus.REJECTED, PurchaseOrderStatus.APPROVED)).toBe(false)
    expect(isValidTransition(PurchaseOrderStatus.REJECTED, PurchaseOrderStatus.RECEIVED)).toBe(false)
  })
})

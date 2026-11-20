import '../../__helpers__/integration-setup'
import prisma from '@/utils/prismaClient'
import { removeOrderDiscount, attachCustomerToOrder, removeOrderDiscountInTransaction } from '@/services/mobile/order.mobile.service'
import { removeDiscountFromOrder } from '@/services/dashboard/discountEngine.service'
import { addItemsToOrder, addCustomerToOrder, updateGuestInfo, voidItems } from '@/services/tpv/order.tpv.service'
import { applyServiceCharge } from '@/services/mobile/service-charge.mobile.service'
import { lockExistingOrderForPayment } from '@/services/shared/paymentShiftClaim'
import { bloquearCuentaParaEditar, reabrirSiRecibeDinero } from '@/services/shared/cuentaCancelada'
import { updateOrder } from '@/services/dashboard/order.dashboard.service'
import { withDeadlockRetry } from '@/utils/serializableRetry'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.mock('@/communication/sockets/managers/socketManager', () => {
  const sm = { getServer: jest.fn(), getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() }
  return { __esModule: true, default: sm, socketManager: sm }
})
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({ notifyCustomerPassUpdated: jest.fn() }))
jest.mock('@/services/access/basePlan.service', () => ({
  ...jest.requireActual('@/services/access/basePlan.service'),
  venueHasFeatureAccess: jest.fn(async () => true),
}))

const sello = Date.now().toString(36)
let orgId: string | undefined, venueId: string | undefined
let staffId: string, customerId: string, productId: string, categoryId: string
let secuencia = 0
beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `S2 ${sello}`, email: `s2-${sello}@test.com`, phone: '5550000000' } })).id
  venueId = (await prisma.venue.create({ data: { name: `S2 ${sello}`, slug: `s2-${sello}`, organizationId: orgId } })).id
  staffId = (await prisma.staff.create({ data: { firstName: 'S2', lastName: 'Prueba', email: `s2-${sello}@test.com` } })).id
  await prisma.staffVenue.create({ data: { venueId, staffId, role: 'MANAGER' } })
  customerId = (await prisma.customer.create({ data: { venueId, firstName: 'Clienta S2', phone: '+525555555555' } })).id
  categoryId = (await prisma.menuCategory.create({ data: { venueId, name: 'Catálogo S2', slug: `s2-${sello}` } })).id
  productId = (await prisma.product.create({ data: { venueId, categoryId, name: 'Producto S2', sku: `S2-${sello}`, price: 100 } })).id
})
afterAll(async () => {
  if (!venueId || !orgId) return
  await prisma.activityLog.deleteMany({ where: { venueId } })
  await prisma.payment.deleteMany({ where: { venueId } })
  await prisma.order.deleteMany({ where: { venueId } })
  await prisma.product.deleteMany({ where: { venueId } })
  await prisma.menuCategory.deleteMany({ where: { venueId } })
  await prisma.customer.deleteMany({ where: { venueId } })
  await prisma.staffVenue.deleteMany({ where: { venueId } })
  await prisma.staff.deleteMany({ where: { id: staffId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
  await prisma.$disconnect()
})
async function venta(status: 'CANCELLED' | 'DELETED' = 'CANCELLED') {
  return prisma.order.create({
    data: {
      venueId: venueId!,
      orderNumber: `S2-${++secuencia}`,
      source: 'WEB',
      originSystem: 'AVOQADO',
      status,
      paymentStatus: 'PENDING',
      contratoDePrecio: 'IVA_INCLUIDO',
      subtotal: 100,
      discountAmount: 25,
      taxAmount: 0,
      total: 75,
      remainingBalance: 75,
      items: { create: { productId, quantity: 1, unitPrice: 100, total: 100, taxAmount: 0 } },
      orderDiscounts: {
        create: {
          name: 'Beneficio regresado a la clienta al anular el folio',
          type: 'FIXED_AMOUNT',
          value: 25,
          amount: 25,
          isComp: true,
          compReason: 'Beneficio regresado a la clienta al anular el folio',
        },
      },
    },
    include: { orderDiscounts: true },
  })
}
function foto(orderId: string) {
  return prisma.order.findUniqueOrThrow({
    where: { id: orderId, venueId },
    include: { items: true, orderDiscounts: true, orderCustomers: true, serviceCharges: true },
  })
}
describe('PostgreSQL: ninguna edición borra ni rebasa la cortesía de una cuenta anulada', () => {
  it.each(['COBRO', 'ATRIBUCION'] as const)('%s excluye una cancelada adicional de otro negocio', async modo => {
    const propia = await venta()
    await prisma.order.update({ where: { id: propia.id }, data: { status: 'PENDING' } })
    const otroVenue = await prisma.venue.create({
      data: { name: `Otro S2 ${++secuencia}`, slug: `otro-s2-${sello}-${secuencia}`, organizationId: orgId! },
    })
    try {
      const ajena = await prisma.order.create({
        data: { venueId: otroVenue.id, orderNumber: 'AJENA-S2', status: 'CANCELLED', subtotal: 100, taxAmount: 0, total: 100 },
      })
      await expect(
        prisma.$transaction(tx =>
          bloquearCuentaParaEditar(tx, { venueId: venueId!, orderId: propia.id, additionalOrderIds: [ajena.id] }, modo),
        ),
      ).resolves.toBe(true)
      expect((await prisma.order.findUniqueOrThrow({ where: { id: ajena.id } })).status).toBe('CANCELLED')
    } finally {
      await prisma.order.deleteMany({ where: { venueId: otroVenue.id } })
      await prisma.venue.delete({ where: { id: otroVenue.id } })
    }
  })
  it.each(['CANCELLED', 'DELETED'] as const)('%s conserva todas las filas y totales por POS y TPV', async status => {
    const order = await venta(status),
      original = await foto(order.id),
      descuento = order.orderDiscounts[0].id
    const editar = [
      () => removeOrderDiscount(venueId!, order.id, descuento, staffId),
      () => removeDiscountFromOrder(order.id, descuento, staffId, venueId!),
      () => addItemsToOrder(venueId!, order.id, [{ productId, quantity: 1 }], order.version),
      () => attachCustomerToOrder(venueId!, order.id, customerId, staffId),
      () => addCustomerToOrder(venueId!, order.id, customerId, staffId),
      () => applyServiceCharge(venueId!, order.id, descuento, staffId),
    ]
    for (const edit of editar) {
      await expect(edit()).rejects.toMatchObject({ statusCode: 400, code: 'ORDER_CANCELLED_NO_EDIT' })
      expect(await foto(order.id)).toEqual(original)
    }
  })
  it('la limpieza de anulación mantiene la excepción para quitar la fila y recalcular', async () => {
    const order = await venta()
    await withDeadlockRetry(
      tx => removeOrderDiscountInTransaction(tx, venueId!, order.id, order.orderDiscounts[0].id, staffId, { porAnulacion: true }),
      { etiqueta: 's2-anulacion-test' },
    )
    expect(await prisma.orderDiscount.count({ where: { orderId: order.id } })).toBe(0)
    expect((await foto(order.id)).status).toBe('CANCELLED')
  })
  it('dinero tardío revive la misma cuenta y después permite editar como una cuenta viva', async () => {
    const order = await venta()
    await prisma.$transaction(async tx => {
      await lockExistingOrderForPayment(tx, { venueId: venueId!, orderId: order.id })
      await reabrirSiRecibeDinero(tx, {
        venueId: venueId!,
        orderId: order.id,
        status: 'CANCELLED',
        originSystem: 'AVOQADO',
        cobrado: 5,
        cubreComoCancelada: false,
        canal: 'S2_TEST',
      })
    })
    await expect(updateGuestInfo(venueId!, order.id, { customerName: 'Clienta que regresó' })).resolves.toMatchObject({
      status: 'PENDING',
      customerName: 'Clienta que regresó',
    })
    expect(await prisma.orderDiscount.count({ where: { orderId: order.id } })).toBe(1)
  })
})

describe('R9/R10 PostgreSQL: ramas de anulación sin editar una cuenta ya anulada', () => {
  it.each(['CANCELLED', 'DELETED'] as const)('%s: panel rechaza cliente/nombre/reactivación con filas intactas', async status => {
    const order = await venta(status)
    await prisma.orderItem.create({ data: { orderId: order.id, productId, quantity: 1, unitPrice: 100, total: 100, taxAmount: 0 } })
    const original = await foto(order.id)
    for (const data of [{ customerId }, { customerName: 'Nueva' }, { status: 'PENDING' }, { status, customerName: 'Nueva' }]) {
      await expect(updateOrder(venueId!, order.id, data as any)).rejects.toMatchObject({ code: 'ORDER_CANCELLED_NO_EDIT' })
      expect(await foto(order.id)).toEqual(original)
    }
  })
  it.each([
    ['CANCELLED', false],
    ['CANCELLED', true],
    ['DELETED', false],
    ['DELETED', true],
  ] as const)('%s: TPV rechaza anular todos=%s y conserva filas/importes/versión', async (status, todos) => {
    const order = await venta(status)
    await prisma.orderItem.create({ data: { orderId: order.id, productId, quantity: 1, unitPrice: 100, total: 100, taxAmount: 0 } })
    const original = await foto(order.id),
      ids = original.items.map(item => item.id)
    await expect(
      voidItems(venueId!, order.id, { itemIds: todos ? ids : [ids[0]], reason: 'S2', staffId, expectedVersion: order.version }),
    ).rejects.toMatchObject({ code: 'ORDER_CANCELLED_NO_EDIT' })
    expect(await foto(order.id)).toEqual(original)
  })
  it.each([false, true])('una viva permite anular todos=%s con sus reglas actuales', async todos => {
    const order = await venta()
    await prisma.orderItem.create({ data: { orderId: order.id, productId, quantity: 1, unitPrice: 100, total: 100, taxAmount: 0 } })
    await prisma.order.update({ where: { id: order.id }, data: { status: 'PENDING', subtotal: 200, total: 175, remainingBalance: 175 } })
    const original = await foto(order.id),
      ids = original.items.map(item => item.id)
    await voidItems(venueId!, order.id, { itemIds: todos ? ids : [ids[0]], reason: 'S2', staffId, expectedVersion: order.version })
    const despues = await foto(order.id)
    expect(despues.status).toBe(todos ? 'CANCELLED' : 'PENDING')
    expect(despues.items).toHaveLength(todos ? 0 : 1)
    expect(despues.version).toBe(original.version + 1)
  })
  it.each(['CANCELLED', 'DELETED'] as const)('anular viva como %s y repetir formulario idéntico conserva datos y versión', async status => {
    const order = await venta()
    await prisma.order.update({ where: { id: order.id }, data: { status: 'PENDING' } })
    await expect(updateOrder(venueId!, order.id, { status })).resolves.toMatchObject({ status })
    const original = await foto(order.id)
    await expect(
      updateOrder(venueId!, order.id, {
        status,
        customerId: '' as any,
        customerName: original.customerName,
        tableId: '' as any,
        servedById: '' as any,
        createdAt: original.createdAt,
        orderNumber: original.orderNumber,
        type: original.type,
      }),
    ).resolves.toMatchObject({ status, version: original.version })
    const despues = await foto(order.id)
    expect({ ...despues, updatedAt: original.updatedAt }).toEqual(original)
  })
  it('panel mantiene 404 para cuenta ajena y ausente, también sin topología', async () => {
    const order = await venta()
    for (const data of [{ customerName: 'Otra' }, { status: 'PENDING' }]) {
      await expect(updateOrder(orgId!, order.id, data as any)).rejects.toMatchObject({ statusCode: 404 })
      await expect(updateOrder(venueId!, orgId!, data as any)).rejects.toMatchObject({ statusCode: 404 })
    }
  })
})

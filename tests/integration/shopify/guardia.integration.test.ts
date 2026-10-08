/**
 * El guardia: cada cambio de "Inventory"."currentStock" de una sucursal ligada a Shopify deja su delta en
 * "ShopifyStockOutbox" EN LA MISMA transacción (spec §4 ③, ajustes 12 bis.2 y 12 bis.6). Contra Postgres real: un
 * trigger no existe en un mock.
 *
 * Los 11 caminos que escriben stock de un producto hoy, todos con su servicio REAL:
 *  1 venta (TPV, POS, ligas: SQL crudo) ............. deductInventoryForProduct
 *  2 reembolso ...................................... restockItem
 *  3 ajuste del dashboard y del POS ................. adjustInventoryStock
 *  4 merma .......................................... logWaste
 *  5 conteo (valor absoluto) ........................ confirmStockCount
 *  6 asistente de producto (valor absoluto) ......... setupSimpleStockStep3
 *  7 importación: saldo de apertura sobre fila vacía  importMenu (merge)
 *  8 importación: producto nuevo (INSERT) ........... importMenu en CONNECTING
 *  9 cancelación de una venta (delivery) ............ reverseSalePosting
 * 10 recepción de mercancía de reventa .............. updatePurchaseOrderItemStatus
 * 11 vales por área V7 ............................... ruta externa (emitir consume, cancelar regresa) y ruta nativa
 *    (emitir reserva, cobrar consume la reserva y la línea normal), con la configuración de area-ticket-v7-flow.test.ts
 */
import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { adjustInventoryStock } from '@/services/dashboard/productInventory.service'
import { restockItem } from '@/services/dashboard/inventoryRestock.service'
import { deductInventoryForProduct } from '@/services/dashboard/productInventoryIntegration.service'
import { setupSimpleStockStep3 } from '@/services/dashboard/productWizard.service'
import { logWaste } from '@/services/shared/inventoryWaste.service'
import { importMenu } from '@/services/dashboard/menu.dashboard.service'
import { confirmStockCount } from '@/services/mobile/inventory.mobile.service'
import { reverseSalePosting } from '@/services/inventory/reverseSalePosting.service'
import { updatePurchaseOrderItemStatus } from '@/services/dashboard/purchaseOrder.service'
import {
  addTicketToCheckout,
  cancelAreaTicket,
  createAreaTicketCheckout,
  finalizeAreaTicketPaymentInTransaction,
  issueAreaTicket,
  lockAreaTicketCheckoutForPayment,
  materializeAreaTicketCheckout,
} from '@/services/mobile/areaTicketV7.mobile.service'
import { agregarProductoShopify, assertTestDatabase, crearEscenarioShopify, EscenarioShopify, limpiarEscenarioShopify } from './fixtures'

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v)
const filas = (productId: string) =>
  prisma.shopifyStockOutbox.findMany({ where: { productId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 20 })
const deltas = async (productId: string) => (await filas(productId)).map(f => f.delta.toString())
const restarUno = (inventoryId: string) =>
  prisma.$executeRaw`UPDATE "Inventory" SET "currentStock" = "currentStock" - 1 WHERE id = ${inventoryId}`
const humano = (e: EscenarioShopify) => ({ type: 'HUMAN' as const, staffId: e.staffId, impersonating: false })

let escenarios: EscenarioShopify[] = []
async function escenario(o?: Parameters<typeof crearEscenarioShopify>[0]): Promise<EscenarioShopify> {
  const e = await crearEscenarioShopify(o)
  escenarios.push(e)
  return e
}

beforeAll(() => assertTestDatabase())
afterEach(async () => {
  for (const e of escenarios) await limpiarEscenarioShopify(e)
  escenarios = []
})

describe('las formas en que se escribe el stock', () => {
  it('resta en SQL crudo (la forma de la venta y de los vales) ⇒ encola −1 con su sucursal y generación', async () => {
    const e = await escenario()
    await prisma.$executeRaw`UPDATE "Inventory" SET "currentStock" = "currentStock" - ${D(1)}, "updatedAt" = NOW() WHERE id = ${e.inventoryId} AND "venueId" = ${e.venueId}`
    const rows = await filas(e.productId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      venueId: e.venueId,
      locationLinkId: e.locationLinkId,
      generation: 1,
      status: 'PENDING',
      ambiguous: false,
      attempts: 0,
      firstAttemptAt: null,
      sentInventoryItemId: null,
    })
    expect(rows[0].delta.toString()).toBe('-1')
  })

  it('suma con increment de Prisma (reembolso, compra, reverso) ⇒ encola +3', async () => {
    const e = await escenario()
    await prisma.inventory.update({ where: { id: e.inventoryId }, data: { currentStock: { increment: 3 } } })
    expect(await deltas(e.productId)).toEqual(['3'])
  })

  it('número absoluto (conteo, asistente) ⇒ encola la diferencia', async () => {
    const e = await escenario()
    await prisma.inventory.update({ where: { id: e.inventoryId }, data: { currentStock: D(7), lastCountedAt: new Date() } })
    expect(await deltas(e.productId)).toEqual(['-3'])
  })

  it('una cantidad con decimales se encola exacta (el mensajero decide qué hacer con ella)', async () => {
    const e = await escenario()
    await prisma.inventory.update({ where: { id: e.inventoryId }, data: { currentStock: { decrement: D('0.5') } } })
    expect(await deltas(e.productId)).toEqual(['-0.5'])
  })

  it('el DELETE de la fila no encola; un INSERT con saldo encola el saldo', async () => {
    const e = await escenario()
    await prisma.$executeRaw`DELETE FROM "Inventory" WHERE id = ${e.inventoryId}`
    expect(await filas(e.productId)).toHaveLength(0)
    await prisma.inventory.create({ data: { productId: e.productId, venueId: e.venueId, currentStock: D(5) } })
    expect(await deltas(e.productId)).toEqual(['5'])
  })

  it('delta 0 no encola', async () => {
    const e = await escenario()
    await prisma.inventory.update({ where: { id: e.inventoryId }, data: { currentStock: D(10) } })
    expect(await filas(e.productId)).toHaveLength(0)
  })

  it('cambiar otra columna (el mínimo) no dispara el guardia', async () => {
    const e = await escenario()
    await prisma.inventory.update({ where: { id: e.inventoryId }, data: { minimumStock: D(3) } })
    expect(await filas(e.productId)).toHaveLength(0)
  })

  it('con la marca de origen shopify NO encola (anti-eco)', async () => {
    const e = await escenario()
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT set_config('avoqado.stock_origen', 'shopify', true)`
      await tx.inventory.update({ where: { id: e.inventoryId }, data: { currentStock: { decrement: 4 } } })
    })
    expect(await filas(e.productId)).toHaveLength(0)
  })

  it('la marca no se escapa de su transacción', async () => {
    const e = await escenario()
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT set_config('avoqado.stock_origen', 'shopify', true)`
    })
    await restarUno(e.inventoryId)
    expect(await deltas(e.productId)).toEqual(['-1'])
  })
})

describe('las fases de la sucursal', () => {
  it('CONNECTING: encola un producto que todavía no tiene pareja, con la generación vigente', async () => {
    const e = await escenario({ linkStatus: 'CONNECTING', initialized: false, generation: 3 })
    const otro = await agregarProductoShopify(e, { pareja: false, stock: 4 })
    await restarUno(otro.inventoryId)
    expect(await filas(otro.productId)).toEqual([
      expect.objectContaining({ locationLinkId: e.locationLinkId, generation: 3, status: 'PENDING' }),
    ])
    expect(await deltas(otro.productId)).toEqual(['-1'])
  })

  it('REVIEWING: también encola productos sin pareja', async () => {
    const e = await escenario({ linkStatus: 'REVIEWING', initialized: false })
    const otro = await agregarProductoShopify(e, { pareja: false })
    await restarUno(otro.inventoryId)
    expect(await deltas(otro.productId)).toEqual(['-1'])
  })

  it('PAUSED desde CONNECTING: sigue encolando productos sin pareja', async () => {
    const e = await escenario({ linkStatus: 'PAUSED', pausedFrom: 'CONNECTING', initialized: false })
    const otro = await agregarProductoShopify(e, { pareja: false })
    await restarUno(otro.inventoryId)
    expect(await deltas(otro.productId)).toEqual(['-1'])
  })

  it('ACTIVE: sólo la pareja iniciada y no suspendida', async () => {
    const e = await escenario()
    const sinPareja = await agregarProductoShopify(e, { pareja: false })
    const sinIniciar = await agregarProductoShopify(e, { initialized: false })
    const suspendida = await agregarProductoShopify(e)
    await prisma.shopifyVariantLink.update({
      where: { id: suspendida.variantLinkId! },
      data: { suspendedReason: 'NIVEL_INEXISTENTE', suspendedAt: new Date() },
    })
    for (const id of [e.inventoryId, sinPareja.inventoryId, sinIniciar.inventoryId, suspendida.inventoryId]) await restarUno(id)
    expect(await deltas(e.productId)).toEqual(['-1'])
    expect(await filas(sinPareja.productId)).toHaveLength(0)
    expect(await filas(sinIniciar.productId)).toHaveLength(0)
    expect(await filas(suspendida.productId)).toHaveLength(0)
  })

  it('PAUSED desde ACTIVE: encola la pareja iniciada y no un producto sin pareja', async () => {
    const e = await escenario({ linkStatus: 'PAUSED', pausedFrom: 'ACTIVE' })
    const sinPareja = await agregarProductoShopify(e, { pareja: false })
    await restarUno(e.inventoryId)
    await restarUno(sinPareja.inventoryId)
    expect(await deltas(e.productId)).toEqual(['-1'])
    expect(await filas(sinPareja.productId)).toHaveLength(0)
  })

  it('PAUSED sin pausedFrom se trata como ACTIVE', async () => {
    const e = await escenario({ linkStatus: 'PAUSED' })
    const sinPareja = await agregarProductoShopify(e, { pareja: false })
    await restarUno(e.inventoryId)
    await restarUno(sinPareja.inventoryId)
    expect(await deltas(e.productId)).toEqual(['-1'])
    expect(await filas(sinPareja.productId)).toHaveLength(0)
  })

  it('DISCONNECTED: no encola nada', async () => {
    const e = await escenario({ linkStatus: 'DISCONNECTED' })
    await restarUno(e.inventoryId)
    expect(await filas(e.productId)).toHaveLength(0)
  })

  it('sucursal sin Shopify: no encola nada', async () => {
    const e = await escenario()
    await prisma.shopifyLocationLink.delete({ where: { id: e.locationLinkId } })
    await restarUno(e.inventoryId)
    expect(await filas(e.productId)).toHaveLength(0)
  })
})

describe('los caminos reales que escriben stock (spec §4 ③)', () => {
  it('venta: deductInventoryForProduct', async () => {
    const e = await escenario()
    await deductInventoryForProduct(e.venueId, e.productId, 1, `orden-${randomUUID()}`)
    expect(await deltas(e.productId)).toEqual(['-1'])
  })

  it('reembolso: restockItem', async () => {
    const e = await escenario()
    await restockItem({ venueId: e.venueId, productId: e.productId, quantity: 2, refundPaymentId: `reembolso-${randomUUID()}` })
    expect(await deltas(e.productId)).toEqual(['2'])
  })

  it('ajuste: adjustInventoryStock', async () => {
    const e = await escenario()
    await adjustInventoryStock(e.venueId, e.productId, { type: 'ADJUSTMENT', quantity: -2, reason: 'prueba' }, e.staffId)
    expect(await deltas(e.productId)).toEqual(['-2'])
  })

  it('merma: logWaste', async () => {
    const e = await escenario()
    await logWaste(e.venueId, e.staffId, {
      itemType: 'PRODUCT',
      itemId: e.productId,
      quantity: 3,
      unit: 'UNIT',
      reasonCode: 'OTHER',
      note: 'Prueba del guardia',
      idempotencyKey: randomUUID(),
      source: 'POS',
    })
    expect(await deltas(e.productId)).toEqual(['-3'])
  })

  it('conteo: confirmStockCount (valor absoluto 10 → 8)', async () => {
    const e = await escenario()
    const count = await prisma.stockCount.create({
      data: {
        venueId: e.venueId,
        type: 'CYCLE',
        status: 'IN_PROGRESS',
        createdById: e.staffId,
        items: { create: { productId: e.productId, expected: D(10), counted: D(8), countedAt: new Date() } },
      },
    })
    await confirmStockCount(count.id, e.venueId, e.staffId, 0)
    expect(await deltas(e.productId)).toEqual(['-2'])
  })

  it('asistente: setupSimpleStockStep3 (valor absoluto 10 → 6)', async () => {
    const e = await escenario()
    await setupSimpleStockStep3(e.venueId, e.productId, { initialStock: 6, reorderPoint: 1, costPerUnit: 50 })
    expect(await deltas(e.productId)).toEqual(['-4'])
  })

  it('importación: saldo de apertura sobre la fila vacía de un producto con pareja', async () => {
    const e = await escenario()
    const sku = `SKU-IMP-${randomUUID().slice(0, 8)}`
    const vacio = await agregarProductoShopify(e, { stock: 0, sku })
    const cat = await prisma.menuCategory.findUniqueOrThrow({ where: { id: e.categoryId } })
    await importMenu(
      e.venueId,
      {
        mode: 'merge',
        categories: [
          {
            name: cat.name,
            slug: cat.slug,
            products: [{ name: 'Producto importado', sku, price: 100, trackInventory: true, currentStock: 12 }],
          },
        ],
      },
      humano(e),
    )
    expect(await deltas(vacio.productId)).toEqual(['12'])
  })

  it('importación: producto NUEVO en CONNECTING (INSERT de Inventory con saldo)', async () => {
    const e = await escenario({ linkStatus: 'CONNECTING', initialized: false })
    const sku = `SKU-NVO-${randomUUID().slice(0, 8)}`
    const cat = await prisma.menuCategory.findUniqueOrThrow({ where: { id: e.categoryId } })
    await importMenu(
      e.venueId,
      {
        mode: 'merge',
        categories: [
          {
            name: cat.name,
            slug: cat.slug,
            products: [{ name: 'Producto nuevo', sku, price: 100, trackInventory: true, currentStock: 4 }],
          },
        ],
      },
      humano(e),
    )
    const nuevo = await prisma.product.findFirstOrThrow({ where: { venueId: e.venueId, sku } })
    expect(await deltas(nuevo.id)).toEqual(['4'])
  })

  it('cancelación de venta: reverseSalePosting', async () => {
    const e = await escenario()
    const order = await prisma.order.create({
      data: {
        venueId: e.venueId,
        orderNumber: `SHP-${randomUUID().slice(0, 8)}`,
        total: D(100),
        subtotal: D(100),
        taxAmount: D(0),
        tipAmount: D(0),
      },
    })
    const posting = await prisma.inventoryPosting.create({
      data: {
        venueId: e.venueId,
        sourceKind: 'ORDER',
        sourceId: order.id,
        effectKind: 'SALE',
        orderId: order.id,
        status: 'APPLIED',
        appliedAt: new Date(),
      },
    })
    const linea = await prisma.inventoryPostingLine.create({
      data: {
        postingId: posting.id,
        effectKey: 'l1',
        productId: e.productId,
        expectedQuantityBase: D(3),
        appliedQuantityBase: D(3),
        status: 'APPLIED',
      },
    })
    await prisma.inventoryMovement.create({
      data: {
        inventoryId: e.inventoryId,
        type: 'SALE',
        quantity: D(-3),
        previousStock: D(13),
        newStock: D(10),
        postingLineId: linea.id,
        reference: order.id,
      },
    })
    const r = await reverseSalePosting({ venueId: e.venueId, orderId: order.id, reason: 'pedido cancelado' })
    expect(r.outcome).toBe('REVERSED')
    expect(await deltas(e.productId)).toEqual(['3'])
  })

  it('recepción de reventa: updatePurchaseOrderItemStatus', async () => {
    const e = await escenario()
    const supplier = await prisma.supplier.create({ data: { venueId: e.venueId, name: 'Proveedor Shopify' } })
    const po = await prisma.purchaseOrder.create({
      data: {
        venueId: e.venueId,
        supplierId: supplier.id,
        orderNumber: `PO-SHP-${randomUUID().slice(0, 8)}`,
        status: 'CONFIRMED',
        orderDate: new Date(),
        subtotal: D(50),
        total: D(50),
        items: {
          create: { productId: e.productId, quantityOrdered: D(5), quantityReceived: D(0), unit: 'UNIT', unitPrice: D(10), total: D(50) },
        },
      },
      include: { items: true },
    })
    await updatePurchaseOrderItemStatus(e.venueId, po.id, po.items[0].id, { receiveStatus: 'RECEIVED', quantityReceived: 4 }, e.staffId)
    expect(await deltas(e.productId)).toEqual(['4'])
  })
})

/** Configuración mínima de area-ticket-v7-flow.test.ts y area-ticket-external-cancel.test.ts sobre el escenario. */
async function prepararVales(e: EscenarioShopify): Promise<{ emisionNativa: string; emisionExterna: string; caja: string }> {
  const sufijo = randomUUID().slice(0, 8)
  // AREA_TICKETS se concede por exento, como en las suites de vales.
  await prisma.venue.update({ where: { id: e.venueId }, data: { seatCapExempt: true } })
  await prisma.venueAreaTicketSettings.create({
    data: { venueId: e.venueId, enabled: true, inventoryReservationMode: 'HOLD_AVAILABLE_STOCK' },
  })
  const nativa = await prisma.fulfillmentArea.create({
    data: { venueId: e.venueId, name: `Cremería ${sufijo}`, fulfillmentMode: 'HOLD_UNTIL_PAID' },
  })
  const externa = await prisma.fulfillmentArea.create({
    data: { venueId: e.venueId, name: `Externa ${sufijo}`, fulfillmentMode: 'HOLD_UNTIL_PAID', settlementRoute: 'EXTERNAL' },
  })
  const d = { emisionNativa: `emision-${sufijo}`, emisionExterna: `externa-${sufijo}`, caja: `caja-${sufijo}` }
  await prisma.terminal.createMany({
    data: [
      {
        venueId: e.venueId,
        name: 'Cremería',
        type: 'POS_ANDROID',
        status: 'ACTIVE',
        deviceUid: d.emisionNativa,
        fulfillmentAreaId: nativa.id,
        canIssueAreaTickets: true,
      },
      {
        venueId: e.venueId,
        name: 'Externa',
        type: 'POS_ANDROID',
        status: 'ACTIVE',
        deviceUid: d.emisionExterna,
        fulfillmentAreaId: externa.id,
        canIssueAreaTickets: true,
      },
      { venueId: e.venueId, name: 'Caja', type: 'POS_ANDROID', status: 'ACTIVE', deviceUid: d.caja, canCheckoutAreaTickets: true },
    ],
  })
  return d
}

describe('vales por área V7 (caminos reales)', () => {
  it('ruta externa: emitir consume y cancelar regresa', async () => {
    const e = await escenario()
    const d = await prepararVales(e)
    const vale = await issueAreaTicket(e.venueId, {
      idempotencyKey: `ext-${randomUUID()}`,
      deviceUid: d.emisionExterna,
      staffId: e.staffId,
      lines: [{ clientLineId: 'l1', productId: e.productId, quantity: '2' }],
    })
    expect(await deltas(e.productId)).toEqual(['-2'])
    await cancelAreaTicket(e.venueId, vale.id, {
      idempotencyKey: `cancel-${randomUUID()}`,
      deviceUid: d.emisionExterna,
      staffId: e.staffId,
      reason: 'El cliente se arrepintió',
    })
    expect(await deltas(e.productId)).toEqual(['-2', '2'])
  })

  it('ruta nativa: emitir sólo reserva; el cobro completo consume la reserva y la línea normal', async () => {
    const e = await escenario()
    const d = await prepararVales(e)
    const normal = await agregarProductoShopify(e)
    const vale = await issueAreaTicket(e.venueId, {
      idempotencyKey: `nat-${randomUUID()}`,
      deviceUid: d.emisionNativa,
      staffId: e.staffId,
      lines: [{ clientLineId: 'l1', productId: e.productId, quantity: '2' }],
    })
    expect(await filas(e.productId)).toHaveLength(0) // reservar no mueve currentStock
    const caja = await createAreaTicketCheckout(e.venueId, {
      idempotencyKey: `checkout-${randomUUID()}`,
      deviceUid: d.caja,
      staffId: e.staffId,
    })
    await addTicketToCheckout(e.venueId, caja.id, vale.code, {
      idempotencyKey: `claim-${randomUUID()}`,
      deviceUid: d.caja,
      staffId: e.staffId,
    })
    const orden = await materializeAreaTicketCheckout(e.venueId, caja.id, {
      idempotencyKey: `mat-${randomUUID()}`,
      deviceUid: d.caja,
      staffId: e.staffId,
      source: 'AVOQADO_ANDROID',
      normalItems: [{ productId: normal.productId, quantity: 1 }],
    })
    const total = new Prisma.Decimal(orden.order.total)
    const llave = `pago-${randomUUID()}`
    const locked = await prisma.$transaction(tx =>
      lockAreaTicketCheckoutForPayment(tx, {
        venueId: e.venueId,
        orderId: orden.order.id,
        idempotencyKey: llave,
        amount: total,
        method: 'CASH',
      }),
    )
    const pago = await prisma.payment.create({
      data: {
        venueId: e.venueId,
        orderId: orden.order.id,
        processedById: e.staffId,
        amount: total,
        method: 'CASH',
        source: 'APP',
        status: 'COMPLETED',
        feePercentage: D(0),
        feeAmount: D(0),
        netAmount: total,
        idempotencyKey: llave,
      },
    })
    await prisma.order.update({ where: { id: orden.order.id }, data: { paidAmount: total, remainingBalance: D(0), paymentStatus: 'PAID' } })
    await prisma.$transaction(tx =>
      finalizeAreaTicketPaymentInTransaction(tx, {
        venueId: e.venueId,
        orderId: orden.order.id,
        paymentId: pago.id,
        fullyPaid: true,
        staffId: e.staffId,
        locked,
      }),
    )
    expect(await deltas(e.productId)).toEqual(['-2'])
    expect(await deltas(normal.productId)).toEqual(['-1'])
  })
})

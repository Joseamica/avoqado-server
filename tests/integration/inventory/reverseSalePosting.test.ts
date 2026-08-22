/**
 * Devolver el stock de una venta que se canceló.
 *
 * 🔴 POR QUÉ EXISTE: hasta el 2026-08-20, NINGÚN camino de la plataforma devolvía
 * inventario — ni las cancelaciones de delivery ni los reembolsos. Un pedido de Uber
 * cancelado dejaba el stock descontado para siempre: la comida nunca se hizo, pero el
 * sistema decía que los ingredientes se habían gastado. El faltante aparecía semanas después
 * en un conteo físico, sin forma de rastrear de dónde salió.
 *
 * Contra PostgreSQL real, no mockeado: el punto entero es que los LOTES PEPS vuelvan a su
 * cantidad correcta, y eso no se prueba con un mock.
 */
import { BatchStatus, MovementType, Prisma, RawMaterialMovementType, Unit, UnitType } from '@prisma/client'

import prisma from '@/utils/prismaClient'
import { reverseSalePosting } from '@/services/inventory/reverseSalePosting.service'

const N = (v: string | number) => new Prisma.Decimal(v)

describe('reverseSalePosting — devolver el stock de una venta cancelada', () => {
  let venueId: string, orgId: string, orderId: string, postingId: string
  let inventoryId: string, rawMaterialId: string, batchViejoId: string, batchNuevoId: string

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: `Org rev ${Date.now()}`, email: `r${Date.now()}@t.mx`, phone: '5555555555' },
    })
    orgId = org.id
    const v = await prisma.venue.create({ data: { organizationId: orgId, name: `V rev ${Date.now()}`, slug: `vr-${Date.now()}` } })
    venueId = v.id

    const cat = await prisma.menuCategory.create({ data: { venueId, name: 'Cat', slug: `cr-${Date.now()}` } })
    const producto = await prisma.product.create({
      data: { venueId, categoryId: cat.id, name: 'Hamburguesa', sku: `SKU-R-${Date.now()}`, price: '100.00' },
    })
    const inv = await prisma.inventory.create({ data: { productId: producto.id, venueId, currentStock: N(7) } })
    inventoryId = inv.id

    const mp = await prisma.rawMaterial.create({
      data: {
        venueId,
        name: 'Carne',
        sku: `MP-${Date.now()}`,
        currentStock: N(4),
        unit: Unit.KILOGRAM,
        unitType: UnitType.WEIGHT,
        minimumStock: N(0),
        reorderPoint: N(0),
        costPerUnit: N(55),
        avgCostPerUnit: N(55),
      },
    })
    rawMaterialId = mp.id

    // Dos lotes: la venta tomó de los DOS (el viejo se agotó y siguió en el nuevo), que es
    // el caso que de verdad rompe una reversa ingenua.
    const b1 = await prisma.stockBatch.create({
      data: {
        rawMaterialId,
        venueId,
        batchNumber: `B1-${Date.now()}`,
        initialQuantity: N(2),
        remainingQuantity: N(0),
        unit: Unit.KILOGRAM,
        costPerUnit: N(50),
        receivedDate: new Date('2026-08-01'),
        status: BatchStatus.DEPLETED,
        depletedAt: new Date(),
      },
    })
    const b2 = await prisma.stockBatch.create({
      data: {
        rawMaterialId,
        venueId,
        batchNumber: `B2-${Date.now()}`,
        initialQuantity: N(5),
        remainingQuantity: N(4),
        unit: Unit.KILOGRAM,
        costPerUnit: N(60),
        receivedDate: new Date('2026-08-10'),
        status: BatchStatus.ACTIVE,
      },
    })
    batchViejoId = b1.id
    batchNuevoId = b2.id

    const order = await prisma.order.create({
      data: { venueId, orderNumber: `R-${Date.now()}`, total: N(100), subtotal: N(100), taxAmount: N(0), tipAmount: N(0) },
    })
    orderId = order.id

    const posting = await prisma.inventoryPosting.create({
      data: { venueId, sourceKind: 'ORDER', sourceId: orderId, effectKind: 'SALE', orderId, status: 'APPLIED', appliedAt: new Date() },
    })
    postingId = posting.id
    const linea = await prisma.inventoryPostingLine.create({
      data: {
        postingId,
        effectKey: 'l1',
        productId: producto.id,
        expectedQuantityBase: N(3),
        appliedQuantityBase: N(3),
        status: 'APPLIED',
      },
    })

    // Los movimientos que la venta DEJÓ: 3 piezas del producto y 3 kg de carne repartidos
    // entre dos lotes (2 del viejo + 1 del nuevo). Es exactamente lo que la reversa lee.
    await prisma.inventoryMovement.create({
      data: {
        inventoryId,
        type: MovementType.SALE,
        quantity: N(-3),
        previousStock: N(10),
        newStock: N(7),
        postingLineId: linea.id,
        reference: orderId,
      },
    })
    await prisma.rawMaterialMovement.createMany({
      data: [
        {
          rawMaterialId,
          venueId,
          batchId: batchViejoId,
          type: RawMaterialMovementType.USAGE,
          quantity: N(-2),
          unit: Unit.KILOGRAM,
          previousStock: N(7),
          newStock: N(5),
          postingLineId: linea.id,
          reference: orderId,
        },
        {
          rawMaterialId,
          venueId,
          batchId: batchNuevoId,
          type: RawMaterialMovementType.USAGE,
          quantity: N(-1),
          unit: Unit.KILOGRAM,
          previousStock: N(5),
          newStock: N(4),
          postingLineId: linea.id,
          reference: orderId,
        },
      ],
    })
  })

  afterAll(async () => {
    try {
      await prisma.rawMaterialMovement.deleteMany({ where: { venueId } })
      await prisma.inventoryMovement.deleteMany({ where: { inventory: { venueId } } })
      await prisma.inventoryPostingLine.deleteMany({ where: { posting: { venueId } } })
      await prisma.inventoryPosting.deleteMany({ where: { venueId } })
      await prisma.stockBatch.deleteMany({ where: { venueId } })
      await prisma.rawMaterial.deleteMany({ where: { venueId } })
      await prisma.inventory.deleteMany({ where: { venueId } })
      await prisma.order.deleteMany({ where: { venueId } })
      await prisma.product.deleteMany({ where: { venueId } })
      await prisma.menuCategory.deleteMany({ where: { venueId } })
      await prisma.venue.deleteMany({ where: { id: venueId } })
      await prisma.organization.deleteMany({ where: { id: orgId } })
    } catch {
      /* fixtures */
    }
  })

  it('🔴 devuelve el stock del producto Y de la materia prima', async () => {
    const r = await reverseSalePosting({ venueId, orderId, reason: 'pedido cancelado por Uber' })

    expect(r.outcome).toBe('REVERSED')
    expect((await prisma.inventory.findUniqueOrThrow({ where: { id: inventoryId } })).currentStock.toString()).toBe('10') // 7 + 3
    expect((await prisma.rawMaterial.findUniqueOrThrow({ where: { id: rawMaterialId } })).currentStock.toString()).toBe('7') // 4 + 3
  })

  it('🔴 cada LOTE recupera exactamente lo suyo — no todo al primero', async () => {
    // Es el caso que rompe una reversa ingenua: si devuelves los 3 kg al lote activo, el
    // costeo PEPS queda mal para siempre (el lote viejo costaba $50 y el nuevo $60), y el
    // reporte de margen miente sin que nada falle.
    const viejo = await prisma.stockBatch.findUniqueOrThrow({ where: { id: batchViejoId } })
    const nuevo = await prisma.stockBatch.findUniqueOrThrow({ where: { id: batchNuevoId } })

    expect(viejo.remainingQuantity.toString()).toBe('2') // 0 + 2
    expect(nuevo.remainingQuantity.toString()).toBe('5') // 4 + 1
    expect(viejo.status).toBe(BatchStatus.ACTIVE) // dejó de estar agotado
    expect(viejo.depletedAt).toBeNull()
  })

  it('deja rastro: un movimiento POSITIVO por cada deducción, con su motivo', async () => {
    const devoluciones = await prisma.rawMaterialMovement.findMany({
      where: { venueId, type: RawMaterialMovementType.ADJUSTMENT },
    })
    expect(devoluciones).toHaveLength(2)
    expect(devoluciones.every(m => m.quantity.greaterThan(0))).toBe(true)
    expect(devoluciones.every(m => (m.reason ?? '').includes('cancel'))).toBe(true)
  })

  it('🔴 IDEMPOTENTE: revertir dos veces NO devuelve el stock dos veces', async () => {
    // Sin esto, un reintento del webhook infla el inventario — que es el mismo daño que el
    // problema original, en la dirección contraria y más difícil de notar.
    const r = await reverseSalePosting({ venueId, orderId, reason: 'reintento' })

    expect(r.outcome).toBe('ALREADY_REVERSED')
    expect((await prisma.inventory.findUniqueOrThrow({ where: { id: inventoryId } })).currentStock.toString()).toBe('10')
    expect((await prisma.rawMaterial.findUniqueOrThrow({ where: { id: rawMaterialId } })).currentStock.toString()).toBe('7')
  })

  it('una orden sin venta aplicada no es un error: no hay nada que devolver', async () => {
    const otra = await prisma.order.create({
      data: { venueId, orderNumber: `R2-${Date.now()}`, total: N(0), subtotal: N(0), taxAmount: N(0), tipAmount: N(0) },
    })
    const r = await reverseSalePosting({ venueId, orderId: otra.id, reason: 'x' })
    expect(r.outcome).toBe('NOTHING_TO_REVERSE')
  })
})

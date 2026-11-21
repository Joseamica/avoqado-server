import { AreaTicketInventoryReservationMode, InventoryMethod, Prisma, StaffRole, TerminalStatus, TerminalType, Unit } from '@prisma/client'

import { createStockBatch } from '@/services/dashboard/fifoBatch.service'
import {
  addTicketToCheckout,
  createAreaTicketCheckout,
  issueAreaTicket,
  materializeAreaTicketCheckout,
} from '@/services/mobile/areaTicketV7.mobile.service'
import { payCashOrder } from '@/services/mobile/order.mobile.service'
import prisma from '@/utils/prismaClient'
import { encenderIvaPorProducto } from '@tests/__helpers__/iva-por-producto'

/**
 * D5 (pizarrón hz:0555ee15:D5), tabla compartida contra Postgres: con el MISMO inventario, ARMAR la venta de vales y LIQUIDARLA contestan
 * lo mismo (aprueban las dos, o rechazan las dos con el mismo código y el mismo texto). Cada caso corre dos veces sobre un catálogo propio
 * e idéntico: «armar» deja el inventario en el estado del caso y arma; «liquidar» arma con el inventario bien, deja el mismo estado y
 * cobra en efectivo. La columna «liquidar» describe lo que la liquidación ya hacía antes de D5; la columna «armar» es lo nuevo.
 */
type Resultado = { ok: true } | { code: string; message: string }
type Linea = { productId: string; quantity: string }
type Suelto = { productId: string; quantity: number; modifierIds?: string[] }
type Escena = { ajenos?: Linea[]; vales: Linea[]; sueltos: Suelto[]; malo: () => Promise<void>; esperado: Resultado }
type Caso = { nombre: string; sinApartado?: boolean; preparar: (tag: string) => Promise<Escena> }

const libre = (label: string, disponible: string, requerida: string): Resultado => ({
  code: 'AREA_TICKET_INSUFFICIENT_STOCK',
  message: `No hay existencia libre suficiente de "${label}". Disponible: ${disponible}; requerida: ${requerida}.`,
})
const lotesDeLaVenta = (label: string, disponible: string, requerida: string): Resultado => ({
  code: 'AREA_TICKET_INSUFFICIENT_STOCK',
  message: `Los lotes FIFO de "${label}" no cubren la venta. Disponible: ${disponible}; requerida: ${requerida}.`,
})
const RESERVA_SIN_EXISTENCIA: Resultado = {
  code: 'AREA_TICKET_INVENTORY_FINALIZATION_FAILED',
  message: 'La existencia reservada ya no está disponible.',
}
const RESERVA_SIN_LOTES: Resultado = {
  code: 'AREA_TICKET_INVENTORY_FINALIZATION_FAILED',
  message: 'Los lotes FIFO no cubren la reserva del vale.',
}

describe('Vales V7 — D5: armar la venta y liquidarla contestan lo mismo (tabla compartida)', () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  let organizationId: string
  let venueId: string
  let staffId: string
  let categoryId: string
  let jamonId: string
  const issueDeviceUid = `tabla-issue-${suffix}`
  const checkoutDeviceUid = `tabla-caja-${suffix}`

  beforeAll(async () => {
    organizationId = (
      await prisma.organization.create({
        data: { name: `Vales tabla ${suffix}`, email: `vales-tabla-${suffix}@example.com`, phone: '5555555555' },
      })
    ).id
    venueId = (
      await prisma.venue.create({
        data: { organizationId, name: `Vales tabla ${suffix}`, slug: `vales-tabla-${suffix}`, seatCapExempt: true },
      })
    ).id
    await encenderIvaPorProducto(venueId)
    staffId = (
      await prisma.staff.create({ data: { email: `vales-tabla-staff-${suffix}@example.com`, firstName: 'Caja', lastName: 'Tabla' } })
    ).id
    await prisma.staffVenue.create({ data: { staffId, venueId, role: StaffRole.MANAGER } })
    const area = await prisma.fulfillmentArea.create({ data: { venueId, name: `Cocina ${suffix}`, fulfillmentMode: 'HOLD_UNTIL_PAID' } })
    await prisma.terminal.createMany({
      data: [
        {
          venueId,
          name: 'Cocina',
          type: TerminalType.POS_ANDROID,
          status: TerminalStatus.ACTIVE,
          deviceUid: issueDeviceUid,
          fulfillmentAreaId: area.id,
          canIssueAreaTickets: true,
        },
        {
          venueId,
          name: 'Caja',
          type: TerminalType.POS_ANDROID,
          status: TerminalStatus.ACTIVE,
          deviceUid: checkoutDeviceUid,
          canCheckoutAreaTickets: true,
        },
      ],
    })
    await prisma.venueAreaTicketSettings.create({
      data: { venueId, enabled: true, inventoryReservationMode: AreaTicketInventoryReservationMode.HOLD_AVAILABLE_STOCK },
    })
    categoryId = (await prisma.menuCategory.create({ data: { venueId, name: 'Comida', slug: `comida-${suffix}`, availableDays: [] } })).id
    jamonId = await producto('Jamon', InventoryMethod.QUANTITY, '1000')
  })

  afterAll(async () => {
    if (!venueId) return
    await prisma.areaTicketFulfillment.deleteMany({ where: { fulfillmentArea: { venueId } } })
    await prisma.areaTicketPrintAttempt.deleteMany({ where: { areaTicket: { venueId } } })
    await prisma.areaTicketPaymentAttempt.deleteMany({ where: { checkoutSession: { venueId } } })
    await prisma.paymentAllocation.deleteMany({ where: { payment: { venueId } } })
    await prisma.payment.deleteMany({ where: { venueId } })
    await prisma.inventoryPosting.deleteMany({ where: { venueId } })
    await prisma.inventoryMovement.deleteMany({ where: { inventory: { venueId } } })
    await prisma.rawMaterialMovement.deleteMany({ where: { venueId } })
    await prisma.areaTicketInventoryReservation.deleteMany({ where: { venueId } })
    await prisma.stockBatch.deleteMany({ where: { venueId } })
    await prisma.orderDiscount.deleteMany({ where: { order: { venueId } } })
    await prisma.orderItemModifier.deleteMany({ where: { orderItem: { order: { venueId } } } })
    await prisma.orderItem.deleteMany({ where: { order: { venueId } } })
    await prisma.areaTicket.deleteMany({ where: { venueId } })
    await prisma.areaTicketCheckoutSession.deleteMany({ where: { venueId } })
    await prisma.order.deleteMany({ where: { venueId } })
    await prisma.inventory.deleteMany({ where: { venueId } })
    await prisma.modifier.deleteMany({ where: { group: { venueId } } })
    await prisma.modifierGroup.deleteMany({ where: { venueId } })
    await prisma.product.deleteMany({ where: { venueId } })
    await prisma.rawMaterial.deleteMany({ where: { venueId } })
    await prisma.menuCategory.deleteMany({ where: { venueId } })
    await prisma.terminal.deleteMany({ where: { venueId } })
    await prisma.fulfillmentArea.deleteMany({ where: { venueId } })
    await prisma.venueAreaTicketSettings.deleteMany({ where: { venueId } })
    await prisma.staffVenue.deleteMany({ where: { venueId } })
    await prisma.venue.delete({ where: { id: venueId } })
    if (staffId) await prisma.staff.delete({ where: { id: staffId } })
    if (organizationId) await prisma.organization.delete({ where: { id: organizationId } })
    await prisma.$disconnect()
  })

  // ── Catálogo ──
  async function producto(name: string, inventoryMethod: InventoryMethod, stock?: string): Promise<string> {
    const id = (
      await prisma.product.create({
        data: {
          venueId,
          categoryId,
          sku: `${name.toUpperCase()}-${suffix}`,
          name,
          price: new Prisma.Decimal('10.00'),
          taxRate: new Prisma.Decimal(0),
          tags: [],
          allergens: [],
          trackInventory: true,
          inventoryMethod,
          unit: Unit.PIECE,
        },
      })
    ).id
    if (stock != null) await prisma.inventory.create({ data: { venueId, productId: id, currentStock: new Prisma.Decimal(stock) } })
    return id
  }
  const fijarExistencia = (productId: string, stock: string) =>
    prisma.inventory.update({ where: { productId }, data: { currentStock: new Prisma.Decimal(stock) } })
  async function insumo(name: string, stock: string, enLotes: number): Promise<string> {
    const id = (
      await prisma.rawMaterial.create({
        data: {
          venueId,
          name,
          sku: `${name.toUpperCase()}-${suffix}`,
          category: 'OTHER',
          currentStock: new Prisma.Decimal(stock),
          unit: Unit.GRAM,
          unitType: 'WEIGHT',
          minimumStock: new Prisma.Decimal('0'),
          reorderPoint: new Prisma.Decimal('0'),
          costPerUnit: new Prisma.Decimal('0.05'),
          avgCostPerUnit: new Prisma.Decimal('0.05'),
        },
      })
    ).id
    if (enLotes > 0)
      await createStockBatch(venueId, id, { quantity: enLotes, unit: Unit.GRAM, costPerUnit: 0.05, receivedDate: new Date() })
    return id
  }
  /** Deja los lotes ACTIVE de un insumo en `total` gramos (el primero lo lleva todo; el resto, en cero). */
  async function fijarLotes(rawMaterialId: string, total: string) {
    const lotes = await prisma.stockBatch.findMany({ where: { venueId, rawMaterialId }, orderBy: { receivedDate: 'asc' }, take: 10 })
    for (const [i, lote] of lotes.entries())
      await prisma.stockBatch.update({ where: { id: lote.id }, data: { remainingQuantity: new Prisma.Decimal(i === 0 ? total : '0') } })
  }
  async function platillo(name: string, rawMaterialId: string, gramos: string): Promise<string> {
    const id = await producto(name, InventoryMethod.RECIPE)
    await prisma.recipe.create({
      data: {
        productId: id,
        portionYield: 1,
        totalCost: new Prisma.Decimal('1.00'),
        lines: { create: [{ rawMaterialId, quantity: new Prisma.Decimal(gramos), unit: Unit.GRAM, isOptional: false }] },
      },
    })
    return id
  }

  // ── Los dos lados ──
  const emitir = (tag: string, i: number, lineas: Linea[]) =>
    issueAreaTicket(venueId, {
      idempotencyKey: `${tag}-vale-${i}-${suffix}`,
      deviceUid: issueDeviceUid,
      staffId,
      lines: lineas.map((linea, j) => ({ clientLineId: `${tag}-${i}-${j}-${suffix}`, ...linea })),
    })
  const resultado = async (accion: Promise<unknown>): Promise<Resultado> => {
    try {
      await accion
      return { ok: true }
    } catch (error: any) {
      if (!error?.code) throw error
      return { code: error.code, message: error.message }
    }
  }

  async function correr(caso: Caso, numero: number, lado: 'armar' | 'liquidar'): Promise<{ obtenido: Resultado; esperado: Resultado }> {
    // Corto: las llaves de idempotencia llevan el tag y el sufijo, y el servidor acepta hasta 64 caracteres.
    const tag = `c${numero}${lado === 'armar' ? 'a' : 'l'}`
    if (caso.sinApartado) {
      await prisma.venueAreaTicketSettings.update({
        where: { venueId },
        data: { inventoryReservationMode: AreaTicketInventoryReservationMode.NONE },
      })
    }
    try {
      const escena = await caso.preparar(tag)
      for (const [i, ajeno] of (escena.ajenos ?? []).entries()) await emitir(`${tag}-ajeno`, i, [ajeno])
      const vale = await emitir(tag, 0, escena.vales)
      const caja = await createAreaTicketCheckout(venueId, {
        idempotencyKey: `${tag}-caja-${suffix}`,
        deviceUid: checkoutDeviceUid,
        staffId,
      })
      await addTicketToCheckout(venueId, caja.id, vale.code, {
        idempotencyKey: `${tag}-claim-${suffix}`,
        deviceUid: checkoutDeviceUid,
        staffId,
      })
      const armar = () =>
        materializeAreaTicketCheckout(venueId, caja.id, {
          idempotencyKey: `${tag}-armar-${suffix}`,
          deviceUid: checkoutDeviceUid,
          staffId,
          source: 'AVOQADO_ANDROID',
          normalItems: escena.sueltos,
        })
      if (lado === 'armar') {
        await escena.malo()
        return { obtenido: await resultado(armar()), esperado: escena.esperado }
      }
      const armada = await armar()
      await escena.malo()
      const centavos = Math.round(Number(armada.order!.total) * 100)
      const pago = payCashOrder(venueId, armada.order!.id, { amount: centavos, tip: 0, staffId, idempotencyKey: `${tag}-pago-${suffix}` })
      return { obtenido: await resultado(pago), esperado: escena.esperado }
    } finally {
      if (caso.sinApartado) {
        await prisma.venueAreaTicketSettings.update({
          where: { venueId },
          data: { inventoryReservationMode: AreaTicketInventoryReservationMode.HOLD_AVAILABLE_STOCK },
        })
      }
    }
  }

  // ── La tabla (cada `preparar` crea su propio catálogo: los dos lados no se estorban) ──
  const casos: Caso[] = [
    {
      nombre: 'suelto por piezas sin existencia',
      preparar: async tag => {
        const papas = await producto(`Papas ${tag}`, InventoryMethod.QUANTITY, '5')
        return {
          vales: [{ productId: jamonId, quantity: '1' }],
          sueltos: [{ productId: papas, quantity: 2 }],
          malo: async () => void (await fijarExistencia(papas, '1')),
          esperado: libre(`Papas ${tag}`, '1.000', '2.000'),
        }
      },
    },
    {
      nombre: 'suelto con receta: el apartado propio toma primero los lotes',
      preparar: async tag => {
        const queso = await insumo(`Queso ${tag}`, '300', 200)
        const quesadilla = await platillo(`Quesadilla ${tag}`, queso, '100')
        return {
          vales: [{ productId: quesadilla, quantity: '1' }],
          sueltos: [{ productId: quesadilla, quantity: 1 }],
          malo: () => fijarLotes(queso, '190'),
          esperado: lotesDeLaVenta(`Queso ${tag}`, '90.000', '100.000'),
        }
      },
    },
    {
      nombre: 'extra de insumo sin existencia',
      preparar: async tag => {
        const queso = await insumo(`Queso extra ${tag}`, '100', 100)
        const taco = await producto(`Taco ${tag}`, InventoryMethod.QUANTITY, '10')
        const grupo = await prisma.modifierGroup.create({ data: { venueId, name: `Extras ${tag}` } })
        const extra = await prisma.modifier.create({
          data: {
            groupId: grupo.id,
            name: `Con queso ${tag}`,
            price: 5,
            rawMaterialId: queso,
            quantityPerUnit: new Prisma.Decimal('50'),
            unit: Unit.GRAM,
            inventoryMode: 'ADDITION',
          },
        })
        return {
          vales: [{ productId: jamonId, quantity: '1' }],
          sueltos: [{ productId: taco, quantity: 1, modifierIds: [extra.id] }],
          malo: async () =>
            void (await prisma.rawMaterial.update({ where: { id: queso }, data: { currentStock: new Prisma.Decimal('30') } })),
          esperado: libre(`Queso extra ${tag}`, '30.000', '50.000'),
        }
      },
    },
    {
      nombre: 'el apartado de otro vale resta a lo suelto',
      preparar: async tag => {
        const papas = await producto(`Papas ajenas ${tag}`, InventoryMethod.QUANTITY, '4')
        return {
          ajenos: [{ productId: papas, quantity: '2' }],
          vales: [{ productId: jamonId, quantity: '1' }],
          sueltos: [{ productId: papas, quantity: 2 }],
          malo: async () => void (await fijarExistencia(papas, '3')),
          esperado: libre(`Papas ajenas ${tag}`, '1.000', '2.000'),
        }
      },
    },
    {
      nombre: 'apartado propio por piezas sin respaldo',
      preparar: async tag => {
        const papas = await producto(`Papas apartadas ${tag}`, InventoryMethod.QUANTITY, '5')
        return {
          vales: [{ productId: papas, quantity: '2' }],
          sueltos: [],
          malo: async () => void (await fijarExistencia(papas, '1')),
          esperado: RESERVA_SIN_EXISTENCIA,
        }
      },
    },
    {
      nombre: 'apartado propio de insumo sin lotes (lote retenido)',
      preparar: async tag => {
        const queso = await insumo(`Queso retenido ${tag}`, '100', 100)
        const quesadilla = await platillo(`Quesadilla retenida ${tag}`, queso, '100')
        return {
          vales: [{ productId: quesadilla, quantity: '1' }],
          sueltos: [],
          malo: () => fijarLotes(queso, '50'),
          esperado: RESERVA_SIN_LOTES,
        }
      },
    },
    {
      nombre: 'apartado de insumo que quedó en cero',
      preparar: async tag => {
        const queso = await insumo(`Queso cero ${tag}`, '100', 100)
        const quesadilla = await platillo(`Quesadilla cero ${tag}`, queso, '100')
        return {
          vales: [{ productId: quesadilla, quantity: '1' }],
          sueltos: [],
          malo: async () =>
            void (await prisma.areaTicketInventoryReservation.updateMany({
              where: { venueId, inventoryId: queso },
              data: { quantityBaseUnits: new Prisma.Decimal('0') },
            })),
          esperado: RESERVA_SIN_LOTES,
        }
      },
    },
    {
      nombre: 'negocio sin apartado: el producto del propio vale',
      sinApartado: true,
      preparar: async tag => {
        const papas = await producto(`Papas sin apartado ${tag}`, InventoryMethod.QUANTITY, '5')
        return {
          vales: [{ productId: papas, quantity: '2' }],
          sueltos: [],
          malo: async () => void (await fijarExistencia(papas, '1')),
          esperado: libre(`Papas sin apartado ${tag}`, '1.000', '2.000'),
        }
      },
    },
    {
      nombre: 'suelto sin fila de inventario',
      preparar: async tag => {
        const papas = await producto(`Papas sin fila ${tag}`, InventoryMethod.QUANTITY, '5')
        return {
          vales: [{ productId: jamonId, quantity: '1' }],
          sueltos: [{ productId: papas, quantity: 1 }],
          malo: async () => void (await prisma.inventory.delete({ where: { productId: papas } })),
          esperado: { code: 'AREA_TICKET_INVENTORY_MISSING', message: `No existe inventario para "Papas sin fila ${tag}".` },
        }
      },
    },
    {
      nombre: 'existencia justa: las dos aprueban',
      preparar: async tag => {
        const papas = await producto(`Papas justas ${tag}`, InventoryMethod.QUANTITY, '5')
        const queso = await insumo(`Queso justo ${tag}`, '200', 200)
        const quesadilla = await platillo(`Quesadilla justa ${tag}`, queso, '100')
        return {
          vales: [{ productId: quesadilla, quantity: '1' }],
          sueltos: [
            { productId: papas, quantity: 2 },
            { productId: quesadilla, quantity: 1 },
          ],
          malo: async () => void (await fijarExistencia(papas, '2')),
          esperado: { ok: true },
        }
      },
    },
  ]

  for (const [numero, caso] of casos.entries()) {
    for (const lado of ['liquidar', 'armar'] as const) {
      it(`${caso.nombre} · ${lado}`, async () => {
        const { obtenido, esperado } = await correr(caso, numero, lado)
        expect(obtenido).toEqual(esperado)
      })
    }
  }
})

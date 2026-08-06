/**
 * Recepción de MERCANCÍA DE REVENTA (tienda de conveniencia).
 *
 * La prueba central de este archivo es la del DOBLE CONTEO, y conviene entender por
 * qué existe antes de tocar nada.
 *
 * El saldo de un producto de reventa vive en `Inventory.currentStock` y su historia en
 * `InventoryMovement`. Al recibir hay que calcular un DELTA: cuánto sumar o restar. La
 * primera versión lo calculaba contra `PurchaseOrderItem.quantityReceived`, que parece
 * la fuente obvia pero es un METADATO mutable: `receiveNoItems` lo pone en 0 sin tocar
 * el saldo, y `receiveAllItems` acepta correr sobre una orden CANCELLED justo para
 * permitir deshacer esa acción.
 *
 * Con eso, esta secuencia —un solo usuario, tres clics, sin concurrencia— duplicaba la
 * existencia:
 *
 *     recibir 5   → delta = 5 − 0 = +5   → Inventory 0 → 5    ✔
 *     recibir ninguno → quantityReceived = 0, saldo intacto   (queda en 5)
 *     recibir todo → delta = 5 − 0 = +5   → Inventory 5 → 10  ✘  llegaron 5
 *
 * El camino de INSUMOS nunca tuvo este defecto porque su delta sale de los lotes vivos,
 * que son estado real y por tanto autocorrectivo. El arreglo fue darle a la mercancía
 * su equivalente: `InventoryMovement.purchaseOrderItemId`, y derivar lo ya aplicado de
 * la suma de esos movimientos.
 */

import prisma from '@/utils/prismaClient'
import { updatePurchaseOrderItemStatus } from '@/services/dashboard/purchaseOrder.service'
import AppError from '@/errors/AppError'
import { Decimal } from '@prisma/client/runtime/library'
import { MovementType, PurchaseOrderItemStatus } from '@prisma/client'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    purchaseOrderItem: { findFirst: jest.fn(), update: jest.fn() },
    purchaseOrder: { findUnique: jest.fn(), update: jest.fn() },
    inventory: { findFirst: jest.fn(), update: jest.fn() },
    inventoryMovement: { findMany: jest.fn(), create: jest.fn() },
    $transaction: jest.fn(),
  },
}))

jest.mock('@/services/dashboard/activity-log.service', () => ({
  logAction: jest.fn(),
}))

import { logAction } from '@/services/dashboard/activity-log.service'

const mockedPrisma = prisma as unknown as {
  purchaseOrderItem: { findFirst: jest.Mock; update: jest.Mock }
  purchaseOrder: { findUnique: jest.Mock; update: jest.Mock }
  inventory: { findFirst: jest.Mock; update: jest.Mock }
  inventoryMovement: { findMany: jest.Mock; create: jest.Mock }
  $transaction: jest.Mock
}

const VENUE_ID = 'venue-1'
const PO_ID = 'po-1'
const ITEM_ID = 'item-prod-1'
const PRODUCT_ID = 'prod-1'
const INVENTORY_ID = 'inv-1'

function makeProductItem(overrides: Partial<any> = {}) {
  return {
    id: ITEM_ID,
    purchaseOrderId: PO_ID,
    rawMaterialId: null,
    rawMaterial: null,
    productId: PRODUCT_ID,
    product: { id: PRODUCT_ID, name: 'Refresco 600ml', unit: 'PIECE', trackInventory: true },
    quantityOrdered: new Decimal(10),
    quantityReceived: new Decimal(0),
    unit: 'PIECE',
    receiveStatus: PurchaseOrderItemStatus.PENDING,
    unitPrice: new Decimal(12.5),
    total: new Decimal(125),
    presentationName: null,
    presentationFactor: null,
    notes: null,
    batches: [],
    purchaseOrder: { id: PO_ID, orderNumber: 'PO-TIENDA-001' },
    ...overrides,
  }
}

/** Movimiento tal como lo lee el servicio: sólo antes y después. */
function movimiento(previo: number, nuevo: number) {
  return { previousStock: new Decimal(previo), newStock: new Decimal(nuevo) }
}

function wireTransaction() {
  mockedPrisma.$transaction.mockImplementation(async (cb: (tx: any) => Promise<any>) => {
    const tx = {
      purchaseOrderItem: mockedPrisma.purchaseOrderItem,
      purchaseOrder: mockedPrisma.purchaseOrder,
      inventory: mockedPrisma.inventory,
      inventoryMovement: mockedPrisma.inventoryMovement,
    }
    return cb(tx)
  })
}

/** El delta que realmente se le pidió a la base en el `increment`. */
function deltaAplicado(): Decimal {
  const llamada = mockedPrisma.inventory.update.mock.calls[0]
  return new Decimal(llamada[0].data.currentStock.increment)
}

beforeEach(() => {
  jest.clearAllMocks()
  wireTransaction()
  mockedPrisma.purchaseOrder.findUnique.mockResolvedValue({ id: PO_ID, status: 'CONFIRMED', items: [] })
  mockedPrisma.purchaseOrderItem.update.mockResolvedValue({})
  mockedPrisma.inventory.findFirst.mockResolvedValue({ id: INVENTORY_ID, currentStock: new Decimal(0) })
  mockedPrisma.inventory.update.mockResolvedValue({})
  mockedPrisma.inventoryMovement.create.mockResolvedValue({})
  mockedPrisma.inventoryMovement.findMany.mockResolvedValue([])
})

describe('recepción de mercancía de reventa', () => {
  describe('🔴 el delta sale del estado real, no de quantityReceived', () => {
    it('REGRESIÓN: recibir → recibir ninguno → recibir todo NO duplica la existencia', async () => {
      // Paso 3 de la secuencia. `receiveNoItems` ya dejó quantityReceived en 0 SIN
      // revertir el saldo, así que la columna miente: dice "no he recibido nada".
      // El movimiento previo es la verdad: esta línea ya metió 5 a la bodega.
      mockedPrisma.purchaseOrderItem.findFirst.mockResolvedValue(makeProductItem({ quantityReceived: new Decimal(0) }))
      mockedPrisma.inventoryMovement.findMany.mockResolvedValue([movimiento(0, 5)])
      mockedPrisma.inventory.findFirst.mockResolvedValue({ id: INVENTORY_ID, currentStock: new Decimal(5) })

      await updatePurchaseOrderItemStatus(VENUE_ID, PO_ID, ITEM_ID, {
        receiveStatus: PurchaseOrderItemStatus.RECEIVED,
        quantityReceived: 5,
      } as any)

      // Recibir 5 sobre 5 ya aplicados no mueve nada. Si alguien vuelve a derivar el
      // delta de `quantityReceived`, aquí saldría +5 y la bodega quedaría en 10.
      expect(mockedPrisma.inventory.update).not.toHaveBeenCalled()
      expect(mockedPrisma.inventoryMovement.create).not.toHaveBeenCalled()
    })

    it('consulta lo ya aplicado filtrando por ESTE renglón, no por la orden completa', async () => {
      // Filtrar por la orden mezclaría lo aplicado por otros renglones y el delta de
      // cada línea saldría contaminado por sus vecinas.
      mockedPrisma.purchaseOrderItem.findFirst.mockResolvedValue(makeProductItem())

      await updatePurchaseOrderItemStatus(VENUE_ID, PO_ID, ITEM_ID, {
        receiveStatus: PurchaseOrderItemStatus.RECEIVED,
        quantityReceived: 3,
      } as any)

      expect(mockedPrisma.inventoryMovement.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { purchaseOrderItemId: ITEM_ID } }),
      )
    })

    it('suma lo ya aplicado por diferencia de saldos, no por el campo quantity', async () => {
      // `quantity` no tiene convención de signo uniforme entre servicios; cada fila sí
      // lleva su propio antes y después. Dos movimientos: +4 y una reversión de −1.
      mockedPrisma.purchaseOrderItem.findFirst.mockResolvedValue(makeProductItem({ quantityReceived: new Decimal(99) }))
      mockedPrisma.inventoryMovement.findMany.mockResolvedValue([movimiento(0, 4), movimiento(4, 3)])
      mockedPrisma.inventory.findFirst.mockResolvedValue({ id: INVENTORY_ID, currentStock: new Decimal(3) })

      await updatePurchaseOrderItemStatus(VENUE_ID, PO_ID, ITEM_ID, {
        receiveStatus: PurchaseOrderItemStatus.RECEIVED,
        quantityReceived: 10,
      } as any)

      // Ya aplicado = 4 − 1 = 3. Recibir 10 ⇒ delta = 7.
      expect(deltaAplicado().toNumber()).toBe(7)
    })
  })

  describe('camino feliz', () => {
    it('suma la existencia con increment atómico y sella el movimiento contra el renglón', async () => {
      mockedPrisma.purchaseOrderItem.findFirst.mockResolvedValue(makeProductItem())

      await updatePurchaseOrderItemStatus(VENUE_ID, PO_ID, ITEM_ID, {
        receiveStatus: PurchaseOrderItemStatus.RECEIVED,
        quantityReceived: 6,
      } as any)

      const update = mockedPrisma.inventory.update.mock.calls[0][0]
      expect(update.where).toEqual({ id: INVENTORY_ID })
      // Incremento, no asignación: dos recepciones simultáneas no se pisan.
      expect(update.data.currentStock).toHaveProperty('increment')
      expect(new Decimal(update.data.currentStock.increment).toNumber()).toBe(6)

      const mov = mockedPrisma.inventoryMovement.create.mock.calls[0][0].data
      expect(mov.type).toBe(MovementType.PURCHASE)
      // Sin esta liga, la próxima recepción no sabe cuánto puso ya esta línea.
      expect(mov.purchaseOrderItemId).toBe(ITEM_ID)
      expect(mov.unitCost.toString()).toBe('12.5') // pesos, 1:1
    })

    it('busca el inventario filtrando también por venue (aislamiento de inquilino)', async () => {
      mockedPrisma.purchaseOrderItem.findFirst.mockResolvedValue(makeProductItem())

      await updatePurchaseOrderItemStatus(VENUE_ID, PO_ID, ITEM_ID, {
        receiveStatus: PurchaseOrderItemStatus.RECEIVED,
        quantityReceived: 2,
      } as any)

      expect(mockedPrisma.inventory.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { productId: PRODUCT_ID, venueId: VENUE_ID } }),
      )
    })

    it('escribe la bitácora de auditoría (ActivityLog), no sólo el movimiento de inventario', async () => {
      // El movimiento vive en una tabla siloed que la pantalla de auditoría del dueño
      // NO lee. Sin este registro, entra mercancía y se mueve dinero sin rastro ahí.
      mockedPrisma.purchaseOrderItem.findFirst.mockResolvedValue(makeProductItem())

      await updatePurchaseOrderItemStatus(VENUE_ID, PO_ID, ITEM_ID, {
        receiveStatus: PurchaseOrderItemStatus.RECEIVED,
        quantityReceived: 2,
      } as any)

      expect(logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'PURCHASE_ORDER_ITEM_RECEIVED',
          venueId: VENUE_ID,
          data: expect.objectContaining({ productId: PRODUCT_ID, purchaseOrderItemId: ITEM_ID }),
        }),
      )
    })
  })

  describe('reversiones', () => {
    it('marcar como DAÑADO devuelve la existencia y lo registra como LOSS, no como ajuste genérico', async () => {
      // Si sale como ADJUSTMENT, un reporte de mermas nunca ve la mercancía que llegó
      // rota. El camino de insumos usa SPOILAGE; éste es su equivalente.
      mockedPrisma.purchaseOrderItem.findFirst.mockResolvedValue(makeProductItem({ quantityReceived: new Decimal(4) }))
      mockedPrisma.inventoryMovement.findMany.mockResolvedValue([movimiento(0, 4)])
      mockedPrisma.inventory.findFirst.mockResolvedValue({ id: INVENTORY_ID, currentStock: new Decimal(4) })

      await updatePurchaseOrderItemStatus(VENUE_ID, PO_ID, ITEM_ID, {
        receiveStatus: PurchaseOrderItemStatus.DAMAGED,
      } as any)

      expect(deltaAplicado().toNumber()).toBe(-4)
      expect(mockedPrisma.inventoryMovement.create.mock.calls[0][0].data.type).toBe(MovementType.LOSS)
    })

    it('recibir menos de lo ya aplicado devuelve la diferencia al almacén', async () => {
      mockedPrisma.purchaseOrderItem.findFirst.mockResolvedValue(makeProductItem({ quantityReceived: new Decimal(5) }))
      mockedPrisma.inventoryMovement.findMany.mockResolvedValue([movimiento(0, 5)])
      mockedPrisma.inventory.findFirst.mockResolvedValue({ id: INVENTORY_ID, currentStock: new Decimal(5) })

      await updatePurchaseOrderItemStatus(VENUE_ID, PO_ID, ITEM_ID, {
        receiveStatus: PurchaseOrderItemStatus.RECEIVED,
        quantityReceived: 3,
      } as any)

      expect(deltaAplicado().toNumber()).toBe(-2)
      expect(mockedPrisma.inventoryMovement.create.mock.calls[0][0].data.type).toBe(MovementType.ADJUSTMENT)
    })
  })

  describe('guardas', () => {
    it('rechaza recibir más de lo ordenado', async () => {
      mockedPrisma.purchaseOrderItem.findFirst.mockResolvedValue(makeProductItem())

      await expect(
        updatePurchaseOrderItemStatus(VENUE_ID, PO_ID, ITEM_ID, {
          receiveStatus: PurchaseOrderItemStatus.RECEIVED,
          quantityReceived: 11, // ordenado: 10
        } as any),
      ).rejects.toThrow(AppError)

      expect(mockedPrisma.inventory.update).not.toHaveBeenCalled()
    })

    it('rechaza un producto sin control de inventario en vez de crearle la fila por atrás', async () => {
      // Crearla aquí haría que el punto de venta empiece a BLOQUEAR sus ventas por
      // falta de existencia: se le rompe la caja a un cliente que no pidió nada.
      mockedPrisma.purchaseOrderItem.findFirst.mockResolvedValue(
        makeProductItem({ product: { id: PRODUCT_ID, name: 'Refresco 600ml', unit: 'PIECE', trackInventory: false } }),
      )

      await expect(
        updatePurchaseOrderItemStatus(VENUE_ID, PO_ID, ITEM_ID, {
          receiveStatus: PurchaseOrderItemStatus.RECEIVED,
          quantityReceived: 2,
        } as any),
      ).rejects.toThrow(/control de inventario/i)

      expect(mockedPrisma.inventory.update).not.toHaveBeenCalled()
    })

    it('rechaza una unidad que no coincide con la del producto', async () => {
      mockedPrisma.purchaseOrderItem.findFirst.mockResolvedValue(makeProductItem({ unit: 'KILOGRAM' }))

      await expect(
        updatePurchaseOrderItemStatus(VENUE_ID, PO_ID, ITEM_ID, {
          receiveStatus: PurchaseOrderItemStatus.RECEIVED,
          quantityReceived: 2,
        } as any),
      ).rejects.toThrow(/unidad/i)
    })

    it('rechaza presentaciones de compra: valuarlas mal descuadraría el inventario', async () => {
      mockedPrisma.purchaseOrderItem.findFirst.mockResolvedValue(
        makeProductItem({ presentationName: 'caja', presentationFactor: new Decimal(24) }),
      )

      await expect(
        updatePurchaseOrderItemStatus(VENUE_ID, PO_ID, ITEM_ID, {
          receiveStatus: PurchaseOrderItemStatus.RECEIVED,
          quantityReceived: 2,
        } as any),
      ).rejects.toThrow(/presentaci/i)
    })

    it('falla claro si el producto no tiene inventario inicializado en la sucursal', async () => {
      mockedPrisma.purchaseOrderItem.findFirst.mockResolvedValue(makeProductItem())
      mockedPrisma.inventory.findFirst.mockResolvedValue(null)

      await expect(
        updatePurchaseOrderItemStatus(VENUE_ID, PO_ID, ITEM_ID, {
          receiveStatus: PurchaseOrderItemStatus.RECEIVED,
          quantityReceived: 2,
        } as any),
      ).rejects.toThrow(/inventario inicializado/i)
    })
  })

  describe('regresión: el camino de insumos no se toca', () => {
    it('un renglón de insumo NO entra al camino de producto', async () => {
      mockedPrisma.purchaseOrderItem.findFirst.mockResolvedValue(
        makeProductItem({
          productId: null,
          product: null,
          rawMaterialId: 'rm-1',
          rawMaterial: {
            id: 'rm-1',
            name: 'Harina',
            unit: 'KILOGRAM',
            currentStock: new Decimal(0),
            perishable: false,
            shelfLifeDays: null,
          },
        }),
      )

      // Sin los mocks de stockBatch/rawMaterial este camino truena — y eso es
      // justamente la prueba de que se fue por el otro lado.
      await expect(
        updatePurchaseOrderItemStatus(VENUE_ID, PO_ID, ITEM_ID, {
          receiveStatus: PurchaseOrderItemStatus.RECEIVED,
          quantityReceived: 2,
        } as any),
      ).rejects.toThrow()

      expect(mockedPrisma.inventory.update).not.toHaveBeenCalled()
      expect(mockedPrisma.inventoryMovement.create).not.toHaveBeenCalled()
    })
  })
})

import prisma from '../../utils/prismaClient'
import AppError from '../../errors/AppError'
import { Prisma, MovementType } from '@prisma/client'
import logger from '../../config/logger'
import { logAction } from './activity-log.service'

/**
 * Product Inventory Service
 *
 * Manages simple count-based inventory for products with inventoryMethod='QUANTITY'.
 * Uses Inventory table (NOT RawMaterial/StockBatch - those are for ingredients).
 *
 * Key differences from RawMaterial:
 * - No FIFO batches (single stock record per product)
 * - No batch tracking (simpler model)
 * - Direct stock adjustments (no batch creation)
 * - Uses InventoryMovement (not RawMaterialMovement)
 */

export interface AdjustInventoryStockDto {
  type: MovementType
  quantity: number // Positive for additions, negative for reductions
  reason?: string
  reference?: string
  unitCost?: number // Cost per unit for this movement (for PURCHASE)
  supplier?: string // Supplier name for this movement (for PURCHASE)
}

/**
 * Datos de un ajuste dentro de una transacción ajena. Igual que
 * `AdjustInventoryStockDto`, pero `quantity` y `unitCost` aceptan también
 * `Prisma.Decimal` para quien ya trae cantidades exactas (la merma del POS).
 */
type StockAdjustmentInTx = Omit<AdjustInventoryStockDto, 'quantity' | 'unitCost'> & {
  quantity: number | Prisma.Decimal
  unitCost?: number | Prisma.Decimal
}

/**
 * El cuerpo transaccional de `adjustInventoryStock`, extraído para que otro
 * servicio (la merma desde el POS) descuente el producto DENTRO de su propia
 * transacción. Sin `waste`, escribe exactamente el mismo movimiento que antes.
 * Con `waste`, el movimiento se liga al folio de merma (`wasteReportId`), toma
 * su `createdAt` y su costo congelado (`unitCostSnapshot`).
 */
export async function adjustInventoryStockInTx(
  tx: Prisma.TransactionClient,
  productId: string,
  inventory: { id: string; lastCountedAt: Date | null },
  data: StockAdjustmentInTx,
  staffId?: string,
  waste?: { reportId: string; createdAt: Date; unitCostSnapshot: Prisma.Decimal | null },
): Promise<{ previousStock: Prisma.Decimal; newStock: Prisma.Decimal }> {
  const updated = await tx.inventory.update({
    where: { id: inventory.id },
    data: {
      currentStock: { increment: data.quantity },
      lastCountedAt: data.type === 'COUNT' ? new Date() : inventory.lastCountedAt,
    },
  })

  const newStock = updated.currentStock
  const previousStock = newStock.sub(data.quantity)

  // La VENTA deja stock negativo a propósito (Square-parity 2026-08-12), así
  // que un producto en −3 tiene que poderse CORREGIR con ajustes manuales en
  // ambas direcciones. Lo único que sigue prohibido es que un ajuste manual
  // lleve un stock ≥ 0 a negativo — eso es un typo, no una corrección; el
  // camino legítimo hacia negativo es la venta. El throw dentro de la tx
  // revierte el increment.
  if (newStock.lessThan(0) && previousStock.greaterThanOrEqualTo(0)) {
    throw new AppError(`Insufficient stock. Current: ${previousStock}, Requested adjustment: ${data.quantity}`, 400)
  }

  await tx.inventoryMovement.create({
    data: {
      inventoryId: inventory.id,
      type: data.type,
      quantity: new Prisma.Decimal(data.quantity),
      previousStock,
      newStock,
      reason: data.reason,
      reference: data.reference,
      unitCost: waste ? waste.unitCostSnapshot : data.unitCost ? new Prisma.Decimal(data.unitCost) : undefined,
      supplier: data.supplier,
      createdBy: staffId,
      // Sólo la merma agrega estas llaves: sin `waste` el objeto queda idéntico
      // al de siempre (ni siquiera con `undefined`).
      ...(waste ? { wasteReportId: waste.reportId, createdAt: waste.createdAt } : {}),
    },
  })

  // Update Product.cost if this is a PURCHASE with unitCost
  if (data.type === 'PURCHASE' && data.unitCost) {
    await tx.product.update({
      where: { id: productId },
      data: {
        cost: new Prisma.Decimal(data.unitCost),
      },
    })
  }

  return { previousStock, newStock }
}

/**
 * Adjust stock for a product with QUANTITY tracking
 */
export async function adjustInventoryStock(
  venueId: string,
  productId: string,
  data: AdjustInventoryStockDto,
  staffId?: string,
): Promise<{ currentStock: number; minimumStock: number; reservedStock: number }> {
  // Verify product exists and has QUANTITY tracking
  const product = await prisma.product.findFirst({
    where: { id: productId, venueId },
    include: { inventory: true },
  })

  if (!product) {
    throw new AppError(`Product with ID ${productId} not found`, 404)
  }

  if (!product.trackInventory || product.inventoryMethod !== 'QUANTITY') {
    throw new AppError(`Product ${productId} does not use QUANTITY tracking`, 400)
  }

  if (!product.inventory) {
    throw new AppError(`Product ${productId} has no inventory record`, 404)
  }

  const inventory = product.inventory

  // 🔴 INCREMENTO ATÓMICO + guardia calculada sobre el RESULTADO (fase 3,
  // 2026-08-13). Antes esto leía `currentStock` FUERA de la transacción y
  // escribía `previousStock + qty` como valor absoluto: un ajuste concurrente
  // con una venta (o con otro ajuste) se pisaba en silencio (lost update).
  // `increment` delega la suma a la base; previousStock/newStock del kardex se
  // derivan del resultado del update, así la cadena previousStock[i] ==
  // newStock[i-1] no miente bajo concurrencia.
  const { previousStock, newStock } = await prisma.$transaction(tx => adjustInventoryStockInTx(tx, productId, inventory, data, staffId))

  logger.info(`✅ Inventory adjusted for product ${productId}: ${previousStock} → ${newStock}`, {
    venueId,
    productId,
    productName: product.name,
    previousStock: previousStock.toNumber(),
    newStock: newStock.toNumber(),
    quantity: data.quantity,
    type: data.type,
  })

  logAction({
    staffId,
    venueId,
    action: 'PRODUCT_STOCK_ADJUSTED',
    entity: 'Product',
    entityId: productId,
    data: { name: product.name, quantity: data.quantity, type: data.type },
  })

  return {
    currentStock: newStock.toNumber(),
    minimumStock: inventory.minimumStock.toNumber(),
    reservedStock: inventory.reservedStock.toNumber(),
  }
}

/**
 * Get stock movements for a product with QUANTITY tracking
 */
export async function getInventoryMovements(venueId: string, productId: string) {
  // Verify product exists and has QUANTITY tracking
  const product = await prisma.product.findFirst({
    where: { id: productId, venueId },
    include: { inventory: true },
  })

  if (!product) {
    throw new AppError(`Product with ID ${productId} not found`, 404)
  }

  if (!product.inventory) {
    throw new AppError(`Product ${productId} has no inventory record`, 404)
  }

  // Fetch movements ordered by most recent first
  const movements = await prisma.inventoryMovement.findMany({
    where: {
      inventoryId: product.inventory.id,
    },
    orderBy: {
      createdAt: 'desc',
    },
    take: 100, // Limit to last 100 movements
  })

  logger.info(`📊 Fetched ${movements.length} inventory movements for product ${productId}`, {
    venueId,
    productId,
    productName: product.name,
    movementCount: movements.length,
  })

  return movements.map(m => ({
    id: m.id,
    type: m.type,
    quantity: m.quantity.toNumber(),
    previousStock: m.previousStock.toNumber(),
    newStock: m.newStock.toNumber(),
    reason: m.reason,
    reference: m.reference,
    createdBy: m.createdBy,
    createdAt: m.createdAt,
  }))
}

/**
 * Lo que el Historial lee del folio de merma de cada movimiento (spec §4.6).
 * `rawMovements` / `productMovements` traen UN solo id — el primero del folio — para
 * saber en qué renglón va el excedente sin repetirlo (ver `wasteHistoryFields`).
 */
const WASTE_REPORT_FOR_HISTORY = {
  reasonCode: true,
  unrecordedQuantity: true,
  rawMovements: { select: { id: true }, orderBy: { id: 'asc' }, take: 1 },
  productMovements: { select: { id: true }, orderBy: { id: 'asc' }, take: 1 },
} satisfies Prisma.InventoryWasteReportSelect

/** Lo mínimo que hace falta del folio para `wasteHistoryFields`: motivo, excedente y el ancla (el
 *  primer movimiento del folio) de la tabla de hijos que corresponda. El Historial trae las dos; el
 *  export del kardex de un insumo sólo `rawMovements`. */
type WasteReportAnchor = {
  reasonCode: string | null
  unrecordedQuantity: Prisma.Decimal
} & Partial<Record<'rawMovements' | 'productMovements', { id: string }[]>>

/**
 * Campos ADITIVOS del Historial (y del export del kardex, Codex P3-2) para los movimientos de merma
 * con folio; `null` en todo lo demás.
 *
 * `wasteUnrecorded` es del FOLIO, no del movimiento: una merma de insumo que tocó dos lotes deja
 * dos movimientos, y repetir el excedente en los dos lo contaría doble. Va sólo en el primer
 * movimiento del folio (el de menor id); en sus hermanos es `null` — agrupar por `wasteReportId`.
 */
export function wasteHistoryFields(
  movementId: string,
  wasteReportId: string | null,
  report: WasteReportAnchor | null,
  children: 'rawMovements' | 'productMovements',
): { wasteReportId: string | null; wasteReasonCode: string | null; wasteUnrecorded: number | null } {
  if (!wasteReportId || !report) {
    return { wasteReportId: null, wasteReasonCode: null, wasteUnrecorded: null }
  }
  const anchorId = report[children]?.[0]?.id
  return {
    wasteReportId,
    wasteReasonCode: report.reasonCode,
    wasteUnrecorded: anchorId === movementId ? report.unrecordedQuantity.toNumber() : null,
  }
}

/**
 * Get unified global inventory movements (Products + Raw Materials)
 */
export async function getGlobalMovements(
  venueId: string,
  query: {
    page: number
    limit: number
    search?: string
    startDate?: string // ISO string
    endDate?: string // ISO string
    type?: string
  },
) {
  const { page, limit, search, startDate, endDate, type } = query
  const _skip = (page - 1) * limit

  // 1. Build where clauses
  const dateFilter =
    startDate && endDate
      ? {
          createdAt: {
            gte: new Date(startDate),
            lte: new Date(endDate),
          },
        }
      : {}

  // Filtro por tipo. La UI habla en su propio vocabulario ("RECEIVED") y cada
  // tabla tiene su enum: productos usan `MovementType`, insumos
  // `RawMaterialMovementType`. Traducir por tabla NO es opcional:
  //   - `RECEIVED` no existe en NINGUNO de los dos: en ambos se llama PURCHASE.
  //     Mandarlo crudo a los insumos hacía que Prisma rechazara la consulta y
  //     el historial reventara en vez de filtrar.
  //   - `SALE` no existe en insumos (no se venden, se consumen) → sin resultados.
  //   - `WASTE` es LOSS en productos y SPOILAGE en insumos.
  const wanted = type && type !== 'ALL' ? type : null

  const productTypeFilter = (() => {
    if (!wanted) return {}
    const map: Record<string, string | null> = { RECEIVED: 'PURCHASE', WASTE: 'LOSS', RETURN: null }
    const mapped = wanted in map ? map[wanted] : wanted
    // Un tipo que este lado no conoce (p. ej. RETURN, que sólo existe en
    // insumos) NO puede quedar sin filtro: eso devolvía el historial completo.
    return mapped ? { type: mapped as any } : { id: { in: [] as string[] } }
  })()

  const rawMaterialTypeFilter = (() => {
    if (!wanted) return {}
    const map: Record<string, string | null> = { RECEIVED: 'PURCHASE', WASTE: 'SPOILAGE', SALE: null }
    const mapped = wanted in map ? map[wanted] : wanted
    return mapped ? { type: mapped as any } : { id: { in: [] as string[] } }
  })()

  // 2. Fetch InventoryMovements (Products)
  const productMovementsPromise = prisma.inventoryMovement.findMany({
    where: {
      inventory: {
        venueId,
        product: search
          ? {
              OR: [{ name: { contains: search, mode: 'insensitive' } }, { sku: { contains: search, mode: 'insensitive' } }],
            }
          : undefined,
      },
      ...dateFilter,
      ...productTypeFilter,
    },
    include: {
      inventory: {
        include: {
          product: true,
        },
      },
      wasteReport: { select: WASTE_REPORT_FOR_HISTORY },
    },
    orderBy: { createdAt: 'desc' },
    take: limit * page, // Fetch up to current page depth to ensure correct merge sort
  })

  // 3. Fetch RawMaterialMovements (Ingredients)
  const rawMaterialMovementsPromise = prisma.rawMaterialMovement.findMany({
    where: {
      venueId,
      rawMaterial: search
        ? {
            OR: [{ name: { contains: search, mode: 'insensitive' } }, { sku: { contains: search, mode: 'insensitive' } }],
          }
        : undefined,
      ...dateFilter,
      ...rawMaterialTypeFilter,
    },
    include: {
      rawMaterial: true,
      // El proveedor sólo se puede saber por el lote que entró con una orden de
      // compra. La columna "Proveedor" del dashboard lo esperaba y el backend
      // nunca lo mandaba, así que TODO salía "Sin proveedor".
      batch: { include: { purchaseOrderItem: { include: { purchaseOrder: { include: { supplier: true } } } } } },
      wasteReport: { select: WASTE_REPORT_FOR_HISTORY },
    },
    orderBy: { createdAt: 'desc' },
    take: limit * page,
  })

  // Totales REALES. Antes se devolvía el literal 1000 ("Dummy total"), así que
  // la UI paginaba sobre un número inventado y no había forma de saber cuántos
  // movimientos existían de verdad.
  const productCountPromise = prisma.inventoryMovement.count({
    where: {
      inventory: {
        venueId,
        product: search
          ? { OR: [{ name: { contains: search, mode: 'insensitive' } }, { sku: { contains: search, mode: 'insensitive' } }] }
          : undefined,
      },
      ...dateFilter,
      ...productTypeFilter,
    },
  })

  const rawMaterialCountPromise = prisma.rawMaterialMovement.count({
    where: {
      venueId,
      rawMaterial: search
        ? { OR: [{ name: { contains: search, mode: 'insensitive' } }, { sku: { contains: search, mode: 'insensitive' } }] }
        : undefined,
      ...dateFilter,
      ...rawMaterialTypeFilter,
    },
  })

  const [productMovements, rawMaterialMovements, productCount, rawMaterialCount] = await Promise.all([
    productMovementsPromise,
    rawMaterialMovementsPromise,
    productCountPromise,
    rawMaterialCountPromise,
  ])

  // 4. Normalize and Merge
  const combined = [
    ...productMovements.map(m => ({
      id: m.id,
      createdAt: m.createdAt,
      itemName: m.inventory.product.name,
      sku: m.inventory.product.sku,
      category: 'PRODUCT',
      type: m.type,
      quantity: m.quantity.toNumber(),
      unit: m.inventory.product.unit || 'UNIT',
      cost: m.inventory.product.cost?.toNumber() || 0,
      // CON SIGNO. Con `Math.abs` perder 10 cervezas y comprar 10 se veían
      // idénticos en la columna de costo — el historial no distinguía una
      // merma de una entrada.
      // Una merma CON folio usa el costo que congeló el folio (`unitCost` del
      // movimiento), no el costo actual; sin costo congelado es `null` =
      // «sin valorar», nunca un costo inventado. Lo demás queda como hoy.
      totalCost: m.wasteReportId
        ? m.unitCost === null
          ? null
          : m.unitCost.mul(m.quantity).toNumber() // en Decimal: 1.15 × −3 es −3.45, no −3.4499999999999997
        : (m.inventory.product.cost?.toNumber() || 0) * m.quantity.toNumber(),
      ...wasteHistoryFields(m.id, m.wasteReportId, m.wasteReport, 'productMovements'),
      // Un movimiento de PRODUCTO no cuelga de una orden de compra, así que no
      // hay proveedor que mostrar. Se declara `null` en vez de omitirlo: la UI
      // pinta "Sin proveedor" a propósito, no por un campo que nunca llegó.
      supplierName: null as string | null,
      reason: m.reason,
      reference: m.reference,
      previousStock: m.previousStock.toNumber(),
      newStock: m.newStock.toNumber(),
      createdBy: m.createdBy,
    })),
    ...rawMaterialMovements.map(m => ({
      id: m.id,
      createdAt: m.createdAt,
      itemName: m.rawMaterial.name,
      sku: m.rawMaterial.sku,
      category: 'INGREDIENT',
      type: m.type,
      quantity: m.quantity.toNumber(),
      unit: m.unit,
      cost: m.rawMaterial.costPerUnit.toNumber(),
      // `costImpact` ya viene firmado desde el movimiento; si falta, se deriva
      // de la cantidad (que también lleva signo). Una merma CON folio usa SÓLO
      // el costo del propio movimiento (su lote): el ajuste directo sin lotes no
      // tiene costo y sale `null` = «sin valorar», sin inventarle el costo actual.
      totalCost: m.wasteReportId
        ? (m.costImpact?.toNumber() ?? null)
        : (m.costImpact?.toNumber() ?? m.rawMaterial.costPerUnit.toNumber() * m.quantity.toNumber()),
      supplierName: (m as any).batch?.purchaseOrderItem?.purchaseOrder?.supplier?.name ?? null,
      reason: m.reason,
      reference: m.reference,
      previousStock: m.previousStock.toNumber(),
      newStock: m.newStock.toNumber(),
      createdBy: m.createdBy,
      ...wasteHistoryFields(m.id, m.wasteReportId, m.wasteReport, 'rawMovements'),
    })),
  ]

  // 5. Sort and Paginate in memory (since we merged sources)
  // Note: For large datasets this isn't efficient, but for typical "history view" it's acceptable.
  // Proper solution would be SQL UNION query or a dedicated history table.
  combined.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())

  // Slice correct page window
  const startIndex = (page - 1) * limit
  const paginated = combined.slice(startIndex, startIndex + limit)

  return {
    data: paginated,
    meta: {
      total: productCount + rawMaterialCount,
      page,
      limit,
    },
  }
}

/**
 * Set minimum stock threshold for a product with QUANTITY tracking
 */
export async function setMinimumStock(venueId: string, productId: string, minimum: number) {
  return prisma.inventory.update({
    where: {
      productId,
      product: { venueId },
    },
    data: {
      minimumStock: minimum,
    },
  })
}

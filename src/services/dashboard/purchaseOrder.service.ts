import {
  BatchStatus,
  PurchaseOrder,
  PurchaseOrderStatus,
  PurchaseOrderItemStatus,
  RawMaterialMovementType,
  MovementType,
  Prisma,
  Unit,
} from '@prisma/client'
import prisma from '../../utils/prismaClient'
import AppError from '../../errors/AppError'
import {
  CreatePurchaseOrderDto,
  UpdatePurchaseOrderDto,
  ReceivePurchaseOrderDto,
  UpdatePurchaseOrderFeesDto,
  UpdatePurchaseOrderItemStatusDto,
  ReceiveAllItemsDto,
  ReceiveNoItemsDto,
} from '../../schemas/dashboard/inventory.schema'
import { Decimal } from '@prisma/client/runtime/library'
import { createStockBatch } from './fifoBatch.service'
import { areUnitsCompatible, convertUnit } from '../../utils/unitConversion'
import { sendPurchaseOrderEmail } from '../resend.service'
import logger from '@/config/logger'
import PDFDocument from 'pdfkit'
import { renderLabelsPdf, getUnitAbbreviation, type LabelItem } from '../labels/labelPdfRenderer'
import { logAction } from './activity-log.service'

/**
 * Un renglón de orden de compra apunta a UN insumo de cocina O a UN producto de
 * reventa, nunca a los dos. Son dos sistemas de inventario paralelos que ya existían:
 *
 *   · RawMaterial → StockBatch (lotes PEPS con caducidad) → RawMaterialMovement
 *   · Product     → Inventory  (saldo simple)             → InventoryMovement
 *
 * Este resolvedor es el ÚNICO lugar donde se decide cuál de los dos es. Todo lo demás
 * —validaciones, mensajes de error, PDF, etiquetas, correo al proveedor— consume el
 * resultado y deja de preguntar por `.rawMaterial` directamente. Sin esto, cada punto
 * del archivo tendría su propio `if (item.rawMaterial)` y tarde o temprano uno se
 * olvidaría, dejando la mercancía de tienda fuera en silencio.
 *
 * Devuelve una unión discriminada a propósito: obliga a TypeScript a exigir que cada
 * consumidor contemple los dos casos.
 */
type LineTargetBase = {
  id: string
  name: string
  sku: string
  gtin: string | null
  unit: Unit
}
export type LineTarget = (LineTargetBase & { kind: 'RAW_MATERIAL' }) | (LineTargetBase & { kind: 'PRODUCT' })

/**
 * Ambas relaciones son OBLIGATORIAS en el tipo (`| null`, no `?`) a propósito.
 *
 * Cuando eran opcionales, una consulta que olvidara `product: true` en su `include`
 * seguía compilando: `line.product` quedaba en `undefined`, el resolvedor caía hasta
 * su `throw` final y devolvía "el renglón no apunta a nada" para datos que estaban
 * perfectamente bien. Pasó en DOS lugares a la vez —las etiquetas y el PDF que se le
 * manda al proveedor— y en ambos rompía la orden COMPLETA, insumos incluidos.
 *
 * Al exigirlas, quien llame a `resolveLineTarget` sin haber cargado las dos relaciones
 * no compila. El compilador pasa a ser la defensa, en vez de la disciplina.
 */
type ResolvableLine = {
  id?: string
  rawMaterial: { id: string; name: string; sku: string; gtin: string | null; unit: Unit } | null
  product: { id: string; name: string; sku: string; gtin: string | null; unit: Unit | null } | null
}

/**
 * Resuelve a qué apunta un renglón. Lanza si no apunta a nada o si apunta a los dos:
 * ambos casos son datos corruptos, no estados válidos que el resto deba tolerar.
 */
export function resolveLineTarget(line: ResolvableLine): LineTarget {
  const tieneInsumo = !!line.rawMaterial
  const tieneProducto = !!line.product

  if (tieneInsumo && tieneProducto) {
    throw new AppError(`El renglón ${line.id ?? ''} apunta a un insumo y a un producto a la vez. Sólo puede ser uno.`, 400)
  }

  if (line.rawMaterial) {
    const rm = line.rawMaterial
    return { kind: 'RAW_MATERIAL', id: rm.id, name: rm.name, sku: rm.sku, gtin: rm.gtin, unit: rm.unit }
  }

  if (line.product) {
    const p = line.product
    // `Product.unit` es opcional en el esquema (un producto puede no rastrear
    // inventario). Para comprarlo SÍ se necesita: sin unidad no se sabe qué se está
    // recibiendo ni cómo valuarlo.
    if (!p.unit) {
      throw new AppError(`El producto "${p.name}" no tiene unidad de medida configurada y no se puede incluir en una orden de compra.`, 400)
    }
    return { kind: 'PRODUCT', id: p.id, name: p.name, sku: p.sku, gtin: p.gtin, unit: p.unit }
  }

  throw new AppError(`El renglón ${line.id ?? ''} no apunta a ningún insumo ni producto.`, 400)
}

/**
 * Los totales de una orden de compra, calculados en UN SOLO lugar.
 *
 * Existía por triplicado —al crear, al editar y al cambiar impuestos— y los tres
 * divergieron: el de editar se saltaba la comisión, así que editar los renglones de
 * una orden con comisión le borraba ese dinero del total sin avisar. Una fórmula de
 * dinero repetida en tres sitios acaba discrepando siempre; la pregunta es cuándo.
 *
 * Todo en PESOS, 1:1, con Decimal. Nunca float.
 */
export function calcularTotalesDeOrden(
  subtotal: Decimal,
  taxRate: Decimal | number,
  commissionRate: Decimal | number | null | undefined,
): { taxAmount: Decimal; commission: Decimal; totalAmount: Decimal } {
  const taxAmount = subtotal.mul(taxRate)
  const commission = subtotal.mul(commissionRate ?? 0)
  return { taxAmount, commission, totalAmount: subtotal.add(taxAmount).add(commission) }
}

/**
 * Verifica que cada renglón apunte a un insumo o producto que EXISTE y pertenece a
 * ESTE venue, y que un producto de reventa sea comprable.
 *
 * Lo usan crear Y editar. Antes sólo lo hacía crear, así que editar una orden podía
 * conectar el insumo o el producto de OTRO local: el aislamiento entre inquilinos
 * dependía de que nadie mandara un id ajeno. Al ser una sola función, cualquier ruta
 * que la llame hereda la validación completa.
 *
 * Se comparan CONJUNTOS de ids únicos, no longitudes de arreglo. La versión anterior
 * comparaba `findMany().length` contra `items.length`, así que repetir el mismo insumo
 * en dos renglones respondía "Some raw materials not found" y mandaba al usuario a
 * buscar un insumo que sí existía. Ahora el mensaje nombra qué id no se encontró.
 */
async function verificarRenglonesDelVenue(venueId: string, items: Array<{ rawMaterialId?: string; productId?: string }>): Promise<void> {
  const rawMaterialIds = [...new Set(items.map(i => i.rawMaterialId).filter((v): v is string => !!v))]
  const productIds = [...new Set(items.map(i => i.productId).filter((v): v is string => !!v))]

  if (rawMaterialIds.length > 0) {
    const encontrados = await prisma.rawMaterial.findMany({
      where: { id: { in: rawMaterialIds }, venueId, deletedAt: null },
      select: { id: true },
    })
    const faltantes = rawMaterialIds.filter(id => !encontrados.some(e => e.id === id))
    if (faltantes.length > 0) {
      throw new AppError(`No se encontraron estos insumos en la sucursal: ${faltantes.join(', ')}`, 404)
    }
  }

  if (productIds.length > 0) {
    const encontrados = await prisma.product.findMany({
      where: { id: { in: productIds }, venueId, deletedAt: null },
      select: { id: true, name: true, trackInventory: true, unit: true },
    })
    const faltantes = productIds.filter(id => !encontrados.some(e => e.id === id))
    if (faltantes.length > 0) {
      throw new AppError(`No se encontraron estos productos en la sucursal: ${faltantes.join(', ')}`, 404)
    }

    // Se valida AQUÍ, al ordenar, y no al recibir: descubrir que un producto no
    // rastrea inventario cuando el camión ya está en la puerta no le sirve a nadie.
    const sinInventario = encontrados.filter(p => !p.trackInventory || !p.unit)
    if (sinInventario.length > 0) {
      throw new AppError(
        `Estos productos no tienen control de inventario activo y no se pueden comprar: ${sinInventario.map(p => p.name).join(', ')}. Actívalo y define su unidad de medida.`,
        400,
      )
    }
  }
}

/**
 * Normaliza una cantidad recibida a la UNIDAD BASE del insumo, junto con su costo.
 *
 * Dos caminos, y el orden importa:
 * 1. **Presentación de compra** (CEDIS: "50 cajas de huevo"): la línea trae
 *    `presentationFactor` congelado al momento de la compra. Cantidad × factor
 *    da la base, y el costo se DIVIDE entre el factor (una caja a $360 son $1
 *    por pieza; sin dividir, el costo unitario quedaría inflado ×360).
 *    Esto cruza dimensiones (kilos↔piezas) porque el factor es explícito.
 * 2. **Legacy** (sin presentación): idéntico a antes — misma unidad se pasa
 *    tal cual, y unidades distintas van por `convertUnit` con su guarda de
 *    compatibilidad dimensional.
 *
 * Convertir AQUÍ (en el borde) mantiene a `createStockBatch`, `currentStock` y
 * los movimientos viendo siempre la unidad base, como hasta hoy.
 */
function purchasedQuantityInBaseUnit(
  orderItem: { unit: Unit; unitPrice: Decimal; presentationFactor: Decimal | null },
  quantityInOrderUnit: Decimal | number,
  // El insumo se pasa APARTE porque el renglón ya puede apuntar a un producto en su
  // lugar. Quien llama es responsable de haber comprobado que este renglón es de insumo.
  rawMaterial: { name: string; unit: Unit },
): { baseQuantity: Decimal; batch: { quantity: Decimal; unit: Unit; costPerUnit: Decimal } } {
  const baseUnit = rawMaterial.unit

  if (orderItem.presentationFactor) {
    const factor = new Decimal(orderItem.presentationFactor)
    if (!factor.isFinite() || factor.lte(0)) {
      throw new AppError(`El factor de presentación de ${rawMaterial.name} es inválido`, 400)
    }
    const baseQuantity = new Decimal(quantityInOrderUnit).mul(factor)
    // Ya viene en unidad base, así que `createStockBatch` no debe reconvertir:
    // se le pasa la base explícita y el costo YA dividido entre el factor.
    return {
      baseQuantity,
      batch: { quantity: baseQuantity, unit: baseUnit, costPerUnit: orderItem.unitPrice.div(factor) },
    }
  }

  // Camino legacy — byte-idéntico al comportamiento anterior.
  if (orderItem.unit !== baseUnit && !areUnitsCompatible(orderItem.unit, baseUnit)) {
    throw new AppError(
      `Cannot receive ${rawMaterial.name}: PO unit ${orderItem.unit} is incompatible with raw material unit ${baseUnit}`,
      400,
    )
  }
  return {
    baseQuantity:
      orderItem.unit === baseUnit ? new Decimal(quantityInOrderUnit) : convertUnit(quantityInOrderUnit, orderItem.unit, baseUnit),
    // `createStockBatch` normaliza (quantity, unit, costPerUnit) internamente:
    // en legacy se le sigue pasando la cantidad y unidad DE LA ORDEN, tal como
    // antes. Pasarle la base con la unidad de la orden la convertiría dos veces.
    batch: { quantity: new Decimal(quantityInOrderUnit), unit: orderItem.unit, costPerUnit: orderItem.unitPrice },
  }
}

async function getStaffSummary(staffId?: string | null) {
  if (!staffId) return null
  const staff = await prisma.staff.findUnique({
    where: { id: staffId },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
    },
  })

  if (!staff) return null

  const name = [staff.firstName, staff.lastName].filter(Boolean).join(' ').trim()

  return {
    id: staff.id,
    name: name || staff.email,
    email: staff.email,
  }
}

/**
 * Generate unique order number
 */
async function generateOrderNumber(venueId: string): Promise<string> {
  const today = new Date()
  const datePrefix = `PO${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`

  const lastOrder = await prisma.purchaseOrder.findFirst({
    where: {
      venueId,
      orderNumber: {
        startsWith: datePrefix,
      },
    },
    orderBy: {
      orderNumber: 'desc',
    },
  })

  if (!lastOrder) {
    return `${datePrefix}-001`
  }

  const lastSequence = parseInt(lastOrder.orderNumber.split('-')[1])
  const nextSequence = String(lastSequence + 1).padStart(3, '0')
  return `${datePrefix}-${nextSequence}`
}

/**
 * Helper function to send Purchase Order email (async, non-blocking)
 */
export async function sendPurchaseOrderEmailAsync(venueId: string, purchaseOrderId: string, staffId?: string): Promise<boolean> {
  // Declared outside try so it is accessible in the catch block for the email-failure audit log

  let po: any = null
  try {
    // Fetch complete PO data
    po = await prisma.purchaseOrder.findUnique({
      where: { id: purchaseOrderId },
      include: {
        supplier: true,
        items: {
          include: {
            rawMaterial: true,
            product: true,
          },
        },
        venue: {
          select: {
            name: true,
            address: true,
            city: true,
            state: true,
            zipCode: true,
          },
        },
      },
    })

    if (!po) {
      logger.warn(`Purchase Order ${purchaseOrderId} not found for email sending`)
      return false
    }

    // Check if supplier has email
    if (!po.supplier.email) {
      logger.warn(`Supplier ${po.supplier.name} (ID: ${po.supplierId}) has no email address - skipping PO email`)
      return false
    }

    // Fetch staff details if staffId provided. Auto-generated POs have no human creator —
    // label them so the supplier sees it's an automated order instead of "N/A".
    let staffName = po.autoGenerated ? 'Avoqado · Re-orden automático' : 'N/A'
    let staffEmail = ''

    if (staffId) {
      const staff = await prisma.staff.findUnique({
        where: { id: staffId },
        select: { firstName: true, lastName: true, email: true },
      })

      if (staff) {
        staffName = `${staff.firstName} ${staff.lastName}`
        staffEmail = staff.email || ''
      }
    }

    // Determine shipping address
    // If custom shipping address is provided, use it. Otherwise use venue address.
    const useCustomShipping = po.shippingAddressType === 'CUSTOM' && po.shippingAddress
    const shippingAddress = useCustomShipping ? po.shippingAddress! : po.venue?.address || 'N/A'
    const shippingCity = useCustomShipping ? po.shippingCity! : po.venue?.city || 'N/A'
    const shippingState = useCustomShipping ? po.shippingState! : po.venue?.state || 'N/A'
    const shippingZipCode = useCustomShipping ? po.shippingZipCode! : po.venue?.zipCode || 'N/A'

    // Format items for email
    // OJO: este `any` fue el que dejó pasar un crash real — con renglones de
    // mercancía de reventa, `item.rawMaterial` es null y el correo al proveedor
    // reventaba en silencio (la función es fire-and-forget). El resolvedor da el
    // nombre correcto sea insumo o producto.
    const formattedItems = po.items.map((item: any) => ({
      name: resolveLineTarget(item).name,
      quantity: item.quantityOrdered.toNumber(),
      unit: item.unit,
      unitPrice: item.unitPrice.toFixed(2),
      total: item.total.toFixed(2),
    }))

    // Send email
    const emailSent = await sendPurchaseOrderEmail({
      orderNumber: po.orderNumber,
      orderDate: po.orderDate.toISOString(),
      expectedDeliveryDate: po.expectedDeliveryDate?.toISOString() || null,
      venueName: po.venue?.name || 'N/A',
      venueAddress: shippingAddress,
      venueCity: shippingCity,
      venueState: shippingState,
      venueZipCode: shippingZipCode,
      supplierName: po.supplier.name,
      supplierContactName: po.supplier.contactName || null,
      supplierEmail: po.supplier.email,
      staffName,
      staffEmail,
      items: formattedItems,
      subtotal: po.subtotal.toFixed(2),
      taxRate: po.taxRate.toNumber(),
      taxAmount: po.taxAmount.toFixed(2),
      total: po.total.toFixed(2),
      notes: po.notes || null,
    })

    if (emailSent) {
      logger.info(`✅ Purchase Order email sent successfully for ${po.orderNumber}`)
    } else {
      logger.warn(`⚠️ Purchase Order email sending failed for ${po.orderNumber} (non-critical)`)
    }
    return emailSent
  } catch (error) {
    logger.error(`Error in sendPurchaseOrderEmailAsync for PO ${purchaseOrderId}:`, error)
    void logAction({
      staffId: null,
      venueId,
      action: 'PURCHASE_ORDER_EMAIL_FAILED',
      entity: 'PurchaseOrder',
      entityId: purchaseOrderId,
      data: {
        orderNumber: po?.orderNumber ?? null,
        supplierId: po?.supplierId ?? null,
        error: error instanceof Error ? error.message : String(error),
      },
    })
    // Don't throw - email failure should not affect PO creation
    return false
  }
}

/**
 * Get all purchase orders for a venue
 */
export async function getPurchaseOrders(
  venueId: string,
  filters?: {
    status?: PurchaseOrderStatus[]
    supplierId?: string
    startDate?: Date
    endDate?: Date
  },
): Promise<PurchaseOrder[]> {
  const where: Prisma.PurchaseOrderWhereInput = {
    venueId,
    ...(filters?.status && filters.status.length > 0 && { status: { in: filters.status } }),
    ...(filters?.supplierId && { supplierId: filters.supplierId }),
    ...(filters?.startDate && { orderDate: { gte: filters.startDate } }),
    ...(filters?.endDate && { orderDate: { lte: filters.endDate } }),
  }

  const purchaseOrders = await prisma.purchaseOrder.findMany({
    where,
    include: {
      supplier: {
        select: {
          id: true,
          name: true,
          contactName: true,
          email: true,
          phone: true,
        },
      },
      items: {
        include: {
          rawMaterial: {
            select: {
              id: true,
              name: true,
              sku: true,
              unit: true,
              currentStock: true,
            },
          },
          // Un renglón puede ser mercancía de reventa en vez de insumo. Sin esto el
          // listado devuelve renglones anónimos (nombre y sku en null) para toda
          // orden de tienda de conveniencia.
          product: {
            select: {
              id: true,
              name: true,
              sku: true,
              unit: true,
            },
          },
        },
      },
    },
    orderBy: {
      orderDate: 'desc',
    },
  })

  return purchaseOrders as any
}

/**
 * Get a single purchase order by ID
 */
export async function getPurchaseOrder(venueId: string, purchaseOrderId: string): Promise<PurchaseOrder | null> {
  const purchaseOrder = await prisma.purchaseOrder.findFirst({
    where: {
      id: purchaseOrderId,
      venueId,
    },
    include: {
      supplier: true,
      items: {
        include: {
          rawMaterial: true,
          product: true, // renglón de mercancía de reventa: sin esto sale anónimo
        },
      },
    },
  })

  if (!purchaseOrder) return null

  const createdBy = await getStaffSummary(purchaseOrder.createdBy)

  return {
    ...purchaseOrder,
    createdById: purchaseOrder.createdById || purchaseOrder.createdBy || null,
    createdBy,
  } as any
}

/**
 * Create a new purchase order
 */
/**
 * Congela la presentación de compra en cada renglón ("50 cajas de huevo").
 *
 * El factor se copia AL MOMENTO DE LA COMPRA a `PurchaseOrderItem.presentationFactor`
 * (snapshot): si mañana alguien corrige "caja = 12 conos" a 12.5, las órdenes
 * viejas siguen valuadas con el factor que realmente se pagó. Sin snapshot, un
 * ajuste de configuración reescribiría el costo histórico del inventario.
 *
 * Cuando hay presentación, `unit` se guarda como la unidad BASE del insumo — el
 * enum `Unit` no puede expresar "caja", y quien lee el renglón se guía por
 * `presentationName`. La recepción ignora `unit` si hay factor (ver
 * `purchasedQuantityInBaseUnit`).
 *
 * Un renglón SIN `presentationName` no toca nada: factor `null` → camino de hoy.
 */
async function resolvePresentationSnapshots(
  venueId: string,
  // `rawMaterialId` es opcional porque un renglón puede ser mercancía de reventa.
  // Las presentaciones de compra son exclusivas de insumos (el esquema Zod rechaza
  // una presentación en un renglón de producto), así que esos renglones se ignoran.
  items: Array<{ rawMaterialId?: string; presentationName?: string }>,
): Promise<Map<number, { name: string; factor: Decimal; baseUnit: Unit }>> {
  const snapshots = new Map<number, { name: string; factor: Decimal; baseUnit: Unit }>()
  const withPresentation = items
    .map((item, index) => ({ item, index }))
    .filter((x): x is { item: { rawMaterialId: string; presentationName?: string }; index: number } =>
      Boolean(x.item.presentationName && x.item.rawMaterialId),
    )
  if (withPresentation.length === 0) return snapshots

  const rows = await prisma.rawMaterialPresentation.findMany({
    where: {
      venueId,
      rawMaterialId: { in: [...new Set(withPresentation.map(({ item }) => item.rawMaterialId))] },
    },
    select: { rawMaterialId: true, name: true, factorToBase: true, rawMaterial: { select: { name: true, unit: true } } },
  })

  for (const { item, index } of withPresentation) {
    const name = item.presentationName!.trim()
    const match = rows.find(r => r.rawMaterialId === item.rawMaterialId && r.name === name)
    if (!match) {
      const available = rows.filter(r => r.rawMaterialId === item.rawMaterialId).map(r => r.name)
      throw new AppError(
        available.length > 0
          ? `La presentación "${name}" no existe para este insumo. Disponibles: ${available.join(', ')}`
          : `Este insumo no tiene presentaciones configuradas; no se puede comprar en "${name}"`,
        400,
      )
    }
    const factor = new Decimal(match.factorToBase)
    if (!factor.isFinite() || factor.lte(0)) {
      throw new AppError(`La presentación "${name}" tiene un factor inválido`, 400)
    }
    snapshots.set(index, { name, factor, baseUnit: match.rawMaterial.unit })
  }

  return snapshots
}

export async function createPurchaseOrder(venueId: string, data: CreatePurchaseOrderDto, staffId?: string): Promise<PurchaseOrder> {
  // Verify supplier exists and belongs to venue
  const supplier = await prisma.supplier.findFirst({
    where: {
      id: data.supplierId,
      venueId,
    },
  })

  if (!supplier) {
    throw new AppError(`Supplier with ID ${data.supplierId} not found`, 404)
  }

  await verificarRenglonesDelVenue(venueId, data.items)

  // Calculate totals
  const subtotal = data.items.reduce((sum, item) => {
    return sum.add(new Decimal(item.unitPrice).mul(item.quantityOrdered))
  }, new Decimal(0))

  const taxRate = data.taxRate || 0.16
  const commissionRate = data.commissionRate || 0

  // Misma fórmula que al editar y que al cambiar impuestos — un solo lugar.
  const { taxAmount, commission, totalAmount } = calcularTotalesDeOrden(subtotal, taxRate, commissionRate)

  // Check minimum order requirement
  if (supplier.minimumOrder && totalAmount.lessThan(supplier.minimumOrder)) {
    throw new AppError(`Order total ${totalAmount.toNumber()} is below supplier minimum order of ${supplier.minimumOrder.toNumber()}`, 400)
  }

  // Resolver ANTES de crear nada: una presentación inexistente debe abortar la
  // orden completa, no dejarla a medias.
  const presentationSnapshots = await resolvePresentationSnapshots(venueId, data.items)

  // Generate order number
  const orderNumber = await generateOrderNumber(venueId)

  // Create purchase order with items
  const purchaseOrder = await prisma.purchaseOrder.create({
    data: {
      venueId,
      supplierId: data.supplierId,
      orderNumber,
      orderDate: new Date(data.orderDate),
      expectedDeliveryDate: data.expectedDeliveryDate ? new Date(data.expectedDeliveryDate) : undefined,
      status: PurchaseOrderStatus.DRAFT,
      subtotal,
      taxRate,
      taxAmount,
      commissionRate,
      commission,
      total: totalAmount,
      notes: data.notes,
      createdBy: staffId,
      // Shipping address fields
      shippingAddressType: data.shippingAddressType || 'VENUE',
      shippingAddress: data.shippingAddress,
      shippingCity: data.shippingCity,
      shippingState: data.shippingState,
      shippingZipCode: data.shippingZipCode,
      items: {
        create: data.items.map((item, index) => {
          const itemTotal = new Decimal(item.unitPrice).mul(item.quantityOrdered)
          const presentation = presentationSnapshots.get(index)
          return {
            // Insumo de cocina O producto de reventa, nunca los dos: la exclusividad
            // ya la garantizó el esquema Zod de entrada.
            ...(item.rawMaterialId ? { rawMaterial: { connect: { id: item.rawMaterialId } } } : {}),
            ...(item.productId ? { product: { connect: { id: item.productId } } } : {}),
            quantityOrdered: item.quantityOrdered,
            // Con presentación, la unidad del renglón es la BASE del insumo: el
            // enum no puede decir "caja", eso lo dice `presentationName`.
            unit: presentation ? presentation.baseUnit : (item.unit as Unit),
            unitPrice: item.unitPrice,
            total: itemTotal,
            quantityReceived: 0,
            presentationName: presentation?.name ?? null,
            presentationFactor: presentation?.factor ?? null,
          }
        }),
      },
    },
    include: {
      supplier: true,
      items: {
        include: {
          rawMaterial: true,
          product: true, // renglón de mercancía de reventa: sin esto sale anónimo
        },
      },
    },
  })

  // Send email notification to supplier and staff (non-blocking)
  // This is async but we don't await it - email failures should not block PO creation
  sendPurchaseOrderEmailAsync(venueId, purchaseOrder.id, staffId).catch(error => {
    logger.error(`Failed to send Purchase Order email for PO ${purchaseOrder.orderNumber}:`, error)
  })

  logAction({
    staffId,
    venueId,
    action: 'PURCHASE_ORDER_CREATED',
    entity: 'PurchaseOrder',
    entityId: purchaseOrder.id,
    data: { orderNumber: purchaseOrder.orderNumber, supplierId: purchaseOrder.supplierId },
  })

  return purchaseOrder as any
}

/**
 * Update a purchase order
 */
export async function updatePurchaseOrder(
  venueId: string,
  purchaseOrderId: string,
  data: UpdatePurchaseOrderDto,
  staffId?: string,
): Promise<PurchaseOrder> {
  const existingOrder = await prisma.purchaseOrder.findFirst({
    where: {
      id: purchaseOrderId,
      venueId,
    },
    include: {
      items: true,
    },
  })

  if (!existingOrder) {
    throw new AppError(`Purchase order with ID ${purchaseOrderId} not found`, 404)
  }

  // Prevent editing received orders (except for undoing receive: RECEIVED → SHIPPED)
  if (existingOrder.status === PurchaseOrderStatus.RECEIVED) {
    // Allow RECEIVED → SHIPPED transition (undo receive)
    if (data.status !== PurchaseOrderStatus.SHIPPED) {
      throw new AppError(`Cannot edit purchase order with status ${existingOrder.status}`, 400)
    }
  }

  let updateData: Prisma.PurchaseOrderUpdateInput = {
    status: data.status,
    expectedDeliveryDate: data.expectedDeliveryDate ? new Date(data.expectedDeliveryDate) : undefined,
    notes: data.notes,
  }

  let updatedPresentationSnapshots = new Map<number, { name: string; factor: Decimal; baseUnit: Unit }>()

  // If items are being updated, recalculate totals
  if (data.items) {
    // 🔴 Reemplazar los renglones los BORRA y los recrea con ids nuevos, y eso corta
    // en silencio la liga con lo que ya entró a la bodega: los `StockBatch` de los
    // insumos y los `InventoryMovement` de la mercancía quedan con su
    // `purchaseOrderItemId` en NULL, mientras `quantityReceived` vuelve a 0. La orden
    // queda diciendo "no he recibido nada" con la mercancía ya en el almacén, así que
    // volver a recibirla la cuenta DOS VECES. Editar cantidades y precios de lo que ya
    // llegó tampoco tiene sentido de negocio: lo que llegó, llegó.
    const conRecepciones = existingOrder.items.filter(i => new Decimal(i.quantityReceived).greaterThan(0))
    if (conRecepciones.length > 0) {
      throw new AppError(
        `Esta orden ya tiene ${conRecepciones.length} renglón(es) con mercancía recibida y sus renglones no se pueden reemplazar. ` +
          `Ajusta la cantidad recibida desde la recepción del renglón, o cancela la orden y crea una nueva.`,
        400,
      )
    }

    // Misma verificación que al crear: sin esto, editar podía conectar el insumo o el
    // producto de OTRO local.
    await verificarRenglonesDelVenue(venueId, data.items)

    const subtotal = data.items.reduce((sum, item) => {
      return sum.add(new Decimal(item.unitPrice).mul(item.quantityOrdered))
    }, new Decimal(0))

    // 🔴 La COMISIÓN también entra en el total. Aquí se calculaba
    // `subtotal + impuesto` a secas, así que editar los renglones de una orden con
    // comisión le BORRABA la comisión del total en silencio: el documento dejaba de
    // cuadrar consigo mismo y el proveedor recibía un total menor al pactado.
    // Al crear sí se sumaba (ver `createPurchaseOrder`); que los dos caminos
    // calcularan distinto es la causa raíz, por eso ahora se calcula igual.
    const { taxAmount, totalAmount } = calcularTotalesDeOrden(subtotal, existingOrder.taxRate, existingOrder.commissionRate)

    updateData = {
      ...updateData,
      subtotal,
      taxAmount,
      commission: subtotal.mul(existingOrder.commissionRate ?? 0),
      total: totalAmount,
    }

    // Resolver ANTES de borrar: si la presentación no existe, la orden se queda
    // como estaba en vez de perder sus renglones.
    updatedPresentationSnapshots = await resolvePresentationSnapshots(existingOrder.venueId, data.items)
  }

  // Borrar y recrear van en UNA transacción: sueltos, si la recreación falla (una FK
  // inválida, un timeout), el `deleteMany` ya se confirmó y la orden se queda con CERO
  // renglones y con sus totales intactos — una orden fantasma que cuadra a nada.
  const purchaseOrder = await prisma.$transaction(async tx => {
    if (data.items) {
      await tx.purchaseOrderItem.deleteMany({ where: { purchaseOrderId } })
    }

    return tx.purchaseOrder.update({
      where: { id: purchaseOrderId },
      data: data.items
        ? {
            ...updateData,
            items: {
              create: data.items.map((item, index) => {
                const itemTotal = new Decimal(item.unitPrice).mul(item.quantityOrdered)
                // El update BORRA y recrea los renglones: sin esto se perdería el
                // snapshot y la orden se recibiría con la conversión apagada.
                const presentation = updatedPresentationSnapshots.get(index)
                return {
                  // Insumo de cocina O producto de reventa, igual que al crear. Antes
                  // esto conectaba SIEMPRE `rawMaterial`, así que editar una orden de
                  // tienda de conveniencia se llevaba sus renglones por delante.
                  ...(item.rawMaterialId ? { rawMaterial: { connect: { id: item.rawMaterialId } } } : {}),
                  ...(item.productId ? { product: { connect: { id: item.productId } } } : {}),
                  quantityOrdered: item.quantityOrdered,
                  unit: presentation ? presentation.baseUnit : (item.unit as Unit),
                  unitPrice: item.unitPrice,
                  total: itemTotal,
                  quantityReceived: 0,
                  presentationName: presentation?.name ?? null,
                  presentationFactor: presentation?.factor ?? null,
                }
              }),
            },
          }
        : updateData,
      include: {
        supplier: true,
        items: {
          include: {
            rawMaterial: true,
            product: true, // renglón de mercancía de reventa: sin esto sale anónimo
          },
        },
      },
    })
  })

  // El actor SÍ llega hasta aquí y no se estaba usando: la bitácora del dueño
  // registraba que una orden de compra cambió, pero no quién la cambió. Sin eso la
  // entrada no sirve para auditar — que es su único propósito.
  // También se guarda el estado ANTERIOR: "pasó de PENDIENTE a AUTORIZADA" es la
  // información que se audita; "quedó en AUTORIZADA" no dice quién movió qué.
  logAction({
    staffId,
    venueId,
    action: 'PURCHASE_ORDER_UPDATED',
    entity: 'PurchaseOrder',
    entityId: purchaseOrder.id,
    data: {
      orderNumber: purchaseOrder.orderNumber,
      estadoAnterior: existingOrder.status,
      estadoNuevo: purchaseOrder.status,
      renglonesReemplazados: !!data.items,
    },
  })

  return purchaseOrder as any
}

/**
 * Delete a purchase order (DRAFT only)
 */
export async function deletePurchaseOrder(venueId: string, purchaseOrderId: string): Promise<PurchaseOrder> {
  const existingOrder = await prisma.purchaseOrder.findFirst({
    where: {
      id: purchaseOrderId,
      venueId,
    },
    include: {
      supplier: true,
      items: true,
    },
  })

  if (!existingOrder) {
    throw new AppError(`Purchase order with ID ${purchaseOrderId} not found`, 404)
  }

  if (existingOrder.status !== PurchaseOrderStatus.DRAFT) {
    throw new AppError('Only DRAFT purchase orders can be deleted', 400)
  }

  await prisma.$transaction([
    prisma.purchaseOrderItem.deleteMany({ where: { purchaseOrderId } }),
    prisma.purchaseOrder.delete({ where: { id: purchaseOrderId } }),
  ])

  logAction({
    venueId,
    action: 'PURCHASE_ORDER_DELETED',
    entity: 'PurchaseOrder',
    entityId: purchaseOrderId,
    data: { orderNumber: existingOrder.orderNumber },
  })

  return existingOrder as any
}

/**
 * Approve a purchase order (change status to APPROVED)
 * @deprecated Use purchaseOrderWorkflow.service.approvePurchaseOrder instead
 */
export async function approvePurchaseOrder(venueId: string, purchaseOrderId: string, staffId?: string): Promise<PurchaseOrder> {
  const order = await prisma.purchaseOrder.findFirst({
    where: {
      id: purchaseOrderId,
      venueId,
    },
  })

  if (!order) {
    throw new AppError(`Purchase order not found`, 404)
  }

  // Allow approval from DRAFT or PENDING_APPROVAL
  const allowedStatuses = [PurchaseOrderStatus.DRAFT, PurchaseOrderStatus.PENDING_APPROVAL] as PurchaseOrderStatus[]
  if (!allowedStatuses.includes(order.status)) {
    throw new AppError(`Can only approve orders with status DRAFT or PENDING_APPROVAL`, 400)
  }

  const updatedOrder = await prisma.purchaseOrder.update({
    where: { id: purchaseOrderId },
    data: {
      status: PurchaseOrderStatus.APPROVED,
      approvedBy: staffId,
      approvedAt: new Date(),
    },
    include: {
      supplier: true,
      items: {
        include: {
          rawMaterial: true,
          product: true, // renglón de mercancía de reventa: sin esto sale anónimo
        },
      },
    },
  })

  logAction({
    staffId,
    venueId,
    action: 'PURCHASE_ORDER_APPROVED',
    entity: 'PurchaseOrder',
    entityId: updatedOrder.id,
    data: { orderNumber: updatedOrder.orderNumber },
  })

  return updatedOrder as any
}

/**
 * Receive a purchase order (mark items as received and update stock)
 */
export async function receivePurchaseOrder(
  venueId: string,
  purchaseOrderId: string,
  data: ReceivePurchaseOrderDto,
  staffId?: string,
): Promise<PurchaseOrder> {
  const order = await prisma.purchaseOrder.findFirst({
    where: {
      id: purchaseOrderId,
      venueId,
    },
    include: {
      items: {
        include: {
          rawMaterial: true,
          // Se carga sólo para poder nombrar el producto en el mensaje de rechazo:
          // este camino no recibe mercancía de reventa.
          product: { select: { name: true } },
        },
      },
    },
  })

  if (!order) {
    throw new AppError(`Purchase order not found`, 404)
  }

  const allowedStatuses = [PurchaseOrderStatus.CONFIRMED, PurchaseOrderStatus.SHIPPED, PurchaseOrderStatus.PARTIAL] as PurchaseOrderStatus[]
  if (!allowedStatuses.includes(order.status)) {
    throw new AppError(`Can only receive orders with status CONFIRMED, SHIPPED, or PARTIAL. Current status: ${order.status}`, 400)
  }

  // Build transaction operations
  const operations = []

  // Track created batches for linking to movements
  const batchCreations: Array<{ itemId: string; batchPromise: Promise<any> }> = []

  for (const receivedItem of data.items) {
    const orderItem = order.items.find(item => item.id === receivedItem.purchaseOrderItemId)

    if (!orderItem) {
      throw new AppError(`Purchase order item ${receivedItem.purchaseOrderItemId} not found`, 404)
    }

    // Este camino LEGACY sólo maneja insumos de cocina y NO se va a extender: usa la
    // forma de arreglo de `$transaction`, que no expone el cliente `tx` y por eso deja
    // los lotes fuera de la transacción (ver docs/DEMO-PITS-2026-08-BITACORA.md §2).
    // La mercancía de reventa se recibe por `applyItemReceiveStatusInTx`, que sí es
    // transaccional. Rechazar explícito es mejor que fallar raro más adelante.
    if (orderItem.productId) {
      throw new AppError(
        `El renglón de "${orderItem.product?.name ?? 'producto'}" es mercancía de reventa y debe recibirse por renglón, no con "Recibir todo" del flujo anterior.`,
        400,
      )
    }
    if (!orderItem.rawMaterial) {
      throw new AppError(`El renglón ${orderItem.id} no apunta a ningún insumo ni producto.`, 400)
    }
    const orderItemRawMaterial = orderItem.rawMaterial

    const totalReceived = orderItem.quantityReceived.add(receivedItem.quantityReceived)

    if (totalReceived.greaterThan(orderItem.quantityOrdered)) {
      throw new AppError(
        `Cannot receive ${receivedItem.quantityReceived} of ${orderItemRawMaterial.name}. Total would exceed ordered quantity.`,
        400,
      )
    }

    // Calculate expiration date if perishable
    let expirationDate: Date | undefined
    if (orderItemRawMaterial.perishable && orderItemRawMaterial.shelfLifeDays) {
      expirationDate = new Date(data.receivedDate)
      expirationDate.setDate(expirationDate.getDate() + orderItemRawMaterial.shelfLifeDays)
    }

    // Presentación de compra (CEDIS): si la línea se compró en "caja", se
    // convierte AQUÍ, en el borde, y todo lo de abajo (batch, stock, movimiento)
    // sigue viendo la unidad base como siempre.
    const purchased = purchasedQuantityInBaseUnit(orderItem, receivedItem.quantityReceived, orderItemRawMaterial)

    // Create FIFO batch for this received quantity. createStockBatch normalizes
    // (quantity, unit, costPerUnit) to the raw material's storage unit
    // internally — we still need to compute the same normalized quantity here
    // because RawMaterial.currentStock and the movement record use the RM unit.
    const batchPromise = createStockBatch(
      venueId,
      orderItemRawMaterial.id,
      {
        purchaseOrderItemId: orderItem.id,
        quantity: purchased.batch.quantity.toNumber(),
        unit: purchased.batch.unit,
        costPerUnit: purchased.batch.costPerUnit.toNumber(),
        receivedDate: new Date(data.receivedDate),
        expirationDate,
      },
      staffId,
    )

    batchCreations.push({ itemId: orderItem.id, batchPromise })

    const receivedInRmUnit = purchased.baseQuantity

    // Update order item quantity received and set receiveStatus
    operations.push(
      prisma.purchaseOrderItem.update({
        where: { id: orderItem.id },
        data: {
          quantityReceived: totalReceived,
          receiveStatus: PurchaseOrderItemStatus.RECEIVED,
        },
      }),
    )

    // Update raw material stock — must add the RM-unit-converted quantity, not
    // the raw PO quantity, otherwise receiving "1 KG" of a GRAM raw material
    // would only bump currentStock by 1 (interpreted as 1 GRAM) while the
    // batch correctly stores 1000g.
    //
    // 🔴 INCREMENTO ATÓMICO, NO ASIGNACIÓN. Antes esto calculaba
    // `orderItemRawMaterial.currentStock.add(recibido)` desde la lectura hecha al
    // inicio de la función —FUERA de la transacción— y lo escribía como valor
    // absoluto. Dos renglones del mismo insumo en la misma OC, o dos recepciones
    // concurrentes de dos paradores distintos, y la segunda escritura PISA a la
    // primera: se pierde una recepción completa y nadie se entera.
    //
    // `increment` se traduce a un `SET currentStock = currentStock + n` que la base
    // resuelve atómicamente, así que el orden de llegada deja de importar. No basta
    // con meterlo en una transacción: con el aislamiento por defecto de PostgreSQL
    // (READ COMMITTED) un leer-modificar-escribir sigue perdiendo actualizaciones.
    operations.push(
      prisma.rawMaterial.update({
        where: { id: orderItemRawMaterial.id },
        data: {
          currentStock: { increment: receivedInRmUnit },
        },
      }),
    )
  }

  // Wait for all batches to be created (outside transaction to avoid nesting)
  const createdBatches = await Promise.all(batchCreations.map(bc => bc.batchPromise))

  // Create movement records linked to batches. Movement.quantity, unit,
  // previousStock, newStock and costImpact must all reference the RM unit so
  // they reconcile cleanly with RawMaterial.currentStock and StockBatch
  // (both also normalized).
  //
  // ⚠️ DEUDA CONOCIDA — `previousStock` y `newStock` de abajo salen de la lectura
  // hecha al INICIO de la función, no del valor real al momento de aplicar. Bajo
  // concurrencia el saldo guardado en `RawMaterial.currentStock` queda CORRECTO
  // (arriba se usa `increment`), pero estas dos columnas del kardex pueden quedar
  // desfasadas. No se corrige aquí porque esta función usa la forma de ARREGLO de
  // `$transaction`, que no expone el cliente `tx` necesario para releer adentro;
  // arreglarlo obliga a convertirla a la forma de callback (~185 líneas).
  //
  // El camino moderno (`applyItemReceiveStatusInTx`) ya corre en forma de callback
  // y no tiene este problema. Toda funcionalidad nueva —incluida la recepción de
  // mercancía de reventa— debe construirse ahí, NO aquí.
  // Ver docs/DEMO-PITS-2026-08-BITACORA.md §2.
  for (let i = 0; i < data.items.length; i++) {
    const receivedItem = data.items[i]
    const orderItem = order.items.find(item => item.id === receivedItem.purchaseOrderItemId)!
    // Ya se validó arriba que todos los renglones de este camino son de insumo.
    const orderItemRawMaterial = orderItem.rawMaterial!
    const batch = createdBatches[i]
    const receivedInRmUnit = purchasedQuantityInBaseUnit(orderItem, receivedItem.quantityReceived, orderItemRawMaterial).baseQuantity

    operations.push(
      prisma.rawMaterialMovement.create({
        data: {
          rawMaterialId: orderItemRawMaterial.id,
          venueId,
          batchId: batch.id,
          type: RawMaterialMovementType.PURCHASE,
          quantity: receivedInRmUnit,
          unit: orderItemRawMaterial.unit,
          previousStock: orderItemRawMaterial.currentStock,
          newStock: orderItemRawMaterial.currentStock.add(receivedInRmUnit),
          // batch.costPerUnit is already per-RM-unit (createStockBatch normalized it).
          costImpact: batch.costPerUnit.mul(receivedInRmUnit),
          reason: `Purchase order ${order.orderNumber} received (Batch: ${batch.batchNumber})`,
          reference: order.id,
          createdBy: staffId,
        },
      }),
    )
  }

  // Update purchase order metadata
  operations.push(
    prisma.purchaseOrder.update({
      where: { id: purchaseOrderId },
      data: {
        receivedDate: new Date(data.receivedDate),
        receivedBy: staffId,
      },
    }),
  )

  // Execute all operations in a transaction
  await prisma.$transaction(operations)

  // Update order status based on item statuses (considers RECEIVED, DAMAGED, NOT_PROCESSED)
  await updatePurchaseOrderStatusBasedOnItems(purchaseOrderId)

  // Fetch updated order
  const updatedOrder = await prisma.purchaseOrder.findUnique({
    where: { id: purchaseOrderId },
    include: {
      supplier: true,
      items: {
        include: {
          rawMaterial: true,
          product: true, // renglón de mercancía de reventa: sin esto sale anónimo
        },
      },
    },
  })

  logAction({
    staffId,
    venueId,
    action: 'PURCHASE_ORDER_RECEIVED',
    entity: 'PurchaseOrder',
    entityId: purchaseOrderId,
    data: { orderNumber: order.orderNumber, itemCount: data.items.length },
  })

  return updatedOrder as any
}

/**
 * Cancel a purchase order
 */
export async function cancelPurchaseOrder(
  venueId: string,
  purchaseOrderId: string,
  reason?: string,
  staffId?: string,
): Promise<PurchaseOrder> {
  const order = await prisma.purchaseOrder.findFirst({
    where: {
      id: purchaseOrderId,
      venueId,
    },
  })

  if (!order) {
    throw new AppError(`Purchase order not found`, 404)
  }

  if (order.status === PurchaseOrderStatus.RECEIVED) {
    throw new AppError(`Cannot cancel order with status ${order.status}`, 400)
  }

  const updatedOrder = await prisma.purchaseOrder.update({
    where: { id: purchaseOrderId },
    data: {
      status: PurchaseOrderStatus.CANCELLED,
      notes: reason ? `${order.notes || ''}\nCancellation reason: ${reason}` : order.notes,
    },
    include: {
      supplier: true,
      items: {
        include: {
          rawMaterial: true,
          product: true, // renglón de mercancía de reventa: sin esto sale anónimo
        },
      },
    },
  })

  void logAction({
    staffId,
    venueId,
    action: 'PURCHASE_ORDER_CANCELLED',
    entity: 'PurchaseOrder',
    entityId: updatedOrder.id,
    data: { orderNumber: updatedOrder.orderNumber, reason },
  })

  return updatedOrder as any
}

/**
 * Get purchase order statistics
 */
export async function getPurchaseOrderStats(venueId: string, startDate?: Date, endDate?: Date) {
  const dateFilter = {
    ...(startDate && { gte: startDate }),
    ...(endDate && { lte: endDate }),
  }

  const orders = await prisma.purchaseOrder.findMany({
    where: {
      venueId,
      ...(Object.keys(dateFilter).length > 0 && { orderDate: dateFilter }),
    },
  })

  const totalOrders = orders.length
  const draftOrders = orders.filter(o => o.status === PurchaseOrderStatus.DRAFT).length
  const sentOrders = orders.filter(o => o.status === PurchaseOrderStatus.SENT).length
  const confirmedOrders = orders.filter(o => o.status === PurchaseOrderStatus.CONFIRMED).length
  const shippedOrders = orders.filter(o => o.status === PurchaseOrderStatus.SHIPPED).length
  const receivedOrders = orders.filter(o => o.status === PurchaseOrderStatus.RECEIVED).length
  const partialOrders = orders.filter(o => o.status === PurchaseOrderStatus.PARTIAL).length
  const cancelledOrders = orders.filter(o => o.status === PurchaseOrderStatus.CANCELLED).length

  const totalSpent = orders.filter(o => o.status !== PurchaseOrderStatus.CANCELLED).reduce((sum, o) => sum.add(o.total), new Decimal(0))

  const averageOrderValue = totalOrders > 0 ? totalSpent.div(totalOrders) : new Decimal(0)

  return {
    period: { startDate, endDate },
    totalOrders,
    statusBreakdown: {
      draft: draftOrders,
      sent: sentOrders,
      confirmed: confirmedOrders,
      shipped: shippedOrders,
      received: receivedOrders,
      partial: partialOrders,
      cancelled: cancelledOrders,
    },
    financials: {
      totalSpent: totalSpent.toNumber(),
      averageOrderValue: averageOrderValue.toNumber(),
    },
  }
}

/**
 * Update tax rate and/or commission rate on an existing purchase order
 * Recalculates all totals based on new rates
 */
export async function updatePurchaseOrderFees(
  venueId: string,
  purchaseOrderId: string,
  data: UpdatePurchaseOrderFeesDto,
): Promise<PurchaseOrder> {
  // Fetch current purchase order with items
  const existingOrder = await prisma.purchaseOrder.findUnique({
    where: { id: purchaseOrderId, venueId },
    include: { items: true },
  })

  if (!existingOrder) {
    throw new AppError('Purchase order not found', 404)
  }

  // Only allow updates on DRAFT or SENT orders
  const allowedStatuses: PurchaseOrderStatus[] = [PurchaseOrderStatus.DRAFT, PurchaseOrderStatus.SENT]
  if (!allowedStatuses.includes(existingOrder.status)) {
    throw new AppError('Cannot update fees on orders that are already confirmed or received', 400)
  }

  // Use existing rates if not provided in update
  const newTaxRate = data.taxRate !== undefined ? new Decimal(data.taxRate) : existingOrder.taxRate
  const newCommissionRate = data.commissionRate !== undefined ? new Decimal(data.commissionRate) : existingOrder.commissionRate

  // Recalculate totals
  const subtotal = existingOrder.subtotal
  // Misma fórmula que al crear y al editar renglones — un solo lugar.
  const { taxAmount, commission, totalAmount: total } = calcularTotalesDeOrden(subtotal, newTaxRate, newCommissionRate)

  // Update purchase order
  const updatedOrder = await prisma.purchaseOrder.update({
    where: { id: purchaseOrderId },
    data: {
      taxRate: newTaxRate,
      taxAmount,
      commissionRate: newCommissionRate,
      commission,
      total,
    },
    include: {
      supplier: true,
      items: {
        include: {
          rawMaterial: true,
          product: true, // renglón de mercancía de reventa: sin esto sale anónimo
        },
      },
    },
  })

  return updatedOrder
}

/**
 * Generate a unique batch number scoped to (venue, rawMaterial, day) within a
 * transaction. Mirrors fifoBatch.service.generateBatchNumber but uses the
 * transaction client so reads stay consistent with concurrent writes.
 */
async function generateBatchNumberInTx(tx: Prisma.TransactionClient, venueId: string, rawMaterialId: string): Promise<string> {
  const today = new Date()
  const datePrefix = `BATCH-${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`

  const lastBatch = await tx.stockBatch.findFirst({
    where: {
      venueId,
      rawMaterialId,
      batchNumber: { startsWith: datePrefix },
    },
    orderBy: { batchNumber: 'desc' },
  })

  if (!lastBatch) return `${datePrefix}-001`
  const batchNumberParts = lastBatch.batchNumber.split('-')
  const lastSequence = Number.parseInt(batchNumberParts[batchNumberParts.length - 1] ?? '0', 10)
  return `${datePrefix}-${String(lastSequence + 1).padStart(3, '0')}`
}

/**
 * Update the receive status of an individual purchase order item — and keep
 * inventory perfectly in sync with the transition.
 *
 * Robust state-machine semantics:
 *   - Forward (→ RECEIVED): create a StockBatch for the delta, increment
 *     RawMaterial.currentStock, log a PURCHASE RawMaterialMovement.
 *   - Reverse (RECEIVED →  DAMAGED | NOT_PROCESSED | PENDING): reduce existing
 *     batches (newest first), decrement currentStock, log a SPOILAGE / RETURN
 *     / ADJUSTMENT movement.
 *   - Idempotent: if the effective received quantity does not change, no stock
 *     side-effects are produced (only metadata fields are updated).
 *
 * Hard guards (throw AppError):
 *   - quantityReceived must not exceed quantityOrdered
 *   - PO unit must be dimensionally compatible with RawMaterial unit
 *   - Cannot reverse below the amount already consumed by sales (the
 *     existing batches' "consumed" portion is locked-in history)
 *
 * Everything runs inside a single prisma.$transaction so partial failures
 * cannot leave currentStock, batches and movements out of sync.
 */
export async function updatePurchaseOrderItemStatus(
  venueId: string,
  purchaseOrderId: string,
  itemId: string,
  data: UpdatePurchaseOrderItemStatusDto,
  staffId?: string,
): Promise<void> {
  await prisma.$transaction(async tx => {
    await applyItemReceiveStatusInTx(tx, venueId, purchaseOrderId, itemId, data, staffId)
  })

  // After the transaction commits, recompute the parent PO status (uses its
  // own connection — safe to run after).
  await updatePurchaseOrderStatusBasedOnItems(purchaseOrderId)
}

/**
 * Recepción de MERCANCÍA DE REVENTA (tienda de conveniencia).
 *
 * Mucho más simple que la de insumos, y a propósito: un producto de reventa no se
 * descompone en lotes con caducidad ni se consume por receta. Su saldo vive en
 * `Inventory.currentStock` y su historia en `InventoryMovement`, que ya traía
 * `unitCost`, `supplier` y el tipo `PURCHASE` sin que nadie los usara.
 *
 * Todo corre con el `tx` del llamador, así que saldo y movimiento se confirman juntos.
 *
 * Decisiones que conviene entender antes de tocar esto:
 *
 * · **Exige `trackInventory` activo.** Si un producto no rastrea inventario y aquí le
 *   creáramos la fila `Inventory` por la puerta de atrás, el punto de venta empezaría
 *   a BLOQUEAR sus ventas por falta de existencia. Se rechaza con un mensaje que dice
 *   qué configurar, en vez de romper la caja de un cliente.
 * · **El saldo se escribe con `increment`**, igual que en insumos y por la misma razón:
 *   dos recepciones simultáneas no se pisan.
 * · **No hay conversión de unidad.** El renglón se compra en la unidad del producto;
 *   la presentación de compra (cajas) queda para cuando exista demanda real, y hasta
 *   entonces se rechaza explícito en vez de valuar mal el inventario.
 *
 * 🔴 **El delta sale del ESTADO REAL, no de `quantityReceived`.** Esto es lo único
 * sutil de la función y ya causó un error de doble conteo. `quantityReceived` es un
 * METADATO mutable: `receiveNoItems` lo pone en 0 sin revertir el saldo. Si el delta
 * se calcula contra esa columna, la secuencia "recibir 5 → recibir ninguno → recibir
 * todo" deja 10 de existencia habiendo llegado 5 — un solo usuario, tres clics, sin
 * concurrencia. El camino de insumos nunca tuvo ese defecto porque su delta sale de
 * los lotes vivos, que son estado real y por tanto autocorrectivo.
 *
 * El equivalente aquí son los `InventoryMovement` que este mismo renglón generó. Se
 * suman por `newStock - previousStock` y NO por `quantity` a propósito: cada fila
 * lleva su propio antes y después, así que la suma es correcta sin depender de la
 * convención de signo, que no es uniforme entre servicios.
 */
async function applyProductItemReceiveStatusInTx(
  tx: Prisma.TransactionClient,
  venueId: string,
  item: {
    id: string
    productId: string | null
    product: { id: string; name: string; unit: Unit | null; trackInventory: boolean } | null
    unit: Unit
    unitPrice: Decimal
    quantityOrdered: Decimal
    quantityReceived: Decimal
    presentationName: string | null
    presentationFactor: Decimal | null
    purchaseOrder: { orderNumber: string; id: string }
  },
  data: UpdatePurchaseOrderItemStatusDto,
  staffId?: string,
): Promise<void> {
  const producto = item.product
  if (!producto) throw new AppError('El renglón apunta a un producto que ya no existe.', 404)

  if (!producto.trackInventory || !producto.unit) {
    throw new AppError(
      `El producto "${producto.name}" no tiene control de inventario activo. Actívalo y define su unidad de medida antes de recibir mercancía.`,
      400,
    )
  }

  if (item.presentationFactor) {
    throw new AppError(
      `El renglón de "${producto.name}" usa la presentación "${item.presentationName}". Las presentaciones de compra todavía no están soportadas para mercancía de reventa; captura la cantidad en ${producto.unit}.`,
      400,
    )
  }

  if (item.unit !== producto.unit) {
    throw new AppError(
      `La unidad ${item.unit} de la orden no coincide con la unidad ${producto.unit} del producto "${producto.name}".`,
      400,
    )
  }

  // Cantidad efectiva: sólo RECEIVED aporta existencia. DAMAGED / NOT_PROCESSED /
  // PENDING la dejan en cero, igual que en el camino de insumos.
  const nuevaCantidad =
    data.receiveStatus === PurchaseOrderItemStatus.RECEIVED
      ? new Decimal(data.quantityReceived !== undefined ? data.quantityReceived : item.quantityReceived.toNumber())
      : new Decimal(0)

  if (nuevaCantidad.greaterThan(item.quantityOrdered)) {
    throw new AppError(
      `No se puede recibir ${nuevaCantidad.toString()} ${item.unit} de "${producto.name}": excede lo ordenado (${item.quantityOrdered.toString()} ${item.unit}).`,
      400,
    )
  }

  // Cuánto puso YA este renglón en la bodega, según los movimientos que él mismo
  // generó. Ver la nota 🔴 del encabezado: NO se usa `item.quantityReceived`.
  const movimientosPrevios = await tx.inventoryMovement.findMany({
    where: { purchaseOrderItemId: item.id },
    select: { previousStock: true, newStock: true },
  })
  const yaAplicado = movimientosPrevios.reduce((acc, m) => acc.add(m.newStock.minus(m.previousStock)), new Decimal(0))

  // Recibir 3 sobre 5 ya aplicados devuelve 2 al almacén, no suma 3. Puede ser negativo.
  const delta = nuevaCantidad.minus(yaAplicado)

  await tx.purchaseOrderItem.update({
    where: { id: item.id },
    data: { quantityReceived: nuevaCantidad, receiveStatus: data.receiveStatus, notes: data.notes ?? undefined },
  })

  // La auditoría va SIEMPRE, incluso si el delta es cero: marcar un renglón como
  // dañado o revertirlo a pendiente es exactamente el tipo de anomalía que un dueño
  // audita. `void` a propósito: fire-and-forget, para que un fallo de bitácora no
  // tumbe la transacción de inventario (mismo patrón que el camino de insumos).
  void logAction({
    staffId: staffId ?? null,
    venueId,
    action: 'PURCHASE_ORDER_ITEM_RECEIVED',
    entity: 'PurchaseOrder',
    entityId: item.purchaseOrder.id,
    data: {
      purchaseOrderItemId: item.id,
      productId: producto.id,
      productName: producto.name,
      status: data.receiveStatus,
      quantityReceived: Number(nuevaCantidad),
      deltaAplicado: Number(delta),
    },
  })

  if (delta.isZero()) return

  // Filtrado por venue además de por producto: el `venueId` que recibe esta función
  // es el de la orden de compra, ya validado por el llamador. Un `findUnique` sólo
  // por productId funcionaría hoy (Inventory.productId es único y Product pertenece
  // a un solo venue), pero deja la garantía apoyada en un invariante de otro modelo
  // en vez de en la consulta que hace la escritura.
  const inventario = await tx.inventory.findFirst({
    where: { productId: producto.id, venueId },
    select: { id: true, currentStock: true },
  })
  if (!inventario) {
    throw new AppError(`El producto "${producto.name}" no tiene inventario inicializado en esta sucursal.`, 400)
  }

  const saldoAnterior = inventario.currentStock
  await tx.inventory.update({
    where: { id: inventario.id },
    data: {
      currentStock: { increment: delta },
      ...(delta.greaterThan(0) ? { lastRestockedAt: data.receivedDate ? new Date(data.receivedDate) : new Date() } : {}),
    },
  })

  // Mercancía marcada como DAÑADA sale como LOSS ("Damage, theft, expiry"), no como
  // un ajuste genérico: es el espejo del SPOILAGE que usa el camino de insumos, y sin
  // él un reporte de mermas no vería nunca la mercancía de tienda que llegó rota.
  const tipoMovimiento = delta.greaterThan(0)
    ? MovementType.PURCHASE
    : data.receiveStatus === PurchaseOrderItemStatus.DAMAGED
      ? MovementType.LOSS
      : MovementType.ADJUSTMENT

  const motivoPorEstado: Partial<Record<PurchaseOrderItemStatus, string>> = {
    [PurchaseOrderItemStatus.DAMAGED]: 'Marcado como dañado en la entrega',
    [PurchaseOrderItemStatus.NOT_PROCESSED]: 'Marcado como no tramitado',
    [PurchaseOrderItemStatus.PENDING]: 'Reversión a pendiente',
  }

  await tx.inventoryMovement.create({
    data: {
      inventoryId: inventario.id,
      purchaseOrderItemId: item.id, // es lo que permite recalcular `yaAplicado` la próxima vez
      type: tipoMovimiento,
      // Con signo, igual que `RawMaterialMovement.quantity` en el camino de insumos
      // y como declara el propio modelo ("Positive or negative").
      quantity: delta,
      previousStock: saldoAnterior,
      newStock: saldoAnterior.add(delta),
      unitCost: item.unitPrice,
      reason: delta.lessThan(0)
        ? `${motivoPorEstado[data.receiveStatus] ?? 'Ajuste de recepción'} — Orden ${item.purchaseOrder.orderNumber} (${producto.name})`
        : `Orden de compra ${item.purchaseOrder.orderNumber} recibida (${producto.name})`,
      reference: item.purchaseOrder.id,
      createdBy: staffId,
    },
  })
}

/**
 * Core of the receive state-machine, shared by updatePurchaseOrderItemStatus
 * (per-item endpoint), receiveAllItems ("Recibir todo") and the mobile
 * receiveStock flow. Runs inside the caller's transaction so batch + movement
 * + currentStock commit atomically.
 */
export async function applyItemReceiveStatusInTx(
  tx: Prisma.TransactionClient,
  venueId: string,
  purchaseOrderId: string,
  itemId: string,
  data: UpdatePurchaseOrderItemStatusDto,
  staffId?: string,
): Promise<void> {
  // Load item scoped to PO + venue, with raw material and batches
  const item = await tx.purchaseOrderItem.findFirst({
    where: {
      id: itemId,
      purchaseOrderId,
      purchaseOrder: { venueId },
    },
    include: {
      rawMaterial: true,
      product: true,
      batches: true,
      purchaseOrder: { select: { orderNumber: true, id: true } },
    },
  })

  if (!item) {
    throw new AppError('Item de orden de compra no encontrado', 404)
  }

  // ── Bifurcación por tipo de renglón ──────────────────────────────────────
  // La mercancía de reventa (tienda de conveniencia) no usa lotes PEPS: su saldo
  // vive en `Inventory` y sus movimientos en `InventoryMovement`. Toda la lógica
  // de abajo —lotes, caducidad, consumo, reversión por lote— es exclusiva de
  // insumos de cocina, así que se delega ANTES de entrar.
  //
  // Se bifurca aquí y no con condicionales adentro para que el camino de insumos
  // quede BYTE-IDÉNTICO a como estaba: ningún venue que hoy compra insumos cambia
  // de comportamiento por este trabajo.
  if (item.productId) {
    await applyProductItemReceiveStatusInTx(tx, venueId, item, data, staffId)
    return
  }

  if (!item.rawMaterial) {
    throw new AppError('El renglón no apunta a ningún insumo ni producto.', 400)
  }
  // A partir de aquí el renglón es de INSUMO. `rawMaterial` local para que
  // TypeScript no exija comprobar el nulo en cada uno de los ~30 usos de abajo.
  const rawMaterial = item.rawMaterial

  // ── Compute effective received quantity in PO unit ───────────────────────
  // Only RECEIVED contributes positive stock; DAMAGED / NOT_PROCESSED /
  // PENDING all reduce the inventory footprint to zero (the goods are not
  // considered on-hand for any of those statuses).
  const newReceiveStatus = data.receiveStatus
  const newQtyReceivedInPoUnit =
    newReceiveStatus === PurchaseOrderItemStatus.RECEIVED
      ? new Decimal(data.quantityReceived !== undefined ? data.quantityReceived : item.quantityReceived.toNumber())
      : new Decimal(0)

  if (newQtyReceivedInPoUnit.greaterThan(item.quantityOrdered)) {
    throw new AppError(
      `No se puede recibir ${newQtyReceivedInPoUnit.toString()} ${item.unit} de ${rawMaterial.name}: excede la cantidad ordenada (${item.quantityOrdered.toString()} ${item.unit}).`,
      400,
    )
  }

  // ── Unit compatibility (PO unit ↔ RawMaterial unit) ──────────────────────
  if (item.unit !== rawMaterial.unit && !areUnitsCompatible(item.unit, rawMaterial.unit)) {
    throw new AppError(
      `La unidad ${item.unit} de la orden es incompatible con la unidad ${rawMaterial.unit} del insumo "${rawMaterial.name}".`,
      400,
    )
  }

  // Presentación de compra congelada al ordenar ("50 cajas"): la cantidad del
  // renglón está EN CAJAS y una caja trae `presentationFactor` unidades base.
  // Esto vive aquí, en el único punto de conversión del núcleo compartido, para
  // que los TRES caminos de recepción (por renglón, "Recibir todo" y el flujo
  // móvil) conviertan igual. Sin factor, todo se comporta byte-idéntico a antes.
  const presentationFactor = item.presentationFactor ? new Decimal(item.presentationFactor) : null
  if (presentationFactor && (!presentationFactor.isFinite() || presentationFactor.lte(0))) {
    throw new AppError(`La presentación "${item.presentationName}" tiene un factor inválido; corrige el insumo antes de recibir.`, 400)
  }

  const toRmUnit = (qInPoUnit: Decimal): Decimal => {
    if (presentationFactor) return qInPoUnit.mul(presentationFactor)
    return item.unit === rawMaterial.unit ? qInPoUnit : new Decimal(convertUnit(qInPoUnit.toNumber(), item.unit, rawMaterial.unit))
  }

  const newQtyInRmUnit = toRmUnit(newQtyReceivedInPoUnit)

  // ── Aggregate existing batches for this item ─────────────────────────────
  // ACTIVE batches still have remaining stock; QUARANTINED and EXPIRED
  // batches are out of circulation and should NOT count toward the
  // "currently received" total — otherwise reversing them would deduct
  // currentStock that isn't there anymore.
  const liveBatches = item.batches.filter(b => b.status === BatchStatus.ACTIVE || b.status === BatchStatus.DEPLETED)
  const liveInitialTotal = liveBatches.reduce((acc, b) => acc.add(b.initialQuantity), new Decimal(0))
  const liveRemainingTotal = liveBatches.reduce((acc, b) => acc.add(b.remainingQuantity), new Decimal(0))
  const consumedTotal = liveInitialTotal.minus(liveRemainingTotal)

  // Cannot end up with less effective stock than what's already been consumed
  // by recipes/sales — that history is locked in.
  if (newQtyInRmUnit.lessThan(consumedTotal)) {
    throw new AppError(
      `No se puede ajustar a ${newQtyReceivedInPoUnit.toString()} ${item.unit}: ya se consumieron ${consumedTotal.toString()} ${rawMaterial.unit} de este lote en ventas u otros movimientos. Haz un ajuste manual de inventario si es necesario.`,
      400,
    )
  }

  const deltaInRmUnit = newQtyInRmUnit.minus(liveInitialTotal)

  // ── 1. Update the PurchaseOrderItem metadata always ──────────────────────
  await tx.purchaseOrderItem.update({
    where: { id: itemId },
    data: {
      receiveStatus: newReceiveStatus,
      quantityReceived:
        data.receiveStatus === PurchaseOrderItemStatus.RECEIVED
          ? data.quantityReceived !== undefined
            ? new Decimal(data.quantityReceived)
            : item.quantityReceived
          : new Decimal(0),
      notes: data.notes !== undefined ? data.notes : item.notes,
    },
  })

  // ── Audit: capture how each item was received (condition per item) ────────
  void logAction({
    staffId: staffId ?? null,
    venueId,
    action: 'PURCHASE_ORDER_ITEM_RECEIVED',
    entity: 'PurchaseOrder',
    entityId: purchaseOrderId,
    data: {
      purchaseOrderItemId: itemId,
      rawMaterialId: rawMaterial.id,
      status: newReceiveStatus,
      quantityReceived: Number(newQtyReceivedInPoUnit ?? 0),
    },
  })

  // ── 2. Apply inventory side-effects only when there's an actual delta ────
  if (deltaInRmUnit.isZero()) {
    return
  }

  const previousStock = rawMaterial.currentStock
  const newStock = previousStock.add(deltaInRmUnit)
  const receivedDate = data.receivedDate ? new Date(data.receivedDate) : new Date()

  if (deltaInRmUnit.greaterThan(0)) {
    // Forward: create new batch for the increment
    const deltaInPoUnit = presentationFactor
      ? deltaInRmUnit.div(presentationFactor)
      : newQtyReceivedInPoUnit.minus(toPoUnitInverse(liveInitialTotal, item.unit, rawMaterial.unit))

    // Cost normalization: PO unitPrice is per PO unit. If RM unit differs,
    // costPerUnit on the batch must be expressed per RM unit so FIFO costing
    // stays consistent with deductStockFIFO.
    //
    // Con presentación el precio es POR CAJA: hay que dividirlo entre el factor
    // o el inventario queda valuado ×factor (una caja de $360 se registraría a
    // $360 el kilo en vez de $30). `item.unit` YA es la unidad base en ese caso,
    // así que la comparación de unidades sola no basta para detectarlo.
    const costPerUnitInRmUnit =
      presentationFactor || item.unit !== rawMaterial.unit ? item.unitPrice.mul(deltaInPoUnit).div(deltaInRmUnit) : item.unitPrice

    const batchNumber = await generateBatchNumberInTx(tx, venueId, rawMaterial.id)

    // Calculate expiration if perishable
    let expirationDate: Date | undefined
    if (rawMaterial.perishable && rawMaterial.shelfLifeDays) {
      expirationDate = new Date(receivedDate)
      expirationDate.setDate(expirationDate.getDate() + rawMaterial.shelfLifeDays)
    }

    const newBatch = await tx.stockBatch.create({
      data: {
        venueId,
        rawMaterialId: rawMaterial.id,
        purchaseOrderItemId: item.id,
        batchNumber,
        initialQuantity: deltaInRmUnit,
        remainingQuantity: deltaInRmUnit,
        unit: rawMaterial.unit,
        costPerUnit: costPerUnitInRmUnit,
        receivedDate,
        expirationDate,
        status: BatchStatus.ACTIVE,
      },
    })

    await tx.rawMaterialMovement.create({
      data: {
        venueId,
        rawMaterialId: rawMaterial.id,
        batchId: newBatch.id,
        type: RawMaterialMovementType.PURCHASE,
        quantity: deltaInRmUnit,
        unit: rawMaterial.unit,
        previousStock,
        newStock,
        costImpact: costPerUnitInRmUnit.mul(deltaInRmUnit),
        reason: `Orden de compra ${item.purchaseOrder.orderNumber} recibida (${rawMaterial.name})`,
        reference: item.purchaseOrder.id,
        createdBy: staffId,
      },
    })
  } else {
    // Reverse: drain existing live batches newest-first by abs(delta)
    const absDelta = deltaInRmUnit.abs()
    let remaining = absDelta
    // Sort newest first — last receives are reversed before older ones
    const sortedBatches = [...liveBatches].sort((a, b) => b.receivedDate.getTime() - a.receivedDate.getTime())

    for (const batch of sortedBatches) {
      if (remaining.lessThanOrEqualTo(0)) break
      // We can only safely drain what's still remaining; consumed portion is locked
      const drainable = batch.remainingQuantity
      if (drainable.lessThanOrEqualTo(0)) continue
      const reduceBy = Decimal.min(drainable, remaining)
      const newRemainingInBatch = batch.remainingQuantity.minus(reduceBy)
      const newInitialInBatch = batch.initialQuantity.minus(reduceBy)
      const fullyReversed = newInitialInBatch.lessThanOrEqualTo(0)
      await tx.stockBatch.update({
        where: { id: batch.id },
        data: {
          initialQuantity: newInitialInBatch,
          remainingQuantity: newRemainingInBatch,
          status: fullyReversed ? BatchStatus.QUARANTINED : batch.status,
          depletedAt: fullyReversed ? receivedDate : batch.depletedAt,
        },
      })
      remaining = remaining.minus(reduceBy)
    }

    if (remaining.greaterThan(0)) {
      // Defensive: should be impossible given the consumedTotal guard above
      throw new AppError(
        `No se pudo revertir ${absDelta.toString()} ${rawMaterial.unit}: lotes activos insuficientes. Revisa el estado de inventario.`,
        500,
      )
    }

    const movementType =
      newReceiveStatus === PurchaseOrderItemStatus.DAMAGED
        ? RawMaterialMovementType.SPOILAGE
        : newReceiveStatus === PurchaseOrderItemStatus.NOT_PROCESSED
          ? RawMaterialMovementType.RETURN
          : RawMaterialMovementType.ADJUSTMENT // back to PENDING
    const reasonByStatus: Record<string, string> = {
      DAMAGED: 'Marcado como dañado en la entrega',
      NOT_PROCESSED: 'Marcado como no tramitado',
      PENDING: 'Reversión a pendiente',
    }

    await tx.rawMaterialMovement.create({
      data: {
        venueId,
        rawMaterialId: rawMaterial.id,
        type: movementType,
        quantity: deltaInRmUnit, // negative
        unit: rawMaterial.unit,
        previousStock,
        newStock,
        // Approximate cost impact using PO unitPrice converted to RM unit
        costImpact: item.unitPrice.mul(
          item.unit === rawMaterial.unit ? deltaInRmUnit : new Decimal(convertUnit(deltaInRmUnit.toNumber(), rawMaterial.unit, item.unit)),
        ),
        reason: `${reasonByStatus[newReceiveStatus] ?? 'Ajuste de recepción'} — Orden ${item.purchaseOrder.orderNumber} (${rawMaterial.name})`,
        reference: item.purchaseOrder.id,
        createdBy: staffId,
      },
    })
  }

  // ── 3. Sync RawMaterial.currentStock ─────────────────────────────────────
  //
  // 🔴 INCREMENTO ATÓMICO, NO ASIGNACIÓN. `newStock` se calcula arriba como
  // `previousStock + delta` para poder estamparlo en el movimiento del kardex, y
  // esa lectura sí ocurre dentro de la transacción. Pero escribirlo como valor
  // absoluto seguiría perdiendo actualizaciones: con el aislamiento por defecto de
  // PostgreSQL (READ COMMITTED) dos transacciones concurrentes pueden leer el mismo
  // saldo y ambas escribir el suyo, y el último gana. Estar dentro de una
  // transacción NO previene esto — sólo lo previene delegar la suma a la base.
  //
  // Con `increment` el saldo queda correcto sin importar el orden de llegada.
  // Relevante para operaciones multi-sucursal donde varios paradores reciben
  // mercancía al mismo tiempo. Ver docs/DEMO-PITS-2026-08-BITACORA.md §2.
  await tx.rawMaterial.update({
    where: { id: rawMaterial.id },
    data: { currentStock: { increment: deltaInRmUnit } },
  })
}

/**
 * Helper: convert RM-unit quantity back to PO unit. Used to express the delta
 * in PO unit for cost normalization. Falls back to identity when units match.
 */
function toPoUnitInverse(qInRmUnit: Decimal, poUnit: Unit, rmUnit: Unit): Decimal {
  if (poUnit === rmUnit) return qInRmUnit
  return new Decimal(convertUnit(qInRmUnit.toNumber(), rmUnit, poUnit))
}

/**
 * Mark all items in a purchase order as RECEIVED with full quantities
 */
export async function receiveAllItems(
  venueId: string,
  purchaseOrderId: string,
  data: ReceiveAllItemsDto,
  staffId?: string,
): Promise<PurchaseOrder> {
  // Fetch purchase order with items
  const purchaseOrder = await prisma.purchaseOrder.findUnique({
    where: { id: purchaseOrderId, venueId },
    include: { items: true },
  })

  if (!purchaseOrder) {
    throw new AppError('Purchase order not found', 404)
  }

  // Only allow receiving on SHIPPED, CONFIRMED, or CANCELLED orders (CANCELLED to allow reverting "receive none")
  const allowedReceiveStatuses: PurchaseOrderStatus[] = [
    PurchaseOrderStatus.SHIPPED,
    PurchaseOrderStatus.CONFIRMED,
    PurchaseOrderStatus.CANCELLED,
  ]
  if (!allowedReceiveStatuses.includes(purchaseOrder.status)) {
    throw new AppError('Can only receive orders that are SHIPPED, CONFIRMED, or CANCELLED', 400)
  }

  const receivedDate = data.receivedDate ? new Date(data.receivedDate) : new Date()

  await prisma.$transaction(async tx => {
    // Conditional status claim — guards against two concurrent "receive all"
    // calls both passing the pre-check above and double-creating batches. Only
    // the transaction that flips the status proceeds; the loser sees count 0.
    const claimed = await tx.purchaseOrder.updateMany({
      where: { id: purchaseOrderId, venueId, status: { in: allowedReceiveStatuses } },
      data: {
        status: PurchaseOrderStatus.RECEIVED,
        receivedDate,
        receivedBy: staffId,
      },
    })
    if (claimed.count === 0) {
      throw new AppError('Can only receive orders that are SHIPPED, CONFIRMED, or CANCELLED', 400)
    }

    // Delegate each item to the same receive state-machine used by the
    // per-item endpoint: creates the batch (in-tx), converts PO unit → RM unit,
    // increments RawMaterial.currentStock, logs the PURCHASE movement, and is
    // idempotent (already-received items produce no stock side-effects).
    for (const item of purchaseOrder.items) {
      await applyItemReceiveStatusInTx(
        tx,
        venueId,
        purchaseOrderId,
        item.id,
        {
          receiveStatus: PurchaseOrderItemStatus.RECEIVED,
          quantityReceived: item.quantityOrdered.toNumber(),
          receivedDate: receivedDate.toISOString(),
        } as UpdatePurchaseOrderItemStatusDto,
        staffId,
      )
    }
  })

  // Return updated purchase order
  return await prisma.purchaseOrder.findUniqueOrThrow({
    where: { id: purchaseOrderId },
    include: {
      supplier: true,
      items: {
        include: {
          rawMaterial: true,
          product: true, // renglón de mercancía de reventa: sin esto sale anónimo
        },
      },
    },
  })
}

/**
 * Mark all items in a purchase order as NOT_PROCESSED
 */
export async function receiveNoItems(venueId: string, purchaseOrderId: string, data: ReceiveNoItemsDto): Promise<PurchaseOrder> {
  // Fetch purchase order
  const purchaseOrder = await prisma.purchaseOrder.findUnique({
    where: { id: purchaseOrderId, venueId },
    include: { items: true },
  })

  if (!purchaseOrder) {
    throw new AppError('Purchase order not found', 404)
  }

  // Only allow on SHIPPED, CONFIRMED, or RECEIVED orders
  const allowedNotProcessedStatuses: PurchaseOrderStatus[] = [
    PurchaseOrderStatus.SHIPPED,
    PurchaseOrderStatus.CONFIRMED,
    PurchaseOrderStatus.RECEIVED,
  ]
  if (!allowedNotProcessedStatuses.includes(purchaseOrder.status)) {
    throw new AppError('Can only mark as not processed on orders that are SHIPPED, CONFIRMED, or RECEIVED', 400)
  }

  await prisma.$transaction(async tx => {
    // Update all items to NOT_PROCESSED
    await tx.purchaseOrderItem.updateMany({
      where: { purchaseOrderId },
      data: {
        receiveStatus: PurchaseOrderItemStatus.NOT_PROCESSED,
        quantityReceived: 0,
        notes: data.reason || 'Items not processed',
      },
    })

    // Update purchase order status to CANCELLED
    await tx.purchaseOrder.update({
      where: { id: purchaseOrderId },
      data: {
        status: PurchaseOrderStatus.CANCELLED,
        notes: data.reason ? `${purchaseOrder.notes || ''}\n\nCancellation reason: ${data.reason}`.trim() : purchaseOrder.notes,
      },
    })
  })

  // Return updated purchase order
  return await prisma.purchaseOrder.findUniqueOrThrow({
    where: { id: purchaseOrderId },
    include: {
      supplier: true,
      items: {
        include: {
          rawMaterial: true,
          product: true, // renglón de mercancía de reventa: sin esto sale anónimo
        },
      },
    },
  })
}

/**
 * Helper function to update purchase order status based on item statuses
 * - If all items are PROCESSED (RECEIVED, DAMAGED, or NOT_PROCESSED) → status = RECEIVED
 * - If some items are PROCESSED → status = PARTIAL
 * - If all items are NOT_PROCESSED or DAMAGED (and none RECEIVED) → status = CANCELLED
 */
async function updatePurchaseOrderStatusBasedOnItems(purchaseOrderId: string): Promise<void> {
  const purchaseOrder = await prisma.purchaseOrder.findUnique({
    where: { id: purchaseOrderId },
    include: { items: true },
  })

  if (!purchaseOrder) return

  const totalItems = purchaseOrder.items.length
  const receivedItems = purchaseOrder.items.filter(i => i.receiveStatus === PurchaseOrderItemStatus.RECEIVED).length
  const notProcessedItems = purchaseOrder.items.filter(i => i.receiveStatus === PurchaseOrderItemStatus.NOT_PROCESSED).length
  const damagedItems = purchaseOrder.items.filter(i => i.receiveStatus === PurchaseOrderItemStatus.DAMAGED).length

  // Count items that have been processed (any status)
  const processedItems = receivedItems + notProcessedItems + damagedItems

  let newStatus = purchaseOrder.status

  // All items have been processed (received, damaged, or not processed)
  if (processedItems === totalItems) {
    // If ALL items are damaged or not processed (none received), mark as CANCELLED
    if (receivedItems === 0 && notProcessedItems + damagedItems === totalItems) {
      newStatus = PurchaseOrderStatus.CANCELLED
    } else {
      // Otherwise, the order is complete (some received, some damaged/not processed)
      newStatus = PurchaseOrderStatus.RECEIVED
    }
  }
  // Some items processed, but not all
  else if (processedItems > 0) {
    newStatus = PurchaseOrderStatus.PARTIAL
  }

  // Update status if changed
  if (newStatus !== purchaseOrder.status) {
    await prisma.purchaseOrder.update({
      where: { id: purchaseOrderId },
      data: { status: newStatus },
    })
  }
}

/**
 * Public function to recalculate and update purchase order status based on item statuses
 * This should be called after batch updates to ensure the order status reflects the latest item states
 */
export async function recalculatePurchaseOrderStatus(venueId: string, purchaseOrderId: string): Promise<void> {
  // Verify the purchase order belongs to the venue
  const purchaseOrder = await prisma.purchaseOrder.findUnique({
    where: { id: purchaseOrderId, venueId },
    select: { id: true },
  })

  if (!purchaseOrder) {
    throw new AppError('Purchase order not found', 404)
  }

  await updatePurchaseOrderStatusBasedOnItems(purchaseOrderId)
}

/**
 * Generate labels for purchase order items
 */
export async function generateLabels(
  venueId: string,
  purchaseOrderId: string,
  config: {
    labelType: string
    barcodeFormat: 'SKU' | 'GTIN'
    details: {
      sku: boolean
      gtin: boolean
      variantName: boolean
      price: boolean
      itemName: boolean
      unitAbbr: boolean
    }
    items: Array<{
      itemId: string
      quantity: number
    }>
  },
): Promise<{ pdfBuffer: Buffer; totalLabels: number }> {
  // 1. Fetch purchase order with items
  const purchaseOrder = await prisma.purchaseOrder.findUnique({
    where: { id: purchaseOrderId, venueId },
    include: {
      items: {
        include: {
          rawMaterial: true,
          product: true, // renglón de mercancía de reventa: sin esto sale anónimo
        },
      },
    },
  })

  if (!purchaseOrder) {
    throw new AppError('Purchase order not found', 404)
  }

  // 2. Filter and map items to LabelItem shape
  const labelItems: LabelItem[] = purchaseOrder.items
    .filter(item => config.items.some(i => i.itemId === item.id))
    .map(item => {
      const configItem = config.items.find(i => i.itemId === item.id)!
      // La etiqueta se imprime igual sea insumo de cocina o mercancía de tienda.
      const target = resolveLineTarget(item)
      return {
        name: target.name,
        sku: target.sku,
        gtin: target.gtin,
        price: item.unitPrice?.toString() ?? null,
        unit: target.unit,
        labelQuantity: configItem.quantity,
      }
    })

  if (labelItems.length === 0) {
    throw new AppError('No items selected for label generation', 400)
  }

  // 3. Use shared renderer
  return renderLabelsPdf(labelItems, config)
}

/**
 * Generate PDF document for purchase order
 */
export async function generatePurchaseOrderPDF(venueId: string, purchaseOrderId: string): Promise<Buffer> {
  // Fetch purchase order with all relations
  const purchaseOrder = await prisma.purchaseOrder.findUnique({
    where: { id: purchaseOrderId, venueId },
    include: {
      supplier: true,
      venue: true,
      items: {
        include: {
          rawMaterial: true,
          product: true, // renglón de mercancía de reventa: sin esto sale anónimo
        },
      },
    },
  })

  if (!purchaseOrder) {
    throw new AppError('Purchase order not found', 404)
  }

  // Create PDF document
  const doc = new PDFDocument({
    size: 'LETTER',
    margin: 50,
  })

  const chunks: Buffer[] = []
  doc.on('data', (chunk: Buffer) => chunks.push(chunk))

  // Header
  doc.fontSize(20).font('Helvetica-Bold').text('ORDEN DE COMPRA', { align: 'center' })
  doc.moveDown(0.5)

  // Order number and date
  doc.fontSize(10).font('Helvetica')
  doc.text(`Orden #: ${purchaseOrder.orderNumber}`, { align: 'right' })
  doc.text(`Fecha: ${new Date(purchaseOrder.orderDate).toLocaleDateString('es-MX')}`, { align: 'right' })
  if (purchaseOrder.expectedDeliveryDate) {
    doc.text(`Entrega esperada: ${new Date(purchaseOrder.expectedDeliveryDate).toLocaleDateString('es-MX')}`, { align: 'right' })
  }
  doc.text(`Estado: ${purchaseOrder.status}`, { align: 'right' })

  doc.moveDown(1)

  // Two columns: Venue and Supplier
  const leftX = 50
  const rightX = 320

  // Venue info (left column)
  doc.fontSize(12).font('Helvetica-Bold').text('DE:', leftX, doc.y)
  doc.fontSize(10).font('Helvetica')
  doc.text(purchaseOrder.venue.name, leftX, doc.y)
  if (purchaseOrder.venue.address) doc.text(purchaseOrder.venue.address, leftX, doc.y)
  if (purchaseOrder.venue.city && purchaseOrder.venue.state) {
    doc.text(`${purchaseOrder.venue.city}, ${purchaseOrder.venue.state}`, leftX, doc.y)
  }
  if (purchaseOrder.venue.phone) doc.text(`Tel: ${purchaseOrder.venue.phone}`, leftX, doc.y)

  // Supplier info (right column)
  const supplierY = 200
  doc.fontSize(12).font('Helvetica-Bold').text('PARA:', rightX, supplierY)
  doc.fontSize(10).font('Helvetica')
  doc.text(purchaseOrder.supplier.name, rightX, doc.y)
  if (purchaseOrder.supplier.contactName) doc.text(`Contacto: ${purchaseOrder.supplier.contactName}`, rightX, doc.y)
  if (purchaseOrder.supplier.email) doc.text(`Email: ${purchaseOrder.supplier.email}`, rightX, doc.y)
  if (purchaseOrder.supplier.phone) doc.text(`Tel: ${purchaseOrder.supplier.phone}`, rightX, doc.y)
  if (purchaseOrder.supplier.address) doc.text(purchaseOrder.supplier.address, rightX, doc.y)

  doc.moveDown(2)

  // Items table
  const tableTop = doc.y + 20
  const tableHeaders = ['Artículo', 'Cantidad', 'Precio Unit.', 'Total']
  const colWidths = [250, 80, 90, 90]
  const colX = [50, 300, 380, 470]

  // Table header
  doc.fontSize(10).font('Helvetica-Bold')
  tableHeaders.forEach((header, i) => {
    doc.text(header, colX[i], tableTop, { width: colWidths[i], align: i === 0 ? 'left' : 'right' })
  })

  // Horizontal line
  doc
    .moveTo(50, tableTop + 15)
    .lineTo(560, tableTop + 15)
    .stroke()

  // Table rows
  doc.font('Helvetica')
  let yPosition = tableTop + 25

  purchaseOrder.items.forEach(item => {
    const itemTotal = item.quantityOrdered.toNumber() * item.unitPrice.toNumber()

    // Check if we need a new page
    if (yPosition > 700) {
      doc.addPage()
      yPosition = 50
    }

    // El PDF que ve el proveedor lista igual insumos de cocina y mercancía de tienda.
    doc.text(resolveLineTarget(item).name, colX[0], yPosition, { width: colWidths[0] })
    doc.text(`${item.quantityOrdered} ${getUnitAbbreviation(item.unit)}`, colX[1], yPosition, {
      width: colWidths[1],
      align: 'right',
    })
    doc.text(`$${item.unitPrice.toFixed(2)}`, colX[2], yPosition, { width: colWidths[2], align: 'right' })
    doc.text(`$${itemTotal.toFixed(2)}`, colX[3], yPosition, { width: colWidths[3], align: 'right' })

    yPosition += 20
  })

  // Summary section
  yPosition += 20

  // Horizontal line
  doc.moveTo(380, yPosition).lineTo(560, yPosition).stroke()

  yPosition += 15

  // Subtotal
  doc.font('Helvetica')
  doc.text('Subtotal:', 380, yPosition)
  doc.text(`$${purchaseOrder.subtotal.toFixed(2)}`, 470, yPosition, { width: 90, align: 'right' })
  yPosition += 20

  // Tax
  if (purchaseOrder.taxAmount && purchaseOrder.taxAmount.toNumber() > 0) {
    doc.text(`IVA (${purchaseOrder.taxRate.toNumber()}%):`, 380, yPosition)
    doc.text(`$${purchaseOrder.taxAmount.toFixed(2)}`, 470, yPosition, { width: 90, align: 'right' })
    yPosition += 20
  }

  // Commission
  if (purchaseOrder.commission && purchaseOrder.commission.toNumber() > 0) {
    doc.text(`Comisión (${purchaseOrder.commissionRate.toNumber()}%):`, 380, yPosition)
    doc.text(`$${purchaseOrder.commission.toFixed(2)}`, 470, yPosition, { width: 90, align: 'right' })
    yPosition += 20
  }

  // Total
  doc.fontSize(12).font('Helvetica-Bold')
  doc.text('TOTAL:', 380, yPosition)
  doc.text(`$${purchaseOrder.total.toFixed(2)}`, 470, yPosition, { width: 90, align: 'right' })

  // Notes
  if (purchaseOrder.notes) {
    yPosition += 40
    if (yPosition > 650) {
      doc.addPage()
      yPosition = 50
    }

    doc.fontSize(10).font('Helvetica-Bold').text('NOTAS:', 50, yPosition)
    yPosition += 15
    doc.fontSize(9).font('Helvetica').text(purchaseOrder.notes, 50, yPosition, { width: 500 })
  }

  // Footer
  const footerY = 720
  doc.fontSize(8).font('Helvetica').text('Generado por Avoqado', 50, footerY, { align: 'center', width: 500 })
  doc.text(`Fecha de generación: ${new Date().toLocaleDateString('es-MX')}`, 50, footerY + 10, {
    align: 'center',
    width: 500,
  })

  // Finalize PDF
  doc.end()

  // Wait for PDF to finish and return buffer
  const pdfBuffer = await new Promise<Buffer>(resolve => {
    doc.on('end', () => {
      resolve(Buffer.concat(chunks))
    })
  })

  return pdfBuffer
}

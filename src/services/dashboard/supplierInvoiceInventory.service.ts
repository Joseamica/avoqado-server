import { createHash } from 'node:crypto'
import cuid from 'cuid'
import { Prisma, PurchaseOrderItemStatus, PurchaseOrderStatus, Unit } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import prisma from '../../utils/prismaClient'
import { BadRequestError, ConflictError, NotFoundError } from '../../errors/AppError'
import { areUnitsCompatible, convertUnit } from '../../utils/unitConversion'
import { applyItemReceiveStatusInTx } from './purchaseOrder.service'
import { invoicePurchaseUnit } from './invoicePurchaseUnit'
import { logAction } from './activity-log.service'

const MAX_LINES = 200
const receiveStatuses: PurchaseOrderStatus[] = [PurchaseOrderStatus.APPROVED, PurchaseOrderStatus.CONFIRMED, PurchaseOrderStatus.SHIPPED]

async function buildReview(db: Prisma.TransactionClient, venueId: string, invoiceId: string, includeIeps = false) {
  const invoice = await db.purchaseOrderInvoice.findFirst({
    where: { id: invoiceId, venueId },
    include: {
      supplier: true,
      purchaseOrder: { include: { items: { take: MAX_LINES + 1 } } },
      lines: { take: MAX_LINES + 1, orderBy: { id: 'asc' }, include: { rawMaterial: true, product: true } },
    },
  })
  if (!invoice) throw new NotFoundError('Factura no encontrada en este negocio.')
  if (invoice.inventoryReceivedAt || invoice.purchaseOrder?.status === PurchaseOrderStatus.RECEIVED) {
    throw new ConflictError('Esta factura ya fue recibida. No se volverá a sumar al inventario.')
  }
  if (invoice.purchaseOrderId && !invoice.inventoryPreparedAt) {
    throw new ConflictError('Esta factura ya está ligada a una orden. Recibe la mercancía desde esa orden para evitar duplicarla.')
  }
  if (invoice.inventoryPreparedAt && !invoice.purchaseOrder)
    throw new ConflictError('La orden preparada ya no existe. Revisa su historial antes de crear otra entrada.')
  if (invoice.purchaseOrder && !receiveStatuses.includes(invoice.purchaseOrder.status)) {
    throw new ConflictError('La compra debe estar autorizada y sin recepciones parciales antes de recibir desde esta factura.')
  }
  if (invoice.cfdiType !== 'I')
    throw new BadRequestError(
      'Sólo un CFDI de ingreso (tipo I) permite preparar una compra. Las notas de crédito y complementos no son entradas de inventario.',
    )
  if (invoice.currency !== 'MXN')
    throw new BadRequestError(
      'Para recibir inventario se necesita un XML con moneda MXN verificada. Las facturas antiguas sin moneda y otras monedas requieren revisión.',
    )
  if (
    ![invoice.subtotalCents, invoice.descuentoCents, invoice.ivaCents, invoice.iepsCents, invoice.totalCents].every(
      n => Number.isSafeInteger(n) && n >= 0,
    )
  )
    throw new BadRequestError('El importe total o los impuestos del XML no son válidos.')
  if (!invoice.uuid) throw new BadRequestError('El XML debe estar timbrado y tener folio fiscal.')
  if (!invoice.lines.length || invoice.lines.length > MAX_LINES)
    throw new BadRequestError(`La recepción admite de 1 a ${MAX_LINES} renglones. Divide la compra en órdenes si excede este límite.`)

  const supplier =
    invoice.supplier ??
    (await db.supplier.findFirst({
      where: { venueId, taxId: { equals: invoice.emisorRfc, mode: 'insensitive' } },
    }))
  if (!supplier || supplier.venueId !== venueId || supplier.taxId?.trim().toUpperCase() !== invoice.emisorRfc.trim().toUpperCase()) {
    throw new BadRequestError('Da de alta al proveedor con el RFC de esta factura antes de preparar la compra.')
  }
  if (!supplier.active || supplier.deletedAt)
    throw new BadRequestError('El proveedor está dado de baja. Reactívalo en Proveedores para recibir esta compra.')

  // A prepared order freezes the cost policy and presentation, like every existing purchase order.
  const includeIepsInCost = invoice.inventoryPreparedAt ? invoice.inventoryIncludeIeps === true : includeIeps
  const presentationLines = invoice.lines.filter(l => l.rawMaterialId && l.presentationName)
  const presentations =
    invoice.purchaseOrder || !presentationLines.length
      ? []
      : await db.rawMaterialPresentation.findMany({
          where: { venueId, OR: presentationLines.map(l => ({ rawMaterialId: l.rawMaterialId!, name: l.presentationName! })) },
          take: MAX_LINES,
        })
  let sumAmount = 0,
    sumDiscount = 0,
    sumIeps = 0
  const lines = invoice.lines.map(line => {
    const target = line.rawMaterial ?? line.product
    if (!target || !!line.rawMaterialId === !!line.productId)
      throw new BadRequestError(`Identifica el artículo de "${line.descripcion}" antes de recibir.`)
    if (target.venueId !== venueId) throw new BadRequestError('El artículo no pertenece a este negocio.')
    if (target.deletedAt) throw new BadRequestError(`El artículo "${target.name}" está dado de baja.`)
    if (!target.active) throw new BadRequestError(`El artículo "${target.name}" está inactivo.`)
    const baseUnit = target.unit
    if (!baseUnit || (line.product && !line.product.trackInventory))
      throw new BadRequestError(`Activa el control de inventario y la unidad de "${target.name}".`)
    const quantity = new Decimal(line.cantidad)
    if (!quantity.isFinite() || quantity.lte(0) || quantity.decimalPlaces() > 3)
      throw new BadRequestError(`Cantidad inválida en "${line.descripcion}".`)
    if (
      ![line.importeCents, line.descuentoCents, line.iepsCents].every(n => Number.isSafeInteger(n) && n >= 0) ||
      line.descuentoCents > line.importeCents
    ) {
      throw new BadRequestError(`Importe o descuento inválido en "${line.descripcion}".`)
    }
    const orderItem = invoice.purchaseOrder?.items.find(i => i.id === line.purchaseOrderItemId)
    const presentation = line.presentationName
      ? presentations.find(p => p.rawMaterialId === line.rawMaterialId && p.name === line.presentationName)
      : null
    const factor = orderItem?.presentationFactor ?? presentation?.factorToBase ?? null
    if (line.presentationName && (!factor || !factor.isFinite() || factor.lte(0)))
      throw new BadRequestError(`Configura la presentación "${line.presentationName}" de "${target.name}" antes de recibir.`)
    if (line.productId && line.presentationName)
      throw new BadRequestError('Las presentaciones de compra de productos de reventa todavía requieren una orden manual.')
    const unit = line.presentationName ? baseUnit : (line.purchaseUnit ?? invoicePurchaseUnit(line.claveUnidad))
    const satUnit = invoicePurchaseUnit(line.claveUnidad)
    if (!line.presentationName && !satUnit)
      throw new BadRequestError(
        `La unidad SAT ${line.claveUnidad ?? 'sin unidad'} necesita una presentación explícita para recibir "${line.descripcion}". Configúrala en el insumo o usa una orden manual.`,
      )
    if (!line.presentationName && satUnit && unit !== satUnit)
      throw new BadRequestError(
        `La unidad de compra de "${line.descripcion}" no coincide con la unidad del XML. Usa una presentación explícita si necesita otra equivalencia.`,
      )
    if (!unit || !areUnitsCompatible(unit, baseUnit) || (line.productId && unit !== baseUnit)) {
      throw new BadRequestError(
        `Confirma la unidad o presentación de "${line.descripcion}". La unidad SAT ${line.claveUnidad ?? 'sin unidad'} no equivale a ${baseUnit}.`,
      )
    }
    const baseQuantity = factor ? quantity.mul(factor) : convertUnit(quantity, unit, baseUnit)
    if (!baseQuantity.isFinite() || baseQuantity.lte(0) || baseQuantity.decimalPlaces() > 3 || baseQuantity.gt('999999999.999'))
      throw new BadRequestError(
        `La cantidad convertida de "${target.name}" excede la precisión del inventario. Usa una unidad base adecuada.`,
      )
    const netAmount = new Decimal(line.importeCents - line.descuentoCents).div(100)
    const costAmount = netAmount.add(includeIepsInCost ? new Decimal(line.iepsCents).div(100) : 0)
    const unitPrice = costAmount.div(quantity).toDecimalPlaces(4)
    const baseUnitCost = unitPrice.mul(quantity).div(baseQuantity).toDecimalPlaces(4)
    if (unitPrice.gt('999999.9999') || baseUnitCost.gt('999999.9999') || (costAmount.gt(0) && baseUnitCost.eq(0)))
      throw new BadRequestError(`El costo de "${target.name}" excede la precisión del inventario. Revisa su unidad base.`)
    if (
      invoice.purchaseOrder &&
      (!orderItem ||
        !orderItem.quantityOrdered.eq(quantity) ||
        !orderItem.quantityReceived.eq(0) ||
        orderItem.rawMaterialId !== line.rawMaterialId ||
        orderItem.productId !== line.productId ||
        orderItem.unit !== unit ||
        !orderItem.unitPrice.eq(unitPrice) ||
        !orderItem.total.eq(costAmount) ||
        orderItem.presentationName !== line.presentationName)
    ) {
      throw new ConflictError(
        'La orden fue modificada o ya tiene una recepción parcial. Revisa y recibe desde la orden para conservar su historial.',
      )
    }
    sumAmount += line.importeCents
    sumDiscount += line.descuentoCents
    sumIeps += line.iepsCents
    return {
      lineId: line.id,
      purchaseOrderItemId: orderItem?.id ?? null,
      rawMaterialId: line.rawMaterialId,
      productId: line.productId,
      name: target.name,
      quantity: quantity.toString(),
      unit,
      supplierItemCode: line.supplierItemCode,
      description: line.descripcion,
      claveUnidad: line.claveUnidad,
      presentationName: line.presentationName,
      presentationFactor: factor?.toString() ?? null,
      baseQuantity: baseQuantity.toString(),
      baseUnit,
      netAmount: netAmount.toString(),
      ieps: new Decimal(line.iepsCents).div(100).toString(),
      costAmount: costAmount.toString(),
      unitPrice: unitPrice.toString(),
      baseUnitCost: baseUnitCost.toString(),
    }
  })
  if (
    sumAmount !== invoice.subtotalCents ||
    sumDiscount !== invoice.descuentoCents ||
    (includeIepsInCost && sumIeps !== invoice.iepsCents)
  ) {
    throw new BadRequestError('El desglose de renglones, descuentos o IEPS no cuadra con el XML. Revisa el comprobante antes de recibir.')
  }
  if (invoice.purchaseOrder && invoice.purchaseOrder.items.length !== lines.length)
    throw new ConflictError('La orden fue modificada y tiene otro número de renglones.')
  const subtotal = lines.reduce((s, l) => s.add(l.costAmount), new Decimal(0))
  const total = new Decimal(invoice.totalCents).div(100)
  if (
    invoice.purchaseOrder &&
    (invoice.purchaseOrder.supplierId !== supplier.id ||
      !invoice.purchaseOrder.subtotal.eq(subtotal) ||
      !invoice.purchaseOrder.total.eq(total) ||
      !invoice.purchaseOrder.taxAmount.eq(total.sub(subtotal)))
  )
    throw new ConflictError('La orden fue modificada. Revisa su proveedor e importes y recibe desde la orden para conservar su historial.')
  const review = {
    invoiceId,
    uuid: invoice.uuid,
    supplierId: supplier.id,
    supplier: supplier.name,
    action: invoice.purchaseOrder ? ('RECEIVE' as const) : ('PREPARE' as const),
    purchaseOrderId: invoice.purchaseOrderId,
    orderStatus: invoice.purchaseOrder?.status ?? null,
    includeIepsInCost,
    subtotal: subtotal.toString(),
    iva: new Decimal(invoice.ivaCents).div(100).toString(),
    ieps: new Decimal(invoice.iepsCents).div(100).toString(),
    total: total.toString(),
    lines,
  }
  return {
    ...review,
    confirmationToken: createHash('sha256')
      .update(JSON.stringify({ venueId, ...review }))
      .digest('hex'),
  }
}

export async function previewSupplierInvoiceInventory(venueId: string, invoiceId: string, includeIeps = false) {
  return buildReview(prisma, venueId, invoiceId, includeIeps)
}

/** Invoice/order links and every inventory effect commit together. An optimistic claim stops retries/concurrent callers. */
export async function confirmSupplierInvoiceInventory(
  venueId: string,
  invoiceId: string,
  confirmationToken: string,
  staffId: string,
  includeIeps = false,
) {
  const result = await prisma.$transaction(
    async tx => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM "PurchaseOrderInvoice" WHERE id = ${invoiceId} AND "venueId" = ${venueId} FOR UPDATE`)
      const review = await buildReview(tx, venueId, invoiceId, includeIeps)
      if (review.confirmationToken !== confirmationToken)
        throw new ConflictError('La compra cambió desde la revisión. Vuelve a revisarla antes de confirmar.')
      const now = new Date()
      const claim = await tx.purchaseOrderInvoice.updateMany({
        where: {
          id: invoiceId,
          venueId,
          inventoryReceivedAt: null,
          ...(review.action === 'PREPARE'
            ? { purchaseOrderId: null, inventoryPreparedAt: null }
            : { purchaseOrderId: review.purchaseOrderId }),
        },
        data:
          review.action === 'PREPARE'
            ? { inventoryPreparedAt: now, inventoryIncludeIeps: review.includeIepsInCost }
            : { inventoryReceivedAt: now },
      })
      if (claim.count !== 1) throw new ConflictError('Otra persona ya procesó esta factura. Actualiza la pantalla para ver su estado.')
      if (review.action === 'PREPARE') {
        const subtotal = new Decimal(review.subtotal),
          total = new Decimal(review.total)
        const itemIds = review.lines.map(() => cuid())
        const order = await tx.purchaseOrder.create({
          data: {
            venueId,
            supplierId: review.supplierId,
            orderNumber: `XML-${invoiceId}`,
            status: PurchaseOrderStatus.PENDING_APPROVAL,
            orderDate: now,
            subtotal,
            total,
            taxAmount: total.sub(subtotal),
            taxRate: 0,
            createdBy: staffId,
            notes: `Compra preparada desde CFDI ${review.uuid}. Costo neto sin IVA${review.includeIepsInCost ? ', con IEPS' : ', sin IEPS'}.`,
            items: {
              create: review.lines.map((l, index) => ({
                id: itemIds[index],
                rawMaterialId: l.rawMaterialId,
                productId: l.productId,
                quantityOrdered: new Decimal(l.quantity),
                unit: l.unit as Unit,
                unitPrice: new Decimal(l.unitPrice),
                total: new Decimal(l.costAmount),
                presentationName: l.presentationName,
                presentationFactor: l.presentationFactor ? new Decimal(l.presentationFactor) : null,
              })),
            },
          },
          include: { items: { take: MAX_LINES } },
        })
        await tx.purchaseOrderInvoice.update({
          where: { id: invoiceId, venueId },
          data: { purchaseOrderId: order.id, supplierId: review.supplierId },
        })
        for (let index = 0; index < review.lines.length; index++) {
          const line = review.lines[index]
          await tx.purchaseOrderInvoiceLine.update({ where: { id: line.lineId, invoiceId }, data: { purchaseOrderItemId: itemIds[index] } })
          if (line.supplierItemCode)
            await tx.supplierItemCode.upsert({
              where: { venueId_supplierId_code: { venueId, supplierId: review.supplierId, code: line.supplierItemCode } },
              create: {
                venueId,
                supplierId: review.supplierId,
                code: line.supplierItemCode,
                rawMaterialId: line.rawMaterialId,
                productId: line.productId,
                purchaseUnit: line.unit,
                presentationName: line.presentationName,
                claveUnidad: line.claveUnidad,
                lastDescription: line.description,
                createdById: staffId,
              },
              update: {
                rawMaterialId: line.rawMaterialId,
                productId: line.productId,
                purchaseUnit: line.unit,
                presentationName: line.presentationName,
                claveUnidad: line.claveUnidad,
                lastDescription: line.description,
              },
            })
        }
        return { purchaseOrderId: order.id, status: order.status, action: review.action }
      }
      const orderClaim = await tx.purchaseOrder.updateMany({
        where: {
          id: review.purchaseOrderId!,
          venueId,
          status: { in: receiveStatuses },
          supplierId: review.supplierId,
          subtotal: new Decimal(review.subtotal),
          total: new Decimal(review.total),
          taxAmount: new Decimal(review.total).sub(review.subtotal),
        },
        data: { status: PurchaseOrderStatus.RECEIVED, receivedDate: now, receivedBy: staffId },
      })
      if (orderClaim.count !== 1) throw new ConflictError('La orden cambió de estado. Revisa su autorización y recepción.')
      for (const line of review.lines) {
        await applyItemReceiveStatusInTx(
          tx,
          venueId,
          review.purchaseOrderId!,
          line.purchaseOrderItemId!,
          {
            receiveStatus: PurchaseOrderItemStatus.RECEIVED,
            quantityReceived: Number(line.quantity),
            receivedDate: now.toISOString(),
          },
          staffId,
        )
      }
      return { purchaseOrderId: review.purchaseOrderId!, status: PurchaseOrderStatus.RECEIVED, action: review.action }
    },
    { timeout: 30000 },
  )
  void logAction({
    staffId,
    venueId,
    action: result.action === 'PREPARE' ? 'PURCHASE_INVOICE_PREPARED' : 'PURCHASE_INVOICE_RECEIVED',
    entity: 'PurchaseOrderInvoice',
    entityId: invoiceId,
    data: result,
  })
  return result
}

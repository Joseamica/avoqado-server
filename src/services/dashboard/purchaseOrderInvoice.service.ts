import { BadRequestError, ConflictError, NotFoundError } from '../../errors/AppError'
import logger from '../../config/logger'
import prisma from '../../utils/prismaClient'
import { parseCfdiReceived } from '../fiscal/cfdiReceived.parser'
import { resolveScopeOrNull } from '../fiscal/chartOfAccounts.service'
import { logAction } from './activity-log.service'
import { decideMatchVerdict } from './invoiceMatchVerdict'
import { matchInvoiceLines, type OrderLineForMatch } from './invoiceLineMatcher'

/**
 * Subir el CFDI del proveedor a una orden de compra y conciliarlo.
 *
 * 🔴 Esto NO toca inventario ni costos, nunca. `StockBatch.costPerUnit` se congela al
 * RECIBIR desde `PurchaseOrderItem.unitPrice`. Si el proveedor facturó otro precio, se
 * guarda el veredicto y se avisa: revaluar el lote cambiaría el costo de ventas que YA
 * ocurrieron con él, y reportes que el dueño ya vio dejarían de cuadrar.
 *
 * La factura no dice qué compraste — la orden ya lo sabe. Esto comprueba que te cobraron
 * lo que pediste.
 */

export interface AttachInvoiceParams {
  venueId: string
  purchaseOrderId: string
  xml: string
  /** URL del XML ya subido a almacenamiento. */
  xmlUrl?: string | null
  uploadedById?: string | null
}

export async function attachInvoiceToPurchaseOrder(params: AttachInvoiceParams) {
  const { venueId, purchaseOrderId, xml, xmlUrl, uploadedById } = params

  const scope = await resolveScopeOrNull(venueId)
  if (!scope) {
    throw new BadRequestError('Este negocio aún no tiene un RFC configurado. Configura la facturación (CFDI) primero.')
  }

  // Valida de paso que el RECEPTOR seamos nosotros: no se importa un CFDI ajeno.
  const { expense, conceptos } = parseCfdiReceived(xml, scope.rfc)

  // Una nota de crédito no es una factura de compra: reduce lo que debes. Tratarla como
  // factura sumaría dos veces. Se rechaza con un mensaje claro en vez de conciliarla mal.
  if (expense.comprobanteTipo !== 'INGRESO') {
    throw new BadRequestError(
      `Este CFDI es de tipo ${expense.comprobanteTipo}, no una factura de compra. Las notas de crédito todavía no se pueden asociar a una orden.`,
    )
  }

  const order = await prisma.purchaseOrder.findFirst({
    where: { id: purchaseOrderId, venueId }, // acotado al negocio: un id ajeno no aparece
    select: {
      id: true,
      total: true,
      supplierId: true,
      supplier: { select: { id: true, name: true, taxId: true } },
      items: { select: { id: true, total: true, quantityOrdered: true, rawMaterialId: true, productId: true } },
    },
  })
  if (!order) throw new NotFoundError('Orden de compra no encontrada en este negocio')

  const existing = await prisma.purchaseOrderInvoice.findFirst({
    where: { venueId, uuid: expense.uuid ?? '' },
    select: { id: true, purchaseOrderId: true },
  })
  if (existing) {
    throw new ConflictError(
      existing.purchaseOrderId === purchaseOrderId
        ? 'Esta factura ya está asociada a esta orden.'
        : 'Esta factura ya está asociada a otra orden de compra.',
    )
  }

  // `Supplier.taxId` es el RFC del proveedor, y es OPCIONAL. Sin él no se puede comprobar
  // nada: `null` significa "no verificable", no "proveedor equivocado". Marcar mismatch ahí
  // acusaría al proveedor de un dato que falta de nuestro lado.
  const supplierTaxId = order.supplier?.taxId?.toUpperCase().trim()
  const supplierMatches = supplierTaxId ? supplierTaxId === expense.proveedorRfc.toUpperCase().trim() : null

  const orderLines: OrderLineForMatch[] = order.items.map(item => ({
    id: item.id,
    totalCents: Math.round(Number(item.total) * 100),
    quantity: Number(item.quantityOrdered),
  }))

  // Los códigos que este proveedor ya usó, traducidos a NUESTRO catálogo (fase 2:
  // `SupplierItemCode`, código → insumo/producto). El mapeo es del proveedor, no de una
  // orden — por eso aquí se traduce a los renglones de ESTA orden por su material.
  const knownMaterials = await loadKnownSupplierCodes(venueId, order.supplierId)
  const knownCodes: Record<string, string> = {}
  const claimed = new Set<string>()
  for (const [code, target] of knownMaterials) {
    const item = order.items.find(
      i =>
        !claimed.has(i.id) &&
        ((target.rawMaterialId && i.rawMaterialId === target.rawMaterialId) || (target.productId && i.productId === target.productId)),
    )
    if (item) {
      knownCodes[code] = item.id
      claimed.add(item.id)
    }
  }

  const match = matchInvoiceLines(conceptos, orderLines, { knownCodes })

  // Una orden puede facturarse en varias entregas: el veredicto compara contra la SUMA de
  // lo ya facturado, no contra esta factura sola (riesgo documentado en el spec).
  const previous = await prisma.purchaseOrderInvoice.aggregate({
    where: { venueId, purchaseOrderId },
    _sum: { totalCents: true },
  })

  const verdict = decideMatchVerdict({
    supplierMatches,
    invoiceTotalCents: expense.totalCents,
    orderTotalCents: Math.round(Number(order.total) * 100),
    previousInvoicesTotalCents: previous._sum.totalCents ?? 0,
    unmatchedConceptos: match.unmatchedConceptos,
    unmatchedOrderItemIds: match.unmatchedOrderItemIds,
  })

  const invoice = await prisma.purchaseOrderInvoice.create({
    data: {
      purchaseOrderId,
      venueId,
      // Se guarda el proveedor de la ORDEN aunque el emisor no coincida: el desajuste vive
      // en `matchStatus`, y perder la referencia haría más difícil verlo.
      supplierId: order.supplierId,
      uuid: expense.uuid ?? '',
      serie: expense.serie ?? null,
      folio: expense.folio ?? null,
      emisorRfc: expense.proveedorRfc,
      emisorNombre: expense.proveedorNombre,
      fechaEmision: new Date(`${expense.fechaEmision}T00:00:00.000Z`),
      subtotalCents: expense.subtotalCents,
      descuentoCents: expense.descuentoCents ?? 0,
      ivaCents: expense.ivaCents ?? 0,
      totalCents: expense.totalCents,
      xmlUrl: xmlUrl ?? null,
      matchStatus: verdict.status,
      matchNotes: verdict.notes as unknown as object,
      uploadedById: uploadedById ?? null,
      lines: {
        create: match.lines.map(line => {
          const item = line.purchaseOrderItemId ? order.items.find(i => i.id === line.purchaseOrderItemId) : null
          const known = line.concepto.supplierItemCode ? knownMaterials.get(line.concepto.supplierItemCode) : null
          return {
            purchaseOrderItemId: line.purchaseOrderItemId,
            // Qué ES el renglón: del renglón casado, o del código ya aprendido. Nunca por texto.
            rawMaterialId: item?.rawMaterialId ?? known?.rawMaterialId ?? null,
            productId: item?.rawMaterialId ? null : (item?.productId ?? (known?.rawMaterialId ? null : (known?.productId ?? null))),
            supplierItemCode: line.concepto.supplierItemCode,
            descripcion: line.concepto.descripcion,
            claveProdServ: line.concepto.claveProdServ,
            claveUnidad: line.concepto.claveUnidad,
            cantidad: line.concepto.cantidad,
            valorUnitarioCents: line.concepto.valorUnitarioCents,
            importeCents: line.concepto.importeCents,
            descuentoCents: line.concepto.descuentoCents,
          }
        }),
      },
    },
    include: { lines: true },
  })

  // Aprender: cada renglón que casó con un renglón de la orden que SÍ sabe qué es, y que
  // traía código del proveedor, alimenta `SupplierItemCode`. Es lo que hace que la próxima
  // factura de este proveedor case sola — sin trabajo extra del usuario (spec, fase 2).
  // No bloquea: si el aprendizaje falla, la factura ya quedó conciliada.
  try {
    for (const line of match.lines) {
      const code = line.concepto.supplierItemCode
      if (!code || !line.purchaseOrderItemId) continue
      const item = order.items.find(i => i.id === line.purchaseOrderItemId)
      if (!item || (!item.rawMaterialId && !item.productId)) continue
      await prisma.supplierItemCode.upsert({
        where: { venueId_supplierId_code: { venueId, supplierId: order.supplierId, code } },
        create: {
          venueId,
          supplierId: order.supplierId,
          code,
          rawMaterialId: item.rawMaterialId,
          productId: item.rawMaterialId ? null : item.productId,
          lastDescription: line.concepto.descripcion,
          createdById: uploadedById ?? null,
        },
        // El más reciente gana: si el proveedor reasignó el código, la última verdad manda.
        update: {
          rawMaterialId: item.rawMaterialId,
          productId: item.rawMaterialId ? null : item.productId,
          lastDescription: line.concepto.descripcion,
        },
      })
    }
  } catch (error) {
    logger.warn('factura: no se pudo aprender un código del proveedor; la conciliación no se afecta', {
      venueId,
      invoiceId: invoice.id,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  logAction({
    staffId: uploadedById ?? undefined,
    venueId,
    action: `PURCHASE_INVOICE_${verdict.status}`,
    entity: 'PurchaseOrderInvoice',
    entityId: invoice.id,
    data: { purchaseOrderId, uuid: invoice.uuid, ...verdict.notes },
  })

  return invoice
}

/**
 * Códigos que este proveedor ya usó, traducidos a nuestro catálogo (`SupplierItemCode`).
 *
 * 🔴 La fase 1 guardaba código → renglón de una orden VIEJA, que no sirve para casar órdenes
 * nuevas. El mapeo estable es código → insumo/producto; a qué renglón corresponde se decide
 * orden por orden.
 */
async function loadKnownSupplierCodes(
  venueId: string,
  supplierId: string,
): Promise<Map<string, { rawMaterialId: string | null; productId: string | null }>> {
  const rows = await prisma.supplierItemCode.findMany({
    where: { venueId, supplierId },
    select: { code: true, rawMaterialId: true, productId: true },
  })
  return new Map(rows.map(r => [r.code, { rawMaterialId: r.rawMaterialId, productId: r.productId }]))
}

export interface RegisterSupplierInvoiceParams {
  venueId: string
  xml: string
  xmlUrl?: string | null
  uploadedById?: string | null
}

/**
 * Fase 2 — la factura SIN orden previa.
 *
 * No hay contra qué conciliar: se registra como evidencia, se identifica lo que los códigos
 * aprendidos ya reconocen, y lo demás lo confirma una persona (`identifyInvoiceLine`).
 * Nunca se adivina por texto, y nunca toca inventario ni costos.
 */
export async function registerSupplierInvoice(params: RegisterSupplierInvoiceParams) {
  const { venueId, xml, xmlUrl, uploadedById } = params

  const scope = await resolveScopeOrNull(venueId)
  if (!scope) {
    throw new BadRequestError('Este negocio aún no tiene un RFC configurado. Configura la facturación (CFDI) primero.')
  }

  const { expense, conceptos } = parseCfdiReceived(xml, scope.rfc)
  if (expense.comprobanteTipo !== 'INGRESO') {
    throw new BadRequestError(
      `Este CFDI es de tipo ${expense.comprobanteTipo}, no una factura de compra. Las notas de crédito todavía no se pueden asociar.`,
    )
  }

  const existing = await prisma.purchaseOrderInvoice.findFirst({
    where: { venueId, uuid: expense.uuid ?? '' },
    select: { id: true },
  })
  if (existing) throw new ConflictError('Esta factura ya está registrada en este negocio.')

  // El proveedor se reconoce por su RFC. Si no está dado de alta (o no tiene RFC capturado),
  // la factura igual se guarda — con el emisor del CFDI como rastro — y se avisa.
  const supplier = await prisma.supplier.findFirst({
    where: { venueId, taxId: { equals: expense.proveedorRfc, mode: 'insensitive' } },
    select: { id: true },
  })

  const knownMaterials = supplier
    ? await loadKnownSupplierCodes(venueId, supplier.id)
    : new Map<string, { rawMaterialId: string | null; productId: string | null }>()

  let unidentifiedLines = 0
  const lines = conceptos.map(concepto => {
    const known = concepto.supplierItemCode ? knownMaterials.get(concepto.supplierItemCode) : null
    if (!known) unidentifiedLines += 1
    return {
      purchaseOrderItemId: null,
      rawMaterialId: known?.rawMaterialId ?? null,
      productId: known?.productId ?? null,
      supplierItemCode: concepto.supplierItemCode,
      descripcion: concepto.descripcion,
      claveProdServ: concepto.claveProdServ,
      claveUnidad: concepto.claveUnidad,
      cantidad: concepto.cantidad,
      valorUnitarioCents: concepto.valorUnitarioCents,
      importeCents: concepto.importeCents,
      descuentoCents: concepto.descuentoCents,
    }
  })

  const invoice = await prisma.purchaseOrderInvoice.create({
    data: {
      purchaseOrderId: null,
      venueId,
      supplierId: supplier?.id ?? null,
      uuid: expense.uuid ?? '',
      serie: expense.serie ?? null,
      folio: expense.folio ?? null,
      emisorRfc: expense.proveedorRfc,
      emisorNombre: expense.proveedorNombre,
      fechaEmision: new Date(`${expense.fechaEmision}T00:00:00.000Z`),
      subtotalCents: expense.subtotalCents,
      descuentoCents: expense.descuentoCents ?? 0,
      ivaCents: expense.ivaCents ?? 0,
      totalCents: expense.totalCents,
      xmlUrl: xmlUrl ?? null,
      matchStatus: 'NO_ORDER',
      matchNotes: {
        unidentifiedLines,
        totalLines: conceptos.length,
        ...(supplier ? {} : { supplierUnknown: true }),
      } as unknown as object,
      uploadedById: uploadedById ?? null,
      lines: { create: lines },
    },
    include: { lines: true },
  })

  logAction({
    staffId: uploadedById ?? undefined,
    venueId,
    action: 'PURCHASE_INVOICE_NO_ORDER',
    entity: 'PurchaseOrderInvoice',
    entityId: invoice.id,
    data: { uuid: invoice.uuid, unidentifiedLines, totalLines: conceptos.length, supplierFound: !!supplier },
  })

  return invoice
}

export interface IdentifyInvoiceLineParams {
  venueId: string
  invoiceId: string
  lineId: string
  rawMaterialId?: string | null
  productId?: string | null
  actorId?: string | null
}

/**
 * Una persona dice qué ES un renglón que los códigos no reconocieron — y el sistema lo
 * APRENDE: la siguiente factura de ese proveedor con ese código se identifica sola.
 * XOR estricto: insumo O producto (mismo patrón de tres capas que PurchaseOrderItem).
 */
export async function identifyInvoiceLine(params: IdentifyInvoiceLineParams) {
  const { venueId, invoiceId, lineId, actorId } = params
  const rawMaterialId = params.rawMaterialId ?? null
  const productId = params.productId ?? null

  if ((rawMaterialId && productId) || (!rawMaterialId && !productId)) {
    throw new BadRequestError('Un renglón es un insumo O un producto: exactamente uno de los dos.')
  }

  const line = await prisma.purchaseOrderInvoiceLine.findFirst({
    where: { id: lineId, invoiceId, invoice: { venueId } }, // acotado al negocio
    select: { id: true, supplierItemCode: true, descripcion: true, invoice: { select: { id: true, supplierId: true } } },
  })
  if (!line) throw new NotFoundError('Renglón de factura no encontrado en este negocio')

  // El destino tiene que existir EN ESTE negocio: un id ajeno no identifica nada.
  if (rawMaterialId) {
    const exists = await prisma.rawMaterial.findFirst({ where: { id: rawMaterialId, venueId }, select: { id: true } })
    if (!exists) throw new NotFoundError('Ese insumo no existe en este negocio')
  } else if (productId) {
    const exists = await prisma.product.findFirst({ where: { id: productId, venueId }, select: { id: true } })
    if (!exists) throw new NotFoundError('Ese producto no existe en este negocio')
  }

  const updated = await prisma.purchaseOrderInvoiceLine.update({
    where: { id: line.id },
    data: { rawMaterialId, productId },
  })

  // Aprender, si hay con qué: código del proveedor + proveedor conocido.
  if (line.supplierItemCode && line.invoice.supplierId) {
    await prisma.supplierItemCode.upsert({
      where: { venueId_supplierId_code: { venueId, supplierId: line.invoice.supplierId, code: line.supplierItemCode } },
      create: {
        venueId,
        supplierId: line.invoice.supplierId,
        code: line.supplierItemCode,
        rawMaterialId,
        productId,
        lastDescription: line.descripcion,
        createdById: actorId ?? null,
      },
      update: { rawMaterialId, productId, lastDescription: line.descripcion },
    })
    logAction({
      staffId: actorId ?? undefined,
      venueId,
      action: 'SUPPLIER_ITEM_CODE_LEARNED',
      entity: 'SupplierItemCode',
      entityId: `${line.invoice.supplierId}:${line.supplierItemCode}`,
      data: { code: line.supplierItemCode, rawMaterialId, productId },
    })
  }

  return updated
}

/** Facturas del negocio (con y sin orden), para la pestaña de facturas del proveedor. */
export async function listSupplierInvoices(venueId: string, filters: { supplierId?: string; onlyNoOrder?: boolean } = {}) {
  return prisma.purchaseOrderInvoice.findMany({
    where: {
      venueId,
      ...(filters.supplierId ? { supplierId: filters.supplierId } : {}),
      ...(filters.onlyNoOrder ? { purchaseOrderId: null } : {}),
    },
    include: {
      lines: true,
      supplier: { select: { id: true, name: true } },
      purchaseOrder: { select: { id: true, orderNumber: true } },
    },
    orderBy: { fechaEmision: 'desc' },
    take: 100,
  })
}

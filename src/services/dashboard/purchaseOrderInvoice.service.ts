import { BadRequestError, ConflictError, NotFoundError } from '../../errors/AppError'
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
      items: { select: { id: true, total: true, quantityOrdered: true } },
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

  // Los códigos que este proveedor ya usó en facturas anteriores. Es lo que hace que la
  // segunda factura del mismo proveedor case sola.
  const knownCodes = await loadKnownSupplierCodes(venueId, order.supplierId)

  const match = matchInvoiceLines(conceptos, orderLines, { knownCodes })
  const verdict = decideMatchVerdict({
    supplierMatches,
    invoiceTotalCents: expense.totalCents,
    orderTotalCents: Math.round(Number(order.total) * 100),
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
        create: match.lines.map(line => ({
          purchaseOrderItemId: line.purchaseOrderItemId,
          supplierItemCode: line.concepto.supplierItemCode,
          descripcion: line.concepto.descripcion,
          claveProdServ: line.concepto.claveProdServ,
          claveUnidad: line.concepto.claveUnidad,
          cantidad: line.concepto.cantidad,
          valorUnitarioCents: line.concepto.valorUnitarioCents,
          importeCents: line.concepto.importeCents,
          descuentoCents: line.concepto.descuentoCents,
        })),
      },
    },
    include: { lines: true },
  })

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
 * Códigos que este proveedor ya usó, con el renglón al que se asociaron.
 *
 * Se lee de las facturas anteriores del mismo proveedor EN ESTE NEGOCIO. En la fase 1 esto
 * casi siempre viene vacío; se llena solo conforme se concilian facturas, y es lo que
 * habilita la fase 2 sin trabajo extra.
 */
async function loadKnownSupplierCodes(venueId: string, supplierId: string): Promise<Record<string, string>> {
  const previous = await prisma.purchaseOrderInvoiceLine.findMany({
    where: {
      supplierItemCode: { not: null },
      purchaseOrderItemId: { not: null },
      invoice: { venueId, supplierId },
    },
    select: { supplierItemCode: true, purchaseOrderItemId: true },
    orderBy: { createdAt: 'desc' },
    take: 500,
  })

  const codes: Record<string, string> = {}
  for (const row of previous) {
    // El más reciente gana: si el proveedor reasignó un código, la última verdad manda.
    if (row.supplierItemCode && row.purchaseOrderItemId && !codes[row.supplierItemCode]) {
      codes[row.supplierItemCode] = row.purchaseOrderItemId
    }
  }
  return codes
}

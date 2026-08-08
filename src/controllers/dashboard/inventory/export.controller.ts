/**
 * Inventory and purchasing exports.
 *
 * The matrix answers "exportable" across inventory and purchasing; the generic helper
 * (`export.helpers.ts`) existed and was wired to exactly three listings. These follow the
 * same shape as those three, deliberately: count first, refuse over the cap, reuse the SAME
 * listing service the screen calls, then hand columns to `encodeExport`.
 *
 * Reusing the listing service is the load-bearing part. A second query built for the export
 * drifts from the one behind the screen, and then the file quietly disagrees with what the
 * user is looking at.
 */
import { NextFunction, Request, Response } from 'express'
import { PurchaseOrderStatus } from '@prisma/client'
import * as rawMaterialService from '../../../services/dashboard/rawMaterial.service'
import * as purchaseOrderService from '../../../services/dashboard/purchaseOrder.service'
import * as supplierService from '../../../services/dashboard/supplier.service'
import {
  encodeExport,
  sendExport,
  parseFormatParam,
  parseColumnsParam,
  getRowCapForFormat,
  type ExportColumnDef,
} from '../../../services/dashboard/export.helpers'

/**
 * Movement types in the reader's language. The enum value is our schema leaking into
 * someone else's report — "SPOILAGE" means nothing to the person counting the storeroom.
 */
const MOVEMENT_TYPE_LABEL: Record<string, string> = {
  PURCHASE: 'Compra',
  USAGE: 'Consumo',
  ADJUSTMENT: 'Ajuste',
  SPOILAGE: 'Merma',
  TRANSFER: 'Traspaso',
  TRANSFER_OUT: 'Traspaso salida',
  TRANSFER_IN: 'Traspaso entrada',
  COUNT: 'Conteo físico',
  RETURN: 'Devolución',
}

/** Purchase-order status in the reader's language. Same reason as the movement types. */
const PURCHASE_ORDER_STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Borrador',
  PENDING_APPROVAL: 'Pendiente de aprobación',
  REJECTED: 'Rechazada',
  APPROVED: 'Aprobada',
  SENT: 'Enviada',
  CONFIRMED: 'Confirmada',
  SHIPPED: 'En tránsito',
  PARTIAL: 'Recibida parcial',
  RECEIVED: 'Recibida',
  CANCELLED: 'Cancelada',
}

/** Per-line receive status. A line can lag its order, which is the point of the column. */
const PURCHASE_ORDER_ITEM_STATUS_LABEL: Record<string, string> = {
  PENDING: 'Pendiente',
  RECEIVED: 'Recibido',
  DAMAGED: 'Dañado',
  NOT_PROCESSED: 'No procesado',
}

/**
 * The shape `getPurchaseOrders` really returns.
 *
 * Its declared return type is the bare `PurchaseOrder` model — the service casts its `include`
 * away with `as any` — so the relations this export reads have to be spelled out here or every
 * access is checked against a type that lies about the query.
 */
type PurchaseOrderExportLine = {
  id: string
  rawMaterial: { name: string | null; sku: string | null } | null
  product: { name: string | null; sku: string | null } | null
  quantityOrdered: unknown
  quantityReceived: unknown
  unit: string | null
  unitPrice: unknown
  total: unknown
  receiveStatus: string | null
  notes: string | null
}

type PurchaseOrderWithLines = {
  id: string
  orderNumber: string
  status: string
  orderDate: Date | null
  expectedDeliveryDate: Date | null
  total: unknown
  supplier: { name: string | null } | null
  // Optional on purpose: the include always returns an array, but an order that somehow
  // arrives without one must skip its lines, not throw halfway through building the file.
  items?: PurchaseOrderExportLine[]
}

/** Current stock per raw material — the sheet someone walks the storeroom with. */
export async function exportRawMaterials(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const format = parseFormatParam(req.query.format)
    const requestedColumnIds = parseColumnsParam(req.query.columns)
    const cap = getRowCapForFormat(format)

    const filters = {
      category: req.query.category as string | undefined,
      lowStock: req.query.lowStock === 'true',
      active: req.query.active === 'true' ? true : req.query.active === 'false' ? false : undefined,
      search: req.query.search as string | undefined,
    }

    const refuseOverCap = (count: number): boolean => {
      if (count <= cap) return false
      res.status(413).json({
        success: false,
        message: `El rango contiene ${count.toLocaleString()} insumos. El máximo por exportación es ${cap.toLocaleString()}. Acota con filtros.`,
      })
      return true
    }

    // Pre-flight: refuse before pulling rows into memory. Skipped when `lowStock` is on,
    // because that filter compares two columns of the same row and therefore runs in memory —
    // the count would be an UPPER BOUND, and refusing on it would 413 a fifty-row file.
    if (!filters.lowStock) {
      const total = await rawMaterialService.countRawMaterialsForExport(venueId, filters)
      if (refuseOverCap(total)) return
    }

    const rows = await rawMaterialService.getRawMaterials(venueId, filters)
    // The exact gate: whatever the pre-flight said, the file itself never goes past the cap.
    // Truncating here would ship a plausible, incomplete sheet.
    if (refuseOverCap(rows.length)) return
    type Row = (typeof rows)[number]

    const allColumns: ExportColumnDef<Row>[] = [
      { id: 'name', label: 'Insumo', value: r => r.name },
      { id: 'sku', label: 'Clave', value: r => r.sku ?? '' },
      { id: 'category', label: 'Categoría', value: r => r.category ?? '' },
      { id: 'unit', label: 'Unidad', value: r => r.unit ?? '' },
      { id: 'currentStock', label: 'Existencia', value: r => Number(r.currentStock) || 0 },
      { id: 'reorderPoint', label: 'Punto de reorden', value: r => Number(r.reorderPoint) || 0 },
      { id: 'costPerUnit', label: 'Costo unitario', value: r => Number(r.costPerUnit) || 0 },
      // Computed here rather than left to the reader: the whole point of the sheet is what
      // the storeroom is worth, and a spreadsheet formula is one more thing to get wrong.
      { id: 'stockValue', label: 'Valor', value: r => Math.round(Number(r.currentStock ?? 0) * Number(r.costPerUnit ?? 0) * 100) / 100 },
      { id: 'active', label: 'Activo', value: r => (r.active ? 'Sí' : 'No') },
    ]

    const encoded = await encodeExport(format, {
      allColumns,
      requestedColumnIds: requestedColumnIds.length > 0 ? requestedColumnIds : allColumns.map(c => c.id),
      rows,
      title: 'Existencias',
    })

    sendExport(res, encoded, 'existencias')
  } catch (error) {
    next(error)
  }
}

/**
 * Kardex for one raw material — every movement, with the actor and the reason.
 *
 * The date params are parsed the same way the movements screen parses them, deliberately: the
 * export exists to hand someone the rows they are looking at, so a different parse here would
 * produce a file that plausibly disagrees with the dialog it was launched from.
 */
export async function exportStockMovements(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, rawMaterialId } = req.params
    const format = parseFormatParam(req.query.format)
    const requestedColumnIds = parseColumnsParam(req.query.columns)
    const cap = getRowCapForFormat(format)

    const filters = {
      startDate: req.query.startDate ? new Date(req.query.startDate as string) : undefined,
      endDate: req.query.endDate ? new Date(req.query.endDate as string) : undefined,
    }

    const total = await rawMaterialService.countStockMovementsForExport(venueId, rawMaterialId, filters)
    if (total > cap) {
      res.status(413).json({
        success: false,
        message: `El rango contiene ${total.toLocaleString()} movimientos. El máximo por exportación es ${cap.toLocaleString()}. Acota el rango de fechas.`,
      })
      return
    }

    // The cap is passed as the limit on purpose. The listing service defaults to 100 rows;
    // inheriting that default would ship a fraction of the range without a 413 to warn anyone.
    const rows = await rawMaterialService.fetchStockMovementsForExport(venueId, rawMaterialId, filters, cap)
    type Row = (typeof rows)[number]

    const allColumns: ExportColumnDef<Row>[] = [
      { id: 'createdAt', label: 'Fecha', value: r => r.createdAt?.toISOString() ?? '' },
      { id: 'rawMaterialName', label: 'Insumo', value: r => r.rawMaterialName ?? '' },
      // Fall back to the raw enum instead of a blank cell: an untranslated type still tells the
      // reader what happened, an empty one loses the row's meaning entirely.
      { id: 'type', label: 'Movimiento', value: r => MOVEMENT_TYPE_LABEL[r.type] ?? r.type ?? '' },
      { id: 'quantity', label: 'Cantidad', value: r => Number(r.quantity) || 0 },
      { id: 'unit', label: 'Unidad', value: r => r.unit ?? '' },
      { id: 'previousStock', label: 'Existencia anterior', value: r => Number(r.previousStock) || 0 },
      { id: 'newStock', label: 'Existencia nueva', value: r => Number(r.newStock) || 0 },
      { id: 'costImpact', label: 'Impacto en costo', value: r => Number(r.costImpact ?? 0) || 0 },
      { id: 'reason', label: 'Motivo', value: r => r.reason ?? '' },
      { id: 'reference', label: 'Referencia', value: r => r.reference ?? '' },
      // The whole point of the report: an adjustment with no name attached is unauditable.
      { id: 'staffName', label: 'Responsable', value: r => r.staffName ?? '' },
    ]

    const encoded = await encodeExport(format, {
      allColumns,
      requestedColumnIds: requestedColumnIds.length > 0 ? requestedColumnIds : allColumns.map(c => c.id),
      rows,
      title: 'Kardex',
    })

    sendExport(res, encoded, 'kardex')
  } catch (error) {
    next(error)
  }
}

/**
 * Purchase orders, ONE ROW PER LINE.
 *
 * The row is the line, not the order, because that is the unit being audited: a controller
 * reconciling against a supplier invoice compares article, quantity and unit price. An
 * order-level file hides exactly that. The order header (number, date, supplier, status,
 * total) repeats on every line so the file still groups cleanly in a pivot table without the
 * reader rebuilding the relationship by hand.
 */
export async function exportPurchaseOrders(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const format = parseFormatParam(req.query.format)
    const requestedColumnIds = parseColumnsParam(req.query.columns)
    const cap = getRowCapForFormat(format)

    // Parsed exactly like the listing screen parses it, repeated param and all: a different
    // parse here exports a plausible file for a different set of orders.
    const status = req.query.status
    const statusArray = status ? ((Array.isArray(status) ? status : [status]) as PurchaseOrderStatus[]) : undefined

    const filters = {
      status: statusArray,
      supplierId: req.query.supplierId as string | undefined,
      startDate: req.query.startDate ? new Date(req.query.startDate as string) : undefined,
      endDate: req.query.endDate ? new Date(req.query.endDate as string) : undefined,
    }

    // Counts LINES, matching what the file will contain. Counting orders instead would wave
    // through a file dozens of times over the cap.
    const total = await purchaseOrderService.countPurchaseOrdersForExport(venueId, filters)
    if (total > cap) {
      res.status(413).json({
        success: false,
        message: `El rango contiene ${total.toLocaleString()} renglones de compra. El máximo por exportación es ${cap.toLocaleString()}. Acota con filtros.`,
      })
      return
    }

    const orders = (await purchaseOrderService.getPurchaseOrders(venueId, filters)) as unknown as PurchaseOrderWithLines[]

    const rows = orders.flatMap(order =>
      (order.items ?? []).map(item => ({
        ...item,
        orderNumber: order.orderNumber,
        orderDate: order.orderDate,
        expectedDeliveryDate: order.expectedDeliveryDate,
        status: order.status,
        supplierName: order.supplier?.name ?? '',
        orderTotal: Number(order.total) || 0,
      })),
    )
    type Row = (typeof rows)[number]

    const allColumns: ExportColumnDef<Row>[] = [
      { id: 'orderNumber', label: 'Orden', value: r => r.orderNumber ?? '' },
      { id: 'orderDate', label: 'Fecha', value: r => r.orderDate?.toISOString() ?? '' },
      { id: 'expectedDeliveryDate', label: 'Entrega esperada', value: r => r.expectedDeliveryDate?.toISOString() ?? '' },
      { id: 'supplierName', label: 'Proveedor', value: r => r.supplierName ?? '' },
      // Fall back to the raw enum instead of a blank cell: an untranslated status still tells
      // the reader where the order stands, an empty one loses it.
      { id: 'status', label: 'Estado', value: r => PURCHASE_ORDER_STATUS_LABEL[r.status] ?? r.status ?? '' },
      // XOR: a line is either a raw material or a resale product, never both and never neither
      // (there is a CHECK constraint on the table). Reading only `rawMaterial` is how resale
      // lines ended up anonymous everywhere else in this codebase.
      { id: 'article', label: 'Artículo', value: r => r.rawMaterial?.name ?? r.product?.name ?? '' },
      { id: 'sku', label: 'Clave', value: r => r.rawMaterial?.sku ?? r.product?.sku ?? '' },
      { id: 'quantityOrdered', label: 'Cantidad pedida', value: r => Number(r.quantityOrdered) || 0 },
      { id: 'quantityReceived', label: 'Cantidad recibida', value: r => Number(r.quantityReceived) || 0 },
      { id: 'unit', label: 'Unidad', value: r => r.unit ?? '' },
      { id: 'unitPrice', label: 'Precio unitario', value: r => Number(r.unitPrice) || 0 },
      { id: 'lineTotal', label: 'Importe del renglón', value: r => Number(r.total) || 0 },
      {
        id: 'receiveStatus',
        label: 'Estado del renglón',
        value: r => PURCHASE_ORDER_ITEM_STATUS_LABEL[r.receiveStatus ?? ''] ?? r.receiveStatus ?? '',
      },
      // Repeated on every line on purpose — it is what makes the file groupable.
      { id: 'orderTotal', label: 'Total de la orden', value: r => Number(r.orderTotal) || 0 },
      { id: 'notes', label: 'Notas', value: r => r.notes ?? '' },
    ]

    const encoded = await encodeExport(format, {
      allColumns,
      requestedColumnIds: requestedColumnIds.length > 0 ? requestedColumnIds : allColumns.map(c => c.id),
      rows,
      title: 'Órdenes de compra',
    })

    sendExport(res, encoded, 'ordenes-de-compra')
  } catch (error) {
    next(error)
  }
}

/** Supplier directory — the sheet someone takes to renegotiate terms. */
export async function exportSuppliers(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const format = parseFormatParam(req.query.format)
    const requestedColumnIds = parseColumnsParam(req.query.columns)
    const cap = getRowCapForFormat(format)

    const filters = {
      active: req.query.active === 'true' ? true : req.query.active === 'false' ? false : undefined,
      search: req.query.search as string | undefined,
      rating: req.query.rating ? parseFloat(req.query.rating as string) : undefined,
    }

    const refuseOverCap = (count: number): boolean => {
      if (count <= cap) return false
      res.status(413).json({
        success: false,
        message: `El rango contiene ${count.toLocaleString()} proveedores. El máximo por exportación es ${cap.toLocaleString()}. Acota con filtros.`,
      })
      return true
    }

    // Counted before fetching, like every other export here. `getSuppliers` is unpaginated AND
    // drags each supplier's pricing rows and five latest purchase orders along, so "fetch then
    // decide" pulls the whole directory into memory precisely in the case we mean to refuse.
    const total = await supplierService.countSuppliersForExport(venueId, filters)
    if (refuseOverCap(total)) return

    const rows = await supplierService.getSuppliers(venueId, filters)
    // The exact gate: the file itself never goes past the cap, whatever the pre-flight said.
    if (refuseOverCap(rows.length)) return

    type Row = (typeof rows)[number]

    const allColumns: ExportColumnDef<Row>[] = [
      { id: 'name', label: 'Proveedor', value: r => r.name },
      { id: 'contactName', label: 'Contacto', value: r => r.contactName ?? '' },
      { id: 'email', label: 'Correo', value: r => r.email ?? '' },
      { id: 'phone', label: 'Teléfono', value: r => r.phone ?? '' },
      { id: 'taxId', label: 'RFC', value: r => r.taxId ?? '' },
      { id: 'leadTimeDays', label: 'Días de entrega', value: r => Number(r.leadTimeDays) || 0 },
      { id: 'minimumOrder', label: 'Pedido mínimo', value: r => Number(r.minimumOrder) || 0 },
      { id: 'rating', label: 'Calificación', value: r => Number(r.rating) || 0 },
      { id: 'active', label: 'Activo', value: r => (r.active ? 'Sí' : 'No') },
    ]

    const encoded = await encodeExport(format, {
      allColumns,
      requestedColumnIds: requestedColumnIds.length > 0 ? requestedColumnIds : allColumns.map(c => c.id),
      rows,
      title: 'Proveedores',
    })

    sendExport(res, encoded, 'proveedores')
  } catch (error) {
    next(error)
  }
}

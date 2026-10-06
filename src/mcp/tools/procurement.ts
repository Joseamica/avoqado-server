import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { planGateMessage } from '../planGate'
import { createSupplier, getSuppliersPage } from '@/services/dashboard/supplier.service'
import prisma from '@/utils/prismaClient'
import { CreateSupplierSchema } from '@/schemas/dashboard/inventory.schema'
import { getPurchaseOrders, getPurchaseOrder } from '@/services/dashboard/purchaseOrder.service'
import { auditMcpWrite } from '../audit'
import { invoiceLineIdentification } from '@/schemas/dashboard/supplierInvoiceInventory.schema'
import { PurchaseOrderStatus } from '@prisma/client'

// Procurement (suppliers + purchase orders) is part of inventory — gate it exactly like the
// other inventory READ tools: the PREMIUM INVENTORY_TRACKING feature. Reads, so venue-scoped
// (own venues only) but no per-action permission, matching low_stock / stock_value / kardex.
const INVENTORY_GATE = ['INVENTORY_TRACKING', 'El control de inventario'] as const

const PO_STATUS_MAP: Record<string, PurchaseOrderStatus> = {
  draft: PurchaseOrderStatus.DRAFT,
  pending_approval: PurchaseOrderStatus.PENDING_APPROVAL,
  rejected: PurchaseOrderStatus.REJECTED,
  approved: PurchaseOrderStatus.APPROVED,
  sent: PurchaseOrderStatus.SENT,
  confirmed: PurchaseOrderStatus.CONFIRMED,
  shipped: PurchaseOrderStatus.SHIPPED,
  partial: PurchaseOrderStatus.PARTIAL,
  received: PurchaseOrderStatus.RECEIVED,
  cancelled: PurchaseOrderStatus.CANCELLED,
}

// Decimal | number | null → number | null (pesos, 1:1 — never cents).
const num = (v: unknown): number | null => (v == null ? null : Number(v))

export function registerProcurementTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  server.tool(
    'list_suppliers',
    'Suppliers / vendors (proveedores) of a venue you can access: name, contact (person, email, phone), rating, average lead time (days to deliver), minimum order value, and whether active. Defaults to active suppliers. Optionally filter by a name/contact/email search. Answers "¿qué proveedores tengo? ¿a quién le compro X? ¿cuál es el más confiable?". Pass venueId. PREMIUM (INVENTORY_TRACKING). For their orders use list_purchase_orders.',
    {
      venueId: z.string().describe('Venue whose suppliers to list (must be in your scope)'),
      search: z.string().optional().describe('Filter by name / contact / email (partial, case-insensitive)'),
      includeInactive: z.boolean().optional().describe('Also include inactive suppliers (default: only active)'),
      limit: z.number().int().positive().max(100).optional().describe('Max suppliers to return (default 50)'),
      offset: z.number().int().min(0).optional().describe('Continue using nextOffset from the previous page'),
    },
    async ({ venueId, search, includeInactive, limit = 50, offset = 0 }) => {
      guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('inventory:read', venueId) // WHY: mirror the dashboard's inventory:read gate — supplier PII + PO line prices aren't free-for-all
      const gate = await planGateMessage(venueId, ...INVENTORY_GATE) // PREMIUM tier — mirrors inventory reads
      if (gate) return text({ ok: false, planRequired: true, error: gate })

      const { rows, total } = await getSuppliersPage(
        venueId,
        {
          ...(includeInactive ? {} : { active: true }),
          ...(search ? { search } : {}),
        },
        { limit, offset },
      )
      const hasMore = offset + rows.length < total
      return text({
        venueId,
        count: rows.length,
        total,
        limit,
        offset,
        hasMore,
        nextOffset: hasMore ? offset + rows.length : null,
        suppliers: rows.map(s => ({
          id: s.id,
          name: s.name,
          contactName: s.contactName,
          email: s.email,
          phone: s.phone,
          rating: num(s.rating), // 1.0–5.0
          leadTimeDays: s.leadTimeDays,
          minimumOrder: num(s.minimumOrder), // pesos
          active: s.active,
        })),
      })
    },
  )

  server.tool(
    'create_supplier',
    'Create ONE supplier in the selected venue. First search list_suppliers to avoid duplicates. Require its actual name; ask for any contact or delivery details needed instead of inventing them. Preview by default, then use the returned confirmation arguments and token after approval. An existing name (including inactive suppliers) is refused with its id. After a timeout search by name before retrying. Requires inventory:create, mcp:write and PREMIUM (INVENTORY_TRACKING).',
    {
      venueId: z.string().min(1),
      name: z.string().trim().min(1, 'El nombre es requerido').max(200),
      contactName: z.string().max(200).optional(),
      email: z.string().email('El correo no es válido').optional(),
      phone: z.string().max(50).optional(),
      leadTimeDays: z.number().int().positive().max(365).optional(),
      notes: z.string().max(2000).optional(),
      confirm: z.boolean().optional(),
    },
    async ({ venueId, confirm, ...fields }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('inventory:create', venueId)
      const gate = await planGateMessage(venueId, ...INVENTORY_GATE)
      if (gate) return text({ ok: false, planRequired: true, error: gate })
      const existing = await prisma.supplier.findFirst({
        where: { venueId, name: { equals: fields.name, mode: 'insensitive' } },
        select: { id: true, name: true, active: true, deletedAt: true },
      })
      if (existing)
        return text({
          ok: false,
          needsInput: true,
          existingSupplier: { id: existing.id, name: existing.name, active: existing.active, archived: existing.deletedAt !== null },
          error:
            'Este proveedor ya existe. Verifica si corresponde a lo solicitado; no lo crees de nuevo ni cambies su nombre para duplicarlo.',
        })
      const data = CreateSupplierSchema.shape.body.parse(fields)
      if (!confirm)
        return text({
          ok: true,
          requiresConfirmation: true,
          venueId,
          supplier: data,
          message: `Crear el proveedor "${data.name}" en esta sucursal. Plazo inicial ${data.leadTimeDays} días (valor predeterminado si no se indicó). Confirma los datos mostrados.`,
        })
      const created = await createSupplier(venueId, data, { staffId: scope.staffId, source: 'customer-mcp' })
      return text({
        ok: true,
        venueId,
        supplier: { id: created.id, name: created.name },
        message: 'Proveedor creado. Conserva su id para verificarlo antes de reintentar.',
      })
    },
  )

  server.tool(
    'supplier_invoices',
    'Supplier CFDI invoices of ONE venue (phase 2): both order-attached and standalone (NO_ORDER). Shows match verdict (MATCHED / PARTIAL / AMOUNT_MISMATCH / LINES_MISMATCH / SUPPLIER_MISMATCH / NO_ORDER), totals in pesos, and per-line identification. Never touches inventory or costs.',
    {
      venueId: z.string().describe('Venue whose supplier invoices to read'),
      supplierId: z.string().optional().describe('Filter by supplier'),
      onlyNoOrder: z.boolean().optional().describe('Only standalone invoices (no purchase order)'),
    },
    async ({ venueId, supplierId, onlyNoOrder }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('inventory:read', venueId)
      const { listSupplierInvoices } = await import('../../services/dashboard/purchaseOrderInvoice.service')
      const invoices = await listSupplierInvoices(venueId, { supplierId, onlyNoOrder })
      return text(
        invoices.map(inv => ({
          id: inv.id,
          uuid: inv.uuid,
          supplier: inv.supplier?.name ?? inv.emisorNombre,
          purchaseOrder: inv.purchaseOrder?.orderNumber ?? null,
          fechaEmision: inv.fechaEmision,
          total: inv.totalCents / 100, // pesos, unidades mayores
          matchStatus: inv.matchStatus,
          lines: inv.lines.length,
          unidentifiedLines: inv.lines.filter(l => !l.rawMaterialId && !l.productId && !l.purchaseOrderItemId).length,
        })),
      )
    },
  )

  server.tool(
    'import_supplier_invoice_xml',
    'Register a supplier purchase XML in ONE branch and identify known supplier codes. Uploading records evidence only; stock is received separately with supplier_invoice_inventory after human review and purchase authorization. Requires inventory:update, mcp:write and Premium inventory plus CFDI. Only use an XML provided by the operator.',
    {
      venueId: z.string().min(1),
      xml: z
        .string()
        .min(1)
        .max(2 * 1024 * 1024),
    },
    async ({ venueId, xml }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('inventory:update', venueId)
      guard.requirePermission('mcp:write', venueId)
      for (const code of ['INVENTORY_TRACKING', 'CFDI']) {
        const gate = await planGateMessage(venueId, code, 'Las compras desde XML')
        if (gate) return text({ ok: false, planRequired: true, error: gate })
      }
      const { registerSupplierInvoice } = await import('../../services/dashboard/purchaseOrderInvoice.service')
      const invoice = await registerSupplierInvoice({ venueId, xml, uploadedById: scope.staffId })
      await auditMcpWrite(scope, { venueId, action: 'SUPPLIER_INVOICE_IMPORTED', entity: 'PurchaseOrderInvoice', entityId: invoice.id })
      return text({
        ok: true,
        invoiceId: invoice.id,
        uuid: invoice.uuid,
        total: invoice.totalCents / 100,
        lines: invoice.lines.map(l => ({
          id: l.id,
          description: l.descripcion,
          quantity: Number(l.cantidad),
          satUnit: l.claveUnidad,
          rawMaterialId: l.rawMaterialId,
          productId: l.productId,
          purchaseUnit: l.purchaseUnit,
          presentationName: l.presentationName,
          netAmount: (l.importeCents - l.descuentoCents) / 100,
        })),
        message: 'XML registrado. Revisa los artículos y unidades antes de preparar la compra. El inventario todavía no cambió.',
      })
    },
  )

  server.tool(
    'identify_supplier_invoice_line',
    'Identify ONE supplier invoice line using the exact raw material OR resale product id selected by the operator. Optionally confirm the purchase unit or an existing purchase presentation. A box needs its actual presentation; never assume one box equals one base unit. The supplier code remembers the chosen item and presentation for future XMLs. Requires inventory:update, mcp:write and Premium inventory plus CFDI.',
    { venueId: z.string().min(1), invoiceId: z.string().min(1), lineId: z.string().min(1), ...invoiceLineIdentification.shape },
    async ({ venueId, invoiceId, lineId, ...fields }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('inventory:update', venueId)
      guard.requirePermission('mcp:write', venueId)
      for (const code of ['INVENTORY_TRACKING', 'CFDI']) {
        const gate = await planGateMessage(venueId, code, 'Las compras desde XML')
        if (gate) return text({ ok: false, planRequired: true, error: gate })
      }
      const { identifyInvoiceLine } = await import('../../services/dashboard/purchaseOrderInvoice.service')
      const line = await identifyInvoiceLine({ venueId, invoiceId, lineId, ...fields, actorId: scope.staffId })
      await auditMcpWrite(scope, {
        venueId,
        action: 'SUPPLIER_INVOICE_LINE_IDENTIFIED',
        entity: 'PurchaseOrderInvoiceLine',
        entityId: lineId,
        data: fields,
      })
      return text({
        ok: true,
        lineId: line.id,
        rawMaterialId: line.rawMaterialId,
        productId: line.productId,
        purchaseUnit: line.purchaseUnit,
        presentationName: line.presentationName,
      })
    },
  )

  server.tool(
    'supplier_invoice_inventory',
    'Review a supplier XML purchase in ONE branch before changing inventory. An invoice without a purchase order prepares a purchase pending authorization; an authorized purchase can be received once. Shows actual base quantities, presentations and net costs in pesos. IVA is excluded; explicitly choose whether IEPS belongs in cost. First call returns a Spanish preview and confirmationToken. After operator approval call with confirm:true and that exact token. Ordinary order-attached invoices and already received purchases cannot add stock again. Requires inventory:create, inventory:update, mcp:write and Premium inventory plus CFDI.',
    {
      venueId: z.string().min(1),
      invoiceId: z.string().min(1),
      includeIeps: z.boolean().optional(),
      confirm: z.boolean().optional(),
      confirmationToken: z.string().optional(),
    },
    async ({ venueId, invoiceId, includeIeps = false, confirm: confirmed, confirmationToken }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('inventory:create', venueId)
      guard.requirePermission('inventory:update', venueId)
      guard.requirePermission('mcp:write', venueId)
      for (const code of ['INVENTORY_TRACKING', 'CFDI']) {
        const gate = await planGateMessage(venueId, code, 'Las compras desde XML')
        if (gate) return text({ ok: false, planRequired: true, error: gate })
      }
      const { previewSupplierInvoiceInventory, confirmSupplierInvoiceInventory } = await import(
        '../../services/dashboard/supplierInvoiceInventory.service'
      )
      if (!confirmed || !confirmationToken) {
        const review = await previewSupplierInvoiceInventory(venueId, invoiceId, includeIeps)
        return text({
          ok: false,
          requiresConfirmation: true,
          review,
          message:
            review.action === 'PREPARE'
              ? 'Confirma los artículos, unidades y costos. Se creará una compra pendiente de autorización; todavía no se sumará inventario.'
              : 'Confirma las cantidades base y costos mostrados. La mercancía se sumará una sola vez al inventario.',
        })
      }
      const result = await confirmSupplierInvoiceInventory(venueId, invoiceId, confirmationToken, scope.staffId, includeIeps)
      await auditMcpWrite(scope, {
        venueId,
        action: 'SUPPLIER_INVOICE_INVENTORY_CONFIRMED',
        entity: 'PurchaseOrderInvoice',
        entityId: invoiceId,
        data: result,
      })
      return text({ ok: true, ...result })
    },
  )

  server.tool(
    'list_purchase_orders',
    'Purchase orders (órdenes de compra) of a venue you can access: order number, supplier, status (draft/pending_approval/approved/sent/received/cancelled…), order date, expected delivery, total amount (pesos), how many line items, and whether it was auto-generated by the reorder job. Newest first. Filter by status. Answers "¿qué órdenes de compra tengo pendientes? ¿qué le pedí a tal proveedor? ¿cuáles ya llegaron?". Pass venueId. PREMIUM (INVENTORY_TRACKING). For the line items of one order use purchase_order_detail.',
    {
      venueId: z.string().describe('Venue whose purchase orders to list (must be in your scope)'),
      status: z
        .enum(['draft', 'pending_approval', 'rejected', 'approved', 'sent', 'confirmed', 'shipped', 'partial', 'received', 'cancelled'])
        .optional()
        .describe('Filter by status (omit for all)'),
      limit: z.number().int().positive().max(100).optional().describe('Max orders to return (default 25, newest first)'),
    },
    async ({ venueId, status, limit }) => {
      guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('inventory:read', venueId) // WHY: mirror the dashboard's inventory:read gate — supplier PII + PO line prices aren't free-for-all
      const gate = await planGateMessage(venueId, ...INVENTORY_GATE) // PREMIUM tier
      if (gate) return text({ ok: false, planRequired: true, error: gate })

      const orders = await getPurchaseOrders(venueId, {
        ...(status ? { status: [PO_STATUS_MAP[status]] } : {}),
      })
      const rows = orders.slice(0, limit ?? 25)
      return text({
        venueId,
        count: rows.length,
        purchaseOrders: rows.map(po => ({
          id: po.id,
          orderNumber: po.orderNumber,
          supplier: (po as { supplier?: { name?: string } }).supplier?.name ?? null,
          status: po.status,
          orderDate: po.orderDate.toISOString(),
          expectedDeliveryDate: po.expectedDeliveryDate?.toISOString() ?? null,
          receivedDate: po.receivedDate?.toISOString() ?? null,
          // Quién recibió la mercancía. Va junto a la fecha porque una recepción sin
          // responsable no sirve para auditar, que es para lo que se consulta.
          receivedBy: (po as { receivedBy?: string | null }).receivedBy ?? null,
          total: num(po.total), // pesos
          itemCount: (po as { items?: unknown[] }).items?.length ?? 0,
          autoGenerated: po.autoGenerated, // true = created by the auto-reorder job
        })),
      })
    },
  )

  server.tool(
    'purchase_order_detail',
    'Full detail of ONE purchase order in a venue you can access, by its id (from list_purchase_orders): supplier + contact, status, order/expected/received dates, amounts (subtotal, tax, total — pesos), whether auto-generated, approval/rejection info, notes, and every LINE ITEM (nombre del artículo, su `tipo` — INSUMO de cocina o MERCANCIA_DE_REVENTA para tienda de conveniencia —, unit, quantity ordered vs received, receive status, unit price, line total, and — si el insumo se compró en presentación — la unidad de compra ("caja") y cuántas unidades base trae). Answers "¿qué traía la orden OC-123? ¿cuánto recibí de cada cosa?". Pass venueId + purchaseOrderId.',
    {
      venueId: z.string().describe('Venue that owns the order (must be in your scope)'),
      purchaseOrderId: z.string().min(1).describe('Purchase order id (from list_purchase_orders)'),
    },
    async ({ venueId, purchaseOrderId }) => {
      guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('inventory:read', venueId) // WHY: mirror the dashboard's inventory:read gate — supplier PII + PO line prices aren't free-for-all
      const gate = await planGateMessage(venueId, ...INVENTORY_GATE) // PREMIUM tier
      if (gate) return text({ ok: false, planRequired: true, error: gate })

      const po = await getPurchaseOrder(venueId, purchaseOrderId)
      if (!po) return text({ found: false, error: `No encontré la orden de compra "${purchaseOrderId}" en este local.` })

      const supplier = (po as { supplier?: { name?: string; contactName?: string | null; email?: string | null; phone?: string | null } })
        .supplier
      const items = (
        po as {
          items?: Array<{
            // Un renglón apunta a un insumo de cocina O a un producto de reventa
            // (tienda de conveniencia). Si sólo se lee `rawMaterial`, las órdenes de
            // mercancía salen con el nombre en null y el operador recibe renglones
            // anónimos con precio: parece que la orden está vacía cuando no lo está.
            rawMaterial?: { name?: string; sku?: string | null; unit?: string } | null
            product?: { name?: string; sku?: string | null; unit?: string } | null
            unit: string
            presentationName?: string | null
            presentationFactor?: unknown
            quantityOrdered: unknown
            quantityReceived: unknown
            receiveStatus: string
            unitPrice: unknown
            total: unknown
          }>
        }
      ).items
      return text({
        found: true,
        purchaseOrder: {
          id: po.id,
          orderNumber: po.orderNumber,
          status: po.status,
          supplier: supplier
            ? {
                name: supplier.name ?? null,
                contactName: supplier.contactName ?? null,
                email: supplier.email ?? null,
                phone: supplier.phone ?? null,
              }
            : null,
          orderDate: po.orderDate.toISOString(),
          expectedDeliveryDate: po.expectedDeliveryDate?.toISOString() ?? null,
          receivedDate: po.receivedDate?.toISOString() ?? null,
          // Quién recibió la mercancía. Va junto a la fecha porque una recepción sin
          // responsable no sirve para auditar, que es para lo que se consulta.
          receivedBy: (po as { receivedBy?: string | null }).receivedBy ?? null,
          subtotal: num(po.subtotal),
          taxAmount: num(po.taxAmount),
          total: num(po.total),
          autoGenerated: po.autoGenerated,
          approvedAt: po.approvedAt?.toISOString() ?? null,
          rejectionReason: po.rejectionReason ?? null,
          notes: po.notes ?? null,
          items: (items ?? []).map(it => ({
            // `material` se conserva por compatibilidad (nunca se quita un campo de
            // una respuesta), pero ahora también resuelve el producto de reventa.
            material: it.rawMaterial?.name ?? it.product?.name ?? null,
            sku: it.rawMaterial?.sku ?? it.product?.sku ?? null,
            // Qué se compró: insumo de cocina o mercancía para revender. Sin esto el
            // agente no puede distinguir "compré harina" de "compré refrescos", que es
            // justo la diferencia entre un restaurante y una tienda.
            tipo: it.product ? 'MERCANCIA_DE_REVENTA' : 'INSUMO',
            unit: it.unit,
            // Comprado en presentación ("50 cajas"): sin esto el agente reporta
            // "50" sin saber 50 de QUÉ, y el precio parece 360 por pieza.
            purchaseUnit: it.presentationName ?? null,
            baseUnitsPerPurchaseUnit: it.presentationFactor != null ? num(it.presentationFactor) : null,
            quantityOrdered: num(it.quantityOrdered),
            quantityReceived: num(it.quantityReceived),
            receiveStatus: it.receiveStatus, // PENDING | PARTIAL | RECEIVED …
            unitPrice: num(it.unitPrice), // pesos
            total: num(it.total), // pesos
          })),
        },
      })
    },
  )
}

import { NextFunction, Request, Response } from 'express'
import * as invoiceService from '../../../services/dashboard/purchaseOrderInvoice.service'
import prisma from '../../../utils/prismaClient'
import {
  confirmSupplierInvoiceInventory,
  previewSupplierInvoiceInventory,
} from '../../../services/dashboard/supplierInvoiceInventory.service'
import { getInvoiceInventoryCatalog, getSupplierInvoiceInbox } from '../../../services/dashboard/supplierInvoiceInbox.service'
import {
  invoiceInventoryConfirmation,
  invoiceInventoryPage,
  invoiceLineIdentification,
} from '../../../schemas/dashboard/supplierInvoiceInventory.schema'
import { z } from 'zod'

/** POST /purchase-orders/:purchaseOrderId/invoices — sube el CFDI del proveedor y lo concilia. */
export async function attachInvoice(
  req: Request<{ venueId: string; purchaseOrderId: string }, {}, { xml: string; xmlUrl?: string | null }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const uploadedById = (req as any).authContext?.userId ?? null
    const invoice = await invoiceService.attachInvoiceToPurchaseOrder({
      venueId: req.params.venueId,
      purchaseOrderId: req.params.purchaseOrderId,
      xml: req.body.xml,
      xmlUrl: req.body.xmlUrl ?? null,
      uploadedById,
    })
    res.status(201).json(invoice)
  } catch (error) {
    next(error)
  }
}

/** GET /purchase-orders/:purchaseOrderId/invoices — facturas ya asociadas a la orden. */
export async function listInvoices(
  req: Request<{ venueId: string; purchaseOrderId: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId, purchaseOrderId } = req.params
    const invoices = await prisma.purchaseOrderInvoice.findMany({
      // Acotado al negocio: un id de orden ajeno no devuelve nada.
      where: { purchaseOrderId, venueId },
      include: { lines: true, purchaseOrder: { select: { id: true, orderNumber: true, status: true } } },
      orderBy: { fechaEmision: 'desc' },
    })
    res.status(200).json(invoices)
  } catch (error) {
    next(error)
  }
}

/** POST /supplier-invoices — fase 2: la factura que llegó SIN orden. Se registra, se identifica lo aprendido. */
export async function registerStandalone(
  req: Request<{ venueId: string }, {}, { xml: string; xmlUrl?: string | null }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const uploadedById = (req as any).authContext?.userId ?? null
    const invoice = await invoiceService.registerSupplierInvoice({
      venueId: req.params.venueId,
      xml: req.body.xml,
      xmlUrl: req.body.xmlUrl ?? null,
      uploadedById,
    })
    res.status(201).json(invoice)
  } catch (error) {
    next(error)
  }
}

/** GET /supplier-invoices — todas las facturas del negocio (con y sin orden). */
export async function listAll(
  req: Request<{ venueId: string }, {}, {}, { supplierId?: string; onlyNoOrder?: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const invoices = await invoiceService.listSupplierInvoices(req.params.venueId, {
      supplierId: req.query.supplierId,
      onlyNoOrder: req.query.onlyNoOrder === 'true',
    })
    res.status(200).json(invoices)
  } catch (error) {
    next(error)
  }
}

/** POST /purchase-invoices/:invoiceId/lines/:lineId/identify — una persona confirma qué ES el renglón, y se aprende. */
export async function identifyLine(
  req: Request<{ venueId: string; invoiceId: string; lineId: string }, {}, { rawMaterialId?: string | null; productId?: string | null }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const line = await invoiceService.identifyInvoiceLine({
      venueId: req.params.venueId,
      invoiceId: req.params.invoiceId,
      lineId: req.params.lineId,
      ...(req.body as z.infer<typeof invoiceLineIdentification>),
      actorId: (req as any).authContext?.userId ?? null,
    })
    res.status(200).json(line)
  } catch (error) {
    next(error)
  }
}

export async function invoiceInbox(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { page, limit, search } = req.query as unknown as z.infer<typeof invoiceInventoryPage>
    res.json(await getSupplierInvoiceInbox(req.params.venueId, page, limit, search))
  } catch (error) {
    next(error)
  }
}

export async function inventoryCatalog(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { page, limit, search, kind } = req.query as unknown as z.infer<typeof invoiceInventoryPage> & { kind: 'RAW' | 'PRODUCT' }
    res.json(await getInvoiceInventoryCatalog(req.params.venueId, kind, page, limit, search))
  } catch (error) {
    next(error)
  }
}

export async function previewInventory(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json(await previewSupplierInvoiceInventory(req.params.venueId, req.params.invoiceId, req.query.includeIeps === 'true'))
  } catch (error) {
    next(error)
  }
}

export async function confirmInventory(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { confirmationToken, includeIeps } = req.body as z.infer<typeof invoiceInventoryConfirmation>
    const result = await confirmSupplierInvoiceInventory(
      req.params.venueId,
      req.params.invoiceId,
      confirmationToken,
      (req as any).authContext.userId,
      includeIeps,
    )
    res.status(200).json(result)
  } catch (error) {
    next(error)
  }
}

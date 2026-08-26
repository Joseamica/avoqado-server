import { NextFunction, Request, Response } from 'express'
import * as invoiceService from '../../../services/dashboard/purchaseOrderInvoice.service'
import prisma from '../../../utils/prismaClient'

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
      include: { lines: true },
      orderBy: { fechaEmision: 'desc' },
    })
    res.status(200).json(invoices)
  } catch (error) {
    next(error)
  }
}

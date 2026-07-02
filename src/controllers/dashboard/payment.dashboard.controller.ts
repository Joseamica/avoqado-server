// controllers/payment.controller.ts

import { NextFunction, Request, Response } from 'express'
import * as paymentDashboardService from '../../services/dashboard/payment.dashboard.service'
import * as receiptDashboardService from '../../services/dashboard/receipt.dashboard.service'
import {
  encodeExport,
  sendExport,
  parseColumnsParam,
  parseFormatParam,
  getRowCapForFormat,
  type ExportColumnDef,
} from '../../services/dashboard/export.helpers'

import prisma from '../../utils/prismaClient'
import { NotFoundError } from '../../errors/AppError'
import logger from '../../config/logger'

// Ruta: GET /venues/:venueId/payments
export async function getPaymentsData(
  req: Request<
    { venueId: string },
    {},
    {},
    {
      page?: string
      pageSize?: string
      // Multi-select arrays (comma-separated)
      merchantAccountIds?: string
      methods?: string
      sources?: string
      staffIds?: string
      // Single-value legacy params
      merchantAccountId?: string
      method?: string
      source?: string
      staffId?: string
      search?: string
      startDate?: string
      endDate?: string
    }
  >,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId } = req.params
    // Parseamos los query params con valores por defecto
    const page = parseInt(req.query.page || '1')
    const pageSize = parseInt(req.query.pageSize || '10')

    // Helper to parse comma-separated query param into string array (drops empty entries)
    const parseList = (raw?: string): string[] | undefined => {
      if (!raw) return undefined
      const list = raw
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
      return list.length > 0 ? list : undefined
    }

    // Extraer filtros opcionales
    const filters: paymentDashboardService.PaymentFilters = {
      merchantAccountIds: parseList(req.query.merchantAccountIds),
      methods: parseList(req.query.methods) as any,
      sources: parseList(req.query.sources),
      staffIds: parseList(req.query.staffIds),
      // Backward-compat single-value filters
      merchantAccountId: req.query.merchantAccountId,
      method: req.query.method as any,
      source: req.query.source,
      staffId: req.query.staffId,
      search: req.query.search,
      startDate: req.query.startDate,
      endDate: req.query.endDate,
    }

    // Llamada al servicio con los parámetros ya parseados
    const paymentsData = await paymentDashboardService.getPaymentsData(venueId, page, pageSize, filters)

    res.status(200).json(paymentsData)
  } catch (error) {
    next(error)
  }
}

// Ruta: GET /payments/:paymentId (ejemplo de cómo sería la ruta)
export async function getPayment(req: Request<{ venueId: string; paymentId: string }>, res: Response, next: NextFunction) {
  try {
    const { venueId, paymentId } = req.params
    const payment = await paymentDashboardService.getPaymentById(venueId, paymentId)
    res.status(200).json(payment)
  } catch (error) {
    next(error)
  }
}

// Ruta: POST /payments/:paymentId/send-receipt
export async function sendPaymentReceipt(
  req: Request<{ venueId: string; paymentId: string }, {}, { recipientEmail?: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId, paymentId } = req.params
    const { recipientEmail } = req.body

    // Generar y almacenar el recibo digital
    const receipt = await receiptDashboardService.generateAndStoreReceipt(venueId, paymentId, recipientEmail)

    // Enviar el recibo por correo asíncronamente (sin hacer esperar al cliente)
    setTimeout(async () => {
      try {
        await receiptDashboardService.sendReceiptByEmail(receipt.id)
      } catch (error) {
        logger.error('Error sending receipt email:', error)
      }
    }, 0)

    res.status(201).json({
      message: 'Receipt created successfully',
      receiptId: receipt.id,
      accessKey: receipt.accessKey,
      status: receipt.status,
    })
  } catch (error) {
    next(error)
  }
}

// Ruta: GET /venues/:venueId/payments/:paymentId/receipts
export async function getPaymentReceipts(
  req: Request<{ paymentId: string; venueId: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { paymentId, venueId } = req.params

    // Primero verificamos que el pago pertenezca al venue especificado
    // Esto respeta el sistema de control de acceso basado en roles
    const payment = await prisma.payment.findFirst({
      where: {
        id: paymentId,
        venueId,
      },
    })

    if (!payment) {
      throw new NotFoundError('Payment not found in this venue')
    }

    // Una vez verificado, obtenemos los recibos asociados
    const receipts = await receiptDashboardService.getReceiptsByPaymentId(paymentId)
    res.status(200).json(receipts)
  } catch (error) {
    next(error)
  }
}

// Ruta: GET /venues/:venueId/receipts/:receiptId
export async function getReceiptById(
  req: Request<{ receiptId: string; venueId: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { receiptId, venueId } = req.params
    // Scope by venue: the receipt (and its PII) must belong to a payment in THIS
    // venue. Without the `payment: { venueId }` filter, a member of venue A could
    // read any receiptId from venue B (IDOR) — checkPermission only proves access
    // to :venueId, it does not scope the looked-up receipt.
    const receipt = await prisma.digitalReceipt.findFirst({
      where: { id: receiptId, payment: { venueId } },
      // incluimos el pago para referencia pero lo importante es el dataSnapshot que ya contiene toda la info
      include: { payment: true },
    })

    if (!receipt) {
      throw new NotFoundError('Receipt not found')
    }

    // Asegurándonos de que el dataSnapshot esté disponible en la respuesta
    res.status(200).json(receipt)
  } catch (error) {
    next(error)
  }
}

// Ruta: PUT /venues/:venueId/payments/:paymentId (SUPERADMIN only)
export async function updatePayment(
  req: Request<{ paymentId: string; venueId: string }, {}, paymentDashboardService.UpdatePaymentData>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { paymentId, venueId } = req.params
    const updateData = req.body

    // Verify payment belongs to this venue
    const payment = await prisma.payment.findFirst({
      where: {
        id: paymentId,
        venueId,
      },
    })

    if (!payment) {
      throw new NotFoundError('Payment not found in this venue')
    }

    logger.info('Updating payment', {
      paymentId,
      venueId,
      userId: req.authContext?.userId,
      fields: Object.keys(updateData),
    })

    const updatedPayment = await paymentDashboardService.updatePayment(venueId, paymentId, updateData)

    res.status(200).json(updatedPayment)
  } catch (error) {
    logger.error('Error updating payment', {
      paymentId: req.params.paymentId,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
    next(error)
  }
}

// Ruta: DELETE /venues/:venueId/payments/:paymentId (SUPERADMIN only)
export async function deletePayment(
  req: Request<{ paymentId: string; venueId: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { paymentId, venueId } = req.params

    // Verify payment belongs to this venue
    const payment = await prisma.payment.findFirst({
      where: {
        id: paymentId,
        venueId,
      },
    })

    if (!payment) {
      throw new NotFoundError('Payment not found in this venue')
    }

    logger.info('Deleting payment', {
      paymentId,
      venueId,
      userId: req.authContext?.userId,
    })

    await paymentDashboardService.deletePayment(venueId, paymentId)

    res.status(204).send()
  } catch (error) {
    logger.error('Error deleting payment', {
      paymentId: req.params.paymentId,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
    next(error)
  }
}

// Ruta: GET /venues/:venueId/payments/export
//
// Streams a CSV / XLSX / PDF of the payments matching the listing filters. Sync export — capped at
// EXPORT_ROW_CAP (10k) and EXPORT_PDF_ROW_CAP (1k) for PDF. Async job queue replaces this when we
// ship one for large tenants.
export async function exportPaymentsData(
  req: Request<
    { venueId: string },
    {},
    {},
    {
      format?: string
      columns?: string
      merchantAccountIds?: string
      methods?: string
      sources?: string
      staffIds?: string
      search?: string
      startDate?: string
      endDate?: string
    }
  >,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId } = req.params
    const format = parseFormatParam(req.query.format)
    const requestedColumnIds = parseColumnsParam(req.query.columns)
    const cap = getRowCapForFormat(format)

    const parseList = (raw?: string): string[] | undefined => {
      if (!raw) return undefined
      const list = raw
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
      return list.length > 0 ? list : undefined
    }

    const filters: paymentDashboardService.PaymentFilters = {
      merchantAccountIds: parseList(req.query.merchantAccountIds),
      methods: parseList(req.query.methods) as any,
      sources: parseList(req.query.sources),
      staffIds: parseList(req.query.staffIds),
      search: req.query.search,
      startDate: req.query.startDate,
      endDate: req.query.endDate,
    }

    // Pre-flight: count and bail if over the cap before pulling rows into memory.
    const total = await paymentDashboardService.countPaymentsForExport(venueId, filters)
    if (total > cap) {
      res.status(413).json({
        success: false,
        message:
          format === 'pdf'
            ? `El rango contiene ${total.toLocaleString()} filas. PDF está limitado a ${cap.toLocaleString()}. Usa CSV o Excel, o reduce el rango con filtros.`
            : `El rango contiene ${total.toLocaleString()} filas. El máximo por export es ${cap.toLocaleString()}. Reduce el rango con filtros.`,
      })
      return
    }

    const rows = await paymentDashboardService.fetchPaymentsForExport(venueId, filters, cap)
    type Row = (typeof rows)[number]

    // Column registry — order here is the order in the output file.
    const allColumns: ExportColumnDef<Row>[] = [
      { id: 'createdAt', label: 'Fecha', value: r => r.createdAt?.toISOString() ?? '' },
      { id: 'paymentId', label: 'ID', value: r => r.id },
      {
        id: 'waiterName',
        label: 'Mesero',
        value: r => (r.processedBy ? `${r.processedBy.firstName ?? ''} ${r.processedBy.lastName ?? ''}`.trim() : ''),
      },
      {
        id: 'merchantAccount',
        label: 'Cuenta Comercial',
        value: r => r.merchantAccount?.displayName || r.merchantAccount?.externalMerchantId || r.ecommerceMerchant?.channelName || '',
      },
      { id: 'method', label: 'Método', value: r => r.method ?? '' },
      { id: 'source', label: 'Origen', value: r => r.source ?? '' },
      {
        id: 'international',
        label: 'Internacional',
        value: r => {
          const raw = (r as any)?.processorData?.isInternational
          return raw === true || raw === 'true' ? 'Sí' : 'No'
        },
      },
      { id: 'cardBrand', label: 'Marca', value: r => r.cardBrand ?? '' },
      {
        id: 'last4',
        label: 'Últimos 4',
        value: r => {
          // Payment model stores maskedPan ("411111******1111") — derive last 4 digits for export.
          const masked = r.maskedPan ?? ''
          return masked ? masked.slice(-4) : ''
        },
      },
      { id: 'amount', label: 'Subtotal', value: r => Number(r.amount) || 0 },
      { id: 'tipAmount', label: 'Propina', value: r => Number(r.tipAmount) || 0 },
      {
        id: 'totalAmount',
        label: 'Total',
        value: r => (Number(r.amount) || 0) + (Number(r.tipAmount) || 0),
      },
      { id: 'status', label: 'Estatus', value: r => r.status ?? '' },
    ]

    const encoded = await encodeExport(format, {
      allColumns,
      requestedColumnIds: requestedColumnIds.length > 0 ? requestedColumnIds : allColumns.map(c => c.id),
      rows,
      title: 'Pagos',
    })

    logger.info('[Payments export]', { venueId, total, format, columns: requestedColumnIds.length })
    sendExport(res, encoded, 'payments')
  } catch (error) {
    logger.error('Error exporting payments', { error: error instanceof Error ? error.message : 'Unknown' })
    next(error)
  }
}

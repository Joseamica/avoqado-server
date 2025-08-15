// controllers/payment.controller.ts

import { NextFunction, Request, Response } from 'express'
import * as paymentDashboardService from '../../services/dashboard/payment.dashboard.service'
import * as receiptDashboardService from '../../services/dashboard/receipt.dashboard.service'

import prisma from '../../utils/prismaClient'
import { NotFoundError } from '../../errors/AppError'

// Ruta: GET /venues/:venueId/payments
export async function getPaymentsData(
  req: Request<{ venueId: string }, {}, {}, { page?: string; pageSize?: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId } = req.params
    // Parseamos los query params con valores por defecto
    const page = parseInt(req.query.page || '1')
    const pageSize = parseInt(req.query.pageSize || '10')

    // Llamada al servicio con los parámetros ya parseados
    const paymentsData = await paymentDashboardService.getPaymentsData(venueId, page, pageSize)

    res.status(200).json(paymentsData)
  } catch (error) {
    next(error)
  }
}

// Ruta: GET /payments/:paymentId (ejemplo de cómo sería la ruta)
export async function getPayment(req: Request<{ paymentId: string }>, res: Response, next: NextFunction) {
  try {
    const { paymentId } = req.params
    const payment = await paymentDashboardService.getPaymentById(paymentId)
    res.status(200).json(payment)
  } catch (error) {
    next(error)
  }
}

// Ruta: POST /payments/:paymentId/send-receipt
export async function sendPaymentReceipt(
  req: Request<{ paymentId: string }, {}, { recipientEmail?: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { paymentId } = req.params
    const { recipientEmail } = req.body

    // Generar y almacenar el recibo digital
    const receipt = await receiptDashboardService.generateAndStoreReceipt(paymentId, recipientEmail)

    // Enviar el recibo por correo asíncronamente (sin hacer esperar al cliente)
    setTimeout(async () => {
      try {
        await receiptDashboardService.sendReceiptByEmail(receipt.id)
      } catch (error) {
        console.error('Error sending receipt email:', error)
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

// Ruta: GET /receipts/:receiptId
export async function getReceiptById(req: Request<{ receiptId: string }>, res: Response, next: NextFunction): Promise<void> {
  try {
    const { receiptId } = req.params
    // Este endpoint sería para uso interno del dashboard
    const receipt = await prisma.digitalReceipt.findUnique({
      where: { id: receiptId },
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

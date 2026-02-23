/**
 * Receipt Mobile Controller
 *
 * Handles sending digital receipts via email and WhatsApp from mobile apps.
 * Supports lookup by receiptAccessKey OR paymentId.
 */

import { Request, Response, NextFunction } from 'express'
import prisma from '../../utils/prismaClient'
import { ReceiptStatus } from '@prisma/client'
import * as receiptService from '../../services/dashboard/receipt.dashboard.service'
import { sendReceiptWhatsApp } from '../../services/whatsapp.service'
import logger from '@/config/logger'

/**
 * Find or create a receipt by accessKey or paymentId.
 * If paymentId is given and no receipt exists, generates one.
 */
async function findOrCreateReceipt(receiptAccessKey?: string, paymentId?: string) {
  if (receiptAccessKey) {
    return prisma.digitalReceipt.findUnique({
      where: { accessKey: receiptAccessKey },
    })
  }

  if (paymentId) {
    // Look for existing receipt
    const existing = await prisma.digitalReceipt.findFirst({
      where: { paymentId },
    })
    if (existing) return existing

    // Generate receipt on-the-fly
    return receiptService.generateAndStoreReceipt(paymentId)
  }

  return null
}

/**
 * POST /venues/:venueId/receipts/send-email
 * Send a digital receipt via email.
 *
 * Body: { receiptAccessKey?: string, paymentId?: string, email: string }
 */
export async function sendReceiptEmail(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { receiptAccessKey, paymentId, email } = req.body

    if ((!receiptAccessKey && !paymentId) || !email) {
      res.status(400).json({
        success: false,
        message: 'Se requiere (receiptAccessKey o paymentId) y email',
      })
      return
    }

    const receipt = await findOrCreateReceipt(receiptAccessKey, paymentId)

    if (!receipt) {
      res.status(404).json({
        success: false,
        message: 'Recibo no encontrado',
      })
      return
    }

    // Update recipient email
    await prisma.digitalReceipt.update({
      where: { id: receipt.id },
      data: { recipientEmail: email },
    })

    // Send email using existing service
    await receiptService.sendReceiptByEmail(receipt.id)

    logger.info(`Receipt email sent via mobile`, {
      receiptId: receipt.id,
      email,
    })

    res.json({
      success: true,
      message: 'Recibo enviado por correo electrónico',
    })
  } catch (error) {
    next(error)
  }
}

/**
 * POST /venues/:venueId/receipts/send-whatsapp
 * Send a digital receipt via WhatsApp Business API.
 *
 * Body: { receiptAccessKey?: string, paymentId?: string, phone: string }
 */
export async function sendReceiptWhatsapp(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { receiptAccessKey, paymentId, phone } = req.body

    if ((!receiptAccessKey && !paymentId) || !phone) {
      res.status(400).json({
        success: false,
        message: 'Se requiere (receiptAccessKey o paymentId) y phone',
      })
      return
    }

    const receipt = await findOrCreateReceipt(receiptAccessKey, paymentId)

    if (!receipt) {
      res.status(404).json({
        success: false,
        message: 'Recibo no encontrado',
      })
      return
    }

    // Extract data from snapshot for WhatsApp message
    const dataSnapshot = receipt.dataSnapshot as any
    const venueName = dataSnapshot?.venue?.name || 'Establecimiento'
    const totalAmount = dataSnapshot?.payment?.totalAmount || dataSnapshot?.order?.total || 0
    const currency = dataSnapshot?.venue?.currency || 'MXN'
    const formattedTotal = `$${Number(totalAmount).toFixed(2)} ${currency}`

    const receiptUrl = `${process.env.FRONTEND_URL}/receipts/public/${receipt.accessKey}`

    // Send via WhatsApp
    await sendReceiptWhatsApp(phone, {
      venueName,
      totalAmount: formattedTotal,
      receiptUrl,
    })

    // Update receipt with phone and status
    await prisma.digitalReceipt.update({
      where: { id: receipt.id },
      data: {
        recipientPhone: phone,
        status: ReceiptStatus.SENT,
        sentAt: new Date(),
      },
    })

    logger.info(`Receipt WhatsApp sent via mobile`, {
      receiptId: receipt.id,
      phone,
    })

    res.json({
      success: true,
      message: 'Recibo enviado por WhatsApp',
    })
  } catch (error) {
    next(error)
  }
}

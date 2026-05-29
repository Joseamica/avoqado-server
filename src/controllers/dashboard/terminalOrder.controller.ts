import { Request, Response, NextFunction } from 'express'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { createOrder, uploadSpeiProof } from '@/services/dashboard/terminalOrder/terminalOrder.service'
import { createCheckoutSessionForOrder } from '@/services/dashboard/terminalOrder/stripeCheckout.service'
import { buildStripeCheckoutUrls } from '@/services/dashboard/terminalOrder/urls'

/**
 * POST /api/v1/dashboard/venues/:venueId/tpv-orders
 *
 * Creates a TerminalOrder. If paymentMethod is CARD_STRIPE, also creates a
 * Stripe Checkout Session and returns the redirect URL. If SPEI, returns
 * `redirectUrl: null` (frontend navigates to /tpv/orders/:id — Plan 2).
 */
export async function createOrderHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const staffId = req.authContext?.userId
    if (!staffId) {
      res.status(401).json({ success: false, error: 'Unauthenticated' })
      return
    }

    const order = await createOrder({
      venueId,
      createdById: staffId,
      ...req.body,
    })

    if (order.paymentMethod === 'CARD_STRIPE') {
      const venue = await prisma.venue.findUniqueOrThrow({
        where: { id: venueId },
        select: { slug: true },
      })

      // `from` controls Stripe's success/cancel URL targets. When 'setup',
      // we route back to the V2 onboarding wizard so a card purchase started
      // inside the wizard doesn't dump the user at /venues/.../tpv/orders/...
      // (which makes them feel they left onboarding). Defaults to 'tpv'.
      const { successUrl, cancelUrl } = buildStripeCheckoutUrls({
        orderId: order.id,
        venueSlug: venue.slug,
        from: req.body.from,
      })

      const { redirectUrl } = await createCheckoutSessionForOrder({
        order: order as any,
        successUrl,
        cancelUrl,
      })

      res.status(201).json({
        success: true,
        data: {
          orderId: order.id,
          orderNumber: order.orderNumber,
          redirectUrl,
        },
      })
      return
    }

    // SPEI path: created with paymentStatus=AWAITING_PROOF — Plan 2 handles upload
    res.status(201).json({
      success: true,
      data: {
        orderId: order.id,
        orderNumber: order.orderNumber,
        redirectUrl: null,
      },
    })
  } catch (error) {
    logger.error('createOrderHandler failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    next(error)
  }
}

/**
 * GET /api/v1/dashboard/venues/:venueId/tpv-orders
 * Lists orders for the venue, newest first.
 */
export async function listOrdersHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const orders = await prisma.terminalOrder.findMany({
      where: { venueId },
      include: {
        items: true,
        _count: { select: { terminals: true } },
      },
      orderBy: { createdAt: 'desc' },
    })
    res.json({ success: true, data: orders })
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/dashboard/venues/:venueId/tpv-orders/:id
 */
export async function getOrderHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, id } = req.params
    const order = await prisma.terminalOrder.findFirst({
      where: { id, venueId },
      include: {
        items: true,
        terminals: {
          select: {
            id: true,
            name: true,
            serialNumber: true,
            activationCode: true,
            status: true,
          },
        },
        createdBy: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
      },
    })
    if (!order) {
      res.status(404).json({ success: false, error: 'Order not found' })
      return
    }

    // For SPEI orders, also expose bank-recipient details (Plan 1: returns empty strings if SPEI not configured yet).
    const speiRecipient =
      order.paymentMethod === 'SPEI'
        ? {
            beneficiary: process.env.SPEI_RECIPIENT_BENEFICIARY ?? '',
            clabe: process.env.SPEI_RECIPIENT_CLABE ?? '',
            rfc: process.env.SPEI_RECIPIENT_RFC ?? '',
            bank: process.env.SPEI_RECIPIENT_BANK ?? '',
          }
        : null

    res.json({ success: true, data: { ...order, speiRecipient } })
  } catch (error) {
    next(error)
  }
}

/**
 * POST /api/v1/dashboard/venues/:venueId/tpv-orders/:id/upload-proof
 *
 * Multipart upload — field name `proof`. Stores the SPEI payment receipt
 * (PDF/JPG/PNG, ≤10MB), advances the order's paymentStatus to PROOF_UPLOADED,
 * and notifies the sales inbox (handled inside the service).
 */
export async function uploadProofHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params
    const file = (req as any).file as Express.Multer.File | undefined
    if (!file) {
      res.status(400).json({ success: false, error: 'No file uploaded (field name: proof)' })
      return
    }

    const updated = await uploadSpeiProof({
      orderId: id,
      file: {
        buffer: file.buffer,
        mimetype: file.mimetype,
        originalname: file.originalname,
        size: file.size,
      },
    })
    res.json({ success: true, data: updated })
  } catch (error) {
    logger.error('uploadProofHandler failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    if (error instanceof Error) {
      res.status(400).json({ success: false, error: error.message })
      return
    }
    next(error)
  }
}

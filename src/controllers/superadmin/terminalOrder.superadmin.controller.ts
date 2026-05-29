import { Request, Response, NextFunction } from 'express'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { assignSerials, markShipped, markDelivered } from '@/services/dashboard/terminalOrder/terminalOrder.service'

/**
 * Superadmin controllers for the TPV Shop fulfillment workflow.
 *
 * Endpoints (mounted under /api/v1/dashboard/superadmin/tpv-orders):
 *   GET    /                  → list every TerminalOrder (cross-venue)
 *   GET    /:id               → get one order with full detail
 *   POST   /:id/assign-serials → create Terminals + advance to SERIALS_ASSIGNED
 *   POST   /:id/mark-shipped  → advance to SHIPPED (+ tracking)
 *   POST   /:id/mark-delivered → advance to DELIVERED
 *
 * All routes require SUPERADMIN role (enforced by parent superadmin.routes.ts).
 */

export async function listAllOrdersHandler(_req: Request, res: Response, next: NextFunction) {
  try {
    const orders = await prisma.terminalOrder.findMany({
      include: {
        items: true,
        venue: { select: { id: true, name: true, slug: true } },
        _count: { select: { terminals: true } },
      },
      orderBy: { createdAt: 'desc' },
    })
    res.json({ success: true, data: orders })
  } catch (error) {
    next(error)
  }
}

export async function getOrderHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const order = await prisma.terminalOrder.findUnique({
      where: { id: req.params.id },
      include: {
        items: true,
        venue: { select: { id: true, name: true, slug: true } },
        terminals: {
          select: {
            id: true,
            name: true,
            serialNumber: true,
            activationCode: true,
            status: true,
            activationCodeExpiry: true,
          },
        },
        createdBy: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
    })
    if (!order) {
      res.status(404).json({ success: false, error: 'Not found' })
      return
    }
    res.json({ success: true, data: order })
  } catch (error) {
    next(error)
  }
}

export async function assignSerialsHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const staff = req.authContext
    const assignedBy = staff?.userId ?? 'unknown@avoqado.io'
    const updated = await assignSerials({
      orderId: req.params.id,
      assignedBy,
      items: req.body.items,
    })
    res.json({ success: true, data: updated })
  } catch (error) {
    logger.error('assignSerialsHandler failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    if (error instanceof Error) {
      res.status(400).json({ success: false, error: error.message })
      return
    }
    next(error)
  }
}

export async function markShippedHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const updated = await markShipped({
      orderId: req.params.id,
      trackingNumber: req.body.trackingNumber,
      carrier: req.body.carrier,
    })
    res.json({ success: true, data: updated })
  } catch (error) {
    if (error instanceof Error) {
      res.status(400).json({ success: false, error: error.message })
      return
    }
    next(error)
  }
}

export async function markDeliveredHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const updated = await markDelivered({ orderId: req.params.id })
    res.json({ success: true, data: updated })
  } catch (error) {
    if (error instanceof Error) {
      res.status(400).json({ success: false, error: error.message })
      return
    }
    next(error)
  }
}

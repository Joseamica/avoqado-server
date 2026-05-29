import prisma from '@/utils/prismaClient'
import { TPV_CATALOG, TAX_RATE } from '@/config/tpvCatalog'
import type {
  ApproveSpeiInput,
  AssignSerialsInput,
  CreateOrderInput,
  CreateOrderItemInput,
  OrderTotals,
  RejectSpeiInput,
  UploadSpeiProofInput,
} from './types'
import { generateOrderNumber } from './orderNumber.service'
import emailService from '@/services/email.service'
import logger from '@/config/logger'
import { uploadFileToStorage, buildStoragePath } from '@/services/storage.service'
import { signApprovalToken, signSerialAssignmentToken } from './token.service'
import { buildMagicLinkUrls, buildSerialAssignmentUrls } from './urls'

export function calculateTotals(items: CreateOrderItemInput[]): OrderTotals {
  if (items.length === 0) {
    throw new Error('At least one item is required')
  }

  let subtotalCents = 0
  for (const item of items) {
    if (item.quantity < 1) {
      throw new Error('Item quantity must be >= 1')
    }
    const entry = TPV_CATALOG[item.catalogKey]
    if (!entry) {
      throw new Error(`Unknown catalog key: ${item.catalogKey}`)
    }
    subtotalCents += entry.unitPriceCents * item.quantity
  }

  const taxCents = Math.round(subtotalCents * TAX_RATE)
  const totalCents = subtotalCents + taxCents

  return { subtotalCents, taxCents, totalCents, currency: 'MXN' }
}

export async function createOrder(input: CreateOrderInput) {
  const totals = calculateTotals(input.items)
  const orderNumber = await generateOrderNumber()

  const initialPaymentStatus = input.paymentMethod === 'CARD_STRIPE' ? 'AWAITING_PAYMENT' : 'AWAITING_PROOF'

  const created = await prisma.terminalOrder.create({
    data: {
      orderNumber,
      venueId: input.venueId,
      createdById: input.createdById,
      contactName: input.contactName,
      contactEmail: input.contactEmail,
      contactPhone: input.contactPhone,
      shippingAddress: input.shippingAddress,
      shippingAddress2: input.shippingAddress2,
      shippingCity: input.shippingCity,
      shippingState: input.shippingState,
      shippingZip: input.shippingZip,
      shippingCountry: input.shippingCountry ?? 'México',
      paymentMethod: input.paymentMethod,
      paymentStatus: initialPaymentStatus,
      subtotalCents: totals.subtotalCents,
      taxCents: totals.taxCents,
      totalCents: totals.totalCents,
      currency: totals.currency,
      fulfillmentStatus: 'NEW',
      items: {
        create: input.items.map(item => {
          const entry = TPV_CATALOG[item.catalogKey]
          return {
            brand: entry.brand,
            model: entry.model,
            productName: entry.name,
            quantity: item.quantity,
            unitPriceCents: entry.unitPriceCents,
            namePrefix: item.namePrefix ?? entry.name,
          }
        }),
      },
    },
    include: { items: true },
  })

  // SPEI: send bank-details email (don't fail order creation if email fails)
  if (created.paymentMethod === 'SPEI') {
    try {
      const baseUrl = process.env.DASHBOARD_URL ?? process.env.FRONTEND_URL ?? process.env.APP_URL ?? 'https://dashboard.avoqado.io'
      const venue = await prisma.venue.findUniqueOrThrow({
        where: { id: created.venueId },
        select: { slug: true },
      })
      const orderDetailUrl = `${baseUrl}/venues/${venue.slug}/tpv/orders/${created.id}`

      const emailSvc = (await import('@/services/email.service')).default
      await emailSvc.sendTerminalOrderSpeiInstructions({
        order: created as any,
        items: created.items as any,
        speiRecipient: {
          beneficiary: process.env.SPEI_RECIPIENT_BENEFICIARY ?? '',
          clabe: process.env.SPEI_RECIPIENT_CLABE ?? '',
          rfc: process.env.SPEI_RECIPIENT_RFC ?? '',
          bank: process.env.SPEI_RECIPIENT_BANK ?? '',
        },
        orderDetailUrl,
      })
    } catch (err) {
      logger.error('createOrder: failed to send SPEI instructions email', {
        orderId: created.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return created
}

/**
 * Generates a 6-char alphanumeric activation code (matches existing Terminal model pattern).
 * Excludes ambiguous chars (0, O, 1, I) for clarity when typed on a PAX device.
 */
function generateActivationCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)]
  }
  return code
}

export async function assignSerials(input: AssignSerialsInput) {
  const order = await prisma.terminalOrder.findUnique({
    where: { id: input.orderId },
    include: { items: true },
  })
  if (!order) throw new Error('Order not found')
  if (order.paymentStatus !== 'PAID') {
    throw new Error(`Order ${order.orderNumber} is not paid (status: ${order.paymentStatus})`)
  }
  if (order.fulfillmentStatus === 'SERIALS_ASSIGNED' || order.fulfillmentStatus === 'SHIPPED' || order.fulfillmentStatus === 'DELIVERED') {
    throw new Error(`Order ${order.orderNumber} already assigned`)
  }

  // Validate payloads against order items
  const itemsById = Object.fromEntries(order.items.map(i => [i.id, i]))
  for (const payload of input.items) {
    const item = itemsById[payload.orderItemId]
    if (!item) throw new Error(`Unknown orderItemId: ${payload.orderItemId}`)
    if (payload.units.length !== item.quantity) {
      throw new Error(`For ${item.productName}: expected ${item.quantity} units, got ${payload.units.length}`)
    }
    for (const unit of payload.units) {
      if (!unit.serial || unit.serial.trim() === '') {
        throw new Error('Each serial is required (cannot be empty)')
      }
      if (!unit.name || unit.name.trim() === '') {
        throw new Error('Each terminal name is required')
      }
    }
  }
  // Ensure every order item has a corresponding payload
  for (const item of order.items) {
    if (!input.items.find(p => p.orderItemId === item.id)) {
      throw new Error(`Missing units for item ${item.productName}`)
    }
  }

  const updatedOrder = await prisma.$transaction(async tx => {
    const allSerials = input.items.flatMap(p => p.units.map(u => u.serial.trim()))
    const existing = await tx.terminal.findFirst({
      where: { serialNumber: { in: allSerials } },
    })
    if (existing) {
      throw new Error(`Serial number already in use: ${existing.serialNumber}`)
    }

    const terminalsToCreate = input.items.flatMap(payload => {
      const item = itemsById[payload.orderItemId]
      return payload.units.map(unit => ({
        venueId: order.venueId,
        terminalOrderId: order.id,
        brand: item.brand,
        model: item.model,
        name: unit.name.trim(),
        serialNumber: unit.serial.trim(),
        type: 'TPV_ANDROID' as const,
        status: 'PENDING_ACTIVATION' as const,
        activationCode: generateActivationCode(),
        activationCodeExpiry: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      }))
    })

    await tx.terminal.createMany({ data: terminalsToCreate })

    return tx.terminalOrder.update({
      where: { id: order.id },
      data: {
        fulfillmentStatus: 'SERIALS_ASSIGNED',
        serialsAssignedAt: new Date(),
        serialsAssignedBy: input.assignedBy,
      },
      include: { items: true, terminals: true },
    })
  })

  // Fire the shipped email — don't fail the assignment if email fails
  try {
    await emailService.sendTerminalOrderTerminalsShipped({
      order: updatedOrder as any,
      items: updatedOrder.items as any,
      terminals: updatedOrder.terminals as any,
    })
  } catch (err) {
    logger.error('Failed to send terminals-shipped email', {
      orderId: updatedOrder.id,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  return updatedOrder
}

interface MarkShippedInput {
  orderId: string
  trackingNumber: string
  carrier: string
}

export async function markShipped(input: MarkShippedInput) {
  const order = await prisma.terminalOrder.findUnique({ where: { id: input.orderId } })
  if (!order) throw new Error('Order not found')
  if (order.fulfillmentStatus !== 'SERIALS_ASSIGNED') {
    throw new Error(`Order must be SERIALS_ASSIGNED before SHIPPED (current: ${order.fulfillmentStatus})`)
  }
  return prisma.terminalOrder.update({
    where: { id: input.orderId },
    data: {
      fulfillmentStatus: 'SHIPPED',
      trackingNumber: input.trackingNumber,
      carrier: input.carrier,
      shippedAt: new Date(),
    },
  })
}

interface MarkDeliveredInput {
  orderId: string
}

export async function markDelivered(input: MarkDeliveredInput) {
  const order = await prisma.terminalOrder.findUnique({ where: { id: input.orderId } })
  if (!order) throw new Error('Order not found')
  if (order.fulfillmentStatus !== 'SHIPPED') {
    throw new Error(`Order must be SHIPPED before DELIVERED (current: ${order.fulfillmentStatus})`)
  }
  return prisma.terminalOrder.update({
    where: { id: input.orderId },
    data: { fulfillmentStatus: 'DELIVERED', deliveredAt: new Date() },
  })
}

const MAX_PROOF_BYTES = 10 * 1024 * 1024 // 10 MB
const ALLOWED_PROOF_MIME = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/jpg', 'image/webp'])

export async function uploadSpeiProof(input: UploadSpeiProofInput) {
  const order = await prisma.terminalOrder.findUnique({ where: { id: input.orderId } })
  if (!order) throw new Error('Order not found')
  if (order.paymentMethod !== 'SPEI') {
    throw new Error('This is not a SPEI order')
  }
  if (order.paymentStatus === 'PAID') {
    throw new Error('Order is already paid')
  }
  if (order.paymentStatus !== 'AWAITING_PROOF' && order.paymentStatus !== 'REJECTED') {
    throw new Error(`Cannot upload proof in payment status ${order.paymentStatus}`)
  }

  if (input.file.size > MAX_PROOF_BYTES) {
    throw new Error('File too large (max 10 MB)')
  }
  if (!ALLOWED_PROOF_MIME.has(input.file.mimetype)) {
    throw new Error(`Unsupported file mimetype: ${input.file.mimetype}`)
  }

  const extByMime: Record<string, string> = {
    'application/pdf': 'pdf',
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/webp': 'webp',
  }
  const ext = extByMime[input.file.mimetype]
  const path = buildStoragePath(`venues/${order.venueId}/tpv-orders/${order.id}/proof.${ext}`)
  const proofUrl = await uploadFileToStorage(input.file.buffer, path, input.file.mimetype)

  const token = signApprovalToken({ orderId: order.id, action: 'approve' })
  const tokenExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

  const wasRejected = order.paymentStatus === 'REJECTED'

  const updated = await prisma.terminalOrder.update({
    where: { id: order.id },
    data: {
      paymentStatus: 'PROOF_UPLOADED',
      speiProofUrl: proofUrl,
      speiProofMimeType: input.file.mimetype,
      speiProofUploadedAt: new Date(),
      speiApprovalToken: token,
      speiTokenExpiresAt: tokenExpiresAt,
      speiRejectionReason: null,
    },
    include: { items: true },
  })

  // Fire sales notification (with attachment + magic links).
  // Don't fail the upload flow if email fails.
  try {
    const { approveUrl, rejectUrl, adminUiUrl } = buildMagicLinkUrls(updated.id, token)
    const emailSvc = (await import('@/services/email.service')).default
    await emailSvc.sendTerminalOrderSpeiProofForSales({
      order: updated as any,
      items: updated.items as any,
      proofUrl: updated.speiProofUrl!,
      proofMimeType: updated.speiProofMimeType!,
      approveUrl,
      rejectUrl,
      adminUiUrl,
      isResubmit: wasRejected,
    })
  } catch (err) {
    logger.error('uploadSpeiProof: failed to send sales notification', {
      orderId: updated.id,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  return updated
}

export async function approveSpei(input: ApproveSpeiInput) {
  const order = await prisma.terminalOrder.findUnique({
    where: { id: input.orderId },
    include: { items: true },
  })
  if (!order) throw new Error('Order not found')
  if (order.paymentStatus !== 'PROOF_UPLOADED') {
    throw new Error(`Order is not in PROOF_UPLOADED state (current: ${order.paymentStatus})`)
  }

  const serialToken = signSerialAssignmentToken(order.id)
  const tokenExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)

  const updated = await prisma.terminalOrder.update({
    where: { id: order.id },
    data: {
      paymentStatus: 'PAID',
      fulfillmentStatus: 'AWAITING_SERIALS',
      speiApprovedAt: new Date(),
      speiApprovedBy: input.approvedBy,
      speiApprovalToken: null,
      speiTokenExpiresAt: null,
      serialAssignmentToken: serialToken,
      serialAssignmentTokenExpiresAt: tokenExpires,
    },
    include: { items: true },
  })

  // Fire emails #4 (customer payment confirmed) + #5 (sales assign serials).
  // Same emails as the Stripe webhook handler — keep behavior identical.
  try {
    const { default: emailSvc } = await import('@/services/email.service')
    await emailSvc.sendTerminalOrderPaymentConfirmed({
      order: updated as any,
      items: order.items,
    })
  } catch (err) {
    logger.error('SPEI approve: failed to send payment-confirmed email', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
  try {
    const { default: emailSvc } = await import('@/services/email.service')
    const urls = buildSerialAssignmentUrls(updated.id, serialToken)
    await emailSvc.sendTerminalOrderSerialAssignmentRequest({
      order: updated as any,
      items: order.items,
      serialAssignmentUrl: urls.serialAssignmentUrl,
      adminUiUrl: urls.adminUiUrl,
    })
  } catch (err) {
    logger.error('SPEI approve: failed to send serial-assignment email', {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  return updated
}

export async function rejectSpei(input: RejectSpeiInput) {
  const order = await prisma.terminalOrder.findUnique({ where: { id: input.orderId } })
  if (!order) throw new Error('Order not found')
  if (order.paymentStatus !== 'PROOF_UPLOADED') {
    throw new Error(`Order is not in PROOF_UPLOADED state (current: ${order.paymentStatus})`)
  }

  const updated = await prisma.terminalOrder.update({
    where: { id: order.id },
    data: {
      paymentStatus: 'REJECTED',
      speiRejectionReason: input.reason,
      speiApprovedBy: input.rejectedBy,
      speiApprovalToken: null,
      speiTokenExpiresAt: null,
    },
    include: { items: true },
  })

  // Fire customer rejection email — don't fail the rejection if email fails
  try {
    const baseUrl = process.env.DASHBOARD_URL ?? process.env.FRONTEND_URL ?? process.env.APP_URL ?? 'https://dashboardv2.avoqado.io'
    const venue = await prisma.venue.findUniqueOrThrow({
      where: { id: updated.venueId },
      select: { slug: true },
    })
    const orderDetailUrl = `${baseUrl}/venues/${venue.slug}/tpv/orders/${updated.id}`

    const emailSvc = (await import('@/services/email.service')).default
    await emailSvc.sendTerminalOrderSpeiRejected({
      order: updated as any,
      items: updated.items as any,
      reason: input.reason,
      orderDetailUrl,
    })
  } catch (err) {
    logger.error('rejectSpei: failed to send customer rejection email', {
      orderId: updated.id,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  return updated
}

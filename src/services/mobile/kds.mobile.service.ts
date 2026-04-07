/**
 * Mobile KDS Service
 *
 * Kitchen Display System management for mobile apps (iOS, Android).
 * Creates, lists, and updates KDS orders that kitchen staff sees
 * on the display after a payment completes with products.
 */

import logger from '../../config/logger'
import { BadRequestError, NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import type { KdsOrderStatus } from '@prisma/client'

// Use string constants instead of Prisma enum to avoid runtime import issues with tsx
const KdsStatus = {
  NEW: 'NEW' as const,
  PREPARING: 'PREPARING' as const,
  READY: 'READY' as const,
  COMPLETED: 'COMPLETED' as const,
}
const VALID_STATUSES = ['NEW', 'PREPARING', 'READY', 'COMPLETED']

// MARK: - Types

export interface CreateKdsOrderItemInput {
  productName: string
  quantity: number
  modifiers?: string[]
  notes?: string | null
}

export interface CreateKdsOrderInput {
  orderNumber: string
  orderType?: string
  orderId?: string | null
  items: CreateKdsOrderItemInput[]
}

export interface KdsOrderResponse {
  id: string
  orderNumber: string
  orderType: string
  orderId: string | null
  status: KdsOrderStatus
  items: Array<{
    id: string
    productName: string
    quantity: number
    modifiers: string[]
    notes: string | null
  }>
  startedAt: string | null
  completedAt: string | null
  createdAt: string
}

// MARK: - List KDS Orders

/**
 * Get active KDS orders for a venue, filtered by status.
 * Default: NEW, PREPARING, READY (active orders only).
 */
export async function listKdsOrders(venueId: string, statusFilter?: string): Promise<KdsOrderResponse[]> {
  // Parse status filter (comma-separated) or default to active statuses
  let statuses: string[]
  if (statusFilter) {
    statuses = statusFilter
      .split(',')
      .map(s => s.trim().toUpperCase())
      .filter(s => VALID_STATUSES.includes(s))
  } else {
    statuses = [KdsStatus.NEW, KdsStatus.PREPARING, KdsStatus.READY]
  }

  const orders = await prisma.kdsOrder.findMany({
    where: {
      venueId,
      status: { in: statuses as KdsOrderStatus[] },
    },
    include: {
      items: true,
    },
    orderBy: { createdAt: 'asc' },
  })

  return orders.map(formatKdsOrder)
}

// MARK: - Create KDS Order

/**
 * Create a new KDS order after payment succeeds.
 */
export async function createKdsOrder(venueId: string, input: CreateKdsOrderInput): Promise<KdsOrderResponse> {
  if (!input.orderNumber) {
    throw new BadRequestError('Se requiere orderNumber')
  }
  if (!input.items || input.items.length === 0) {
    throw new BadRequestError('Se requiere al menos un item')
  }

  const order = await prisma.kdsOrder.create({
    data: {
      venueId,
      orderNumber: input.orderNumber,
      orderType: input.orderType || 'DINE_IN',
      orderId: input.orderId || null,
      status: KdsStatus.NEW,
      items: {
        create: input.items.map(item => ({
          productName: item.productName,
          quantity: item.quantity,
          modifiers: item.modifiers ? JSON.stringify(item.modifiers) : null,
          notes: item.notes || null,
        })),
      },
    },
    include: {
      items: true,
    },
  })

  logger.info(`KDS order created: #${order.orderNumber} for venue ${venueId}`)
  return formatKdsOrder(order)
}

// MARK: - Update KDS Order Status

/**
 * Update the status of a KDS order (NEW -> PREPARING -> READY -> COMPLETED).
 */
export async function updateKdsOrderStatus(venueId: string, orderId: string, newStatus: string): Promise<KdsOrderResponse> {
  const upperStatus = newStatus.toUpperCase()

  if (!VALID_STATUSES.includes(upperStatus)) {
    throw new BadRequestError(`Estado invalido: ${newStatus}. Valores: ${VALID_STATUSES.join(', ')}`)
  }

  const existing = await prisma.kdsOrder.findFirst({
    where: { id: orderId, venueId },
  })

  if (!existing) {
    throw new NotFoundError('Orden KDS no encontrada')
  }

  const now = new Date()
  const updateData: any = { status: upperStatus }

  if (upperStatus === KdsStatus.PREPARING && !existing.startedAt) {
    updateData.startedAt = now
  }
  if (upperStatus === KdsStatus.COMPLETED) {
    updateData.completedAt = now
  }

  const updated = await prisma.kdsOrder.update({
    where: { id: orderId },
    data: updateData,
    include: { items: true },
  })

  logger.info(`KDS order #${updated.orderNumber} status -> ${upperStatus}`)
  return formatKdsOrder(updated)
}

// MARK: - Bump Order (instant complete)

/**
 * Instantly mark a KDS order as COMPLETED.
 */
export async function bumpKdsOrder(venueId: string, orderId: string): Promise<KdsOrderResponse> {
  const existing = await prisma.kdsOrder.findFirst({
    where: { id: orderId, venueId },
  })

  if (!existing) {
    throw new NotFoundError('Orden KDS no encontrada')
  }

  const updated = await prisma.kdsOrder.update({
    where: { id: orderId },
    data: {
      status: KdsStatus.COMPLETED,
      completedAt: new Date(),
    },
    include: { items: true },
  })

  logger.info(`KDS order #${updated.orderNumber} bumped to COMPLETED`)
  return formatKdsOrder(updated)
}

// MARK: - Helper

function formatKdsOrder(order: any): KdsOrderResponse {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    orderType: order.orderType,
    orderId: order.orderId,
    status: order.status,
    items: (order.items || []).map((item: any) => ({
      id: item.id,
      productName: item.productName,
      quantity: item.quantity,
      modifiers: item.modifiers ? JSON.parse(item.modifiers) : [],
      notes: item.notes,
    })),
    startedAt: order.startedAt?.toISOString() || null,
    completedAt: order.completedAt?.toISOString() || null,
    createdAt: order.createdAt.toISOString(),
  }
}

/**
 * Mobile Cash Drawer Service
 *
 * Cash drawer session management for iOS/Android POS apps.
 * Tracks open/close, pay-in, pay-out, and cash sales.
 */

import prisma from '../../utils/prismaClient'
import { BadRequestError, ConflictError, NotFoundError } from '../../errors/AppError'
import { logAction } from '../dashboard/activity-log.service'
import { Decimal } from '@prisma/client/runtime/library'

// ============================================================================
// GET CURRENT SESSION
// ============================================================================

/**
 * Get the current open cash drawer session for a venue, including all events.
 */
export async function getCurrentSession(venueId: string) {
  const session = await prisma.cashDrawerSession.findFirst({
    where: { venueId, status: 'OPEN' },
    include: {
      events: {
        orderBy: { createdAt: 'desc' },
      },
    },
  })

  if (!session) {
    return null
  }

  return formatSession(session)
}

// ============================================================================
// OPEN SESSION
// ============================================================================

interface OpenSessionParams {
  venueId: string
  staffId: string
  staffName: string
  startingAmount: number // cents
  deviceName?: string
}

/**
 * Open a new cash drawer session. Only one session can be open per venue at a time.
 */
export async function openSession(params: OpenSessionParams) {
  const { venueId, staffId, staffName, startingAmount, deviceName } = params

  if (startingAmount < 0) {
    throw new BadRequestError('El monto inicial no puede ser negativo')
  }

  // Check for existing open session
  const existingOpen = await prisma.cashDrawerSession.findFirst({
    where: { venueId, status: 'OPEN' },
  })

  if (existingOpen) {
    throw new ConflictError('Ya existe una caja abierta. Cierra la caja actual antes de abrir una nueva.')
  }

  const amountDecimal = centsToDecimal(startingAmount)

  const session = await prisma.cashDrawerSession.create({
    data: {
      venueId,
      openedByStaffId: staffId,
      openedByName: staffName,
      startingAmount: amountDecimal,
      deviceName: deviceName || null,
      status: 'OPEN',
      events: {
        create: {
          venueId,
          type: 'OPEN',
          amount: amountDecimal,
          staffId,
          staffName,
          note: `Caja abierta con $${amountDecimal}`,
        },
      },
    },
    include: {
      events: {
        orderBy: { createdAt: 'desc' },
      },
    },
  })

  logAction({
    staffId,
    venueId,
    action: 'CASH_DRAWER_OPENED',
    entity: 'CashDrawerSession',
    entityId: session.id,
    data: { startingAmount: Number(amountDecimal), deviceName, source: 'MOBILE' },
  })

  return formatSession(session)
}

// ============================================================================
// PAY IN
// ============================================================================

interface PayInOutParams {
  venueId: string
  staffId: string
  staffName: string
  amount: number // cents
  note?: string
}

/**
 * Add a pay-in event (cash added to drawer).
 */
export async function payIn(params: PayInOutParams) {
  const { venueId, staffId, staffName, amount, note } = params

  if (amount <= 0) {
    throw new BadRequestError('El monto debe ser mayor a 0')
  }

  const session = await getOpenSession(venueId)
  const amountDecimal = centsToDecimal(amount)

  const event = await prisma.cashDrawerEvent.create({
    data: {
      sessionId: session.id,
      venueId,
      type: 'PAY_IN',
      amount: amountDecimal,
      staffId,
      staffName,
      note: note || null,
    },
  })

  logAction({
    staffId,
    venueId,
    action: 'CASH_DRAWER_PAY_IN',
    entity: 'CashDrawerEvent',
    entityId: event.id,
    data: { sessionId: session.id, amount: Number(amountDecimal), note, source: 'MOBILE' },
  })

  return formatEvent(event)
}

// ============================================================================
// PAY OUT
// ============================================================================

/**
 * Add a pay-out event (cash removed from drawer).
 */
export async function payOut(params: PayInOutParams) {
  const { venueId, staffId, staffName, amount, note } = params

  if (amount <= 0) {
    throw new BadRequestError('El monto debe ser mayor a 0')
  }

  const session = await getOpenSession(venueId)
  const amountDecimal = centsToDecimal(amount)

  const event = await prisma.cashDrawerEvent.create({
    data: {
      sessionId: session.id,
      venueId,
      type: 'PAY_OUT',
      amount: amountDecimal,
      staffId,
      staffName,
      note: note || null,
    },
  })

  logAction({
    staffId,
    venueId,
    action: 'CASH_DRAWER_PAY_OUT',
    entity: 'CashDrawerEvent',
    entityId: event.id,
    data: { sessionId: session.id, amount: Number(amountDecimal), note, source: 'MOBILE' },
  })

  return formatEvent(event)
}

// ============================================================================
// CLOSE SESSION
// ============================================================================

interface CloseSessionParams {
  venueId: string
  staffId: string
  staffName: string
  actualAmount: number // cents
  note?: string
}

/**
 * Close the current cash drawer session.
 * Calculates expected amount from events and determines over/short.
 */
export async function closeSession(params: CloseSessionParams) {
  const { venueId, staffId, staffName, actualAmount, note } = params

  if (actualAmount < 0) {
    throw new BadRequestError('El monto no puede ser negativo')
  }

  const session = await prisma.cashDrawerSession.findFirst({
    where: { venueId, status: 'OPEN' },
    include: {
      events: true,
    },
  })

  if (!session) {
    throw new NotFoundError('No hay una caja abierta')
  }

  // Calculate expected amount from events
  const expectedAmount = calculateExpectedAmount(session)
  const actualDecimal = centsToDecimal(actualAmount)
  const overShort = Number(actualDecimal) - expectedAmount

  const closedSession = await prisma.cashDrawerSession.update({
    where: { id: session.id },
    data: {
      status: 'CLOSED',
      closedByStaffId: staffId,
      closedByName: staffName,
      closedAt: new Date(),
      actualAmount: actualDecimal,
      overShort: new Decimal(overShort.toFixed(2)),
      closingNote: note || null,
      events: {
        create: {
          venueId,
          type: 'CLOSE',
          amount: actualDecimal,
          staffId,
          staffName,
          note: note || null,
        },
      },
    },
    include: {
      events: {
        orderBy: { createdAt: 'desc' },
      },
    },
  })

  logAction({
    staffId,
    venueId,
    action: 'CASH_DRAWER_CLOSED',
    entity: 'CashDrawerSession',
    entityId: session.id,
    data: {
      expectedAmount,
      actualAmount: Number(actualDecimal),
      overShort,
      source: 'MOBILE',
    },
  })

  return formatSession(closedSession)
}

// ============================================================================
// HISTORY
// ============================================================================

/**
 * Get closed cash drawer sessions (history).
 */
export async function getHistory(venueId: string, page: number = 1, pageSize: number = 20) {
  const skip = (page - 1) * pageSize

  const [sessions, total] = await Promise.all([
    prisma.cashDrawerSession.findMany({
      where: { venueId, status: 'CLOSED' },
      include: {
        events: {
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: { closedAt: 'desc' },
      skip,
      take: pageSize,
    }),
    prisma.cashDrawerSession.count({
      where: { venueId, status: 'CLOSED' },
    }),
  ])

  return {
    sessions: sessions.map(formatSession),
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    },
  }
}

// ============================================================================
// SYNC (Offline-first bulk event sync)
// ============================================================================

interface SyncEvent {
  type: 'PAY_IN' | 'PAY_OUT' | 'CASH_SALE'
  amount: number // cents
  note?: string
  staffId: string
  staffName: string
  orderId?: string
  createdAt?: string // ISO date
}

/**
 * Bulk sync events from mobile (for offline-first support).
 * Creates multiple events in a single transaction.
 */
export async function syncEvents(venueId: string, events: SyncEvent[]) {
  const session = await getOpenSession(venueId)

  if (!events || events.length === 0) {
    throw new BadRequestError('No hay eventos para sincronizar')
  }

  const createdEvents = await prisma.$transaction(
    events.map(event =>
      prisma.cashDrawerEvent.create({
        data: {
          sessionId: session.id,
          venueId,
          type: event.type,
          amount: centsToDecimal(event.amount),
          note: event.note || null,
          staffId: event.staffId,
          staffName: event.staffName,
          orderId: event.orderId || null,
          createdAt: event.createdAt ? new Date(event.createdAt) : new Date(),
        },
      }),
    ),
  )

  logAction({
    staffId: events[0]?.staffId,
    venueId,
    action: 'CASH_DRAWER_SYNC',
    entity: 'CashDrawerSession',
    entityId: session.id,
    data: { eventCount: createdEvents.length, source: 'MOBILE' },
  })

  return {
    syncedCount: createdEvents.length,
    events: createdEvents.map(formatEvent),
  }
}

// ============================================================================
// HELPERS
// ============================================================================

async function getOpenSession(venueId: string) {
  const session = await prisma.cashDrawerSession.findFirst({
    where: { venueId, status: 'OPEN' },
  })

  if (!session) {
    throw new NotFoundError('No hay una caja abierta. Abre una caja primero.')
  }

  return session
}

function calculateExpectedAmount(session: any): number {
  let expected = Number(session.startingAmount)

  for (const event of session.events) {
    const amount = Number(event.amount)
    switch (event.type) {
      case 'PAY_IN':
      case 'CASH_SALE':
        expected += amount
        break
      case 'PAY_OUT':
        expected -= amount
        break
    }
  }

  return Math.round(expected * 100) / 100
}

function centsToDecimal(cents: number): Decimal {
  return new Decimal((cents / 100).toFixed(2))
}

function formatSession(session: any) {
  const expectedAmount = calculateExpectedAmount(session)

  return {
    id: session.id,
    venueId: session.venueId,
    deviceName: session.deviceName,
    status: session.status,
    openedByStaffId: session.openedByStaffId,
    openedByName: session.openedByName,
    openedAt: session.openedAt.toISOString(),
    startingAmount: decimalToCents(session.startingAmount),
    closedByStaffId: session.closedByStaffId,
    closedByName: session.closedByName,
    closedAt: session.closedAt ? session.closedAt.toISOString() : null,
    actualAmount: session.actualAmount ? decimalToCents(session.actualAmount) : null,
    expectedAmount: Math.round(expectedAmount * 100),
    overShort: session.overShort ? decimalToCents(session.overShort) : null,
    closingNote: session.closingNote,
    events: session.events ? session.events.map(formatEvent) : [],
  }
}

function formatEvent(event: any) {
  return {
    id: event.id,
    sessionId: event.sessionId,
    type: event.type,
    amount: decimalToCents(event.amount),
    note: event.note,
    staffId: event.staffId,
    staffName: event.staffName,
    orderId: event.orderId,
    createdAt: event.createdAt.toISOString(),
  }
}

function decimalToCents(val: any): number {
  return Math.round(Number(val) * 100)
}

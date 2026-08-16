/**
 * Mobile Cash Drawer Service
 *
 * Cash drawer session management for iOS/Android POS apps.
 * Tracks open/close, pay-in, pay-out, and cash sales.
 */

import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
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
  startingAmount: number // dollars (e.g. 10.50 = $10.50)
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

  const amountDecimal = dollarsToDecimal(startingAmount)

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
  amount: number // dollars (e.g. 20.00 = $20.00)
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
  const amountDecimal = dollarsToDecimal(amount)

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
  const amountDecimal = dollarsToDecimal(amount)

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
  actualAmount: number // dollars
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
  const actualDecimal = dollarsToDecimal(actualAmount)
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
// TENDER BREAKDOWN (payments by method for the corte / Z-report)
// ============================================================================

/**
 * Payments grouped by tender for a time window — the authoritative source for
 * the corte de caja's "Desglose por método de pago" (the drawer only tracks
 * CASH physically, so card/other totals must come from the payment records).
 * Sums amount + tip per COMPLETED payment (refunds ride as negative COMPLETED
 * payments, so the signed sum auto-nets them). Window = the drawer session's
 * [openedAt, closedAt || now].
 */
export async function getTenderBreakdown(venueId: string, from: Date, to: Date) {
  const payments = await prisma.payment.findMany({
    where: {
      venueId,
      status: 'COMPLETED',
      createdAt: { gte: from, lte: to },
    },
    select: { method: true, amount: true, tipAmount: true },
  })

  // `total` sigue incluyendo la propina —es lo que entró por ese método y lo que
  // el cajón tiene físicamente— pero ahora viaja aparte cuánto de eso fue propina.
  // Mezclarlas sin distinguirlas escondía dinero que NO es del negocio: la propina
  // se le entrega al mesero, así que un corte que la suma al efectivo hace que el
  // cajón "cuadre" con dinero que se va a repartir.
  const byMethod = new Map<string, { total: number; tips: number }>()
  for (const p of payments) {
    const method = p.method || 'OTHER'
    const tip = Number(p.tipAmount ?? 0)
    const acc = byMethod.get(method) || { total: 0, tips: 0 }
    acc.total += Number(p.amount) + tip
    acc.tips += tip
    byMethod.set(method, acc)
  }

  // Emit every method with activity, dollars major units (matches this API).
  // `tips` es ADITIVO: los clientes viejos siguen leyendo `total` igual que antes.
  const tenderBreakdown = Array.from(byMethod.entries())
    .map(([method, v]) => ({
      method,
      total: Number(v.total.toFixed(2)),
      tips: Number(v.tips.toFixed(2)),
    }))
    .filter(t => t.total !== 0 || t.tips !== 0)
    .sort((a, b) => b.total - a.total)

  const totalTips = Number(tenderBreakdown.reduce((sum, t) => sum + t.tips, 0).toFixed(2))

  return { tenderBreakdown, totalTips, from: from.toISOString(), to: to.toISOString() }
}

// ============================================================================
// SYNC (Offline-first bulk event sync)
// ============================================================================

interface SyncEvent {
  /**
   * `CASH_SALE` sigue en la unión porque las apps ya desplegadas lo mandan y el contrato
   * `/mobile` no rompe versiones viejas — pero el servidor lo DESCARTA (ver `syncEvents`):
   * la venta en efectivo ya crea su propio movimiento al cobrar.
   */
  type: 'PAY_IN' | 'PAY_OUT' | 'CASH_SALE'
  amount: number // dollars
  note?: string
  staffId: string
  staffName: string
  orderId?: string
  createdAt?: string // ISO date
  /**
   * Llave de idempotencia del POS: el id con el que la app guarda el evento en su base
   * local (Android `CashDrawerEventEntity.id`, un UUID estable). Opcional para no romper
   * apps viejas — sin ella el reintento no se puede deduplicar.
   */
  localId?: string
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

  // 🔴 EL SERVIDOR ES DUEÑO DEL `CASH_SALE` — el cliente ya no lo puede empujar.
  //
  // Desde que el cobro en efectivo crea su propio movimiento de caja en el servidor
  // (`services/shared/cashDrawerPosting.ts`, enganchado en `payCashOrder`,
  // `recordOrderPayment` y `recordFastPayment`), aceptar además el `CASH_SALE` que las
  // apps YA DESPLEGADAS empujan a este endpoint contaría la MISMA venta dos veces: un
  // SOBRANTE inventado, el mismo defecto que veníamos a arreglar pero al revés.
  //
  // No se puede deduplicar contra el evento del servidor: la app manda un UUID local
  // propio, no el `paymentId`, y un cheque partido en dos cobros iguales haría
  // indistinguibles el duplicado y el legítimo. Se descartan y punto.
  //
  // No se pierde nada: TODA venta en efectivo de un POS pasa por uno de esos tres
  // servicios, así que el movimiento nace igual —y ahora también cuando la app estaba
  // sin red, porque el intent `PAY_CASH` del outbox llega por `payCashOrder`. El push
  // del cliente era fire-and-forget SIN cola de reintento: si la respuesta se perdía,
  // el movimiento no existía nunca.
  //
  // PAY_IN y PAY_OUT siguen siendo del cliente: no nacen de un cobro.
  const droppedCashSales = events.filter(event => event.type === 'CASH_SALE').length
  const acceptedEvents = events.filter(event => event.type !== 'CASH_SALE')

  if (droppedCashSales > 0) {
    logger.info('💵 [CASH-DRAWER] CASH_SALE del cliente ignorado — el servidor ya lo registra al cobrar', {
      venueId,
      sessionId: session.id,
      droppedCashSales,
    })
  }

  if (acceptedEvents.length === 0) {
    // 200 con lote vacío, no error: el push del cliente es fire-and-forget y un 4xx
    // aquí lo haría reintentar para siempre algo que nunca vamos a aceptar.
    return { syncedCount: 0, events: [] }
  }

  const toRow = (event: SyncEvent) => ({
    sessionId: session.id,
    venueId,
    type: event.type,
    amount: dollarsToDecimal(event.amount),
    note: event.note || null,
    staffId: event.staffId,
    staffName: event.staffName,
    orderId: event.orderId || null,
    localId: event.localId || null,
    createdAt: event.createdAt ? new Date(event.createdAt) : new Date(),
  })

  // 🔴 `createMany` + `skipDuplicates` en vez de un `create` por evento — SOLO
  // para los eventos que traen `localId`.
  //
  // Las apps mandan el lote fire-and-forget y sin cola de reintento: si la respuesta se
  // pierde, el MISMO lote vuelve. El `create` ciego insertaba las filas otra vez y el cajón
  // terminaba con efectivo inventado — que el arqueo daba por bueno. Con la llave
  // `localId` del POS y el índice `@@unique([venueId, localId])`, el reintento choca y
  // Postgres lo salta en vez de duplicar.
  const keyed = acceptedEvents.filter(event => Boolean(event.localId))
  const unkeyed = acceptedEvents.filter(event => !event.localId)

  // 🔴 Apps viejas sin `localId` (contrato /mobile: las versiones ya
  // distribuidas siguen funcionando): tras un `createMany` no hay llave para
  // RELEER sus filas, y responder `events: []` rompía a los clientes que
  // marcan su outbox local con el eco de la respuesta — re-mandaban el lote
  // completo en cada sync, y sin llave el índice único no puede deduplicarlo:
  // efectivo inventado causado por el propio cambio de forma. Se insertan una
  // a una (el comportamiento que esas apps siempre tuvieron) para poder
  // devolverlas.
  //
  // 🔴 TODO el lote va en UNA transacción (audit 2026-08-13): con inserts
  // sueltos, un fallo a media lista dejaba los primeros commiteados aunque el
  // request regresara error — el reintento del cliente los reinsertaba (los
  // sin llave no tienen dedupe) y el cajón inventaba efectivo. Todo-o-nada:
  // o entra el lote completo, o el reintento parte de cero.
  const { insertedCount, unkeyedRows } = await prisma.$transaction(
    async tx => {
      let inserted = 0
      if (keyed.length > 0) {
        const result = await tx.cashDrawerEvent.createMany({
          data: keyed.map(toRow),
          skipDuplicates: true,
        })
        inserted += result.count
      }

      const createdUnkeyed = [] as Awaited<ReturnType<typeof prisma.cashDrawerEvent.create>>[]
      for (const event of unkeyed) {
        createdUnkeyed.push(await tx.cashDrawerEvent.create({ data: toRow(event) }))
      }
      inserted += createdUnkeyed.length

      return { insertedCount: inserted, unkeyedRows: createdUnkeyed }
    },
    // Timeout explícito (audit max): el default de 5s de la tx interactiva no
    // aguanta el lote de una app vieja que reconecta tras un día offline
    // (~cientos de creates secuenciales sin llave). Un P2028 aquí revertía el
    // lote completo y el cliente lo reintentaba idéntico por siempre.
    { timeout: 30_000 },
  )

  logAction({
    staffId: acceptedEvents[0]?.staffId,
    venueId,
    action: 'CASH_DRAWER_SYNC',
    entity: 'CashDrawerSession',
    entityId: session.id,
    data: { eventCount: insertedCount, receivedCount: events.length, source: 'MOBILE' },
  })

  // `createMany` no devuelve las filas: las del lote con llave se releen por su
  // `localId` (incluye las que un lote anterior ya había insertado — el cliente
  // necesita el eco de TODO lo que mandó para marcar su outbox como sincronizado).
  const localIds = keyed.map(e => e.localId as string)
  const keyedRows = localIds.length
    ? await prisma.cashDrawerEvent.findMany({ where: { venueId, localId: { in: localIds } }, orderBy: { createdAt: 'asc' } })
    : []

  const allRows = [...keyedRows, ...unkeyedRows].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())

  return {
    syncedCount: insertedCount,
    events: allRows.map(formatEvent),
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

/**
 * Efectivo que DEBERÍA haber en el cajón: inicial + PAY_IN + CASH_SALE − PAY_OUT.
 *
 * Los tres tipos que suman/restan tienen dueño y ninguno se cuenta dos veces:
 *   · `CASH_SALE` — lo crea el SERVIDOR al cobrar (`services/shared/cashDrawerPosting.ts`,
 *     enganchado en `payCashOrder`, `recordOrderPayment` y `recordFastPayment`), con una
 *     llave derivada del `paymentId`. Reproducir el mismo pago del outbox no duplica nada,
 *     y `syncEvents` descarta los `CASH_SALE` que empujan las apps para no sumar dos veces.
 *     Incluye la propina en efectivo, igual que `cashCloseout.dashboard.service.ts`.
 *   · `PAY_OUT` — retiros a mano Y el reembolso en efectivo (`refund.mobile.service.ts`),
 *     que es el ÚNICO que mueve el cajón por un reembolso: el Payment negativo del refund
 *     no vuelve a entrar por el enganche de ventas.
 *   · `PAY_IN` — entradas a mano; siguen siendo del cliente.
 */
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

function dollarsToDecimal(dollars: number): Decimal {
  return new Decimal(Number(dollars).toFixed(2))
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
    startingAmount: toDollars(session.startingAmount),
    closedByStaffId: session.closedByStaffId,
    closedByName: session.closedByName,
    closedAt: session.closedAt ? session.closedAt.toISOString() : null,
    actualAmount: session.actualAmount ? toDollars(session.actualAmount) : null,
    expectedAmount: Number(expectedAmount.toFixed(2)),
    overShort: session.overShort ? toDollars(session.overShort) : null,
    closingNote: session.closingNote,
    events: session.events ? session.events.map(formatEvent) : [],
  }
}

/**
 * 🔴 `localId` SALE EN LA RESPUESTA: sin él los clientes fusionan por INFERENCIA.
 *
 * La llave ya se guardaba —la manda el POS al sincronizar y el servidor la deriva del
 * `paymentId` para lo que escribe él (`srv-cash-sale:` / `srv-refund:`, ver
 * `services/shared/cashDrawerPosting.ts`)— pero NUNCA se devolvía. El cliente recibía el
 * evento del servidor sin forma de reconocer que ERA EL SUYO, así que lo insertaba al lado
 * del que ya tenía en su base local: el MISMO movimiento, dos filas, dos veces en el arqueo.
 *
 * Medido en Android: un PAY_IN de $100 que ya estaba en Room antes de actualizar la app deja
 * el esperado del cajero en **$5,330.00 en vez de $5,230.00 — +$100**, el tamaño exacto del
 * movimiento heredado (con un PAY_OUT el error va al otro lado: faltante inventado). No se
 * cura solo: la limpieza por tipo del cliente excluye PAY_IN/PAY_OUT a propósito (un retiro
 * sin red debe sobrevivir) y su promoción sólo corre al ESCRIBIR el evento, así que jamás
 * alcanza filas que ya estaban en la base. Es PERMANENTE.
 *
 * Con la llave la fusión es exacta: `localId` que el cliente reconoce → es suyo, la fila local
 * adopta el id del servidor (UNA fila); `localId` desconocido o null → es de otro aparato o lo
 * escribió el servidor, entra por su id.
 *
 * ADITIVO y OPCIONAL (contrato /mobile — nunca se quita ni se renombra un campo): `null`
 * cuando la fila no tiene llave, y una app vieja que no lo lee se comporta idéntico a hoy.
 */
function formatEvent(event: any) {
  return {
    id: event.id,
    sessionId: event.sessionId,
    type: event.type,
    amount: toDollars(event.amount),
    note: event.note,
    staffId: event.staffId,
    staffName: event.staffName,
    orderId: event.orderId,
    localId: event.localId ?? null,
    createdAt: event.createdAt.toISOString(),
  }
}

function toDollars(val: any): number {
  return Number(Number(val).toFixed(2))
}

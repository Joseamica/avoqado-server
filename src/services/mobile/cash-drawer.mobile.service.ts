/**
 * Mobile Cash Drawer Service
 *
 * Cash drawer session management for iOS/Android POS apps.
 * Tracks open/close, pay-in, pay-out, and cash sales.
 */

import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { BadRequestError, ConflictError, InternalServerError, NotFoundError } from '../../errors/AppError'
import { logAction } from '../dashboard/activity-log.service'
import { Decimal } from '@prisma/client/runtime/library'
import { Prisma } from '@prisma/client'

/**
 * Largo máximo de la llave de idempotencia que un cliente puede mandar.
 *
 * 🔴 NO es un número al azar: es el techo de lo que la propia plataforma genera, con holgura.
 * Las llaves reales de hoy son un UUID del POS (36) o una derivada del `paymentId`
 * (`srv-cash-sale:` + cuid = 39, el más largo del repo — ver `shared/cashDrawerPosting.ts`).
 * 64 deja sitio para un prefijo nuevo o un id más largo sin que ninguna llave legítima quepa
 * justa, y a la vez impide que un cliente meta kilobytes en una columna INDEXADA: sin tope,
 * una llave gigante o revienta el índice btree de Postgres con un error críptico (500 por lo
 * que debería ser un 400) o infla el índice del que depende la protección contra el doble
 * cobro. El límite se aplica en TODAS las puertas que aceptan la llave del cliente
 * (`pay-in`, `pay-out`, `sync`), no sólo en las nuevas.
 */
const LOCAL_ID_MAX_LENGTH = 64

/**
 * Normaliza la llave que manda el cliente: ausente → `null` (app vieja, sigue igual);
 * presente pero inservible → 400 explícito, nunca un 500 desde el índice.
 *
 * NO se recorta el valor: la llave la elige el cliente y tiene que poder reenviar EXACTAMENTE
 * la misma cadena para que el dedupe empareje. Sólo se rechaza la que no sirve como llave.
 */
function normalizeLocalId(raw: unknown, campo = 'localId'): string | null {
  if (raw === undefined || raw === null) return null

  if (typeof raw !== 'string') {
    throw new BadRequestError(`${campo} debe ser texto`)
  }
  if (raw.trim().length === 0) {
    throw new BadRequestError(`${campo} no puede venir vacío`)
  }
  if (raw.length > LOCAL_ID_MAX_LENGTH) {
    throw new BadRequestError(`${campo} no puede exceder ${LOCAL_ID_MAX_LENGTH} caracteres`)
  }

  return raw
}

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
/**
 * Las apps mandan `staffName` opcional y el controlador rellenaba 'Staff' cuando faltaba — así el
 * dashboard («Caja física») decía "Abierta por Staff" (visto en /full-testing 27-ago). Si viene un
 * nombre real se respeta; si no, se resuelve del `Staff` y sólo en último caso queda 'Staff'.
 */
async function resolveMobileStaffName(staffId: string | null | undefined, provided?: string | null): Promise<string> {
  const given = (provided || '').trim()
  if (given && given !== 'Staff') return given
  if (!staffId) return given || 'Staff'
  try {
    const staff = await prisma.staff.findUnique({ where: { id: staffId }, select: { firstName: true, lastName: true } })
    const name = [staff?.firstName, staff?.lastName].filter(Boolean).join(' ').trim()
    return name || given || 'Staff'
  } catch {
    return given || 'Staff'
  }
}

export async function openSession(params: OpenSessionParams) {
  const { venueId, staffId, startingAmount, deviceName } = params
  const staffName = await resolveMobileStaffName(staffId, params.staffName)

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

  // Fase 4: el check de arriba es la respuesta amable del caso normal, pero NO evita la
  // carrera (dos requests pasan el findFirst antes de que ninguno cree). Lo que la evita es el
  // índice único parcial `CashDrawerSession(venueId) WHERE status='OPEN'` (migración
  // 20260827_cash_drawer_one_open_per_venue). Aquí sólo se traduce ese choque al MISMO
  // ConflictError que las apps ya conocen, en vez de dejar escapar un P2002 como 500.
  const session = await prisma.cashDrawerSession
    .create({
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
    .catch((error: unknown) => {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictError('Ya existe una caja abierta. Cierra la caja actual antes de abrir una nueva.')
      }
      throw error
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
  /**
   * Caja a la que pertenece el movimiento (cola offline, Codex 3ª auditoría). Sin él se usa la abierta.
   * Si ESA caja ya cerró, el movimiento se acepta igual sobre ella —el dinero sí salió del cajón— con
   * recálculo del overShort y bitácora `CASH_DRAWER_ADJUSTED_AFTER_CLOSE`; nunca se carga a otra caja.
   */
  sessionId?: string | null
  /**
   * 🔴 LLAVE DE IDEMPOTENCIA DEL POS. OPCIONAL y ADITIVA (contrato /mobile: una app ya
   * distribuida que no la mande se comporta EXACTAMENTE como hoy).
   *
   * Es el id con el que la app guarda el movimiento en su base local — Android
   * `CashDrawerEventEntity.id`, un UUID estable; iOS el suyo — la MISMA llave que ya viaja
   * por `/cash-drawer/sync`. El push de un ingreso/retiro es fire-and-forget: si la respuesta
   * se pierde, el POS reintenta el MISMO movimiento y sin llave el servidor crea una SEGUNDA
   * fila que el arqueo da por buena (efectivo inventado, +$100 medido en Android).
   */
  localId?: string | null
}

/**
 * Lo que devuelven `payIn` / `payOut`.
 *
 * `created` es la señal con la que el controlador elige el código HTTP: **201 cuando la fila
 * se creó, 200 cuando la llave ya existía** y se devuelve la que ya estaba. El CUERPO es
 * idéntico en los dos casos, así que un cliente que ignore el código sigue funcionando.
 */
export interface DrawerEventResult {
  event: ReturnType<typeof formatEvent>
  /** `false` = reintento: no se creó nada, se devolvió el movimiento que ya existía. */
  created: boolean
}

/**
 * Registra un movimiento manual del cajero (ingreso o retiro), idempotente por `localId`.
 *
 * 🔴 EL PUNTO ENTERO ES EL REINTENTO. El caso real no es un cliente hostil: es la respuesta
 * que se pierde (WiFi del local, 502 del proxy, la app que se reinicia a media petición) y el
 * POS que reenvía el MISMO retiro. Sin llave eso era un SEGUNDO retiro; con ella el índice
 * `@@unique([venueId, localId])` lo bloquea y se devuelve el movimiento original.
 *
 * `createMany` + `skipDuplicates` en vez de `create`: con `create`, el choque lanza P2002 y el
 * cajero vería un error 500 por una operación que SÍ había funcionado — y volvería a teclearla.
 * Es el mismo patrón que ya usa `services/shared/cashDrawerPosting.ts` para lo que escribe el
 * servidor, para que haya UNA sola forma de escribir en esta tabla.
 *
 * GANA LA PRIMERA ESCRITURA: un reenvío con la misma llave y otro monto NO reescribe la fila.
 * Si pudiera, la idempotencia se convertiría en una puerta para mover dinero sin dejar rastro.
 */
async function recordManualDrawerEvent(type: 'PAY_IN' | 'PAY_OUT', params: PayInOutParams): Promise<DrawerEventResult> {
  const { venueId, staffId, amount, note } = params
  const staffName = await resolveMobileStaffName(staffId, params.staffName)

  if (amount <= 0) {
    throw new BadRequestError('El monto debe ser mayor a 0')
  }

  // Se valida ANTES de tocar la base: una llave basura no puede llegar al índice único.
  const localId = normalizeLocalId(params.localId)
  const session = params.sessionId
    ? await prisma.cashDrawerSession.findFirst({ where: { id: params.sessionId, venueId }, select: { id: true, status: true } })
    : await getOpenSession(venueId)
  if (!session) throw new NotFoundError('Esa caja no existe en este negocio')
  const amountDecimal = dollarsToDecimal(amount)

  const row = {
    sessionId: session.id,
    venueId,
    type,
    amount: amountDecimal,
    staffId,
    staffName,
    note: note || null,
    localId,
  }

  const action = type === 'PAY_IN' ? 'CASH_DRAWER_PAY_IN' : 'CASH_DRAWER_PAY_OUT'

  const auditar = (entityId: string) =>
    logAction({
      staffId,
      venueId,
      action,
      entity: 'CashDrawerEvent',
      entityId,
      data: { sessionId: session.id, amount: Number(amountDecimal), note, source: 'MOBILE' },
    })

  // Sin llave: EXACTAMENTE el `create` de siempre. Las apps ya distribuidas no cambian de
  // camino ni de comportamiento — simplemente no ganan la protección (Postgres permite
  // varios NULL en un índice único, así que aquí no hay nada que deduplicar).

  // 🔴 Caja YA CERRADA (llega tarde desde la cola de un aparato): el dinero sí salió/entró del cajón,
  // así que el movimiento se acepta SOBRE ESA caja, bajo candado, con recálculo del overShort firmado y
  // bitácora con los valores anterior/nuevo. Cargarlo a la caja abierta de hoy sería atribuirlo mal;
  // rechazarlo, perderlo.
  if ((session as { status?: string }).status === 'CLOSED') {
    const result = await prisma.$transaction(async tx => {
      await tx.cashDrawerSession.updateMany({ where: { id: session.id }, data: { updatedAt: new Date() } })
      const inserted = localId
        ? await tx.cashDrawerEvent.createMany({ data: [row], skipDuplicates: true })
        : { count: (await tx.cashDrawerEvent.create({ data: row })) ? 1 : 0 }
      const stored = localId ? await tx.cashDrawerEvent.findFirst({ where: { venueId, localId } }) : await tx.cashDrawerEvent.findFirst({ where: { sessionId: session.id, type }, orderBy: { createdAt: 'desc' } })
      if (!stored) throw new InternalServerError('No se pudo confirmar el movimiento de caja')
      if (inserted.count > 0) {
        const full = await tx.cashDrawerSession.findUnique({ where: { id: session.id }, select: { actualAmount: true, overShort: true, startingAmount: true, events: { select: { type: true, amount: true } } } })
        if (full && full.actualAmount !== null) {
          const expected = calculateExpectedAmount({ startingAmount: full.startingAmount, events: full.events })
          const overShort = Number(full.actualAmount) - expected
          await tx.cashDrawerSession.update({ where: { id: session.id }, data: { overShort: new Decimal(overShort.toFixed(2)) } })
          logAction({
            staffId,
            venueId,
            action: 'CASH_DRAWER_ADJUSTED_AFTER_CLOSE',
            entity: 'CashDrawerSession',
            entityId: session.id,
            data: { cause: type, eventId: stored.id, amount: Number(amountDecimal), overShortBefore: full.overShort != null ? Number(full.overShort) : null, overShortAfter: overShort, expectedAfter: expected, source: 'MOBILE_OFFLINE_REPLAY' },
          })
        }
      }
      return { stored, created: inserted.count > 0 }
    })
    if (result.created) auditar(result.stored.id)
    return { event: formatEvent(result.stored), created: result.created }
  }
  // 🔴 P1 (Codex, 2ª auditoría): el movimiento MANUAL se colaba en una caja que el cierre acababa de
  // firmar. Mismo candado que la venta: dentro de la transacción se TOCA la fila con status='OPEN'
  // (UPDATE = candado de fila); si el cierre ya la marcó CLOSED, al re-evaluar no hay fila y el
  // movimiento se rechaza con el mismo "no hay caja abierta" que las apps ya conocen.
  const lockOrThrow = async (tx: Prisma.TransactionClient) => {
    const lock = await tx.cashDrawerSession.updateMany({ where: { id: session.id, status: 'OPEN' }, data: { updatedAt: new Date() } })
    if (!lock || lock.count === 0) throw new NotFoundError('No hay una caja abierta')
  }
  if (!localId) {
    const event = await prisma.$transaction(async tx => {
      await lockOrThrow(tx)
      return tx.cashDrawerEvent.create({ data: row })
    })
    auditar(event.id)
    return { event: formatEvent(event), created: true }
  }
  const result = await prisma.$transaction(async tx => {
    await lockOrThrow(tx)
    return tx.cashDrawerEvent.createMany({ data: [row], skipDuplicates: true })
  })
  const stored = await prisma.cashDrawerEvent.findFirst({ where: { venueId, localId } })

  if (!stored) {
    // No debería ocurrir: o lo acabamos de insertar, o ya estaba. Si la relectura falla no
    // podemos devolverle al POS la fila que tiene que adoptar, y mentir con una fila
    // inventada sería peor: se responde error y el reintento vuelve a deduplicar.
    logger.error('❌ [CASH-DRAWER] Movimiento guardado pero imposible de releer por su llave', { venueId, localId, type })
    throw new InternalServerError('No se pudo confirmar el movimiento de caja')
  }

  const created = result.count > 0

  if (created) {
    auditar(stored.id)
  } else {
    // Ni auditoría nueva ni fila nueva: el movimiento es el mismo de antes.
    logger.info('💵 [CASH-DRAWER] Movimiento manual ya registrado (reintento) — se devuelve el original, no se duplica', {
      venueId,
      sessionId: session.id,
      type,
      localId,
      eventId: stored.id,
    })
  }

  return { event: formatEvent(stored), created }
}

/**
 * Add a pay-in event (cash added to drawer). Idempotente por `localId` — ver
 * `recordManualDrawerEvent`.
 */
export async function payIn(params: PayInOutParams): Promise<DrawerEventResult> {
  return recordManualDrawerEvent('PAY_IN', params)
}

// ============================================================================
// PAY OUT
// ============================================================================

/**
 * Add a pay-out event (cash removed from drawer). Idempotente por `localId` — ver
 * `recordManualDrawerEvent`.
 */
export async function payOut(params: PayInOutParams): Promise<DrawerEventResult> {
  return recordManualDrawerEvent('PAY_OUT', params)
}

// ============================================================================
// CLOSE SESSION
// ============================================================================

interface CloseSessionParams {
  /** Id de la caja que el aparato cerró (cola offline). Si ya no es la abierta, 404 en vez de cerrar otra. */
  sessionId?: string | null
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
  const { venueId, staffId, actualAmount, note } = params
  const staffName = await resolveMobileStaffName(staffId, params.staffName)

  if (actualAmount < 0) {
    throw new BadRequestError('El monto no puede ser negativo')
  }

  const session = await prisma.cashDrawerSession.findFirst({
    where: { venueId, status: 'OPEN' },
    select: { id: true },
  })
  if (!session) {
    throw new NotFoundError('No hay una caja abierta')
  }
  // 🔴 P1 (Codex, 2ª auditoría): un cierre ENCOLADO en el aparato (sin red) llega tarde. Si trae el
  // id de SU caja y la caja abierta ahora es OTRA, no se cierra la ajena con el conteo de la vieja:
  // se contesta el mismo 404, que el aparato entiende como "esa ya no está abierta".
  if (params.sessionId && params.sessionId !== session.id) {
    throw new NotFoundError('No hay una caja abierta')
  }
  const actualDecimal = dollarsToDecimal(actualAmount)

  // Fase 4: el cierre es UNA transacción con CAS. Antes era leer → calcular → actualizar en
  // tres pasos sueltos: una venta que entrara entre "leer" y "escribir" dejaba el `overShort`
  // obsoleto, y dos cierres simultáneos se pisaban y creaban dos eventos CLOSE. Ahora:
  //   · los eventos se leen DENTRO de la tx (lo que ella ve es lo que se firma);
  //   · el `updateMany where status='OPEN'` es el candado: quien pierde la carrera no
  //     actualiza nada y recibe el mismo "no hay caja abierta" que ya conocen las apps;
  //   · el CLOSE se crea sólo si el CAS ganó.
  const { closedSession, expectedAmount, overShort } = await prisma.$transaction(async tx => {
    // 🔴 P1 (Codex 27-ago): el CAS va PRIMERO. El UPDATE toma el candado de la fila; un cobro que
    // quiera sumar al cajón (createEventUnderSessionLock, con `status='OPEN'`) se queda esperando
    // y al re-evaluar ya no encuentra la caja abierta. Sólo entonces se leen los eventos: lo que
    // se lee bajo el candado es exactamente lo que se firma.
    const closedAt = new Date()
    const won = await tx.cashDrawerSession.updateMany({
      where: { id: session.id, venueId, status: 'OPEN' },
      data: {
        status: 'CLOSED',
        closedByStaffId: staffId,
        closedByName: staffName,
        closedAt,
        actualAmount: actualDecimal,
        closingNote: note || null,
      },
    })
    if (won.count !== 1) {
      throw new NotFoundError('No hay una caja abierta')
    }
    const events = await tx.cashDrawerEvent.findMany({ where: { sessionId: session.id }, orderBy: { createdAt: 'asc' } })
    const startingAmount = events.find(e => e.type === 'OPEN')?.amount ?? 0
    const expected = calculateExpectedAmount({ startingAmount, events })
    const diff = Number(actualDecimal) - expected
    await tx.cashDrawerSession.update({ where: { id: session.id }, data: { overShort: new Decimal(diff.toFixed(2)) } })
    await tx.cashDrawerEvent.create({
      data: { sessionId: session.id, venueId, type: 'CLOSE', amount: actualDecimal, staffId, staffName, note: note || null },
    })
    const closed = await tx.cashDrawerSession.findUnique({
      where: { id: session.id },
      include: { events: { orderBy: { createdAt: 'desc' } } },
    })
    if (!closed) throw new NotFoundError('No hay una caja abierta')
    return { closedSession: closed, expectedAmount: expected, overShort: diff }
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
   * apps viejas — sin ella el reintento no se puede deduplicar. Misma llave y mismas
   * reglas de validación que en `pay-in` / `pay-out` (ver `normalizeLocalId`).
   */
  localId?: string | null
}

/**
 * Bulk sync events from mobile (for offline-first support).
 * Creates multiple events in a single transaction.
 */
/**
 * `appVersion` (header `x-app-version`) sólo alimenta la MÉTRICA de compatibilidad: cuántos
 * `CASH_SALE` empujan todavía las apps viejas y desde qué versión. Es lo que permite retirar el
 * descarte de abajo por DATO (N días con `droppedCashSales = 0`) y no por "ya están todos
 * actualizados" — decisión del founder (27-ago): nada de gates manuales, nada de código muerto.
 */
export async function syncEvents(venueId: string, events: SyncEvent[], appVersion?: string | null) {
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
  // 🔴 La llave se valida aquí también: `/sync` es la OTRA puerta por la que un cliente
  // escribe en la columna indexada. Validar sólo `pay-in`/`pay-out` dejaría el hueco
  // abierto por donde entra el lote. Se valida lo que de verdad vamos a insertar (los
  // `CASH_SALE` se descartan más abajo, así que su llave nunca toca el índice).
  const acceptedEvents = events
    .filter(event => event.type !== 'CASH_SALE')
    .map(event => ({ ...event, localId: normalizeLocalId(event.localId, 'events[].localId') }))

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
    data: { eventCount: insertedCount, receivedCount: events.length, droppedCashSales, appVersion: appVersion ?? null, source: 'MOBILE' },
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
/**
 * Exportada para que el dashboard (`cashDrawer.dashboard.service`) muestre EXACTAMENTE el
 * mismo esperado que vio el cajero al cerrar. Dos fórmulas = dos verdades para el mismo
 * dinero, que es justo lo que la unificación de caja está quitando.
 */
export function calculateExpectedAmount(session: any): number {
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

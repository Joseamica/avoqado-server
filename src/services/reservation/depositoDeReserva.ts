/**
 * D681 · EL DUEÑO DEL DEPÓSITO DE UNA RESERVA.
 *
 * Este archivo es el ÚNICO que escribe los campos del depósito de una reserva (`depositStatus`, `checkoutSessionId`,
 * `depositExpiresAt`, `depositPaidAt`, `depositProcessorRef`, `depositRefundedAt`) y los cambios de `status` que provoca el
 * depósito (pagado → CONFIRMED, liga vencida → CANCELLED). Lo vigila `tests/unit/architecture/depositoDeReservaUnDueno.test.ts`.
 *
 * Por qué: en las rondas 1 y 2 de Codex chocaban siete escritores entre sí (cancelar, el aviso de pago o de vencida de Stripe,
 * el barrido por reloj, la consulta a Stripe, el regreso de la app de clientes, crear o «pagar de nuevo» la liga) y cada parche
 * abría otra esquina. Aquí cada evento pasa por UNA tabla de transiciones (`decidirTransicion`, pura) y se escribe con CAS: el
 * `where` lleva el estado que se leyó; si otro escritor ganó, se vuelve a leer y a decidir. Una transición no permitida no
 * cambia nada; si había dinero de por medio (un pago), deja `MoneyAnomaly` una sola vez.
 *
 * Los cambios de `status` que NO vienen del depósito (confirmar a mano, llegada, terminar, no-show, reagendar, cancelar) siguen
 * en su máquina de estados (`transitionReservation`, `checkIn.service`…). Cuando cancelar toca el depósito, lo hace llamando a
 * este archivo dentro de su misma transacción.
 */
import { DepositStatus, Prisma, ReservationStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { ConflictError, ServiceUnavailableError } from '@/errors/AppError'
import { getProvider } from '@/services/payments/provider-registry'
import type { EcommerceMerchantWithProvider } from '@/services/payments/providers/provider.interface'

type Db = Prisma.TransactionClient | typeof prisma

/** Una liga nueva no puede alargar el apartado más que esto sobre su vencimiento original (Stripe redondea y pide ≥ 30 min). */
const TOLERANCIA_ALARGAR_MS = 2 * 60_000
const INTENTOS_CAS = 5

export type EstadoDeposito = {
  id: string
  venueId: string
  confirmationCode: string
  status: ReservationStatus
  depositStatus: DepositStatus | null
  checkoutSessionId: string | null
  depositExpiresAt: Date | null
}

export type EventoDeposito =
  /** Se creó una liga de Stripe (alta, «pagar de nuevo», recuperación de huérfanas). */
  | { tipo: 'LIGA_CREADA'; sesionId: string; venceEn: Date; merchantId: string }
  /** Stripe cobró (aviso, consulta o regreso de la app). `eventoId` hace única la anomalía si no se puede aplicar. */
  | { tipo: 'PAGADO'; paymentIntentId: string | null; pagadoEn?: Date; eventoId: string }
  /** La liga venció o se cerró sin pagar (`sesionId`), o venció por reloj sin liga (`sesionId: null`). */
  | { tipo: 'VENCIDO'; sesionId: string | null; motivo: string }
  /** La reserva se cancela (en la MISMA transacción que su status): la liga `sesionCerrada` ya se cerró en Stripe. */
  | { tipo: 'CANCELADA'; sesionCerrada: string | null }
  /** El negocio se queda con el depósito pagado (cancelación tardía o no-show): la reserva debe seguir en ese estado. */
  | { tipo: 'RETENIDO'; por: 'CANCELLED' | 'NO_SHOW' }
  /** Stripe confirmó la devolución del depósito. */
  | { tipo: 'DEVUELTO'; devueltoEn: Date }
  /** «Sí llegó»: el depósito retenido vuelve a contar como pagado. */
  | { tipo: 'RESTAURADO' }

export type MotivoRechazo = 'CANCELADA' | 'PAGADA' | 'APARTADO_VENCIDO' | 'SIN_CONFIRMAR' | 'LIGA_ABIERTA' | 'CERRADA' | 'NO_APLICA'

export type Decision =
  | { tipo: 'APLICAR'; data: Prisma.ReservationUncheckedUpdateManyInput }
  | { tipo: 'IGUAL' }
  | { tipo: 'RECHAZO'; motivo: MotivoRechazo }

const DEPOSITO_COBRADO: DepositStatus[] = ['PAID', 'REFUNDED', 'FORFEITED', 'DISPUTED']

/**
 * La tabla de transiciones. Pura: dado el estado leído y el evento, dice qué escribir. Es la única regla; nadie más decide.
 */
export function decidirTransicion(
  e: Omit<EstadoDeposito, 'id' | 'venueId' | 'confirmationCode'>,
  ev: EventoDeposito,
  ahora: Date,
): Decision {
  const d = e.depositStatus
  switch (ev.tipo) {
    case 'LIGA_CREADA': {
      if (e.checkoutSessionId === ev.sesionId) return { tipo: 'IGUAL' }
      if (e.status === 'CANCELLED') return { tipo: 'RECHAZO', motivo: 'CANCELADA' }
      if (d && DEPOSITO_COBRADO.includes(d)) return { tipo: 'RECHAZO', motivo: 'PAGADA' }
      if (e.status === 'COMPLETED' || e.status === 'NO_SHOW') return { tipo: 'RECHAZO', motivo: 'CERRADA' }
      // Ya hay una liga abierta: nunca dos ligas cobrando el mismo depósito (quien la reemplaza primero la cierra o la reusa).
      if (d === 'PENDING' && e.checkoutSessionId) return { tipo: 'RECHAZO', motivo: 'LIGA_ABIERTA' }
      if (e.status === 'PENDING') {
        // Un apartado por depósito: la liga nueva nunca lo alarga más allá de su vencimiento original.
        if (d === null) return { tipo: 'RECHAZO', motivo: 'SIN_CONFIRMAR' }
        if (d === 'EXPIRED') return { tipo: 'RECHAZO', motivo: 'APARTADO_VENCIDO' }
        if (e.depositExpiresAt) {
          if (e.depositExpiresAt.getTime() <= ahora.getTime()) return { tipo: 'RECHAZO', motivo: 'APARTADO_VENCIDO' }
          if (ev.venceEn.getTime() > e.depositExpiresAt.getTime() + TOLERANCIA_ALARGAR_MS)
            return { tipo: 'RECHAZO', motivo: 'APARTADO_VENCIDO' }
        }
      }
      // CONFIRMED / CHECKED_IN: pago voluntario de una reserva «paga al llegar» (depósito null) o de una liga anterior vencida.
      return {
        tipo: 'APLICAR',
        data: {
          checkoutSessionId: ev.sesionId,
          ecommerceMerchantId: ev.merchantId,
          depositExpiresAt: ev.venceEn,
          depositStatus: 'PENDING',
        },
      }
    }
    case 'PAGADO': {
      if (d === 'PAID') return { tipo: 'IGUAL' }
      if (e.status === 'CANCELLED' || (d !== null && d !== 'PENDING')) return { tipo: 'RECHAZO', motivo: 'CANCELADA' }
      const deposito = { depositStatus: 'PAID' as const, depositPaidAt: ev.pagadoEn ?? ahora, depositProcessorRef: ev.paymentIntentId }
      // Sólo una reserva que esperaba el pago se confirma; a quien ya llegó o ya terminó, el pago no le cambia el status.
      if (e.status === 'PENDING') return { tipo: 'APLICAR', data: { status: 'CONFIRMED', confirmedAt: ahora, ...deposito } }
      return { tipo: 'APLICAR', data: deposito }
    }
    case 'VENCIDO': {
      if (ev.sesionId !== e.checkoutSessionId) return { tipo: 'IGUAL' } // venció una liga que ya no es la de la reserva
      if (d !== 'PENDING') return { tipo: 'IGUAL' }
      if (e.status === 'PENDING') {
        return {
          tipo: 'APLICAR',
          data: { status: 'CANCELLED', cancelledAt: ahora, cancelledBy: 'SYSTEM', cancellationReason: ev.motivo, depositStatus: 'EXPIRED' },
        }
      }
      // Ya confirmada, llegada, terminada o cancelada: el vencimiento sólo cierra el depósito, nunca cancela ni cambia quién canceló.
      return { tipo: 'APLICAR', data: { depositStatus: 'EXPIRED' } }
    }
    case 'CANCELADA': {
      if (e.status !== 'CANCELLED') return { tipo: 'RECHAZO', motivo: 'NO_APLICA' }
      if (d !== 'PENDING') return { tipo: 'IGUAL' } // pagado: lo atiende la devolución o la retención después
      if (e.checkoutSessionId !== ev.sesionCerrada) return { tipo: 'RECHAZO', motivo: 'LIGA_ABIERTA' }
      return { tipo: 'APLICAR', data: { depositStatus: 'EXPIRED' } }
    }
    case 'RETENIDO': {
      if (d === 'FORFEITED') return { tipo: 'IGUAL' }
      if (d !== 'PAID' || e.status !== ev.por) return { tipo: 'RECHAZO', motivo: 'NO_APLICA' }
      return { tipo: 'APLICAR', data: { depositStatus: 'FORFEITED' } }
    }
    case 'DEVUELTO': {
      if (d === 'REFUNDED') return { tipo: 'IGUAL' }
      if (d !== 'PAID') return { tipo: 'RECHAZO', motivo: 'NO_APLICA' }
      return { tipo: 'APLICAR', data: { depositStatus: 'REFUNDED', depositRefundedAt: ev.devueltoEn } }
    }
    case 'RESTAURADO': {
      if (d === 'PAID') return { tipo: 'IGUAL' }
      if (d !== 'FORFEITED' || e.status === 'CANCELLED' || e.status === 'NO_SHOW') return { tipo: 'RECHAZO', motivo: 'NO_APLICA' }
      return { tipo: 'APLICAR', data: { depositStatus: 'PAID' } }
    }
  }
}

export type ResultadoDeposito =
  | { resultado: 'APLICADO'; antes: EstadoDeposito; despues: EstadoDeposito }
  | { resultado: 'IGUAL'; antes: EstadoDeposito }
  | { resultado: 'RECHAZADO'; motivo: MotivoRechazo; antes: EstadoDeposito }
  | { resultado: 'NO_EXISTE' }

const SELECT_ESTADO = {
  id: true,
  venueId: true,
  confirmationCode: true,
  status: true,
  depositStatus: true,
  checkoutSessionId: true,
  depositExpiresAt: true,
} as const

type Referencia = { reservationId: string; venueId?: string } | { checkoutSessionId: string }

/**
 * La ÚNICA función que escribe el depósito de una reserva. Lee, decide con la tabla y escribe con CAS; si otro escritor ganó,
 * vuelve a leer. Dentro de la transacción de quien llama si recibe `db = tx`.
 */
export async function aplicarAlDeposito(db: Db, ref: Referencia, evento: EventoDeposito): Promise<ResultadoDeposito> {
  const where =
    'checkoutSessionId' in ref
      ? { checkoutSessionId: ref.checkoutSessionId }
      : { id: ref.reservationId, ...(ref.venueId ? { venueId: ref.venueId } : {}) }
  for (let intento = 0; intento < INTENTOS_CAS; intento++) {
    const antes = await db.reservation.findFirst({ where, select: SELECT_ESTADO })
    if (!antes) return { resultado: 'NO_EXISTE' }
    const ahora = new Date()
    const decision = decidirTransicion(antes, evento, ahora)
    if (decision.tipo === 'IGUAL') return { resultado: 'IGUAL', antes }
    if (decision.tipo === 'RECHAZO') {
      if (evento.tipo === 'PAGADO') await anotarPagoSinReserva(db, antes, evento.eventoId)
      return { resultado: 'RECHAZADO', motivo: decision.motivo, antes }
    }
    const { count } = await db.reservation.updateMany({
      where: {
        id: antes.id,
        venueId: antes.venueId,
        status: antes.status,
        depositStatus: antes.depositStatus,
        checkoutSessionId: antes.checkoutSessionId,
        depositExpiresAt: antes.depositExpiresAt,
      },
      data: decision.data,
    })
    if (count === 1) {
      const despues = { ...antes, ...(decision.data as Partial<EstadoDeposito>) }
      logger.info(
        `💳 [DEPÓSITO] ${antes.confirmationCode}: ${evento.tipo} · ${antes.status}/${antes.depositStatus} → ${despues.status}/${despues.depositStatus}`,
      )
      return { resultado: 'APLICADO', antes, despues }
    }
  }
  throw new ConflictError('La reservación cambió mientras se procesaba; intenta de nuevo.')
}

/** Un pago que llegó a una reserva que ya no puede recibirlo (cancelada, vencida): dinero que alguien debe devolver. Una vez. */
async function anotarPagoSinReserva(db: Db, e: EstadoDeposito, eventoId: string): Promise<void> {
  await db.moneyAnomaly.createMany({
    data: [
      {
        category: 'PAID_AFTER_DIVERGENT_STATE',
        reservationId: e.id,
        stripeEventId: eventoId,
        expectedState: { depositStatus: 'PENDING' },
        observedState: { status: e.status, depositStatus: e.depositStatus },
      },
    ],
    skipDuplicates: true,
  })
  logger.error('🚨 [STRIPE CONNECT] Money anomaly detected', {
    category: 'PAID_AFTER_DIVERGENT_STATE',
    reservationId: e.id,
    stripeEventId: eventoId,
  })
}

/** Stripe Checkout pide que una liga dure al menos 30 min desde que se crea (más un margen para el reloj). */
const MINIMO_DE_STRIPE_MS = 30 * 60_000 + 5_000

/**
 * Hasta cuándo puede durar una liga NUEVA de esta reserva. Un apartado por depósito (reserva PENDING con fecha) nunca se alarga
 * más allá de su vencimiento original; si vence antes de lo que Stripe deja abrir una liga, no hay liga (`null`).
 */
export function vencimientoDeLigaNueva(e: { status: ReservationStatus; depositExpiresAt: Date | null }, ahora = new Date()): Date | null {
  const minimo = new Date(ahora.getTime() + MINIMO_DE_STRIPE_MS)
  if (e.status !== 'PENDING' || !e.depositExpiresAt) return minimo
  if (e.depositExpiresAt.getTime() >= minimo.getTime()) return e.depositExpiresAt
  if (e.depositExpiresAt.getTime() + TOLERANCIA_ALARGAR_MS >= minimo.getTime()) return minimo
  return null
}

/** El estado inicial del depósito al CREAR una reserva (el único lugar donde una creación pone estos campos). */
export function depositoAlCrear(estado: DepositStatus | null, venceEn: Date | null = null) {
  return { depositStatus: estado, depositExpiresAt: venceEn }
}

/** Texto para quien pidió la liga cuando el depósito ya no la acepta. */
export function textoDeRechazo(motivo: MotivoRechazo): string {
  switch (motivo) {
    case 'PAGADA':
      return 'El depósito de esta reservación ya está pagado.'
    case 'CANCELADA':
      return 'Esta reservación ya se canceló.'
    case 'APARTADO_VENCIDO':
      return 'Tu apartado venció. Reserva de nuevo.'
    case 'SIN_CONFIRMAR':
      return 'Esta reservación todavía no está confirmada por el negocio; puedes pagar al llegar.'
    case 'LIGA_ABIERTA':
      return 'Ya hay un pago en curso para esta reservación.'
    default:
      return 'Esta reservación ya no acepta pagos en línea.'
  }
}

/**
 * Guarda en la reserva una liga recién creada. Si el depósito ya no la acepta (cancelada, pagada, apartado vencido u otra liga
 * abierta), la liga nueva se cierra en Stripe y NO se entrega.
 */
export async function registrarLiga(args: {
  reservationId: string
  venueId: string
  merchant: EcommerceMerchantWithProvider & { id: string }
  session: { id: string; expiresAt: Date }
}): Promise<void> {
  const r = await aplicarAlDeposito(
    prisma,
    { reservationId: args.reservationId, venueId: args.venueId },
    { tipo: 'LIGA_CREADA', sesionId: args.session.id, venceEn: args.session.expiresAt, merchantId: args.merchant.id },
  )
  if (r.resultado === 'APLICADO' || r.resultado === 'IGUAL') return
  try {
    await getProvider(args.merchant).expireAuthorizationCheckout(args.merchant, args.session.id)
  } catch (error) {
    // Nadie tiene esta liga (no se entrega) y vence sola a su hora.
    logger.warn(`⚠️ [DEPÓSITO] No se pudo cerrar la liga ${args.session.id} que no se entregó`, error)
  }
  throw new ConflictError(r.resultado === 'RECHAZADO' ? textoDeRechazo(r.motivo) : 'Reservación no encontrada')
}

/**
 * La cuenta conectada de Stripe que creó la liga de la reserva (la fijada); las filas viejas sin cuenta fijada usan la más
 * nueva activa del negocio, igual que la conciliación.
 */
export async function cuentaDeLaReserva(venueId: string, pinnedMerchantId: string | null) {
  if (pinnedMerchantId) {
    const pinned = await prisma.ecommerceMerchant.findFirst({
      where: { id: pinnedMerchantId, venueId, provider: { code: 'STRIPE_CONNECT' } },
      include: { provider: true },
    })
    if (pinned) return pinned
    logger.warn(`⚠️ [DEPÓSITO] Cuenta fijada ${pinnedMerchantId} no encontrada; se usa la más nueva activa del negocio ${venueId}`)
  }
  return prisma.ecommerceMerchant.findFirst({
    where: { venueId, active: true, provider: { code: 'STRIPE_CONNECT', active: true } },
    include: { provider: true },
    orderBy: { createdAt: 'desc' },
  })
}

export const TEXTO_NO_SE_PUDO_CERRAR = 'No pudimos cerrar el pago en línea; intenta de nuevo en un momento'

/**
 * Cierra en Stripe la liga de una reserva ANTES de cancelarla. Falla CERRADA: si no se puede comprobar que la liga ya no cobra,
 * lanza 503 y la reserva no se toca. Si resulta que ya se pagó, lo dice (quien llama aplica el pago antes de cancelar).
 */
export async function cerrarLiga(
  venueId: string,
  r: { checkoutSessionId: string; ecommerceMerchantId: string | null },
): Promise<{ cerrada: true } | { pagada: true; paymentIntentId: string | null }> {
  const merchant = await cuentaDeLaReserva(venueId, r.ecommerceMerchantId)
  if (!merchant) throw new ServiceUnavailableError(TEXTO_NO_SE_PUDO_CERRAR, 'DEPOSIT_CHECKOUT_CLOSE_FAILED')
  const provider = getProvider(merchant)
  try {
    await provider.expireAuthorizationCheckout(merchant, r.checkoutSessionId)
    return { cerrada: true }
  } catch (error) {
    // Stripe no deja cerrar una liga ya vencida o ya pagada: se pregunta cuál de las dos.
    try {
      const estado = await provider.getPaymentStatus(merchant, r.checkoutSessionId)
      if (estado.status === 'EXPIRED') return { cerrada: true }
      if (estado.status === 'PAID') return { pagada: true, paymentIntentId: estado.paymentIntentId ?? null }
    } catch {
      // sin respuesta: cae al 503
    }
    logger.warn(`⚠️ [DEPÓSITO] No se pudo cerrar la liga ${r.checkoutSessionId}`, error)
    throw new ServiceUnavailableError(TEXTO_NO_SE_PUDO_CERRAR, 'DEPOSIT_CHECKOUT_CLOSE_FAILED')
  }
}

/**
 * Antes de cancelar: si el depósito sigue pendiente con liga, la cierra en Stripe (o, si ya se pagó, aplica el pago para que la
 * cancelación siga el camino de un depósito pagado). Devuelve la liga cerrada, que la cancelación pasa a `CANCELADA`.
 */
export async function cerrarLigaAntesDeCancelar(venueId: string, reservationId: string): Promise<{ sesionCerrada: string | null }> {
  const r = await prisma.reservation.findFirst({
    where: { id: reservationId, venueId },
    select: { status: true, depositStatus: true, checkoutSessionId: true, ecommerceMerchantId: true },
  })
  // Sólo se cierra la liga de una reserva que sí se puede cancelar (las demás las rechaza su máquina de estados).
  const cancelable = r?.status === 'PENDING' || r?.status === 'CONFIRMED'
  if (!r || !cancelable || r.depositStatus !== 'PENDING' || !r.checkoutSessionId) return { sesionCerrada: r?.checkoutSessionId ?? null }
  const cierre = await cerrarLiga(venueId, { checkoutSessionId: r.checkoutSessionId, ecommerceMerchantId: r.ecommerceMerchantId })
  if ('pagada' in cierre) {
    await aplicarAlDeposito(
      prisma,
      { reservationId, venueId },
      { tipo: 'PAGADO', paymentIntentId: cierre.paymentIntentId, eventoId: `cierre:${r.checkoutSessionId}:paid` },
    )
  }
  return { sesionCerrada: r.checkoutSessionId }
}

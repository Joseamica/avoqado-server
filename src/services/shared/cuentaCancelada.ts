import { Prisma, type OrderStatus } from '@prisma/client'

import logger from '@/config/logger'
import { BadRequestError, ConflictError } from '@/errors/AppError'
import { claseDeEstado, estadoAlRecibirDinero } from './orderBalance'

/** El texto del founder (3-oct). El código es el de la solicitud a la terminal (`terminal-payment.service.ts:1737`): las apps ya lo conocen. */
export const MENSAJE_CUENTA_CANCELADA = 'Esta cuenta está cancelada, abre una nueva.'

/**
 * Codex r10 #2 (regla del controlador, 3-oct): se clasifica por lo que HACE la operación, no por cómo viaja. Sólo es cobro NUEVO
 * el efectivo que entra al cajón con una persona enfrente que todavía puede devolverlo. Registrar dinero ya capturado —la cola sin
 * red, una tarjeta ajena ya aprobada, una transferencia hecha, la terminal— nunca lo es.
 */
export function esCobroNuevo(a: { enVivo: boolean; efectivoDeCajon: boolean }): boolean {
  return a.enVivo && a.efectivoDeCajon
}

/** Un cobro nuevo sobre una cancelada o borrada ⇒ 400, nada se escribe. Vale para cualquier origen: rechazar no esconde dinero. */
export function rechazarCobroNuevoSobreCancelada(status: string): void {
  if (claseDeEstado(status) === 'CANCELADA') throw new BadRequestError(MENSAJE_CUENTA_CANCELADA, 'ORDER_CANCELLED_NO_NEW_CHARGE')
}

/**
 * El estado con el que se CALCULA y se GUARDA una cuenta que recibe dinero ya capturado: el estado FINAL (Codex r13 #1).
 * - De AVOQADO: cancelada con dinero ⇒ PENDING (se reabre), como desde la v10.
 * - De la plataforma de delivery o de SoftRestaurant (Codex r12 #5): su estado lo dictan ellos, así que sale de CANCELADA sólo en
 *   los casos en que HOY salía —cuando lo cobrado cubre lo que debía tal como está (`cubreComoCancelada`), que es lo que hoy decide
 *   el cierre—. Al salir se calcula VIVA, con su IVA: la v13 la calculaba cancelada y la guardaba COMPLETED (una importada de
 *   $100 + $16 quedaba PAGADA en $100 con $16 reconstruidos). Si no cubre, sigue cancelada y se calcula cancelada, como hoy; su
 *   defecto previo (el pago de la plataforma que vuelve a contar) vive en el plan de registro de cobros (B9).
 */
export function estadoParaCobrar<S extends string>(
  o: { status: S; originSystem: string },
  cobrado: Prisma.Decimal | number,
  cubreComoCancelada: boolean,
): S | 'PENDING' {
  return o.originSystem === 'AVOQADO' || cubreComoCancelada ? estadoAlRecibirDinero(o.status, cobrado) : o.status
}

/**
 * ¿Puede un cierre automático escribir COMPLETED/PAID? Una viva, sí. Una cancelada o borrada, de cualquier origen, nunca: si
 * recibió lo que debía ya salió de CANCELADA (`estadoParaCobrar`), y si no, no está saldada (r7 #1: cerrarla revivía su IVA).
 */
export function cierreAutomaticoPermitido(status: string): boolean {
  return claseDeEstado(status) === 'VIVA'
}

/** Codex r13 #2: el ganador de una carrera idempotente ya registró este cobro. Quien llama lo atrapa en su red del P2002. */
export class CobroYaRegistrado extends Error {
  constructor(readonly paymentId: string) {
    super('El cobro ya está registrado con esta llave')
  }
}

/**
 * Una llave de idempotencia ya usada por OTRA orden ⇒ 409. Vive aquí (preflight R-4) para que el atajo de `payCashOrder` y
 * `salirSiLaLlaveYaTienePago` respondan con el MISMO texto.
 */
export function assertIdempotentPaymentOrder(payment: { orderId?: string | null }, orderId: string): void {
  if (payment.orderId && payment.orderId !== orderId) {
    throw new ConflictError(
      'La idempotencyKey ya pertenece a otra orden. Genera una llave nueva para este cobro.',
      'IDEMPOTENCY_KEY_REUSED',
    )
  }
}

/**
 * Codex r13 #2: ANTES del rechazo de una cancelada, la identidad del cobro se resuelve otra vez BAJO EL CANDADO. Dos peticiones con
 * la misma llave pueden pasar las dos la consulta rápida; si la primera ya registró el pago y después cancelaron la cuenta por
 * fuera, la segunda no es un cobro nuevo: es la misma operación. Valida que la llave sea de ESTA orden (el mismo 409 del atajo de
 * hoy, `assertIdempotentPaymentOrder`) y sale por la recuperación de la carrera, que devuelve ese pago. Sin llave, o sin pago con
 * ella, no hace nada. CALLER_LOCKED.
 */
export async function salirSiLaLlaveYaTienePago(
  tx: Pick<Prisma.TransactionClient, 'payment'>,
  a: { venueId: string; orderId: string; idempotencyKey?: string | null },
): Promise<void> {
  if (!a.idempotencyKey) return
  const ya = await tx.payment.findUnique({
    where: { venueId_idempotencyKey: { venueId: a.venueId, idempotencyKey: a.idempotencyKey } },
    select: { id: true, orderId: true },
  })
  if (!ya) return
  assertIdempotentPaymentOrder(ya, a.orderId)
  throw new CobroYaRegistrado(ya.id)
}

/**
 * Dinero YA capturado sobre una cancelada ⇒ la saca de CANCELADA según `estadoParaCobrar`, bajo el candado de la orden de quien
 * llama, y deja rastro: cambia un resultado firmado. Devuelve el estado con el que quien llama calcula y guarda. CALLER_LOCKED.
 * La bitácora va con el `tx` a propósito (preflight R-6): auditoría atómica de un resultado firmado, no `logAction`.
 */
export async function reabrirSiRecibeDinero(
  tx: Pick<Prisma.TransactionClient, 'order' | 'activityLog'>,
  a: {
    venueId: string
    orderId: string
    status: OrderStatus
    originSystem: string
    cobrado: Prisma.Decimal | number
    cubreComoCancelada: boolean
    canal: string
    paymentId?: string | null
    idempotencyKey?: string | null
    staffId?: string | null
  },
): Promise<OrderStatus> {
  const estado = estadoParaCobrar(a, a.cobrado, a.cubreComoCancelada)
  if (estado === a.status) return estado
  await tx.order.update({ where: { id: a.orderId, venueId: a.venueId }, data: { status: estado } })
  const datos = {
    estadoAnterior: a.status,
    estadoNuevo: estado,
    origen: a.originSystem,
    canal: a.canal,
    paymentId: a.paymentId ?? null,
    idempotencyKey: a.idempotencyKey ?? null,
    cobrado: new Prisma.Decimal(a.cobrado).toFixed(2),
  }
  await tx.activityLog.create({
    data: {
      action: 'ORDER_REOPENED_BY_CAPTURED_PAYMENT',
      entity: 'Order',
      entityId: a.orderId,
      venueId: a.venueId,
      staffId: a.staffId ?? null,
      data: datos,
    },
  })
  logger.warn('🔁 [Cobro capturado] una cuenta CANCELADA recibió dinero ya cobrado y se reabrió', {
    venueId: a.venueId,
    orderId: a.orderId,
    ...datos,
  })
  return estado
}

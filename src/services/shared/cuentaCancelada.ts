import {
  NotificationChannel,
  NotificationPriority,
  NotificationType,
  OnlineOrderStatus,
  Prisma,
  StaffRole,
  type OrderStatus,
} from '@prisma/client'

import logger from '@/config/logger'
import AppError, { BadRequestError, ConflictError } from '@/errors/AppError'
import { CANCELLED_ELSEWHERE, OPEN_ONLINE_STATUSES } from '@/services/online-ordering/constants'
import { claseDeEstado, estadoAlRecibirDinero, impuestoQueSeCobraAparte } from './orderBalance'

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
  o: { status: S; originSystem: string; source?: string | null },
  cobrado: Prisma.Decimal | number,
  cubreComoCancelada: boolean,
): S | 'PENDING' {
  // 🔴 Rappi 2b (T8; Codex código r1 #3): el estado de un pedido de Rappi lo dicta Rappi. Si lo canceló y llega dinero (efectivo sin
  // red, una tarjeta ya aprobada), el dinero se registra y el pedido SIGUE cancelado; quien llama avisa. Por cualquier canal.
  if (o.source === 'RAPPI') return o.status
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
 * 🔴 R5-2 (Codex r4, P2 E): ¿el pago de una llave es un COBRO COMPLETADO de esta orden? La misma columna `idempotencyKey` guarda
 * cobros, intentos (FAILED/PENDING/PROCESSING) y devoluciones (`type: REFUND`, importe negativo); sólo un cobro completado es «la
 * misma operación» que un reintento de cobro puede devolver como hecha. Lo comparten el atajo de mesa ajena del middleware y los
 * retornos idempotentes de `payCashOrder`. `status` nunca es nulo en una fila real (default PENDING).
 */
export function esCobroCompletadoDeLaOrden(
  payment: { orderId?: string | null; status?: string | null; type?: string | null },
  orderId: string,
): boolean {
  return payment.orderId === orderId && payment.status === 'COMPLETED' && payment.type !== 'REFUND'
}

/**
 * R5-2: la llave ya existe en ESTA orden pero NO es un cobro completado (un intento fallido, una devolución) ⇒ 409, sin escribir
 * nada: ni se afirma un cobro que no ocurrió ni se inserta otro pago con una llave ocupada. Mismo código que la llave de otra orden
 * (las apps ya lo conocen: Android lo reintenta y lo deja en cuarentena visible; el reducer lo rechaza a cuarentena).
 */
export function assertLlaveEsEsteCobro(
  payment: { orderId?: string | null; status?: string | null; type?: string | null },
  orderId: string,
): void {
  assertIdempotentPaymentOrder(payment, orderId)
  if (!esCobroCompletadoDeLaOrden(payment, orderId)) {
    throw new ConflictError(
      'La idempotencyKey ya pertenece a otra operación de esta orden (un intento fallido o una devolución). Genera una llave nueva para este cobro.',
      'IDEMPOTENCY_KEY_REUSED',
    )
  }
}

/** Dueño de la mesa ajena, como lo nombra el 403 de la propiedad de mesa. */
export type DuenoDeMesa = { ownerId: string | null; ownerName: string }

/** El cuerpo EXACTO del 403 de mesa ajena: lo comparten el middleware y el controller de cobro (R5-1). */
export function cuerpoMesaAjena(dueno: DuenoDeMesa) {
  return {
    error: 'Forbidden',
    code: 'TABLE_OWNED_BY_OTHER',
    message: `Solo ${dueno.ownerName} puede modificar esta mesa`,
    ownerId: dueno.ownerId,
    ownerName: dueno.ownerName,
  }
}

/**
 * 🔴 R5-1 (Codex r4, P2 R): la petición sólo estaba autorizada a RECUPERAR el pago de su llave (mesa ajena) y ese pago ya no está
 * —lo borraron entre el middleware y el servicio— o no es un cobro completado de esta orden. Es el mismo 403 de mesa ajena: no se
 * entra al camino que crea un pago nuevo. El reducer lo lee por `code` (TABLE_OWNED_BY_OTHER ⇒ REJECTED, como `errorMesaAjena`).
 */
export class MesaAjenaSoloRecuperacion extends AppError {
  constructor(readonly dueno: DuenoDeMesa) {
    super(`Solo ${dueno.ownerName} puede modificar esta mesa`, 403, true, 'TABLE_OWNED_BY_OTHER', {
      ownerId: dueno.ownerId,
      ownerName: dueno.ownerName,
    })
  }
}

/**
 * 🔴 R8: EL PUNTO ÚNICO DE LA LLAVE. Dos peticiones con la misma llave pueden pasar las dos la consulta rápida; la segunda espera el
 * candado y, para entonces, la primera ya confirmó. Por eso, ya con los candados tomados y ANTES de cualquier regla de estado que pueda
 * haber cambiado entre las dos (venta cerrada o cancelada, saldo, catálogo, sesión de vales, propiedad de mesa), se busca el pago de
 * la llave: si existe es la misma operación y sale por la recuperación de la carrera (`CobroYaRegistrado`), que lo devuelve como la
 * primera vez. Una llave de OTRA orden ⇒ 409 (`assertIdempotentPaymentOrder`). Sin llave, o sin pago con ella, no hace nada: es un
 * cobro nuevo y siguen todas las reglas. Lo llaman `payCashOrder` y `recordOrderPayment` (TPV), cada uno una vez. CALLER_LOCKED.
 */
export async function salirSiLaLlaveYaTienePago(
  tx: Pick<Prisma.TransactionClient, 'payment'>,
  a: {
    venueId: string
    orderId: string
    idempotencyKey?: string | null
    /** 🔴 R8: el cobro del POS (`payCashOrder`) aplica aquí mismo R5-2: sólo un cobro COMPLETADO de esta orden sale; lo demás ⇒ 409. */
    soloCobroCompletado?: boolean
  },
): Promise<void> {
  if (!a.idempotencyKey) return
  const ya = await tx.payment.findUnique({
    where: { venueId_idempotencyKey: { venueId: a.venueId, idempotencyKey: a.idempotencyKey } },
    select: { id: true, orderId: true, status: true, type: true },
  })
  if (!ya) return
  if (a.soloCobroCompletado) assertLlaveEsEsteCobro(ya, a.orderId)
  else assertIdempotentPaymentOrder(ya, a.orderId)
  throw new CobroYaRegistrado(ya.id)
}

/** Pedidos en línea 1c (S1): quién recibe el aviso de un pedido web cancelado que después se cobró. */
const ROLES_QUE_RECIBEN_EL_AVISO: StaffRole[] = [StaffRole.MANAGER, StaffRole.ADMIN, StaffRole.OWNER]
/** Tope del reparto del aviso (regla de consultas acotadas): un negocio real tiene unos cuantos gerentes, no cientos. */
const MAX_GERENTES_AVISADOS = 50
/**
 * Lo que `conciliarPedidoEnLinea` LEE de la cuenta al reabrirla. Va fuera de la llamada a propósito: la guarda de escritores del
 * contrato de precio (`orderContratoDePrecioWriters.test.ts`) busca `contratoDePrecio:` dentro de cada `order.update`, y aquí sólo
 * se lee; el `data` de esa escritura nunca lo toca.
 */
const LO_QUE_LEE_LA_CONCILIACION = {
  orderNumber: true,
  contratoDePrecio: true,
  taxAmount: true,
  onlineOrder: { select: { id: true, status: true } },
} satisfies Prisma.OrderSelect

/**
 * Dinero YA capturado sobre una cancelada ⇒ la saca de CANCELADA según `estadoParaCobrar`, bajo el candado de la orden de quien
 * llama, y deja rastro: cambia un resultado firmado. Devuelve el estado con el que quien llama calcula y guarda. CALLER_LOCKED.
 * La bitácora va con el `tx` a propósito (preflight R-6): auditoría atómica de un resultado firmado, no `logAction`.
 * Pedidos en línea 1c (S1): si la cuenta es de un pedido web, también lo concilia, con el MISMO `tx` (`conciliarPedidoEnLinea`).
 * La firma y el retorno no cambian (Codex plan r1 #13: la TPV usa el retorno como estado).
 */
export async function reabrirSiRecibeDinero(
  tx: Pick<Prisma.TransactionClient, 'order' | 'activityLog' | 'onlineOrder' | 'staffVenue' | 'notification'>,
  a: {
    venueId: string
    orderId: string
    status: OrderStatus
    originSystem: string
    /** Rappi 2b: un pedido de Rappi nunca se reabre (`estadoParaCobrar`). */
    source?: string | null
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
  // La MISMA escritura trae lo que el pedido en línea necesita (sin otra lectura para las cuentas que no son web).
  const reabierta = await tx.order.update({
    where: { id: a.orderId, venueId: a.venueId },
    data: { status: estado },
    select: LO_QUE_LEE_LA_CONCILIACION,
  })
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
  if (reabierta?.onlineOrder) await conciliarPedidoEnLinea(tx, a, estado, reabierta)
  return estado
}

/**
 * 🔴 Pedidos en línea 1c, S1 (regla del founder 3-oct: el dinero ya capturado nunca se rechaza ni se pierde). La cuenta de un pedido
 * web cancelado acaba de reabrirse con dinero capturado (la cola sin red, la terminal). Antes la cuenta quedaba COMPLETED/PAID y el
 * pedido CANCELLED_BY_STAFF —o ACCEPTED, si lo canceló el panel y nadie leyó la bandeja (Codex plan r2 #4)—, partido en dos y sin
 * que nadie se enterara. Todo va con el `tx` del dinero: si la transacción revierte no queda ni el pago ni el aviso, y si confirma
 * quedan los dos (Codex plan r1 #14; por eso NO `createNotification`, que escribe con el cliente global).
 *
 * ¿El cobro deja la cuenta saldada? Lo decide `cubreComoCancelada`, el `isFullyPaid` que cada llamador calculó con TODOS sus cobros
 * (los previos más éste), y que con IVA incluido es exactamente el saldo de la cuenta viva: las dos aritméticas sólo difieren en el
 * IVA que va aparte, que una cancelada no debe (`impuestoQueSeCobraAparte`). Los pedidos web nacen con IVA incluido; si alguna vez
 * llega uno con IVA aparte, «cubre como cancelada» no prueba que cubra viva y el pedido no se completa (se reporta igual).
 */
async function conciliarPedidoEnLinea(
  tx: Pick<Prisma.TransactionClient, 'activityLog' | 'onlineOrder' | 'staffVenue' | 'notification'>,
  a: Parameters<typeof reabrirSiRecibeDinero>[1],
  estado: OrderStatus,
  cuenta: {
    orderNumber: string
    contratoDePrecio: string
    taxAmount: Prisma.Decimal | null
    onlineOrder: { id: string; status: OnlineOrderStatus } | null
  },
): Promise<void> {
  const pedido = cuenta.onlineOrder
  // Un pedido ya ENTREGADO no se toca ni se reporta.
  if (!pedido || pedido.status === OnlineOrderStatus.COMPLETED) return

  const saldada = a.cubreComoCancelada && impuestoQueSeCobraAparte({ ...cuenta, status: estado }).isZero()
  const ahora = new Date()
  // Saldada ⇒ el pedido se ENTREGA (desde cualquier estado salvo COMPLETED). No saldada ⇒ hay dinero en una cuenta cancelada que
  // quedó viva otra vez: si el pedido sigue ABIERTO (el panel canceló y nadie leyó la bandeja, Codex plan r2 #4) se cierra como lo
  // cierra la bandeja al leer (`cancelledOrderSync.ts`, mismos valores). Así el resultado no depende de esa lectura, y el pedido no
  // queda «En preparación», cobrable ni imprimible en la cocina (`printClaim.service.ts`). Si ya estaba cancelado, no se toca.
  const destino = saldada
    ? {
        puedeSalirDe: (s: OnlineOrderStatus) => s !== OnlineOrderStatus.COMPLETED,
        data: { status: OnlineOrderStatus.COMPLETED, completedAt: ahora },
      }
    : {
        puedeSalirDe: (s: OnlineOrderStatus) => OPEN_ONLINE_STATUSES.includes(s),
        data: { status: OnlineOrderStatus.CANCELLED_BY_STAFF, cancelledAt: ahora, cancelledBy: CANCELLED_ELSEWHERE },
      }
  let estadoAnterior: OnlineOrderStatus = pedido.status
  let estadoFinal: OnlineOrderStatus = pedido.status
  if (destino.puedeSalirDe(pedido.status)) {
    // CAS sobre el estado leído. Si la bandeja lo movió entre la lectura y la escritura (sincroniza la cancelación AL LEER, sin el
    // candado de la orden), se relee UNA vez: si todavía puede moverse, se reintenta; si no, se respeta lo que quedó.
    const cas = await tx.onlineOrder.updateMany({ where: { id: pedido.id, status: pedido.status }, data: destino.data })
    if (cas.count === 1) {
      estadoFinal = destino.data.status
    } else {
      const releido = await tx.onlineOrder.findUnique({ where: { orderId: a.orderId }, select: { id: true, status: true } })
      if (releido) {
        estadoAnterior = releido.status
        estadoFinal = releido.status
        if (destino.puedeSalirDe(releido.status)) {
          const otraVez = await tx.onlineOrder.updateMany({ where: { id: releido.id, status: releido.status }, data: destino.data })
          if (otraVez.count === 1) estadoFinal = destino.data.status
        }
      }
      if (estadoFinal !== destino.data.status && destino.puedeSalirDe(estadoFinal)) {
        logger.warn('[OnlineOrdering] el pedido de una cuenta cobrada tras cancelarse cambió dos veces bajo el cobro; no se movió', {
          venueId: a.venueId,
          orderId: a.orderId,
          onlineOrderId: pedido.id,
          destino: destino.data.status,
        })
      }
    }
  }
  const completado = estadoFinal === OnlineOrderStatus.COMPLETED

  await tx.activityLog.create({
    data: {
      action: 'ONLINE_ORDER_COLLECTED_AFTER_CANCEL',
      entity: 'OnlineOrder',
      entityId: pedido.id,
      venueId: a.venueId,
      staffId: a.staffId ?? null,
      data: {
        onlineOrderId: pedido.id,
        orderId: a.orderId,
        estadoAnterior,
        cobradoCents: new Prisma.Decimal(a.cobrado).times(100).toDecimalPlaces(0).toNumber(),
        canal: a.canal,
        idempotencyKey: a.idempotencyKey ?? null,
      },
    },
  })

  // Un aviso por gerente activo del negocio. Hay dinero en un pedido que alguien canceló: se avisa aunque el cobro sea parcial.
  const gerentes = await tx.staffVenue.findMany({
    where: { venueId: a.venueId, active: true, role: { in: ROLES_QUE_RECIBEN_EL_AVISO } },
    select: { staffId: true },
    orderBy: { staffId: 'asc' },
    take: MAX_GERENTES_AVISADOS,
  })
  // Fix r1: la página llena NO se recorta en silencio. Se avisa a los que caben y queda el rastro para revisarlo.
  if (gerentes.length === MAX_GERENTES_AVISADOS) {
    logger.warn('⚠️ [OnlineOrdering] página llena de gerentes al avisar de un pedido cobrado tras cancelarse; puede haber más sin aviso', {
      venueId: a.venueId,
      orderId: a.orderId,
      tope: MAX_GERENTES_AVISADOS,
    })
  }
  if (gerentes.length > 0) {
    await tx.notification.createMany({
      data: gerentes.map(g => ({
        recipientId: g.staffId,
        venueId: a.venueId,
        type: NotificationType.ALERT,
        priority: NotificationPriority.HIGH,
        channels: [NotificationChannel.IN_APP],
        entityType: 'Order',
        entityId: a.orderId,
        title: 'Se cobró un pedido en línea cancelado',
        message: `El pedido #${cuenta.orderNumber} se había cancelado y después se registró su cobro. Revisa con quien lo canceló.`,
        metadata: { onlineOrderId: pedido.id, orderNumber: cuenta.orderNumber, completado, canal: a.canal },
      })),
    })
  }
  logger.warn('🧾 [OnlineOrdering] se registró dinero en un pedido en línea cancelado', {
    venueId: a.venueId,
    orderId: a.orderId,
    onlineOrderId: pedido.id,
    estadoAnterior,
    completado,
    gerentesAvisados: gerentes.length,
  })
}

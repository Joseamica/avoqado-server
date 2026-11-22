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
import { FOLIO_PAID_STATUSES, claseDeEstado, estadoAlRecibirDinero, impuestoQueSeCobraAparte } from './orderBalance'
import { lockExistingOrderForPayment } from './paymentShiftClaim'
import { bloquearVentaParaLiga } from './ligaDeClienteEnVenta'
import { MOTIVO_BENEFICIO_REGRESADO, sellarFolioAnuladoEnTx } from '@/services/online-ordering/cortesiaDeFolio'

/** El texto del founder (3-oct). El código es el de la solicitud a la terminal (`terminal-payment.service.ts:1737`): las apps ya lo conocen. */
export const MENSAJE_CUENTA_CANCELADA = 'Esta cuenta está cancelada, abre una nueva.'

type CuentaParaEditar = { venueId: string; orderId: string; additionalOrderIds?: string[] }

/** Quien llama ya posee el candado: esta relectura no toma otro ni amplía su alcance. */
export async function rechazarSiCuentaAnuladaEnTx(tx: Prisma.TransactionClient, input: CuentaParaEditar): Promise<void> {
  const ids = [...new Set([input.orderId, ...(input.additionalOrderIds ?? [])])]
  const anuladas = await tx.order.count({
    where: { venueId: input.venueId, id: { in: ids }, status: { in: ['CANCELLED', 'DELETED'] } },
  })
  if (anuladas > 0) throw new BadRequestError(MENSAJE_CUENTA_CANCELADA, 'ORDER_CANCELLED_NO_EDIT')
}

/** Conserva el candado financiero completo o el de atribución, que no interbloquea las métricas del cliente. */
export async function bloquearCuentaParaEditar(
  tx: Prisma.TransactionClient,
  input: CuentaParaEditar,
  modo: 'COBRO' | 'ATRIBUCION' = 'COBRO',
): Promise<boolean> {
  let existe: boolean
  if (modo === 'ATRIBUCION') {
    existe = await bloquearVentaParaLiga(tx, input)
  } else {
    existe = await lockExistingOrderForPayment(tx, input)
  }
  if (!existe) return false
  await rechazarSiCuentaAnuladaEnTx(tx, input)
  return true
}

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
export const ROLES_QUE_RECIBEN_EL_AVISO: StaffRole[] = [StaffRole.MANAGER, StaffRole.ADMIN, StaffRole.OWNER]
/** Tope del reparto del aviso (regla de consultas acotadas): un negocio real tiene unos cuantos gerentes, no cientos. */
export const MAX_GERENTES_AVISADOS = 50
/**
 * Lo que `conciliarPedidoEnLinea` LEE de la cuenta al reabrirla. Va fuera de la llamada a propósito: la guarda de escritores del
 * contrato de precio (`orderContratoDePrecioWriters.test.ts`) busca `contratoDePrecio:` dentro de cada `order.update`, y aquí sólo
 * se lee; el `data` de esa escritura nunca lo toca.
 */
const LO_QUE_LEE_LA_CONCILIACION = {
  orderNumber: true,
  contratoDePrecio: true,
  taxAmount: true,
  // Tienda híbrida (T9): un folio (`requiresAcceptance:false`) saldado tarde va a «Por entregar», no a «Entregado».
  onlineOrder: { select: { id: true, status: true, requiresAcceptance: true } },
  // S9 (P2-5): la cortesía que dejó la anulación de un folio (su beneficio ya regresó a la clienta), para el aviso al gerente. Son las
  // filas de UNA cuenta con ese motivo exacto: una o dos en una venta real.
  orderDiscounts: { where: { isComp: true, compReason: MOTIVO_BENEFICIO_REGRESADO }, select: { amount: true } },
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
    onlineOrder: { id: string; status: OnlineOrderStatus; requiresAcceptance?: boolean } | null
    orderDiscounts?: Array<{ amount: Prisma.Decimal }>
  },
): Promise<void> {
  const pedido = cuenta.onlineOrder
  // Un pedido ya ENTREGADO no se toca ni se reporta.
  if (!pedido || pedido.status === OnlineOrderStatus.COMPLETED) return

  const saldada = a.cubreComoCancelada && impuestoQueSeCobraAparte({ ...cuenta, status: estado }).isZero()
  const ahora = new Date()
  // Saldada ⇒ «Mi equipo»: el pedido se ENTREGA (desde cualquier estado salvo COMPLETED). Un folio (tienda híbrida, decisión 18)
  // todavía por pagar pasa a «Por entregar» (`ACCEPTED`) aquí, sin marca de cocina (como hoy). Un folio CERRADO (vencido, cancelado o
  // rechazado) NO (S9, Codex r2): lo revive `syncPaidClosedFolios`, cada 30 s y al leer la bandeja o las listas, que publica después del
  // commit (evento en vivo, aviso a la clienta y bitácora `ONLINE_ORDER_ACCEPTED`) y no marca la cocina salvo que la caja lo haya cobrado
  // antes de cerrarse (regla C, founder 10-nov: `cobradoATiempoEnTx`); desde esta transacción nadie
  // publicaba. ACCEPTED, READY y COMPLETED se quedan como están: el dinero nunca lo entrega. El `where` de cada CAS repite de quién es
  // (R15), para que ninguna rama escriba el destino de la otra. No saldada ⇒ hay dinero en una cuenta cancelada que quedó viva otra vez:
  // si el pedido sigue ABIERTO (el panel canceló y nadie leyó la bandeja, Codex plan r2 #4) se cierra como lo cierra la bandeja al leer
  // (`cancelledOrderSync.ts`, mismos valores). Así el resultado no depende de esa lectura, y el pedido no queda «En preparación»,
  // cobrable ni imprimible en la cocina (`printClaim.service.ts`). Si ya estaba cancelado, no se toca. Un folio que sólo abona sigue
  // cerrado: cuando otro cobro salde la cuenta, `syncPaidClosedFolios` lo pasa a «Por entregar».
  const esFolio = pedido.requiresAcceptance === false
  const NO_LO_MUEVE_EL_DINERO: OnlineOrderStatus[] = [
    OnlineOrderStatus.ACCEPTED,
    OnlineOrderStatus.READY,
    OnlineOrderStatus.COMPLETED,
    ...FOLIO_CERRADO,
  ]
  const destino: {
    puedeSalirDe: (s: OnlineOrderStatus) => boolean
    donde: Prisma.OnlineOrderWhereInput
    data: Prisma.OnlineOrderUpdateManyMutationInput & { status: OnlineOrderStatus }
  } = !saldada
    ? {
        puedeSalirDe: s => OPEN_ONLINE_STATUSES.includes(s),
        donde: {},
        data: { status: OnlineOrderStatus.CANCELLED_BY_STAFF, cancelledAt: ahora, cancelledBy: CANCELLED_ELSEWHERE },
      }
    : esFolio
      ? {
          puedeSalirDe: s => !NO_LO_MUEVE_EL_DINERO.includes(s),
          donde: { requiresAcceptance: false },
          data: { status: OnlineOrderStatus.ACCEPTED, acceptedAt: ahora },
        }
      : {
          puedeSalirDe: s => s !== OnlineOrderStatus.COMPLETED,
          donde: { requiresAcceptance: true },
          data: { status: OnlineOrderStatus.COMPLETED, completedAt: ahora },
        }
  let estadoAnterior: OnlineOrderStatus = pedido.status
  let estadoFinal: OnlineOrderStatus = pedido.status
  if (destino.puedeSalirDe(pedido.status)) {
    // CAS sobre el estado leído. Si otro lo movió entre la lectura y la escritura, se relee UNA vez: si todavía puede moverse, se
    // reintenta; si no, se respeta lo que quedó. (La bandeja ya no puede: desde R12 cierra releyendo bajo el candado de la orden,
    // que tiene este cobro; la relectura queda de defensa.)
    const cas = await tx.onlineOrder.updateMany({ where: { id: pedido.id, status: pedido.status, ...destino.donde }, data: destino.data })
    if (cas.count === 1) {
      estadoFinal = destino.data.status
    } else {
      const releido = await tx.onlineOrder.findUnique({ where: { orderId: a.orderId }, select: { id: true, status: true } })
      if (releido) {
        estadoAnterior = releido.status
        estadoFinal = releido.status
        if (destino.puedeSalirDe(releido.status)) {
          const otraVez = await tx.onlineOrder.updateMany({
            where: { id: releido.id, status: releido.status, ...destino.donde },
            data: destino.data,
          })
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
  // 🔴 S9 v5 (A0, B1, B2): en «Nadie» la conciliación SELLA el folio si no tenía fecha de cierre (una reapertura prueba que la cuenta
  // estuvo anulada: cubre lo anulado antes del despliegue), RENUEVA la ventana del barrido si sigue cerrado y NO avisa: el aviso es de la
  // nota que deja el escritor del dinero (`notarDineroEnFolioCerradoEnTx`), una vez por folio. «Mi equipo», como hoy.
  if (esFolio) {
    await sellarFolioAnuladoEnTx(tx, { venueId: a.venueId, orderId: a.orderId })
    await renovarRecuperacionDeFolioEnTx(tx, { venueId: a.venueId, orderId: a.orderId })
    logger.warn('🧾 [OnlineOrdering] dinero en la cuenta reabierta de un folio: sellado y renovado (el aviso lo da la nota del cobro)', {
      venueId: a.venueId,
      orderId: a.orderId,
      onlineOrderId: pedido.id,
      estadoAnterior,
      estadoFinal,
    })
    return
  }
  const completado = estadoFinal === OnlineOrderStatus.COMPLETED

  const gerentesAvisados = await avisarDelCobroTardioEnTx(tx, {
    venueId: a.venueId,
    orderId: a.orderId,
    onlineOrderId: pedido.id,
    orderNumber: cuenta.orderNumber,
    estadoAnterior,
    completado,
    cobrado: a.cobrado,
    canal: a.canal,
    idempotencyKey: a.idempotencyKey ?? null,
    staffId: a.staffId ?? null,
    cortesia: sumaDeCortesia(cuenta.orderDiscounts),
  })
  logger.warn('🧾 [OnlineOrdering] se registró dinero en un pedido en línea cancelado', {
    venueId: a.venueId,
    orderId: a.orderId,
    onlineOrderId: pedido.id,
    estadoAnterior,
    completado,
    gerentesAvisados,
  })
}

const sumaDeCortesia = (filas: Array<{ amount: Prisma.Decimal }> | undefined) =>
  (filas ?? []).reduce((suma, d) => suma.plus(d.amount), new Prisma.Decimal(0))

/**
 * El rastro y el aviso al gerente del dinero que llegó a un pedido en línea anulado: la bitácora `ONLINE_ORDER_COLLECTED_AFTER_CANCEL`
 * y un aviso ALERT por gerente activo, con el `tx` del dinero (si la transacción revierte, no queda ni el rastro ni el aviso).
 * S9 (P2-5): si la anulación del folio dejó cortesía, el texto dice que se respetó su precio y que el beneficio ya había regresado.
 * Devuelve a cuántos gerentes avisó.
 */
async function avisarDelCobroTardioEnTx(
  tx: Pick<Prisma.TransactionClient, 'activityLog' | 'staffVenue' | 'notification'>,
  d: {
    venueId: string
    orderId: string
    onlineOrderId: string
    orderNumber: string
    estadoAnterior: OnlineOrderStatus
    completado: boolean
    cobrado: Prisma.Decimal | number
    canal: string
    idempotencyKey: string | null
    staffId: string | null
    cortesia: Prisma.Decimal
    /** S9 v5 (D2): el dinero llegó y la cuenta SIGUE cancelada (el cripto no reabre): el texto no puede decir «se respetó su precio». */
    sigueCancelada?: boolean
  },
): Promise<number> {
  await tx.activityLog.create({
    data: {
      action: 'ONLINE_ORDER_COLLECTED_AFTER_CANCEL',
      entity: 'OnlineOrder',
      entityId: d.onlineOrderId,
      venueId: d.venueId,
      staffId: d.staffId,
      data: {
        onlineOrderId: d.onlineOrderId,
        orderId: d.orderId,
        estadoAnterior: d.estadoAnterior,
        cobradoCents: new Prisma.Decimal(d.cobrado).times(100).toDecimalPlaces(0).toNumber(),
        canal: d.canal,
        idempotencyKey: d.idempotencyKey,
      },
    },
  })

  // Un aviso por gerente activo del negocio. Hay dinero en un pedido que alguien canceló: se avisa aunque el cobro sea parcial.
  const gerentes = await tx.staffVenue.findMany({
    where: { venueId: d.venueId, active: true, role: { in: ROLES_QUE_RECIBEN_EL_AVISO } },
    select: { staffId: true },
    orderBy: { staffId: 'asc' },
    take: MAX_GERENTES_AVISADOS,
  })
  // Fix r1: la página llena NO se recorta en silencio. Se avisa a los que caben y queda el rastro para revisarlo.
  if (gerentes.length === MAX_GERENTES_AVISADOS) {
    logger.warn('⚠️ [OnlineOrdering] página llena de gerentes al avisar de un pedido cobrado tras cancelarse; puede haber más sin aviso', {
      venueId: d.venueId,
      orderId: d.orderId,
      tope: MAX_GERENTES_AVISADOS,
    })
  }
  // S9 (P2-5): si la anulación del folio dejó cortesía, el negocio respeta el precio que vio la clienta y absorbe ese beneficio una vez.
  const message = !d.cortesia.gt(0)
    ? `El pedido #${d.orderNumber} se había cancelado y después se registró su cobro. Revisa con quien lo canceló.`
    : d.sigueCancelada
      ? `Pedido #${d.orderNumber}: llegó un cobro después de cancelarse y la cuenta sigue cancelada; su beneficio de $${d.cortesia.toFixed(2)} ya había regresado a la clienta. Decide si lo devuelves o reabres la cuenta.`
      : `Pedido #${d.orderNumber}: se cobró después de vencer y se respetó su precio; su beneficio de $${d.cortesia.toFixed(2)} ya había regresado a la clienta.`
  if (gerentes.length > 0) {
    await tx.notification.createMany({
      data: gerentes.map(g => ({
        recipientId: g.staffId,
        venueId: d.venueId,
        type: NotificationType.ALERT,
        priority: NotificationPriority.HIGH,
        channels: [NotificationChannel.IN_APP],
        entityType: 'Order',
        entityId: d.orderId,
        title: 'Se cobró un pedido en línea cancelado',
        message,
        metadata: { onlineOrderId: d.onlineOrderId, orderNumber: d.orderNumber, completado: d.completado, canal: d.canal },
      })),
    })
  }
  return gerentes.length
}

/** Tienda híbrida (tabla 7b): dónde puede estar un folio que el dinero tardío revive: vencido, cancelado o rechazado. */
export const FOLIO_CERRADO: OnlineOrderStatus[] = [
  OnlineOrderStatus.EXPIRED,
  OnlineOrderStatus.CANCELLED_BY_CUSTOMER,
  OnlineOrderStatus.CANCELLED_BY_STAFF,
  OnlineOrderStatus.REJECTED,
]
/** R18: la cuenta de un folio está SALDADA (`FOLIO_PAID_STATUSES`, el espejo de `esVentaCerrada`) y viva. */
export const CUENTA_SALDADA: Prisma.OrderWhereInput = {
  paymentStatus: { in: FOLIO_PAID_STATUSES },
  status: { notIn: ['CANCELLED', 'DELETED'] },
}

/**
 * 🔴 Regla C (founder, 10-nov): ¿la caja cobró este folio ANTES de que se cerrara? Sólo si el cobro lo dice con su hora
 * (`Order.loyaltySaleAt`: la hora del aparato del cobro sin red que saldó la cuenta, acotada por arriba a su llegada,
 * `horaDeLaVenta`) y esa hora es anterior a la fecha EXACTA del cierre: la del CAS que lo venció, lo rechazó o lo canceló (la clienta
 * o el personal). Sin hora, con una anterior a que existiera el folio (un reloj de aparato sin hora), o sin fecha exacta, no: como hoy.
 * No son exactas las fechas que se escriben DESPUÉS de la anulación real: el `cancelledAt` del sello (la conciliación lo pone al llegar
 * el dinero si no había fecha) y el de «cancelado por otra vía» (`CANCELLED_ELSEWHERE`: la sincronización y la conciliación lo
 * reescriben con su propia hora). Con ellas el cobro siempre parecería anterior.
 */
function cobradoAntesDeCerrar(folio: FolioConCierre, horaDelCobro: Date | null | undefined): boolean {
  const t = cierreExacto(folio)
  if (!horaDelCobro || t == null) return false
  const hora = horaDelCobro.getTime()
  return hora >= folio.createdAt.getTime() && hora < t
}

type FolioConCierre = {
  createdAt: Date
  expiredAt: Date | null
  cancelledAt: Date | null
  cancelledBy: string | null
  rejectedAt: Date | null
}

/** La T de la regla C: la menor fecha EXACTA de cierre (ms), o `null` si no hay ninguna. */
function cierreExacto(folio: FolioConCierre): number | null {
  const cancelacionExacta = folio.cancelledBy != null && folio.cancelledBy !== CANCELLED_ELSEWHERE ? folio.cancelledAt : null
  const cierres = [folio.expiredAt, cancelacionExacta, folio.rejectedAt].filter((d): d is Date => d != null)
  return cierres.length > 0 ? Math.min(...cierres.map(d => d.getTime())) : null
}

/**
 * 🔴 Regla C completa, bajo el candado de la orden de quien llama: `cobradoAntesDeCerrar` y, además, que desde el cierre sólo UN cobro
 * con dinero haya nacido o cambiado: el que saldó la cuenta y trae la hora. Si hay otro, no sabemos cuándo se cobró su parte, y la hora
 * del que salda no es la de cuando la cuenta quedó pagada (Codex r1 #2: otra caja cobró después del cierre y subió antes; r2 #1: un
 * cripto que nació antes y se confirmó después). Por eso cuenta `createdAt` O `updatedAt` desde T: todo cambio de estado o de importe
 * de un `Payment` pasa por Prisma y mueve `updatedAt` (los `UPDATE "Payment"` crudos sólo parchan `processorData` o datos de la
 * tarjeta). Un cambio ajeno después de T sólo puede dejarlo como hoy. Sólo consulta cuando la hora ya dice «antes» (índice
 * `[orderId]`; los reembolsos son filas negativas y no cuentan).
 */
export async function cobradoATiempoEnTx(
  tx: Pick<Prisma.TransactionClient, 'payment'>,
  a: { venueId: string; orderId: string; folio: FolioConCierre; horaDelCobro: Date | null | undefined },
): Promise<boolean> {
  const t = cierreExacto(a.folio)
  if (t == null || !cobradoAntesDeCerrar(a.folio, a.horaDelCobro)) return false
  const tardios = await tx.payment.count({
    where: {
      venueId: a.venueId,
      orderId: a.orderId,
      status: 'COMPLETED',
      amount: { gt: 0 },
      OR: [{ createdAt: { gte: new Date(t) } }, { updatedAt: { gte: new Date(t) } }],
    },
  })
  return tardios === 1
}

/**
 * 🔴 Tienda híbrida (tabla 7b; S9, Codex r1 P2 y r2): el ÚNICO paso que revive un folio cerrado (vencido, cancelado o rechazado) cuya
 * cuenta ya quedó saldada y viva, a «Por entregar» (`ACCEPTED`), nunca a «Entregado». Lo usa sólo el barrido (`syncPaidClosedFolios`,
 * por donde pasa todo dinero tardío, llegue por donde llegue), que publica después del commit (S9, Codex r2: un folio cerrado no pasa a
 * «Por entregar» sin sus publicaciones; por eso ni la conciliación ni el cierre del cobro lo mueven).
 *
 * Bajo el candado de la orden de quien llama: relee el folio y hace el CAS sobre ese estado y la cuenta saldada (`acceptedAt` es la hora
 * de la escritura, R52). S9 v5: revive SIN avisar; el aviso al gerente lo da la nota del cobro (`notarDineroEnFolioCerradoEnTx`). Una
 * cuenta que no es de folio, o un folio que no está cerrado, no se toca. Devuelve lo que revivió (para los avisos de después del commit)
 * o `null`.
 * Regla C (founder, 10-nov): si la caja lo cobró antes de cerrarse (`cobradoATiempoEnTx`) y `marcarCocina` (hay pantalla), marca la
 * cocina en esta misma transacción y devuelve `cocina: true` para que quien llama arme la comanda después del commit; el armado no la
 * suprime (S9 B4 la deja pasar con la misma regla). Si no, como hoy: revive sin cocina.
 */
export async function revivirFolioSaldadoEnTx(
  tx: Pick<Prisma.TransactionClient, 'onlineOrder' | 'order' | 'payment'>,
  a: { venueId: string; orderId: string; ahora: Date; marcarCocina?: boolean },
): Promise<{ onlineOrderId: string; estadoAnterior: OnlineOrderStatus; acceptedAt: Date; cocina: boolean } | null> {
  const pedido = await tx.onlineOrder.findFirst({
    where: { orderId: a.orderId, venueId: a.venueId, requiresAcceptance: false, status: { in: FOLIO_CERRADO } },
    select: {
      id: true,
      status: true,
      createdAt: true,
      expiredAt: true,
      cancelledAt: true,
      cancelledBy: true,
      rejectedAt: true,
      order: { select: { loyaltySaleAt: true } },
    },
  })
  if (!pedido) return null
  const cas = await tx.onlineOrder.updateMany({
    where: { id: pedido.id, status: pedido.status, requiresAcceptance: false, order: CUENTA_SALDADA },
    data: { status: OnlineOrderStatus.ACCEPTED, acceptedAt: a.ahora },
  })
  if (cas.count !== 1) return null
  const cocina =
    a.marcarCocina === true &&
    (await cobradoATiempoEnTx(tx, { venueId: a.venueId, orderId: a.orderId, folio: pedido, horaDelCobro: pedido.order?.loyaltySaleAt }))
  // La cuenta ya es saldada y viva (el CAS lo exigió bajo el candado): sólo la marca, que limpia el armado o el barrido.
  if (cocina) await tx.order.updateMany({ where: { id: a.orderId, venueId: a.venueId }, data: { kitchenPendingAt: a.ahora } })
  return { onlineOrderId: pedido.id, estadoAnterior: pedido.status, acceptedAt: a.ahora, cocina }
}

/**
 * 🔴 S9 v5 (B2): renueva la recuperación de un folio «Nadie» CERRADO: `updatedAt` de ahora, para que la ventana de 7 días de
 * `syncPaidClosedFolios` (R13) cuente desde este dinero, reapertura o saldo, y no desde el cierre. Una sola sentencia, bajo el candado
 * de la orden de quien llama; no cambia el estado (R11) y NUNCA avisa. La llaman la conciliación, la nota y los recálculos de la
 * terminal que dejan saldada una cuenta `WEB` sin dinero nuevo. Nada usa `OnlineOrder.updatedAt` como versión ni CAS.
 */
export async function renovarRecuperacionDeFolioEnTx(
  tx: Pick<Prisma.TransactionClient, 'onlineOrder'>,
  a: { venueId: string; orderId: string },
): Promise<void> {
  await tx.onlineOrder.updateMany({
    where: { orderId: a.orderId, venueId: a.venueId, requiresAcceptance: false, status: { in: FOLIO_CERRADO } },
    data: { updatedAt: new Date() },
  })
}

/**
 * 🔴 S9 v5 (B3, R12): la NOTA de los 7 escritores de dinero (POS, terminal en sus dos cierres, pago manual, «Liquidar saldo»,
 * «Liquidar todo» y cripto), llamada SÓLO con dinero que entra y con su importe real. Si la cuenta es de un folio «Nadie» que se anuló
 * alguna vez (el sello de A0: `expiredAt`, `cancelledAt` o `rejectedAt`), renueva su recuperación y avisa al gerente UNA vez por folio
 * (`ONLINE_ORDER_COLLECTED_AFTER_CANCEL`, contado bajo el candado de la orden que ya tiene quien llama):
 *   · con la cortesía de su anulación, el texto S9, o D2 si la cuenta sigue cancelada (el cripto no reabre);
 *   · sin cortesía, sólo si este cobro la reabrió, con el texto S1 de siempre.
 * Con `source` distinto de `WEB` no consulta nada (la ruta caliente de la terminal y el POS). «Mi equipo» no entra: lo avisa la
 * conciliación, como hoy. Es el único emisor del aviso de un folio «Nadie».
 */
export async function notarDineroEnFolioCerradoEnTx(
  tx: Pick<Prisma.TransactionClient, 'onlineOrder' | 'order' | 'activityLog' | 'staffVenue' | 'notification'>,
  a: {
    venueId: string
    orderId: string
    entra: Prisma.Decimal
    source?: string | null
    reabierta: boolean
    canal: string
    paymentId?: string | null
    idempotencyKey?: string | null
    staffId?: string | null
  },
): Promise<void> {
  if (!a.entra.gt(0)) return
  if (a.source != null && a.source !== 'WEB') return
  const folio = await tx.onlineOrder.findFirst({
    where: { orderId: a.orderId, venueId: a.venueId, requiresAcceptance: false },
    select: { id: true, status: true, expiredAt: true, cancelledAt: true, rejectedAt: true },
  })
  if (!folio || !(folio.expiredAt ?? folio.cancelledAt ?? folio.rejectedAt)) return // A0: nunca anulado
  await renovarRecuperacionDeFolioEnTx(tx, a) // sólo pega si sigue cerrado
  const cuenta = await tx.order.findFirst({
    where: { id: a.orderId, venueId: a.venueId },
    select: { orderNumber: true, status: true, orderDiscounts: LO_QUE_LEE_LA_CONCILIACION.orderDiscounts },
  })
  const cortesia = sumaDeCortesia(cuenta?.orderDiscounts)
  if (cortesia.isZero() && !a.reabierta) return // sin beneficio regresado: sólo la reapertura avisa, con el S1 de siempre (BASE)
  const yaSeAviso = await tx.activityLog.count({
    where: { venueId: a.venueId, entity: 'OnlineOrder', entityId: folio.id, action: 'ONLINE_ORDER_COLLECTED_AFTER_CANCEL' },
  })
  if (yaSeAviso > 0) return
  await avisarDelCobroTardioEnTx(tx, {
    venueId: a.venueId,
    orderId: a.orderId,
    onlineOrderId: folio.id,
    orderNumber: cuenta?.orderNumber ?? '',
    estadoAnterior: folio.status,
    completado: false,
    cobrado: a.entra,
    canal: a.canal,
    idempotencyKey: a.idempotencyKey ?? null,
    staffId: a.staffId ?? null,
    cortesia,
    sigueCancelada: claseDeEstado(cuenta?.status ?? '') === 'CANCELADA',
  })
}

import { BadRequestError, ConflictError, NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { withDeadlockRetry, type TxConReintento } from '../../utils/serializableRetry'
import { ORDER_LOCK_WAIT_BUDGET } from '../shared/paymentShiftClaim'

/**
 * 🔴 hz:e82938e1:D36 (DINERO, ventas abiertas). «Cobrar» de la TPV crea la venta en el SERVIDOR al ir a cobrar
 * (`/orders/with-items`). Si la cajera regresa con «atrás» SIN haber tocado tarjeta, efectivo ni cripto, la terminal pide
 * anularla aquí; antes quedaba PENDING para siempre en «Cuentas por cobrar» (106 en 90 días, medido el 20-nov). Promesa y mapa:
 * docs/audit/2026-11-20-d36-cobrar-ventas-abiertas/promesa.md del workspace.
 *
 * Es la MISMA anulación de «Cancelar cuenta» del panel y del MCP (`cancelOrderInTransaction` + `publishCancelledOrder`, como
 * `cancelarCuentaSinCobrar`): mismo orden de candados, retira comandas, suelta vales, devuelve canjes y usos de descuentos con tope
 * (D24), y el apartado del cupón se libera solo (cuenta únicamente ventas no canceladas). Encima, candados de EVIDENCIA, porque
 * aquí no hay una persona revisando:
 *  - sólo una venta de Cobrar: TPV, para llevar, sin mesa, sin pedido en línea, y declarada «para cobrarse en el momento»
 *    (`payLater = false`, que sólo manda la TPV nueva). Un «Pagar después» (`true`) o una venta de una TPV vieja (`null`) es o
 *    puede ser una cuenta abierta A PROPÓSITO: no se toca.
 *  - la creó ESTA terminal (`Order.terminalId` = la terminal del token): otra terminal no anula lo que no abrió.
 *  - reciente: de las últimas 24 h (la terminal reintenta sin red; pasado eso ya no es «la venta que se acaba de armar»).
 *  - bajo el candado de la cuenta: otra vez todo lo anterior (Codex r1 #2), y NINGÚN `Payment` de ningún estado (cripto pendiente,
 *    tarjeta rechazada, efectivo…), ninguna asignación de pago y NINGUNA `TerminalPaymentRequest` (también las cerradas).
 * La bitácora (`ORDER_CANCELLED`) va DENTRO de la transacción (Codex r1 #7): si el servidor muere entre el commit y la publicación,
 * el reintento de la terminal ve «ya retirada» y la entrada ya existe. Un cobro que llegue DESPUÉS sobre la anulada la reabre con
 * rastro (`reabrirSiRecibeDinero`).
 *
 * Lo que NO hace (declarado en la promesa): devolver el uso de un descuento de CATÁLOGO con tope que `with-items` sumó al crear la
 * venta — esas filas no llevan la marca `usoContado` y marcarlas es el proyecto «Contador de usos con un solo dueño». El cupón sí se
 * libera (su apartado cuenta sólo ventas no canceladas).
 */

export const CAMINO_ATRAS_SIN_COBRO = 'TPV_COBRAR_ATRAS_SIN_COBRO'
export const MOTIVO_ATRAS_SIN_COBRO = 'La cajera regresó en Cobrar antes de cobrar'

const MENSAJE_NO_ES_DE_COBRAR =
  'Esta venta no es una venta de Cobrar hecha para cobrarse en el momento: no se anula sola. Si hace falta, cancélala en el panel.'
const MENSAJE_OTRA_TERMINAL = 'Esta venta la abrió otra terminal: sólo la terminal que la abrió puede retirarla.'
const MENSAJE_SIN_TERMINAL = 'No se pudo confirmar desde qué terminal se pide: la venta se queda como está.'
/** La terminal reintenta un retiro que no salió por falta de red; pasado este plazo la venta ya no se retira sola. */
export const PLAZO_PARA_RETIRAR_MS = 24 * 60 * 60 * 1000

const MENSAJE_VIEJA = 'Esta venta ya no es reciente: no se anula sola. Si hace falta, cancélala en el panel.'
const MENSAJE_CON_RASTRO =
  'Esta venta ya tiene un intento de cobro (un pago o una solicitud a la terminal): se queda como está para revisarla.'

/** Quién pide: la sesión (bitácora) y el serial de la terminal del token (`authContext.terminalSerialNumber`). */
export interface QuienRetira {
  staffId?: string | null
  terminalSerial?: string | null
}

/** La regla de «venta de Cobrar» sobre lo que se leyó (antes y otra vez bajo el candado). */
function exigirVentaDeCobrar(venta: {
  source: string
  type: string
  tableId: string | null
  onlineOrder: { id: string } | null
  payLater: boolean | null
}): void {
  const esDeCobrar = venta.source === 'TPV' && venta.type === 'TAKEOUT' && !venta.tableId && !venta.onlineOrder && venta.payLater === false
  if (!esDeCobrar) throw new BadRequestError(MENSAJE_NO_ES_DE_COBRAR, 'NO_ES_VENTA_DE_COBRAR')
}

type VentaLeida = {
  source: string
  type: string
  tableId: string | null
  payLater: boolean | null
  terminalId: string | null
  createdAt: Date
  onlineOrder: { id: string } | null
}

const SELECT_DE_LA_VENTA = {
  source: true,
  type: true,
  tableId: true,
  payLater: true,
  terminalId: true,
  createdAt: true,
  onlineOrder: { select: { id: true } },
} as const

/** Todo lo que se exige de la venta, sobre una lectura (antes, para contestar rápido; y otra vez bajo el candado). */
function exigirRetirable(venta: VentaLeida, terminalId: string, ahora: Date): void {
  exigirVentaDeCobrar(venta)
  if (!venta.terminalId || venta.terminalId !== terminalId) throw new BadRequestError(MENSAJE_OTRA_TERMINAL, 'OTRA_TERMINAL')
  if (ahora.getTime() - venta.createdAt.getTime() > PLAZO_PARA_RETIRAR_MS) throw new BadRequestError(MENSAJE_VIEJA, 'VENTA_VIEJA')
}

/**
 * Corre DENTRO de la transacción de la anulación, con la cuenta ya tomada (`assertOrderCancellableUnderLock`) y antes del commit:
 * cualquier cosa que no se cumpla revierte la anulación entera. Al final deja la ÚNICA entrada de bitácora, en la misma transacción.
 */
async function exigirYAnotarEnTx(
  tx: TxConReintento,
  a: { venueId: string; orderId: string; terminalId: string; serial: string; staffId: string | null; ahora: Date },
): Promise<void> {
  const venta = await tx.order.findFirst({ where: { id: a.orderId, venueId: a.venueId }, select: SELECT_DE_LA_VENTA })
  if (!venta) throw new NotFoundError('Esta venta no existe en este negocio.')
  exigirRetirable(venta, a.terminalId, a.ahora)
  // Sin filtro de estado A PROPÓSITO: un PENDING de cripto, un FAILED o un REFUNDED también son un intento de cobro.
  const [pagos, asignaciones, solicitudes] = await Promise.all([
    tx.payment.count({ where: { orderId: a.orderId, venueId: a.venueId } }),
    tx.paymentAllocation.count({ where: { orderId: a.orderId } }),
    // También las cerradas y las lápidas de admisión: en una venta de Cobrar no debería haber ninguna; si la hay, la tocó el POS.
    tx.terminalPaymentRequest.count({ where: { venueId: a.venueId, orderId: a.orderId } }),
  ])
  if (pagos > 0 || asignaciones > 0 || solicitudes > 0) {
    throw new ConflictError(MENSAJE_CON_RASTRO, 'VENTA_CON_RASTRO_DE_COBRO', { pagos, asignaciones, solicitudes })
  }
  await tx.activityLog.create({
    data: {
      action: 'ORDER_CANCELLED',
      entity: 'Order',
      entityId: a.orderId,
      staffId: a.staffId,
      venueId: a.venueId,
      data: { camino: CAMINO_ATRAS_SIN_COBRO, terminal: a.serial, reason: MOTIVO_ATRAS_SIN_COBRO },
    },
  })
}

/** 200 de la ruta: la anuló ahora, o ya estaba anulada (el reintento sin red no escribe ni audita dos veces). */
export type ResultadoDelRetiro = { estado: 'RETIRADA' | 'YA_RETIRADA' }

export async function anularVentaDeCobrarSinCobro(
  venueId: string,
  orderId: string,
  quien: QuienRetira,
  ahora: Date = new Date(),
): Promise<ResultadoDelRetiro> {
  // Lectura previa, sin candado (como `cancelarCuentaSinCobrar`): contesta rápido lo que no se puede, sin tomar candados de más.
  const venta = await prisma.order.findFirst({ where: { id: orderId, venueId }, select: { status: true, ...SELECT_DE_LA_VENTA } })
  if (!venta) throw new NotFoundError('Esta venta no existe en este negocio.')
  if (venta.status === 'CANCELLED' || venta.status === 'DELETED') return { estado: 'YA_RETIRADA' }
  exigirVentaDeCobrar(venta)

  const serial = quien.terminalSerial?.trim()
  if (!serial) throw new BadRequestError(MENSAJE_SIN_TERMINAL, 'TERMINAL_NO_IDENTIFICADA')
  // La misma búsqueda con la que `/orders/with-items` estampó `Order.terminalId` (serial del token, dentro del negocio).
  const terminal = await prisma.terminal.findFirst({ where: { serialNumber: serial, venueId }, select: { id: true } })
  if (!terminal) throw new BadRequestError(MENSAJE_SIN_TERMINAL, 'TERMINAL_NO_IDENTIFICADA')
  exigirRetirable(venta, terminal.id, ahora)

  const staffId = quien.staffId ?? null
  const { cancelOrderInTransaction, publishCancelledOrder } = await import('@/services/mobile/order.mobile.service')
  let result: Awaited<ReturnType<typeof cancelOrderInTransaction>>
  try {
    result = await withDeadlockRetry(
      tx =>
        cancelOrderInTransaction(
          tx,
          venueId,
          orderId,
          undefined,
          staffId ?? undefined,
          dentro => exigirYAnotarEnTx(dentro, { venueId, orderId, terminalId: terminal.id, serial, staffId, ahora }),
          {
            // La mesa se vuelve a revisar bajo el candado; una ya anulada responde ORDER_ALREADY_CANCELLED (abajo: YA_RETIRADA).
            contarPagosRegistrados: true,
            rechazarYaCancelada: true,
            rechazarCuentaDeMesa: true,
            mensajeConDinero: MENSAJE_CON_RASTRO,
          },
        ),
      { etiqueta: 'anularVentaDeCobrarSinCobro', ...ORDER_LOCK_WAIT_BUDGET },
    )
  } catch (error) {
    // Dos retiros de la misma venta a la vez (el reintento de la terminal): el segundo ve, bajo el candado, la anulación del primero.
    if ((error as { code?: string } | null)?.code === 'ORDER_ALREADY_CANCELLED') return { estado: 'YA_RETIRADA' }
    throw error
  }
  // La bitácora ya quedó en la transacción: aquí sólo los avisos (sockets, referidos, vales, pases) de cualquier anulación.
  await publishCancelledOrder(venueId, result, staffId ?? undefined, MOTIVO_ATRAS_SIN_COBRO, undefined, { bitacoraEnLaTx: true })
  return { estado: 'RETIRADA' }
}

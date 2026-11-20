/**
 * D36 (hz:e82938e1:D36, encargo da7275 · 20-nov-2026): «Cobrar» de la TPV crea la venta en el servidor al tocar «Cobrar»; si la cajera
 * toca «atrás» antes de pasar la tarjeta, esa venta se quedaba PENDING con productos para siempre (106 en 90 días, 91 en Mindform) y
 * ensuciaba «Cuentas por cobrar». La limpieza de órdenes abandonadas sólo borra las VACÍAS.
 *
 * Aquí la TPV la RETIRA: se cancela (nunca se borra: los renglones y la bitácora quedan como rastro) sólo si nunca se intentó cobrar.
 * La TPV ya revisó su libreta y su cola antes de llamar; el servidor vuelve a comprobar, bajo el candado de la orden, lo que él ve:
 *
 *   · es una venta de mostrador de la TPV: `source = TPV`, `type = TAKEOUT`, sin mesa, de las últimas 24 h;
 *   · ningún `Payment` de ningún estado ni tipo (un PENDING o un FAILED también es un intento: no se retira);
 *   · ninguna solicitud de cobro del POS que la nombre, salvo una lápida de admisión (la misma excepción que la limpieza);
 *   · y lo de siempre de `cancelOrderInTransaction`: sin dinero, sin cobro de terminal vivo, no Rappi.
 *
 * Una venta ya cancelada contesta `YA_RETIRADA` (la TPV reintenta tras perder la red y no debe escribir ni auditar dos veces).
 * Cualquier otro rechazo es definitivo: la venta se queda como estaba (como hoy) y la TPV deja de intentarlo.
 */
import { ConflictError, NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { withDeadlockRetry } from '../../utils/serializableRetry'
import { ORDER_LOCK_WAIT_BUDGET } from '../shared/paymentShiftClaim'
import type { TxConReintento } from '@/utils/serializableRetry'

export const VENTA_NO_RETIRABLE = 'VENTA_NO_RETIRABLE' as const
export const MOTIVO_DE_RETIRO = 'Cobrar: la cajera regresó antes de cobrar (sin ningún intento de cobro)'
/** La TPV reintenta un retiro que no salió por falta de red; pasado este plazo ya no es «la venta que se acaba de armar». */
export const PLAZO_PARA_RETIRAR_MS = 24 * 60 * 60 * 1000

export type ResultadoDelRetiro = { estado: 'RETIRADA' | 'YA_RETIRADA' }

type Motivo = 'NO_ES_DE_COBRAR' | 'CON_MESA' | 'VIEJA' | 'CON_INTENTO_DE_COBRO' | 'CON_SOLICITUD_DEL_POS' | 'NO_PENDIENTE'

function noSePuede(motivo: Motivo, mensaje: string): never {
  throw new ConflictError(mensaje, VENTA_NO_RETIRABLE, { motivo })
}

/** Lo que no cambia bajo una cancelación se lee sin candado, como `cancelarCuentaSinCobrar`; el dinero se cuenta bajo el candado. */
async function revisarQueEsDeCobrar(venueId: string, orderId: string, ahora: Date): Promise<'PENDIENTE' | 'YA_RETIRADA'> {
  const order = await prisma.order.findFirst({
    where: { id: orderId, venueId },
    select: { source: true, type: true, tableId: true, createdAt: true, status: true, paymentStatus: true },
  })
  if (!order) throw new NotFoundError('Esta venta no existe en este negocio.')
  if (order.status === 'CANCELLED') return 'YA_RETIRADA'
  if (order.source !== 'TPV' || order.type !== 'TAKEOUT') noSePuede('NO_ES_DE_COBRAR', 'Esta venta no es de «Cobrar»: no se retira sola.')
  if (order.tableId) noSePuede('CON_MESA', 'Esta venta es de una mesa: no se retira sola.')
  if (ahora.getTime() - order.createdAt.getTime() > PLAZO_PARA_RETIRAR_MS)
    noSePuede('VIEJA', 'Esta venta ya no es reciente: no se retira sola.')
  if (order.status !== 'PENDING' || order.paymentStatus !== 'PENDING') {
    noSePuede('NO_PENDIENTE', 'Esta venta ya no está pendiente de cobro: no se retira sola.')
  }
  return 'PENDIENTE'
}

/** Corre DENTRO de la transacción de la cancelación, con el candado de la orden ya tomado: un rechazo deshace todo. */
async function sinNingunIntentoDeCobro(tx: TxConReintento, venueId: string, orderId: string): Promise<void> {
  const pagos = await tx.payment.count({ where: { venueId, orderId } })
  if (pagos > 0) noSePuede('CON_INTENTO_DE_COBRO', 'Esta venta ya tuvo un intento de cobro: no se retira sola.')
  const solicitudes = await tx.terminalPaymentRequest.count({
    where: {
      venueId,
      orderId,
      // La lápida de admisión (FAILED + REJECTED_…) prueba que ese cobro nunca se creó: no cuenta, como en la limpieza de abandonadas.
      NOT: { status: 'FAILED', failureCode: { startsWith: 'REJECTED_' } },
    },
  })
  if (solicitudes > 0) noSePuede('CON_SOLICITUD_DEL_POS', 'Esta venta tiene un cobro enviado desde el POS: no se retira sola.')
}

export async function retirarVentaSinCobro(
  venueId: string,
  orderId: string,
  staffId: string | undefined,
  ahora: Date = new Date(),
): Promise<ResultadoDelRetiro> {
  if ((await revisarQueEsDeCobrar(venueId, orderId, ahora)) === 'YA_RETIRADA') return { estado: 'YA_RETIRADA' }
  const { cancelOrderInTransaction, publishCancelledOrder } = await import('@/services/mobile/order.mobile.service')
  let result: Awaited<ReturnType<typeof cancelOrderInTransaction>>
  try {
    result = await withDeadlockRetry(
      tx =>
        cancelOrderInTransaction(tx, venueId, orderId, undefined, staffId, dentro => sinNingunIntentoDeCobro(dentro, venueId, orderId), {
          contarPagosRegistrados: true,
          rechazarYaCancelada: true,
          rechazarCuentaDeMesa: true,
        }),
      { etiqueta: 'retirarVentaSinCobro', ...ORDER_LOCK_WAIT_BUDGET },
    )
  } catch (error: any) {
    // Dos retiros de la misma venta a la vez (el reintento de la TPV): el segundo ve la cancelación del primero.
    if (error?.code === 'ORDER_ALREADY_CANCELLED') return { estado: 'YA_RETIRADA' }
    throw error
  }
  await publishCancelledOrder(venueId, result, staffId, MOTIVO_DE_RETIRO, { origen: 'COBRAR_ATRAS_SIN_COBRO' })
  return { estado: 'RETIRADA' }
}

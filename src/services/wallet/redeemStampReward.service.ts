import { Prisma, StampRewardStatus, StampRewardType } from '@prisma/client'
import { BadRequestError, NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { recalculateOrderTotals } from '../mobile/comp-item.mobile.service'
import { logAction } from '../dashboard/activity-log.service'
import { notifyCustomerPassUpdated } from './notifyPassUpdated.service'

/**
 * Canjear el premio de una cartilla llena.
 *
 * 🔴 DINERO: esto baja lo que el cliente paga.
 */

export interface RedeemStampRewardResult {
  discountAmount: number
  rewardLabel: string
  /** La orden con sus totales ya recalculados. */
  order: unknown
}

/** Pesos con dos decimales. Un flotante suelto en dinero acaba en un centavo que no cuadra. */
function money(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Cuánto baja la cuenta este premio.
 *
 * 🔴 La BASE es `subtotal − descuentos ya aplicados`, no el total. El total incluye
 * cobros por servicio que un descuento no puede compensar: calcular contra él
 * quemaría el premio sin bajar la cuenta en la misma medida. Es la misma corrección
 * que ya se hizo en el canje de puntos (auditoría 2026-07-18).
 */
async function calcularDescuento(
  order: { id: string; subtotal: Prisma.Decimal | number; discountAmount: Prisma.Decimal | number | null },
  reward: { rewardType: StampRewardType; rewardValue: Prisma.Decimal | number | null },
): Promise<number> {
  const base = Math.max(0, Number(order.subtotal) - Number(order.discountAmount ?? 0))

  if (reward.rewardType === StampRewardType.PERCENTAGE) {
    // 🔴 El porcentaje se aplica a la cuenta. Tratar el 20 como pesos cobra de menos
    // en una cuenta grande y de MÁS en una chica, y pasa desapercibido hasta el corte.
    return money((base * Number(reward.rewardValue ?? 0)) / 100)
  }

  if (reward.rewardType === StampRewardType.FREE_PRODUCT) {
    // 🔴 Se descuenta el artículo MÁS CARO de la cuenta, no el precio de catálogo del
    // producto prometido. Decisión del founder (D10), tomada de Square: si el cliente
    // pide algo más caro que su café gratis, no paga la diferencia. Con el precio de
    // catálogo terminaría pagando parte de un premio que ya se ganó.
    const items = await prisma.orderItem.findMany({
      where: { orderId: order.id },
      select: { unitPrice: true },
    })
    const masCaro = items.reduce((max, it) => Math.max(max, Number(it.unitPrice)), 0)
    return money(masCaro)
  }

  return money(Number(reward.rewardValue ?? 0))
}

export interface RedeemStampRewardOptions {
  /** Staff.id de quien lo aplicó. Sólo para la bitácora. */
  staffId?: string
}

export async function redeemStampReward(
  venueId: string,
  orderId: string,
  rewardId: string,
  options: RedeemStampRewardOptions = {},
): Promise<RedeemStampRewardResult> {
  const order = await prisma.order.findFirst({
    where: { id: orderId, venueId },
    select: { id: true, customerId: true, subtotal: true, discountAmount: true, paymentStatus: true, paidAmount: true },
  })

  if (!order) throw new NotFoundError('Orden no encontrada')
  // 🔴 El dinero ya entró: meter un descuento después deja el cobro y la cuenta
  // discrepando, y el corte no cuadra al cerrar el turno.
  if (order.paymentStatus === 'PAID' || order.paymentStatus === 'PARTIAL') {
    throw new BadRequestError('No se puede aplicar un premio a una cuenta ya pagada.')
  }
  if (!order.customerId) {
    throw new BadRequestError('La cuenta debe estar vinculada al cliente dueño del premio.')
  }
  const customerId = order.customerId

  // 🔴 Filtrado por venue: sin eso, el premio de una sucursal bajaría la cuenta de
  // otra. Un premio ajeno simplemente no existe para este negocio.
  const reward = await prisma.stampReward.findFirst({ where: { id: rewardId, venueId, customerId } })
  if (!reward) throw new NotFoundError('Premio no encontrado')

  // Atajo barato: la garantía de verdad contra el doble canje es el UPDATE
  // condicional de más abajo, pero avisar aquí evita levantar una transacción y da
  // un mensaje claro en el caso normal.
  if (reward.status !== StampRewardStatus.PENDING) {
    throw new BadRequestError('Este premio ya fue canjeado.')
  }
  // Si caduca y aun así se canjea, la fecha de vencimiento es decorativa — y el
  // negocio que puso un plazo descubre que nunca se respetó.
  if (reward.expiresAt && reward.expiresAt.getTime() < Date.now()) {
    throw new BadRequestError('Este premio ya venció.')
  }

  const base = Math.max(0, Number(order.subtotal) - Number(order.discountAmount ?? 0))
  // 🔴 Tope contra la BASE. Sin él, un premio de $500 sobre una cuenta de $250 deja
  // la orden en negativo: el negocio no sólo regala el consumo, queda debiendo.
  const discountAmount = Math.min(await calcularDescuento(order, reward), base)

  // 🔴 Y sobre una cuenta en cero NO se quema. Canjear ahí gastaría el premio sin
  // darle nada al cliente: se pierde un café gratis ya ganado, y sin forma de
  // devolverlo desde el mostrador.
  if (discountAmount <= 0) {
    throw new BadRequestError('Esta cuenta no tiene nada sobre lo que aplicar el premio.')
  }

  await prisma.$transaction(async tx => {
    // 🔴 Quemar PRIMERO y de forma CONDICIONAL. El chequeo de estado corre fuera de
    // la transacción, así que dos cajeros que tocan "canjear" a la vez lo ven los dos
    // en PENDING: lo único que separa un café regalado de dos es que este UPDATE
    // exija el estado anterior. Si no encuentra la fila en PENDING, alguien más ganó
    // la carrera y aquí no se crea ningún descuento.
    const quemado = await tx.stampReward.updateMany({
      where: { id: rewardId, venueId, customerId, status: StampRewardStatus.PENDING },
      data: { status: StampRewardStatus.REDEEMED, redeemedAt: new Date() },
    })
    if (quemado.count === 0) {
      throw new BadRequestError('Este premio ya fue canjeado.')
    }

    const descuento = await tx.orderDiscount.create({
      data: {
        orderId: order.id,
        type: 'FIXED_AMOUNT',
        name: reward.rewardLabel,
        value: new Prisma.Decimal(discountAmount),
        amount: new Prisma.Decimal(discountAmount),
        isManual: true,
      },
    })

    // Deja el rastro de vuelta: es lo que permitirá devolver el premio si alguien
    // quita ese descuento de la cuenta.
    await tx.stampReward.update({ where: { id: rewardId }, data: { orderDiscountId: descuento.id } })
  })

  // 🔴 Crear la fila del descuento NO baja la cuenta: `total` y `discountAmount` de
  // la orden son campos calculados. Sin este recálculo el premio queda quemado y el
  // cliente paga completo — que es la peor combinación posible.
  //
  // Va FUERA de la transacción, igual que en el canje de puntos: recalcular lee
  // toda la orden y alargar la transacción con esa lectura la deja bloqueando filas
  // que el cobro necesita.
  const totals = await recalculateOrderTotals(orderId, 0, Number(order.paidAmount ?? 0))

  // Un premio es producto que sale sin cobrarse. Sin registro no hay forma de
  // revisar por qué el inventario no cuadra al cierre. Fire-and-forget: un fallo de
  // auditoría no puede deshacer un canje que ya ocurrió.
  void logAction({
    action: 'STAMP_REWARD_REDEEMED',
    entity: 'StampReward',
    entityId: rewardId,
    staffId: options.staffId,
    venueId,
    data: {
      orderId,
      customerId: reward.customerId,
      rewardType: reward.rewardType,
      rewardLabel: reward.rewardLabel,
      discountAmount,
    },
  })

  // El premio se fue de su cartilla: su tarjeta tiene que dejar de ofrecerlo.
  void notifyCustomerPassUpdated(venueId, reward.customerId)

  return { discountAmount, rewardLabel: reward.rewardLabel, order: totals }
}

/**
 * Devuelve el premio detrás de un `OrderDiscount` cuando ese descuento se quita de la
 * cuenta.
 *
 * 🔴 DINERO en la dirección contraria. Sin esto, el cliente pagó su cartilla completa
 * —siete visitas— por un descuento que ya no existe, y desde el mostrador no hay forma
 * de devolvérselo. Es el espejo exacto de `refundLoyaltyForOrderDiscount`, que ya hace
 * lo mismo con los puntos.
 *
 * Corre DENTRO de la transacción de quien llama, para que la fila del descuento y el
 * premio se muevan juntos: si se separan, un fallo a medias deja al cliente sin
 * descuento y sin premio.
 *
 * Es un no-op silencioso para los descuentos normales, que son la inmensa mayoría.
 */
export async function refundStampRewardForOrderDiscount(
  tx: Prisma.TransactionClient,
  venueId: string,
  row: { id: string },
): Promise<{ rewardId: string; customerId: string; rewardLabel: string } | null> {
  const reward = await tx.stampReward.findFirst({
    where: { orderDiscountId: row.id, venueId },
    select: { id: true, customerId: true, rewardLabel: true },
  })
  if (!reward) return null

  // 🔴 Los tres campos JUNTOS. Dejar `redeemedAt` o el vínculo al descuento haría que
  // el premio se vea disponible pero arrastrando el rastro de un canje que ya no
  // ocurrió — y `orderDiscountId` es único, así que el rastro viejo impediría
  // canjearlo otra vez sobre una cuenta distinta.
  await tx.stampReward.update({
    where: { id: reward.id },
    data: { status: StampRewardStatus.PENDING, redeemedAt: null, orderDiscountId: null },
  })

  return { rewardId: reward.id, customerId: reward.customerId, rewardLabel: reward.rewardLabel }
}

import { Prisma, StampRewardStatus, StampRewardType } from '@prisma/client'
import { BadRequestError, NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { recalculateOrderTotals } from '../mobile/comp-item.mobile.service'
import { logAction } from '../dashboard/activity-log.service'
import { notifyCustomerPassUpdated } from './notifyPassUpdated.service'
import { ORDER_LOCK_WAIT_BUDGET, lockExistingOrderForPayment } from '../shared/paymentShiftClaim'
import { rechazarSiEsImportada } from '../shared/ordenImportada'
import { aCentavos, capacidadRestante, comoJson, leerReparto, nuevoRepartoDeCuenta, nuevoRepartoDirigido } from '../shared/repartoDescuento'
import { RENGLON_PARA_REPARTO_SELECT, conservarDescuentoHistorico, filasDeLaOrden } from '../shared/repartoDescuentoTx'

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
  db: Prisma.TransactionClient,
  order: { id: string; subtotal: Prisma.Decimal | number; discountAmount: Prisma.Decimal | number | null },
  reward: { rewardType: StampRewardType; rewardValue: Prisma.Decimal | number | null },
): Promise<{ monto: number; renglonPremiadoId: string | null }> {
  const base = Math.max(0, Number(order.subtotal) - Number(order.discountAmount ?? 0))

  if (reward.rewardType === StampRewardType.PERCENTAGE) {
    // 🔴 El porcentaje se aplica a la cuenta. Tratar el 20 como pesos cobra de menos
    // en una cuenta grande y de MÁS en una chica, y pasa desapercibido hasta el corte.
    return { monto: money((base * Number(reward.rewardValue ?? 0)) / 100), renglonPremiadoId: null }
  }

  if (reward.rewardType === StampRewardType.FREE_PRODUCT) {
    // 🔴 P11 (founder, 2-oct; Square: «maximize the reward value in the buyer's favor»): UNA pieza del artículo que más le
    // regala al cliente, sólo entre los renglones que todavía cobran algo, y nunca más de lo que ese renglón tiene disponible
    // (su aportación —que ya descuenta lo que vive en el renglón, el mismo importe que duplica una fila espejo: el espejo no
    // vuelve a consumir lugar— menos lo que ya le dieron las filas DIRIGIDAS). Antes tomaba el `unitPrice` más alto aunque fuera una cortesía
    // ($0) o un artículo por peso que vale menos que su precio por kilo. Empate ⇒ el de mayor precio, luego el de id menor.
    // Renglones y filas se leen bajo el candado de la orden, con la MISMA transacción: un artículo agregado mientras el
    // canje esperaba también cuenta. Todo en centavos enteros.
    const renglones = await db.orderItem.findMany({
      where: { orderId: order.id },
      select: { ...RENGLON_PARA_REPARTO_SELECT, unitPrice: true },
    })
    // Las filas de CUENTA no restan: el cálculo canónico las re-reparte DESPUÉS de las dirigidas (pasos 3-4), así que no le
    // quitan lugar al premio. Restarlas hacía depender el premio del orden (cuenta de $10 antes ⇒ $95 en vez de $100). El tope
    // `min(monto, base)` del canje sigue protegiendo el total.
    const dirigidas = (await filasDeLaOrden(db, order.id)).filter(f => leerReparto(f.reparto)?.alcance === 'DIRIGIDO')
    const capacidad = capacidadRestante(renglones, dirigidas)
    const [elegido] = renglones
      .map(r => {
        const precio = aCentavos(r.unitPrice)
        return { id: r.id, precio, premio: Math.min(precio, capacidad.get(r.id) ?? 0) }
      })
      .filter(c => c.premio > 0)
      .sort((a, b) => b.premio - a.premio || b.precio - a.precio || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    // Sin renglón que todavía cobre, 0: la guarda del canje rechaza y el premio NO se quema.
    return { monto: elegido ? elegido.premio / 100 : 0, renglonPremiadoId: elegido?.id ?? null }
  }

  return { monto: money(Number(reward.rewardValue ?? 0)), renglonPremiadoId: null }
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
  // 🔴 La ORDEN se bloquea antes que el premio (Order → StampReward, el mismo orden que el cobro y la lealtad), todo
  // lo que decide el canje —estado, cliente, base, tope y el artículo gratis— se lee bajo ese candado con la MISMA
  // transacción, y quemar + descontar + recalcular van juntos: si algo falla después de quemar, el rollback devuelve
  // el premio a PENDING y la cuenta queda como estaba.
  const { reward, discountAmount, totals } = await prisma.$transaction(async tx => {
    if (!(await lockExistingOrderForPayment(tx, { venueId, orderId }))) throw new NotFoundError('Orden no encontrada')
    const order = await tx.order.findFirst({
      where: { id: orderId, venueId },
      select: {
        id: true,
        customerId: true,
        subtotal: true,
        discountAmount: true,
        paymentStatus: true,
        paidAmount: true,
        originSystem: true,
      },
    })

    if (!order) throw new NotFoundError('Orden no encontrada')
    // R11 (Codex r5): la cabecera de una importada manda y sus renglones traen el IVA dentro y por pieza; rearmarla aquí cobraría
    // el IVA dos veces (P12). Esos cambios se hacen en el POS externo.
    rechazarSiEsImportada(order)
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
    const reward = await tx.stampReward.findFirst({ where: { id: rewardId, venueId, customerId } })
    if (!reward) throw new NotFoundError('Premio no encontrado')

    // Aviso claro para el caso normal; la garantía de verdad contra el doble canje es
    // el UPDATE condicional de más abajo (el candado es de la ORDEN, no del premio).
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
    const calculo = await calcularDescuento(tx, order, reward)
    const discountAmount = Math.min(calculo.monto, base)

    // 🔴 Y sobre una cuenta en cero NO se quema. Canjear ahí gastaría el premio sin
    // darle nada al cliente: se pierde un café gratis ya ganado, y sin forma de
    // devolverlo desde el mostrador.
    if (discountAmount <= 0) {
      throw new BadRequestError('Esta cuenta no tiene nada sobre lo que aplicar el premio.')
    }

    // 🔴 Quemar de forma CONDICIONAL. El mismo premio puede estar canjeándose sobre OTRA
    // cuenta (otro candado de orden): lo único que separa un café regalado de dos es que
    // este UPDATE exija el estado anterior. Si no encuentra la fila en PENDING, alguien
    // más ganó la carrera y aquí no se crea ningún descuento.
    const quemado = await tx.stampReward.updateMany({
      where: { id: rewardId, venueId, customerId, status: StampRewardStatus.PENDING },
      data: { status: StampRewardStatus.REDEEMED, redeemedAt: new Date() },
    })
    if (quemado.count === 0) {
      throw new BadRequestError('Este premio ya fue canjeado.')
    }

    // Codex r1 P1: lo que la cabecera trae fuera de toda fila (orden anterior a B2…) queda en su fila antes de crear ésta.
    await conservarDescuentoHistorico(tx, order.id, order.discountAmount)
    const descuento = await tx.orderDiscount.create({
      data: {
        orderId: order.id,
        type: 'FIXED_AMOUNT',
        name: reward.rewardLabel,
        value: new Prisma.Decimal(discountAmount),
        amount: new Prisma.Decimal(discountAmount),
        isManual: true,
        // B2: FREE_PRODUCT dirigido al renglón premiado (cabe por construcción: P11 ya lo topó a lo disponible); % y fijo,
        // de CUENTA. Los centavos finales los pone el recálculo de abajo.
        reparto: comoJson(
          calculo.renglonPremiadoId
            ? nuevoRepartoDirigido(discountAmount, { [calculo.renglonPremiadoId]: discountAmount }, { espejo: false })
            : nuevoRepartoDeCuenta({ conPromociones: true }),
        ),
      },
    })

    // Deja el rastro de vuelta: es lo que permitirá devolver el premio si alguien
    // quita ese descuento de la cuenta.
    await tx.stampReward.update({ where: { id: rewardId }, data: { orderDiscountId: descuento.id } })

    // 🔴 Crear la fila del descuento NO baja la cuenta: `total` y `discountAmount` de
    // la orden son campos calculados. Sin este recálculo el premio queda quemado y el
    // cliente paga completo — que es la peor combinación posible. Va DENTRO de la
    // transacción: quemar sin recalcular (o al revés) nunca puede quedar escrito.
    const totals = await recalculateOrderTotals(orderId, 0, Number(order.paidAmount ?? 0), tx)
    return { reward, discountAmount, totals }
  }, ORDER_LOCK_WAIT_BUDGET)

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

// src/services/online-ordering/beneficios.service.ts
/**
 * Tienda híbrida, parte 2 (S10, P2-4): el cotizador conoce a la clienta. Con sesión, la cotización aplica lo que la caja ya aplica
 * (descuentos automáticos, de grupo y asignados) y lo que ella elige usar (cupón, premio de sellos, puntos), en el orden fijo de la
 * parte 2: motor → cupón → premio → puntos.
 *
 * Una sola cadena, `aplicarBeneficiosEnTx`, en dos modos:
 * - **estricto** (crear el folio, S11): cualquier canje elegido que falle lanza `BENEFIT_UNAVAILABLE`; toma los candados como la caja
 *   (asesor del cupón → una pasada ascendente de `Discount` → premio → `Customer`, «Orden de candados de la parte 2»).
 * - **tolerante** (cotizar): cada canje en su `SAVEPOINT`; lo que ya no está sale en `descartados`. Es una SIMULACIÓN que se deshace:
 *   no aparta ni bloquea nada compartido (R9). Ni asesor del cupón, ni pasada de contadores de `Discount`; los límites de uso se leen
 *   sin candado y la memoria de usos propios del motor reemplaza el contador que no escribe (R9''). Sólo bloquea filas nuevas (la cuenta
 *   provisional) y de la propia clienta (su premio, su `Customer`). Los `FOR KEY SHARE` implícitos de las llaves foráneas sobre filas
 *   compartidas (`Venue`, `Product`, `Modifier`, `Discount`, `CouponCode`) son compatibles con los incrementos y candados de la caja.
 *
 * Garantía (R1'''): cotización = modo estricto, por construcción: el mismo código, el mismo orden y los mismos helpers de la caja con
 * su default (sin aritmética propia). Sus imprecisiones de centavo o de punto son deuda de BASE (`hz:dcc49fe5:D2`), no de aquí.
 */
import cuid from 'cuid'
import { Prisma, StampRewardStatus } from '@prisma/client'
import logger from '@/config/logger'
import AppError, { BadRequestError, NotFoundError } from '@/errors/AppError'
import prisma from '@/utils/prismaClient'
import { buildDatasourceUrl } from '@/utils/datasourceUrl'
import { isDeadlockError, isModelLockTimeoutError, withDeadlockRetry, type TxConReintento } from '@/utils/serializableRetry'
import { aplicarDescuentosDelMotorEnTx } from '@/services/dashboard/discountEngine.service'
import { apartarCupon, bloquearDescuentoDelCupon, cuponDeLaVenta, ligarCupon, montoDelCupon } from '@/services/shared/cuponDeLaVenta'
import { canjearPremioEnTx, renglonDelPremioEnTx } from '@/services/wallet/redeemStampReward.service'
import { redeemPointsToOrderInTransaction } from '@/services/mobile/loyalty.mobile.service'
import { comoJson, nuevoRepartoDeCuenta } from '@/services/shared/repartoDescuento'
import { conservarDescuentoHistorico, sincronizarRepartos } from '@/services/shared/repartoDescuentoTx'
import { baseDeCargos, recalcularCargosPorServicio } from '@/services/shared/serviceCharges'
import { computeStoredOrderTotal } from '@/services/shared/orderBalance'
import type { LogActionParams } from '@/services/dashboard/activity-log.service'
import { crearCuentaDelPedidoEnTx, toQuoteSnapshot } from './order.service'
import { quoteCart, type CartItemInput, type QuoteResult } from './quote.service'

export type BeneficioElegido = 'CUPON' | 'PREMIO' | 'PUNTOS'
export interface EleccionDeBeneficios {
  premioId?: string
  puntos?: number
  cupon?: string
}
export interface BeneficioAplicado {
  tipo: 'DESCUENTO' | 'CUPON' | 'PREMIO' | 'PUNTOS'
  nombre: string
  monto: Prisma.Decimal
  orderDiscountId: string
  /** D8: sólo PREMIO de producto gratis: el índice (desde 0) del renglón del carrito donde cae, como `lineIndex` de los avisos. */
  lineIndex?: number
}
export interface OfertaDeBeneficios {
  /** D8: `lineIndex` = el renglón del carrito donde caería si lo usa («Va en tu Latte»); sólo de producto gratis, y sólo al cotizar. */
  premio: { id: string; etiqueta: string; lineIndex?: number } | null
  puntos: { saldo: number; minimo: number; valorPorPunto: number; maxPuntos: number } | null
  cupon: boolean
}
/** La cotización de hoy y, con sesión, lo de los beneficios. Sin sesión, ningún campo nuevo (como hoy). */
export interface QuoteConBeneficios extends QuoteResult {
  totalConBeneficios?: Prisma.Decimal
  aplicados?: BeneficioAplicado[]
  oferta?: OfertaDeBeneficios
  descartados?: BeneficioElegido[]
  /** `false` = no se simuló (sin lugar, candado o tiempo agotado, o pool desconocido): la tienda dice que se calculan al pedir. */
  beneficios?: { calculados: boolean }
  /** S11 (Codex r8): `false` = `aplicados` llegó al tope (`MAX_APLICADOS`): `toPublicQuote` nunca lo publica (sale degradada). */
  aplicadosCompletos?: false
}

export const BENEFIT_UNAVAILABLE = 'BENEFIT_UNAVAILABLE'

/**
 * Tope del desglose `aplicados` (r5 #2, r6). Nada se trunca en silencio: si la cuenta trae más filas, la cadena lo dice
 * (`aplicadosCompletos: false` y el conteo) y la cotización entera degrada a `calculados:false` (o todo o nada). ponytail: 500 filas
 * de una cuenta nueva (el motor apila automáticos sin máximo); si un negocio llega a tantas, paginar el desglose.
 */
export const MAX_APLICADOS = 500

/**
 * R8''': ⌊pool / 6⌋ simulaciones a la vez en todo el servidor, con el `connection_limit` EXPLÍCITO de la URL que recibió el mismo
 * Prisma (`buildDatasourceUrl`). Sin él (p. ej. `pgbouncer=true` sin límite) no se sabe cuántas conexiones hay: cero.
 */
export function topeGlobalDeSimulaciones(url: string | undefined): number {
  const limite = Number(url?.match(/[?&]connection_limit=(\d+)/)?.[1] ?? 0)
  return Number.isInteger(limite) && limite > 0 ? Math.floor(limite / 6) : 0
}

/**
 * Los techos de la simulación (R5'', R8'''). Mutables sólo para las pruebas, como `REINTENTO_POR_INTERBLOQUEO`.
 * ponytail: 2 por negocio y ⌊pool / 6⌋ en todo el servidor, semáforo en memoria (una sola instancia, sin Redis) y espera de 300 ms; al
 * llenarse, la cotización sale sin beneficios (`calculados:false`). Subirlos sólo midiendo la espera de conexión de los cobros (P2024 y
 * el `[query-guard]` del log) con la tienda cotizando. La MISMA clienta que cobra en caja en ese instante puede esperar lo que dure su
 * cotización (su premio y su `Customer`): a lo más `transaccion.timeout`.
 */
export const SIMULACION = {
  porNegocio: 2,
  global: topeGlobalDeSimulaciones(buildDatasourceUrl()),
  esperaPorLugarMs: 300,
  /** Higiene, no garantía (R5''): la garantía para la caja de otra clienta es que la simulación no toma sus candados (R9). */
  transaccion: { maxWait: 300, timeout: 800 },
}
if (SIMULACION.global === 0) {
  logger.warn(
    '⚠️ [OnlineOrdering] la tienda NO cotiza beneficios: la URL de la base no declara un connection_limit de 6 o más (o no se puede saber el pool, p. ej. pgbouncer sin límite); se calculan al pedir',
    { tope: SIMULACION.global },
  )
}

// ── canjes ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Un rechazo de NEGOCIO del canje (un 4xx con el texto de la caja) pasa a `BENEFIT_UNAVAILABLE`; cualquier otro error sube tal cual. */
function comoNoDisponible(error: unknown, cual: BeneficioElegido): AppError {
  if (error instanceof AppError && error.code === BENEFIT_UNAVAILABLE) return error
  if (error instanceof AppError && error.statusCode >= 400 && error.statusCode < 500) {
    return new AppError(error.message, 409, true, BENEFIT_UNAVAILABLE, { cual })
  }
  throw error
}

/** Lo que devuelve un canje tolerante que la caja rechazó (queda en `descartados`). */
const DESCARTADO = Symbol('descartado')

/**
 * Un canje elegido. Estricto: su rechazo de negocio es `BENEFIT_UNAVAILABLE`. Tolerante: corre en su `SAVEPOINT` (el patrón de
 * `paymentEffects.service.ts`); si la caja lo rechaza, `ROLLBACK TO SAVEPOINT` y devuelve `DESCARTADO`. 🔴 Una traba (40P01), un
 * candado o tiempo vencidos (55P03, 57014, P2028) NO se atrapan aquí: suben y abortan la simulación entera; `withDeadlockRetry` repite
 * sólo la traba. Seguir tras un `ROLLBACK TO SAVEPOINT` de una víctima mostraría como «descartado» un beneficio que sí estaba (R63).
 * S11 (R7): devuelve lo que devolvió el canje, para su bitácora.
 */
async function canjear<T>(
  tx: TxConReintento,
  cual: BeneficioElegido,
  tolerante: boolean,
  fn: () => Promise<T>,
): Promise<T | typeof DESCARTADO> {
  if (!tolerante) {
    try {
      return await fn()
    } catch (error) {
      throw comoNoDisponible(error, cual)
    }
  }
  const punto = `beneficio_${cual.toLowerCase()}`
  await tx.$executeRawUnsafe(`SAVEPOINT ${punto}`)
  let resultado: T | typeof DESCARTADO
  try {
    resultado = await fn()
  } catch (error) {
    comoNoDisponible(error, cual)
    await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${punto}`)
    resultado = DESCARTADO
  }
  await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${punto}`)
  return resultado
}

/**
 * El cupón sobre la cuenta ya armada: se valida y se aparta con las piezas de la caja (`cuponDeLaVenta`, `apartarCupon`, `ligarCupon`)
 * y se monta como en una cuenta abierta (`applyCouponCode` de la TPV): sobre lo que queda tras el motor, con su tope en el reparto, y
 * los totales con la regla compartida. En la simulación `apartarCupon` va sin candado y con los usos propios del motor (R9'').
 */
async function aplicarCuponEnTx(
  tx: TxConReintento,
  c: {
    venueId: string
    orderId: string
    customerId: string
    codigo: string
    simulacion: boolean
    usosPropios: ReadonlyMap<string, number>
  },
): Promise<{ discountId: string; couponCodeId: string; monto: number }> {
  const order = await tx.order.findFirst({
    where: { id: c.orderId, venueId: c.venueId },
    select: {
      subtotal: true,
      discountAmount: true,
      taxAmount: true,
      tipAmount: true,
      paidAmount: true,
      contratoDePrecio: true,
      status: true,
    },
  })
  if (!order) throw new NotFoundError('Orden no encontrada')
  const queda = Math.round(Math.max(0, Number(order.subtotal) - Number(order.discountAmount)) * 100) / 100
  const cupon = await cuponDeLaVenta(tx, c.venueId, c.codigo, queda, c.customerId)
  // R2: lo que en caja pide autorización (aprobación de gerente o el permiso de cortesía) no se aplica desde la tienda: nadie lo autoriza.
  if (cupon.discount.requiresApproval || cupon.discount.type === 'COMP') {
    throw new BadRequestError('Este cupón se aplica en caja con autorización del negocio.')
  }
  await apartarCupon(tx, c.venueId, cupon, c.customerId, {
    conCandado: !c.simulacion,
    usosPropios: c.simulacion ? (c.usosPropios.get(cupon.discount.id) ?? 0) : 0,
  })
  const monto = montoDelCupon(cupon.discount, queda)
  if (monto <= 0) throw new BadRequestError('La cuenta ya está completamente descontada; no se puede aplicar otro descuento.')

  await conservarDescuentoHistorico(tx, c.orderId, order.discountAmount)
  await tx.orderDiscount.create({
    data: ligarCupon(
      {
        orderId: c.orderId,
        type: cupon.discount.type,
        value: cupon.discount.value,
        name: cupon.discount.name,
        amount: monto,
        taxReduction: 0,
        isAutomatic: false,
        // Como la TPV: % de lo que queda ⇒ fila de CUENTA; el tope del catálogo viaja en el reparto (R6, también 0).
        reparto: comoJson(
          nuevoRepartoDeCuenta({
            conPromociones: true,
            tope:
              cupon.discount.type === 'PERCENTAGE' && cupon.discount.maxDiscountAmount != null
                ? Number(cupon.discount.maxDiscountAmount)
                : null,
          }),
        ),
      },
      cupon,
    ),
  })
  const sincronizado = await sincronizarRepartos(tx, c.orderId)
  const descuento = Number(order.discountAmount) + monto
  const cargos = await recalcularCargosPorServicio(tx, c.orderId, baseDeCargos(order.subtotal, descuento))
  const total = computeStoredOrderTotal({
    subtotal: order.subtotal,
    discountAmount: descuento,
    contratoDePrecio: order.contratoDePrecio,
    taxAmount: new Prisma.Decimal(order.taxAmount).plus(sincronizado.impuestoDevuelto),
    status: order.status,
    serviceChargeAmount: cargos,
    tipAmount: order.tipAmount,
  }).toNumber()
  await tx.order.update({
    where: { id: c.orderId },
    data: {
      discountAmount: descuento,
      serviceChargeAmount: cargos,
      total,
      remainingBalance: Math.max(0, total - Number(order.paidAmount)),
    },
  })
  return { discountId: cupon.discount.id, couponCodeId: cupon.id, monto }
}

/**
 * La cadena de beneficios sobre una cuenta NUEVA de la clienta, en la transacción de quien la crea (EN_TX: no abre otra). Orden fijo:
 * (asesor del cupón, sólo estricto) → motor → cupón → premio → puntos. `total` y `aplicados` se LEEN de la cuenta al final (R1): son los
 * que dejó el último recálculo de la caja, nunca una suma de pasos. Nunca escribe ni bloquea `WalletPass` (R55 a): la fila de la bandeja
 * del premio la deja `canjearPremioEnTx` y se deshace con lo demás.
 */
export async function aplicarBeneficiosEnTx(
  tx: TxConReintento,
  i: { venueId: string; orderId: string; customerId: string; eleccion: EleccionDeBeneficios },
  opciones: { tolerante?: true; premioOfrecido?: string } = {},
): Promise<{
  total: Prisma.Decimal
  aplicados: BeneficioAplicado[]
  descartados: BeneficioElegido[]
  /** Sólo si la cuenta trae más de `MAX_APLICADOS` filas: el desglose llega hasta el tope y aquí va el conteo real (r5 #2). */
  aplicadosCompletos?: false
  aplicadosTotal?: number
  /** S11 (Codex r8): el premio elegido quedó canjeado en esta cuenta. Se sabe por su fila, no por el desglose (que puede ir recortado). */
  premio: boolean
  /** D8: sólo al cotizar con `premioOfrecido` y sin premio elegido: el renglón del carrito donde caería ese premio. */
  premioOfrecidoEn?: number
  /**
   * S11 (R7): sólo en estricto, la bitácora de cada canje real (la del motor y las de los envoltorios públicos del cupón, el premio y
   * los puntos). Quien crea el folio la escribe con su `tx`: un intento revertido se lleva sus filas.
   */
  auditorias?: LogActionParams[]
}> {
  const { venueId, orderId, customerId, eleccion } = i
  const simulacion = opciones.tolerante === true
  const descartados: BeneficioElegido[] = []
  // R3 y R4: el programa se lee SIN crearlo (nunca `getOrCreateLoyaltyConfig`).
  const config = await tx.loyaltyConfig.findUnique({ where: { venueId } })
  const codigo = eleccion.cupon?.trim().toUpperCase() || null

  // Codex plan2-r2 #1: en estricto, el asesor del cupón va ANTES que toda fila `Discount`, como su canje (`canjearCuponEnTx`); el
  // código se resuelve sólo leyendo. R9: cotizar no lo toma.
  const descuentoDelCupon =
    codigo && !simulacion
      ? ((await tx.couponCode.findFirst({ where: { code: codigo, discount: { venueId } }, select: { discountId: true } }))?.discountId ??
        null)
      : null
  if (descuentoDelCupon) await bloquearDescuentoDelCupon(tx, descuentoDelCupon)

  const motor = await aplicarDescuentosDelMotorEnTx(tx, {
    venueId,
    orderId,
    bloquearTambien: descuentoDelCupon ? [descuentoDelCupon] : [],
    simulacion,
  })
  // R9'': sólo los incrementos de `Discount.currentUses` que el motor NO escribió en la simulación (nacen en cada intento).
  const usosPropios = new Map<string, number>()
  if (simulacion) for (const d of motor.applied) usosPropios.set(d.discountId, (usosPropios.get(d.discountId) ?? 0) + 1)

  const auditorias: LogActionParams[] = [...motor.audits]
  const auditoria = (action: string, entity: string, entityId: string, data: Prisma.InputJsonValue): LogActionParams => ({
    staffId: null,
    venueId,
    action,
    entity,
    entityId,
    data,
  })

  if (codigo) {
    const r = await canjear(tx, 'CUPON', simulacion, () =>
      aplicarCuponEnTx(tx, { venueId, orderId, customerId, codigo, simulacion, usosPropios }),
    )
    if (r === DESCARTADO) descartados.push('CUPON')
    else {
      const data = { discountId: r.discountId, couponCodeId: r.couponCodeId, amount: r.monto, source: 'coupon' }
      auditorias.push(auditoria('DISCOUNT_APPLIED', 'Order', orderId, data))
    }
  }
  // D8: el renglón donde cae el premio (el que P11 eligió al canjearlo) o, al cotizar sin elegirlo, donde caería: en ESTE punto de la
  // cadena (tras motor y cupón, antes de los puntos), sólo leyendo.
  let renglonDelPremio: string | null = null
  let renglonOfrecido: string | null = null
  if (eleccion.premioId) {
    const premioId = eleccion.premioId
    const r = await canjear(tx, 'PREMIO', simulacion, async () => {
      if (!config?.active || !config.stampsEnabled) throw new BadRequestError('La tarjeta de sellos no está activa en este negocio.')
      return canjearPremioEnTx(tx, venueId, orderId, premioId)
    })
    if (r === DESCARTADO) descartados.push('PREMIO')
    else {
      renglonDelPremio = r.renglonPremiadoId ?? null
      // La misma de `avisarPremioCanjeado` (redeemStampReward.service.ts).
      const data = {
        orderId,
        customerId,
        rewardType: r.reward?.rewardType ?? null,
        rewardLabel: r.reward?.rewardLabel ?? null,
        discountAmount: r.discountAmount,
      }
      auditorias.push(auditoria('STAMP_REWARD_REDEEMED', 'StampReward', premioId, data))
    }
  } else if (simulacion && opciones.premioOfrecido) {
    renglonOfrecido = await renglonDelPremioEnTx(tx, venueId, orderId, opciones.premioOfrecido)
  }
  if (eleccion.puntos) {
    const puntos = eleccion.puntos
    const r = await canjear(tx, 'PUNTOS', simulacion, async () => {
      if (!config?.active) throw new BadRequestError('El programa de lealtad no está activo en esta sucursal')
      const programa = { ...config, pointsPerDollar: config.pointsPerDollar.toNumber(), redemptionRate: config.redemptionRate.toNumber() }
      return redeemPointsToOrderInTransaction(tx, venueId, orderId, customerId, puntos, undefined, programa)
    })
    if (r === DESCARTADO) descartados.push('PUNTOS')
    else {
      // La misma de `redeemPointsToOrder` (loyalty.mobile.service.ts).
      const data = { customerId, points: r.pointsToBurn, discountAmount: r.discountAmount }
      auditorias.push(auditoria('LOYALTY_POINTS_REDEEMED', 'Order', orderId, data))
    }
  }

  const cuenta = await tx.order.findFirst({ where: { id: orderId, venueId }, select: { total: true } })
  if (!cuenta) throw new NotFoundError('Orden no encontrada')
  // r5 #2: nada se trunca en silencio. Una de más dice si el tope se alcanzó; entonces se cuentan todas y la respuesta lo avisa.
  const leidas = await tx.orderDiscount.findMany({
    where: { orderId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: MAX_APLICADOS + 1,
    select: { id: true, name: true, amount: true, couponCodeId: true, loyaltyTransactionId: true },
  })
  const filas = leidas.slice(0, MAX_APLICADOS)
  const incompleto =
    leidas.length > MAX_APLICADOS
      ? { aplicadosCompletos: false as const, aplicadosTotal: await tx.orderDiscount.count({ where: { orderId } }) }
      : {}
  const filaDelPremio =
    eleccion.premioId && !descartados.includes('PREMIO')
      ? ((await tx.stampReward.findFirst({ where: { id: eleccion.premioId, venueId }, select: { orderDiscountId: true } }))
          ?.orderDiscountId ?? null)
      : null
  const lineaDelPremio = filaDelPremio ? await indiceEnElCarrito(tx, orderId, renglonDelPremio) : undefined
  const premioOfrecidoEn = await indiceEnElCarrito(tx, orderId, renglonOfrecido)
  const aplicados = filas.map(f => ({
    tipo: (f.couponCodeId
      ? 'CUPON'
      : f.loyaltyTransactionId
        ? 'PUNTOS'
        : f.id === filaDelPremio
          ? 'PREMIO'
          : 'DESCUENTO') as BeneficioAplicado['tipo'],
    nombre: f.name ?? '',
    monto: new Prisma.Decimal(f.amount),
    orderDiscountId: f.id,
    ...(f.id === filaDelPremio && lineaDelPremio !== undefined ? { lineIndex: lineaDelPremio } : {}),
  }))
  return {
    total: new Prisma.Decimal(cuenta.total),
    aplicados,
    descartados,
    premio: filaDelPremio !== null,
    ...(premioOfrecidoEn !== undefined ? { premioOfrecidoEn } : {}),
    ...incompleto,
    ...(simulacion ? {} : { auditorias }),
  }
}

/**
 * D8: el índice del renglón en el carrito que mandó la tienda. La cuenta de un pedido en línea nace con `sequence` = índice de la línea
 * cotizada (`crearCuentaDelPedidoEnTx`), y una cotización con `ok` tiene una línea por cada artículo de `items`, en su orden.
 */
async function indiceEnElCarrito(tx: TxConReintento, orderId: string, renglonId: string | null): Promise<number | undefined> {
  if (!renglonId) return undefined
  return (await tx.orderItem.findFirst({ where: { id: renglonId, orderId }, select: { sequence: true } }))?.sequence
}

// ── oferta ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Lo que la tienda le ofrece elegir, sólo leyendo (R4: nunca crea la configuración de lealtad) y sólo si su función está prendida:
 * el premio PENDING vigente con los sellos prendidos; los puntos como `getCustomerLoyalty` (`loyalty.mobile.service.ts`) cuando ya
 * alcanzan el mínimo; el campo de cupón si el negocio tiene uno vigente que la tienda puede aplicar (R2: sin aprobación ni cortesía).
 */
export async function ofertaDeBeneficios(venueId: string, customerId: string): Promise<OfertaDeBeneficios> {
  const ahora = new Date()
  const config = await prisma.loyaltyConfig.findUnique({ where: { venueId } })
  const premio =
    config?.active && config.stampsEnabled
      ? await prisma.stampReward.findFirst({
          where: { venueId, customerId, status: StampRewardStatus.PENDING, OR: [{ expiresAt: null }, { expiresAt: { gt: ahora } }] },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: { id: true, rewardLabel: true },
        })
      : null

  let puntos: OfertaDeBeneficios['puntos'] = null
  if (config?.active) {
    const cliente = await prisma.customer.findFirst({ where: { id: customerId, venueId }, select: { loyaltyPoints: true } })
    const saldo = cliente?.loyaltyPoints ?? 0
    const valorPorPunto = Number(config.redemptionRate)
    const valor = Math.round(saldo * valorPorPunto * 100) / 100
    const maxPuntos = valorPorPunto > 0 ? Math.min(saldo, Math.floor(valor / valorPorPunto)) : 0
    if (saldo >= config.minPointsRedeem && maxPuntos >= config.minPointsRedeem) {
      puntos = { saldo, minimo: config.minPointsRedeem, valorPorPunto, maxPuntos }
    }
  }

  const cupon = await prisma.couponCode.findFirst({
    where: {
      active: true,
      AND: [
        {
          OR: [{ validFrom: { lte: ahora } }, { validFrom: null, discount: { OR: [{ validFrom: null }, { validFrom: { lte: ahora } }] } }],
        },
        {
          OR: [
            { validUntil: { gte: ahora } },
            { validUntil: null, discount: { OR: [{ validUntil: null }, { validUntil: { gte: ahora } }] } },
          ],
        },
      ],
      discount: { venueId, active: true, scope: 'ORDER', requiresApproval: false, type: { not: 'COMP' } },
    },
    select: { id: true },
  })

  return { premio: premio ? { id: premio.id, etiqueta: premio.rewardLabel } : null, puntos, cupon: !!cupon }
}

// ── cotizar ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Un lugar de simulación: `tomar` espera a lo más `ms`; el lugar que se suelta pasa directo al primero que espera. */
class Lugares {
  private ocupados = 0
  private readonly fila: Array<() => void> = []
  constructor(private readonly tope: () => number) {}
  get libre(): boolean {
    return this.ocupados === 0 && this.fila.length === 0
  }
  tomar(ms: number): Promise<boolean> {
    if (this.ocupados < this.tope()) {
      this.ocupados++
      return Promise.resolve(true)
    }
    if (ms <= 0 || this.tope() <= 0) return Promise.resolve(false)
    return new Promise(resolve => {
      const turno = () => {
        clearTimeout(reloj)
        resolve(true)
      }
      const reloj = setTimeout(() => {
        this.fila.splice(this.fila.indexOf(turno), 1)
        resolve(false)
      }, ms)
      this.fila.push(turno)
    })
  }
  soltar(): void {
    const siguiente = this.fila.shift()
    if (siguiente) siguiente()
    else this.ocupados--
  }
}
const lugaresGlobales = new Lugares(() => SIMULACION.global)
const lugaresPorNegocio = new Map<string, Lugares>()

/** Un lugar del negocio y uno global, con UNA espera total de `esperaPorLugarMs`; `null` si no alcanzó (R5'', R8'''). */
async function tomarLugar(venueId: string): Promise<(() => void) | null> {
  if (SIMULACION.global <= 0) return null
  const limite = Date.now() + SIMULACION.esperaPorLugarMs
  let delNegocio = lugaresPorNegocio.get(venueId)
  if (!delNegocio) {
    delNegocio = new Lugares(() => SIMULACION.porNegocio)
    lugaresPorNegocio.set(venueId, delNegocio)
  }
  const negocio = delNegocio
  const soltarNegocio = () => {
    negocio.soltar()
    if (negocio.libre && lugaresPorNegocio.get(venueId) === negocio) lugaresPorNegocio.delete(venueId)
  }
  if (!(await negocio.tomar(limite - Date.now()))) {
    if (negocio.libre) lugaresPorNegocio.delete(venueId)
    return null
  }
  if (!(await lugaresGlobales.tomar(limite - Date.now()))) {
    soltarNegocio()
    return null
  }
  return () => {
    lugaresGlobales.soltar()
    soltarNegocio()
  }
}

/** El código de Postgres o de Prisma de un error, directo o envuelto (P2010). */
function codigoDe(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const e = error as { code?: unknown; errorCode?: unknown; meta?: { code?: unknown; sqlState?: unknown }; cause?: { code?: unknown } }
  // `PrismaClientInitializationError` trae su código en `errorCode` (P1001, P1017…), no en `code`.
  const anidado = [e.meta?.code, e.meta?.sqlState, e.cause?.code, e.errorCode].find(v => typeof v === 'string') as string | undefined
  return e.code === 'P2010' ? anidado : typeof e.code === 'string' ? e.code : anidado
}

/**
 * R5'' y r5 #1: con la cotización base ya hecha, un error de INFRAESTRUCTURA al leer la oferta o al simular no es un 500: la cotización
 * sale sin beneficios (nunca con un «descartado» falso). Candado vencido (55P03), sentencia o transacción agotadas (57014, P2028), la
 * traba que se repitió hasta agotarse (40P01), el pool sin conexión libre (P2024) y la base inalcanzable o que cerró la conexión
 * (P1001, P1002, P1008, P1017). Un error de negocio o de programación sube tal cual.
 */
const CEDE_POR_INFRAESTRUCTURA = new Set(['55P03', '57014', 'P2028', 'P2024', 'P1001', 'P1002', 'P1008', 'P1017'])
export function cedeLaSimulacion(error: unknown): boolean {
  if (isDeadlockError(error) || isModelLockTimeoutError(error)) return true
  if (CEDE_POR_INFRAESTRUCTURA.has(codigoDe(error) ?? '')) return true
  return error instanceof Prisma.PrismaClientUnknownRequestError && /code: "(55P03|57014)"/.test(error.message)
}

/** El resultado de la simulación viaja como error para que la transacción se deshaga; no es una traba: sale al primer intento. */
class Simulada extends Error {
  constructor(readonly resultado: Awaited<ReturnType<typeof aplicarBeneficiosEnTx>>) {
    super('simulación de la cotización: se deshace a propósito')
  }
}

type CarritoCotizado = Pick<QuoteResult, 'subtotal' | 'total' | 'lines'>

/**
 * La SIMULACIÓN (R5'', R9): en una transacción acotada, la cuenta provisional `COTIZACION-<cuid>` (su `FOR KEY SHARE` de la clienta va
 * primero, R6) + `aplicarBeneficiosEnTx` tolerante, y se deshace lanzando `Simulada`. El lugar del semáforo lo toma quien llama.
 * ponytail: una escritura deshecha por simulación (≈ 20–40 sentencias); si pesa, una por clienta cada N s.
 */
async function simularLaCadena(
  venueId: string,
  quote: CarritoCotizado,
  customerId: string,
  eleccion: EleccionDeBeneficios,
  premioOfrecido?: string,
) {
  const folio = `COTIZACION-${cuid()}`
  return withDeadlockRetry(
    async tx => {
      // Cede ella, nunca la caja: espera poco un candado y nunca deja una sentencia larga.
      await tx.$executeRaw`SET LOCAL lock_timeout = '200ms'`
      await tx.$executeRaw`SET LOCAL statement_timeout = '500ms'`
      const { orderId } = await crearCuentaDelPedidoEnTx(tx, {
        venueId,
        externalId: folio,
        orderNumber: folio,
        quote: toQuoteSnapshot(quote),
        customer: { name: 'Cotización', phone: null, email: null },
        customerId,
        note: null,
        paymentMode: 'PAY_AT_PICKUP',
      })
      throw new Simulada(await aplicarBeneficiosEnTx(tx, { venueId, orderId, customerId, eleccion }, { tolerante: true, premioOfrecido }))
    },
    { etiqueta: 'simularLaCadena', ...SIMULACION.transaccion },
  ).catch((error: unknown) => {
    if (error instanceof Simulada) return error.resultado
    throw error
  })
}

/**
 * S11 (R2'', R2'''): el total del borrador de tarjeta, sin crear nada: la MISMA simulación que cotizar, con un lugar del MISMO semáforo
 * (global y por negocio, contado junto con las cotizaciones) tomado ANTES de pedir conexión, pero sin la degradación de S10. `null` = no
 * hubo lugar (el borrador responde 503, sin decisión bajo la llave); un error de infraestructura sube (`cedeLaSimulacion` lo
 * reconoce). Termina, con su rollback, antes de que el borrador abra su transacción.
 */
export async function simularBeneficios(
  venueId: string,
  quote: CarritoCotizado,
  customerId: string,
  eleccion: EleccionDeBeneficios,
): Promise<Awaited<ReturnType<typeof aplicarBeneficiosEnTx>> | null> {
  const soltar = await tomarLugar(venueId)
  if (!soltar) {
    logger.info('[OnlineOrdering] simulación de beneficios sin lugar', { venueId, tope: SIMULACION.global })
    return null
  }
  try {
    return await simularLaCadena(venueId, quote, customerId, eleccion)
  } finally {
    soltar()
  }
}

/**
 * La cotización de la tienda. Sin sesión, la de hoy (`quoteCart`). Con sesión, además, la SIMULACIÓN (`simularLaCadena`), con su lugar
 * del semáforo. Nunca lanza `BENEFIT_UNAVAILABLE`: lo que ya no está sale en `descartados`.
 */
export async function cotizarConBeneficios(
  venueId: string,
  items: CartItemInput[],
  o: { customerId: string | null; eleccion: EleccionDeBeneficios | null; now?: Date },
): Promise<QuoteConBeneficios> {
  const quote = await quoteCart(venueId, items, { now: o.now })
  if (!o.customerId || !quote.ok) return quote
  const customerId = o.customerId

  const soltar = await tomarLugar(venueId)
  if (!soltar) {
    logger.info('[OnlineOrdering] cotización sin beneficios: no hubo lugar para simular', { venueId, tope: SIMULACION.global })
    return { ...quote, beneficios: { calculados: false } }
  }
  const inicio = Date.now()
  let calculados = false
  try {
    const oferta = await ofertaDeBeneficios(venueId, customerId)
    const r = await simularLaCadena(venueId, quote, customerId, o.eleccion ?? {}, oferta.premio?.id)
    // r6: o se calcula todo o no se calcula. Con más filas que el tope del desglose, no se anuncian beneficios con detalle incompleto.
    if (r.aplicadosCompletos === false) {
      logger.warn('[OnlineOrdering] la cotización sale sin beneficios: el desglose pasa del tope', {
        venueId,
        filas: r.aplicadosTotal,
        tope: MAX_APLICADOS,
      })
      return { ...quote, beneficios: { calculados: false } }
    }
    calculados = true
    // D8: donde cae el premio ofrecido: el de lo aplicado si es el que eligió; si no lo eligió, donde caería.
    const ofrecido = oferta.premio
    const lineIndex =
      ofrecido && o.eleccion?.premioId === ofrecido.id ? r.aplicados.find(a => a.tipo === 'PREMIO')?.lineIndex : r.premioOfrecidoEn
    return {
      ...quote,
      totalConBeneficios: r.total,
      aplicados: r.aplicados,
      oferta: ofrecido && lineIndex !== undefined ? { ...oferta, premio: { ...ofrecido, lineIndex } } : oferta,
      descartados: r.descartados,
      beneficios: { calculados: true },
    }
  } catch (error) {
    if (!cedeLaSimulacion(error)) throw error
    logger.warn('[OnlineOrdering] la simulación de beneficios cedió: la cotización sale sin beneficios', {
      venueId,
      codigo: codigoDe(error),
    })
    return { ...quote, beneficios: { calculados: false } }
  } finally {
    // Ya terminó la transacción (confirmada nunca: deshecha o abortada) cuando se suelta el lugar.
    soltar()
    logger.info('[OnlineOrdering] cotización con beneficios', { venueId, ms: Date.now() - inicio, calculados })
  }
}

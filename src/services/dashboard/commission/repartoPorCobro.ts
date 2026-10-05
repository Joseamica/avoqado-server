// src/services/dashboard/commission/repartoPorCobro.ts
/**
 * Reparto de un valor de la ORDEN entre sus COBROS — PURO, sin base de datos (fase 3 de pago por servicio, A1).
 *
 * La comisión corre POR COBRO, pero el descuento, el IVA y la base por categorías son de la ORDEN. Antes cada cobro
 * recibía el descuento y el IVA de TODA la orden (dos cobros de $225 en «precio de lista» comisionaban $550 sobre una
 * venta de $500), y el camino de categorías le cargaba al PRIMER cobro toda la base (devolver ese cobro dejaba la
 * comisión en $0 aunque seguían cobrados $225). Aquí cada cobro se lleva la parte proporcional a lo que pagó; el que
 * completa la orden se lleva lo que falta, así que las partes suman exactamente el valor (spec §9-1, Codex r3-14).
 */
import { Prisma } from '@prisma/client'
import { FULL_PAYMENT_TOLERANCE } from '@/services/shared/orderBalance'

const CERO = new Prisma.Decimal(0)

export function parteDelCobro(input: {
  totalOrden: Prisma.Decimal // lo que se cobra en total por la orden, sin propina
  cobro: Prisma.Decimal // lo que pagó ESTE cobro (sin propina)
  valor: Prisma.Decimal // lo que se reparte (descuento, IVA o base de categoría de la orden); debe ser ≥ 0 (con negativos la suma deja de ser `valor`)
  yaRepartido: Prisma.Decimal // lo que ya se asignó a cobros anteriores de la misma orden
  esUltimo: boolean // el cobro que completa la orden se lleva el residuo de centavos
}): Prisma.Decimal {
  const resto = Prisma.Decimal.max(CERO, input.valor.minus(input.yaRepartido))
  // Orden de total cero (cortesía completa): no hay proporción posible; el cobro se lleva lo que quede.
  if (input.esUltimo || input.totalOrden.lte(0)) return resto
  const proporcion = Prisma.Decimal.min(1, Prisma.Decimal.max(0, input.cobro.div(input.totalOrden)))
  return Prisma.Decimal.min(resto, input.valor.mul(proporcion).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP))
}

/** Un cobro dentro de su orden: lo que cobra la orden, lo que pagó este cobro y los valores de la orden que se reparten. */
export interface CobroDeLaOrden {
  totalOrden: Prisma.Decimal // lo que se cobra por la orden, sin propina
  cobro: Prisma.Decimal // lo que pagó ESTE cobro, sin propina
  descuento: Prisma.Decimal // descuento efectivo de la orden (tope: subtotal)
  iva: Prisma.Decimal // IVA registrado de la orden (incluido o aparte)
}

/**
 * OTRO cobro confirmado de la misma orden, visible bajo el candado de la orden, y lo que YA recibió de un esquema
 * (materializado o en cola). `null` = ese cobro no tiene registro de este esquema (persona excluida, esquema distinto).
 */
export interface OtroCobro {
  monto: Prisma.Decimal // lo que pagó, sin propina
  base: Prisma.Decimal | null // su base de la orden (categorías o sobrante), sin propina
  descuento: Prisma.Decimal | null // su parte del descuento
  iva: Prisma.Decimal | null // su parte del IVA
}

const completa = (acumulado: Prisma.Decimal, total: Prisma.Decimal) => acumulado.gte(total.minus(FULL_PAYMENT_TOLERANCE))

/**
 * La parte de `valor` que le toca a ESTE cobro (fase 3, A1; Codex plan r2, el riesgo de A1b). NO depende del orden de las
 * fechas: bajo el candado de la orden, `yaRepartido` es lo que ya recibieron los OTROS cobros confirmados visibles —lo
 * registrado (`campo`), o su parte proporcional si no tienen registro— y el cobro que completa la orden se lleva lo que
 * falta, con el residuo de centavos. Así dos cobros confirmados en cualquier orden suman exactamente el valor.
 *
 * `valor` debe ser ≥ 0: con un valor negativo (p. ej. un reverso) las partes dejan de sumar `valor`.
 *
 * ponytail: un cobro SIN registro que en su momento completó la orden cuenta aquí como proporcional, no como residuo; sólo
 * pesa si llega OTRO cobro después de saldada la orden (sobrepago), y es a lo más un centavo por cobro.
 */
export function repartir(
  c: Pick<CobroDeLaOrden, 'totalOrden' | 'cobro'>,
  valor: Prisma.Decimal,
  otros: OtroCobro[] = [],
  campo: 'base' | 'descuento' | 'iva' = 'base',
): Prisma.Decimal {
  let yaRepartido = CERO
  let acumulado = c.cobro
  for (const o of otros) {
    acumulado = acumulado.plus(o.monto)
    yaRepartido = yaRepartido.plus(
      o[campo] ?? parteDelCobro({ totalOrden: c.totalOrden, cobro: o.monto, valor, yaRepartido: CERO, esUltimo: false }),
    )
  }
  return parteDelCobro({ totalOrden: c.totalOrden, cobro: c.cobro, valor, yaRepartido, esUltimo: completa(acumulado, c.totalOrden) })
}

/**
 * Redondea al centavo unas partes que juntas deben sumar `total` (default: su suma exacta, redondeada): cada una hacia
 * abajo y los centavos que faltan, uno por parte, a los mayores restos; en empate, el orden del arreglo (quien llama lo
 * fija estable). Así $10 entre tres son 3.34 + 3.33 + 3.33, nunca $9.99 (Codex plan r1-4).
 */
export function redondearRepartido(
  exactos: Prisma.Decimal[],
  total: Prisma.Decimal = exactos.reduce((s, x) => s.plus(x), CERO).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
): Prisma.Decimal[] {
  const partes = exactos.map(x => x.toDecimalPlaces(2, Prisma.Decimal.ROUND_FLOOR))
  let centavos = total
    .minus(partes.reduce((s, x) => s.plus(x), CERO))
    .mul(100)
    .toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP)
    .toNumber()
  const porResto = exactos.map((x, i) => ({ i, resto: x.minus(partes[i]) })).sort((a, b) => b.resto.comparedTo(a.resto) || a.i - b.i)
  for (const { i } of porResto) {
    if (centavos <= 0) break
    partes[i] = partes[i].plus('0.01')
    centavos--
  }
  // Guarda de dinero: un `total` que no concuerda con los exactos (o con más centavos que partes) dejaría partes que no suman.
  // Mejor fallar en voz alta que repartir de más o de menos sin avisar.
  const suma = partes.reduce((s, x) => s.plus(x), CERO)
  if (!suma.equals(total)) {
    throw new Error(
      `redondearRepartido: las partes suman ${suma.toFixed(2)} y no suman el total ${total.toString()}; los exactos no concuerdan con el total.`,
    )
  }
  return partes
}

/**
 * Task P1 · la suma exacta del dinero: centavos enteros (`bigint`) desde los campos originales de cada cobro, y a pesos sólo al
 * final, para la respuesta. Sumar `number` deriva a volumen (500,000 cobros de $10,000.01 daban $5,000,005,000.06). La comisión de
 * un cobro sale de `proyectarComisionYNeto`: una sola fórmula para el costo, la liquidación y lo que cae en el banco.
 * La usan la semana del panel (`getSettlementsLandingInWeek`) y la de la B (`settlementWeekByGroups.service.ts`).
 */
import { Prisma } from '@prisma/client'
import logger from '@/config/logger'
import { proyectarComisionYNeto } from './proyeccionMonetaria'

export type Centavos = bigint
export interface SumaDeDinero {
  gross: Centavos
  commission: Centavos
  net: Centavos
  count: number
}
type Valor = Prisma.Decimal | string | number

/**
 * Los centavos de un importe que TIENE que leerse (C6 r1: la suma que regresa la base). Redondea a 2 decimales con la regla de
 * `proyectarComisionYNeto` (la mitad, lejos del cero). Lanza si no es un número finito, también con `null` o `undefined`: quien
 * pregunta recibe «No pude leer ese dato», nunca un $0 callado.
 */
export function aCentavosEstricto(valor: Valor): Centavos {
  const d = new Prisma.Decimal(String(valor)) // lanza si no se puede leer ('', 'abc', 'null')
  if (!d.isFinite()) throw new Error('El importe no es un número finito')
  return BigInt(d.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).times(100).toFixed(0))
}

/**
 * Nunca lanza (el panel: un cobro raro no tumba la semana). Lo mismo que `aCentavosEstricto`; `null` o `undefined` cuentan 0 (una
 * propina o un cargo fijo que no vienen). Algo que no es número también cuenta 0, pero avisa (C6 r1): sin el valor, que puede ser
 * un dato del negocio, sólo su tipo.
 */
export function aCentavos(valor: Valor | null | undefined): Centavos {
  if (valor === null || valor === undefined) return 0n
  try {
    return aCentavosEstricto(valor)
  } catch {
    logger.warn('sumaExactaDeDinero: an amount is not a finite number; it counts 0', { type: typeof valor })
    return 0n
  }
}

/** Los centavos de UN cobro, cada uno desde su campo original. La comisión sale de `proyectarComisionYNeto`: una sola fórmula. */
export function centavosDeUnCobro(cobro: {
  amount: Valor
  tipAmount?: Valor | null
  venueChargeAmount: Valor
  venueFixedFee?: Valor | null
}): { gross: Centavos; commission: Centavos; net: Centavos } {
  const gross = aCentavos(cobro.amount) + aCentavos(cobro.tipAmount)
  const commission = aCentavos(proyectarComisionYNeto(0, cobro.venueChargeAmount, cobro.venueFixedFee).fee)
  return { gross, commission, net: gross - commission }
}

export function nuevaSuma(): SumaDeDinero {
  return { gross: 0n, commission: 0n, net: 0n, count: 0 }
}

/** Suma `x` en `a`; sin `count`, cuenta 1. */
export function sumar(a: SumaDeDinero, x: { gross: Centavos; commission: Centavos; net: Centavos; count?: number }): void {
  a.gross += x.gross
  a.commission += x.commission
  a.net += x.net
  a.count += x.count ?? 1
}

/** Centavos → pesos con 2 decimales, para la respuesta (la división es exacta al centavo hasta 2^53 centavos). */
export function aPesos(a: SumaDeDinero): { gross: number; commission: number; net: number; count: number } {
  const pesos = (c: Centavos) => Number(c) / 100
  return { gross: pesos(a.gross), commission: pesos(a.commission), net: pesos(a.net), count: a.count }
}

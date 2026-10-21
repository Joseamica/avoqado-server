// src/services/giftCards/giftCardLimits.ts
/**
 * Topes de tarjetas de regalo (spec 2026-10-14 § 4.3 y § 6; dictamen D6):
 *  - por sobre: entre el mínimo del negocio (≥ $100) y su máximo, que nunca pasa de $10,000;
 *  - por operación: la suma de los sobres de una compra debe quedar ESTRICTAMENTE debajo de min($70,000, 645 × UMA).
 * La UMA vive en una tabla con fecha de inicio; una prueba falla si su último renglón tiene más de 13 meses (cada
 * febrero se agrega la UMA nueva). En producción nunca se apaga la venta por eso: rige la UMA más reciente conocida.
 * Los mensajes NUNCA sugieren partir la compra.
 */
import { Prisma } from '@prisma/client'
import { formatInTimeZone } from 'date-fns-tz'
import { GiftCardError } from './giftCardErrors'

/** UMA diaria en pesos, vigente desde el 1-feb de cada año (INEGI). */
export const UMA_DIARIA: ReadonlyArray<{ desde: string; valor: string }> = [
  { desde: '2025-02-01', valor: '113.14' },
  { desde: '2026-02-01', valor: '117.31' },
]

export const TOPE_LEGAL_POR_OPERACION = new Prisma.Decimal(70000)
const VECES_UMA_POR_OPERACION = 645
export const MINIMO_POR_SOBRE = new Prisma.Decimal(100)
export const MAXIMO_POR_SOBRE = new Prisma.Decimal(10000)
/** Sobres por cuenta de tarjetas: acota la activación y las lecturas (`findMany` con `take`). */
export const MAX_SOBRES_POR_CUENTA = 20

const PESOS = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' })
export function formatoPesos(monto: Prisma.Decimal | number): string {
  return PESOS.format(Number(monto))
}

export function topePorOperacion(fecha: Date): Prisma.Decimal {
  const dia = formatInTimeZone(fecha, 'America/Mexico_City', 'yyyy-MM-dd')
  const vigente = [...UMA_DIARIA].reverse().find(fila => fila.desde <= dia)
  if (!vigente) throw new Error(`La tabla de UMA no cubre la fecha ${dia}`)
  return Prisma.Decimal.min(TOPE_LEGAL_POR_OPERACION, new Prisma.Decimal(vigente.valor).mul(VECES_UMA_POR_OPERACION))
}

export function assertMontoDeSobre(monto: Prisma.Decimal, s: { minAmount: Prisma.Decimal; maxAmount: Prisma.Decimal }): void {
  const minimo = Prisma.Decimal.max(s.minAmount, MINIMO_POR_SOBRE)
  const maximo = Prisma.Decimal.min(s.maxAmount, MAXIMO_POR_SOBRE)
  if (monto.decimalPlaces() > 2 || monto.lessThan(minimo) || monto.greaterThan(maximo)) {
    throw new GiftCardError(
      'GIFT_CARD_AMOUNT_OUT_OF_RANGE',
      `El monto de cada tarjeta de regalo debe estar entre ${formatoPesos(minimo)} y ${formatoPesos(maximo)}.`,
      422,
      { minimo: minimo.toNumber(), maximo: maximo.toNumber() },
    )
  }
}

export function assertTopeDeOperacion(suma: Prisma.Decimal, fecha: Date): void {
  const tope = topePorOperacion(fecha)
  if (!suma.lessThan(tope)) {
    throw new GiftCardError(
      'GIFT_CARD_OPERATION_LIMIT',
      `El total de tarjetas de regalo de una compra debe ser menor a ${formatoPesos(tope)}.`,
      422,
      { tope: tope.toNumber() },
    )
  }
}

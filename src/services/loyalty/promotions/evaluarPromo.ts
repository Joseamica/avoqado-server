import { Prisma } from '@prisma/client'
import { isWithinVenueSchedule } from '@/utils/datetime'

/** Evaluador PURO de promociones de lealtad: sin base de datos ni I/O. Spec §4.3. */

export type LimiteDePromo = 'NONE' | 'ONCE_PER_DAY' | 'ONCE_PER_PROMOTION'

export interface PromoCandidata {
  id: string
  name: string
  createdAt: Date
  startsAt: Date // instante UTC; ya es max(inicio del día, momento de guardar)
  endsAt: Date | null
  endedAt: Date | null
  daysOfWeek: number[]
  timeFrom: string | null
  timeUntil: string | null
  productIds: string[]
  categoryIds: string[]
  categoryNames: string[] // nombres ACTUALES de esas categorías
  minSpend: number | null
  limit: LimiteDePromo
  kind: 'MULTIPLY' | 'ADD'
  multiplier: number | null
  extraStamps: number | null
  extraPoints: number | null
}

export interface VentaParaPromo {
  soldAt: Date
  timezone: string
  amount: number
  /** neto = lo cobrado del renglón tras SUS descuentos; categoryName = el que guardó el renglón al venderse */
  lineas: { productId: string | null; categoryIdActual: string | null; categoryName: string | null; neto: Prisma.Decimal }[]
  /** usos de ESTA clienta; delDia = día del negocio de soldAt */
  usos: Record<string, { delDia: number; total: number }>
}

export interface PromoDecidida {
  promotionId: string
  name: string
  kind: 'MULTIPLY' | 'ADD'
  multiplier: number | null
  extraStamps: number | null
  extraPoints: number | null
  /** amount × Σneto que califica ÷ Σneto total, a centavos; sin filtro = amount */
  montoQueCalifica: Prisma.Decimal
}

const linea = (p: PromoCandidata, l: VentaParaPromo['lineas'][number]) =>
  l.neto.gt(0) &&
  ((l.productId !== null && p.productIds.includes(l.productId)) ||
    (l.categoryIdActual !== null && p.categoryIds.includes(l.categoryIdActual)) ||
    // r2 #4: el producto pudo cambiar de categoría; el nombre guardado en el renglón sigue valiendo
    (l.categoryName !== null && p.categoryNames.includes(l.categoryName)))

/** Devuelve el monto que califica, o null si la promo no aplica a esta venta. */
function evaluar(p: PromoCandidata, v: VentaParaPromo): Prisma.Decimal | null {
  const t = v.soldAt.getTime()
  if (t < p.startsAt.getTime()) return null
  if (p.endsAt && t > p.endsAt.getTime()) return null
  if (p.endedAt && t >= p.endedAt.getTime()) return null
  if (!isWithinVenueSchedule({ daysOfWeek: p.daysOfWeek, timeFrom: p.timeFrom, timeUntil: p.timeUntil }, v.soldAt, v.timezone)) return null
  if (p.minSpend !== null && v.amount < p.minSpend) return null
  const uso = v.usos[p.id]
  if (p.limit === 'ONCE_PER_DAY' && uso && uso.delDia >= 1) return null
  if (p.limit === 'ONCE_PER_PROMOTION' && uso && uso.total >= 1) return null

  const amount = new Prisma.Decimal(v.amount)
  const centavos = (n: Prisma.Decimal) => n.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
  if (p.productIds.length === 0 && p.categoryIds.length === 0) return centavos(amount)

  const califican = v.lineas.filter(l => linea(p, l))
  if (califican.length === 0) return null
  const sum = (ls: typeof v.lineas) => ls.reduce((a, l) => a.plus(l.neto), new Prisma.Decimal(0))
  const total = sum(v.lineas)
  if (total.lte(0)) return null
  // multiplica antes de dividir; nunca más que el amount
  const monto = centavos(amount.times(sum(califican)).dividedBy(total))
  return monto.gt(amount) ? centavos(amount) : monto
}

export function evaluarPromo(promos: PromoCandidata[], venta: VentaParaPromo): PromoDecidida | null {
  let mejor: { p: PromoCandidata; monto: Prisma.Decimal } | null = null
  for (const p of promos) {
    const monto = evaluar(p, venta)
    if (!monto) continue
    const dt = mejor ? p.createdAt.getTime() - mejor.p.createdAt.getTime() : 1
    // empate de createdAt: id mayor, para no depender del orden de entrada
    if (dt > 0 || (dt === 0 && p.id > mejor!.p.id)) mejor = { p, monto }
  }
  if (!mejor) return null
  const { p, monto } = mejor
  return {
    promotionId: p.id,
    name: p.name,
    kind: p.kind,
    multiplier: p.multiplier,
    extraStamps: p.extraStamps,
    extraPoints: p.extraPoints,
    montoQueCalifica: monto,
  }
}

export function sellosConPromo(d: PromoDecidida | null): number {
  if (!d) return 1
  return d.kind === 'MULTIPLY' ? (d.multiplier ?? 1) : 1 + (d.extraStamps ?? 0)
}

export function puntosConPromo(
  base: { total: number; bono: number; pointsPerDollar: number },
  d: PromoDecidida | null,
): { total: number; bonusPoints: number; visitBonusPoints: number } {
  if (!d) return { total: base.total, bonusPoints: 0, visitBonusPoints: base.bono }
  if (d.kind === 'ADD') {
    const extra = d.extraPoints ?? 0
    return { total: base.total + extra, bonusPoints: extra, visitBonusPoints: base.bono + extra }
  }
  const mult = new Prisma.Decimal(d.multiplier ?? 1)
  // floor de lo que califica (puntos normales = floor(monto × ppd) + bono), luego × (mult − 1); Decimal hasta ese floor (r2 #2)
  const bonusPoints = d.montoQueCalifica.times(base.pointsPerDollar).floor().plus(base.bono).times(mult.minus(1)).floor().toNumber()
  return {
    total: base.total + bonusPoints,
    bonusPoints,
    visitBonusPoints: new Prisma.Decimal(base.bono).times(mult).floor().toNumber(),
  }
}

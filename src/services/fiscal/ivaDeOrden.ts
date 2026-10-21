import { Prisma } from '@prisma/client'
import { BadRequestError } from '../../errors/AppError'
import { aCentavos, aportacionCents, leerReparto } from '../shared/repartoDescuento'
import { hayBloqueados, resolverTratamiento } from './ivaDeRenglon'
import { grossByRateFromItems, repartirProporcional } from './ivaMath'
import { tuplaDesdeTratamiento, type IvaTratamiento } from './ivaTratamiento'

type Importe = number | { toString(): string }
export type RenglonParaIva = {
  id?: string
  quantity: number
  unitPrice: Importe
  total?: Importe
  discountAmount: Importe
  isCortesia?: boolean | null
  orderPromotionId?: string | null
  ivaTratamiento?: IvaTratamiento | null
  product: { taxRate: Importe | null; ivaTratamiento?: IvaTratamiento } | null
}
export type OrdenParaIva = {
  items?: RenglonParaIva[]
  total?: Importe
  discountAmount?: Importe
  orderDiscounts?: { amount: Importe; reparto: unknown }[]
  serviceCharges?: { amount: Importe; taxable: boolean }[]
}

// Se lee uno extra para detectar el límite; nunca calcular una póliza con una orden recortada.
const MAX_COMPONENTES = 1000
export const ordenParaIvaSelect = {
  total: true,
  discountAmount: true,
  items: {
    take: MAX_COMPONENTES + 1,
    orderBy: { id: 'asc' },
    select: {
      id: true,
      quantity: true,
      unitPrice: true,
      total: true,
      discountAmount: true,
      isCortesia: true,
      orderPromotionId: true,
      ivaTratamiento: true,
      product: { select: { taxRate: true, ivaTratamiento: true } },
    },
  },
  orderDiscounts: { take: MAX_COMPONENTES + 1, orderBy: { id: 'asc' }, select: { amount: true, reparto: true } },
  serviceCharges: { take: MAX_COMPONENTES + 1, orderBy: { id: 'asc' }, select: { amount: true, taxable: true } },
} as const satisfies Prisma.OrderSelect

/**
 * La tasa de UN renglón, como la lee la póliza: sello > tratamiento del producto > IVA_16; un BLOQUEADO conserva la tasa de su
 * producto. La comparten la mezcla de la cuenta y la base «sin IVA» de la comisión por categorías (fase 3 de Pago al personal).
 */
export function tasaDelRenglon(it: Pick<RenglonParaIva, 'ivaTratamiento' | 'product'>): number {
  const tratamiento = resolverTratamiento({
    selladoIva: it.ivaTratamiento,
    productoIva: it.product?.ivaTratamiento,
    tieneProducto: it.product != null,
  })
  return hayBloqueados([tratamiento]) ? Number(it.product?.taxRate ?? 0.16) : tuplaDesdeTratamiento(tratamiento, 0).taxRate
}

/**
 * Mezcla monetaria de la cuenta para repartir un cobro (pólizas y comisión sin IVA).
 * `total` conserva extras, peso y precio aplicado; B2 aporta el neto propio y su reparto dirigido.
 * La tasa sigue al CFDI: sello > tratamiento del producto > IVA_16. Esto NO construye conceptos SAT.
 */
export function grossByRateFromOrder(order: OrdenParaIva | null | undefined): { rate: number; grossCents: number }[] {
  const items = order?.items ?? []
  const discounts = order?.orderDiscounts ?? []
  const charges = order?.serviceCharges ?? []
  if ([items, discounts, charges].some(rows => rows.length > MAX_COMPONENTES)) {
    throw new BadRequestError('La orden excede 1000 componentes fiscales; no se calculó IVA con datos parciales.')
  }
  const rows = items
    .map((it, index) => {
      // Compatibilidad con llamadores antiguos sin total. Las lecturas de cobros siempre traen total e id.
      const total = it.total ?? new Prisma.Decimal(String(it.unitPrice)).mul(it.quantity)
      const id = it.id ?? String(index)
      const rate = tasaDelRenglon(it)
      return {
        id,
        rate,
        grossCents: aportacionCents({
          id,
          total,
          discountAmount: it.discountAmount,
          isCortesia: it.isCortesia,
          orderPromotionId: it.orderPromotionId,
        }),
        // Una cortesía móvil (total=0) y una promoción ya están netas en la cabecera.
        propio: aCentavos(total) === 0 || (!it.isCortesia && it.orderPromotionId) ? 0 : Math.max(0, aCentavos(it.discountAmount)),
      }
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const porId = new Map(rows.map(row => [row.id, row]))
  let conocido = 0
  for (const discount of discounts) {
    const reparto = leerReparto(discount.reparto)
    if (!reparto) {
      if (discount.reparto != null) throw new BadRequestError('Reparto de descuento inválido; no se puede determinar el IVA del cobro.')
      continue // Histórico sin constancia: sólo su remanente se reparte proporcionalmente.
    }
    if (reparto.espejo) continue // Ya restado como descuento propio del renglón.
    const aplicado = Object.values(reparto.renglones).reduce((s, c) => s + c, 0)
    if (aplicado > aCentavos(discount.amount)) throw new BadRequestError('El reparto excede el descuento registrado.')
    for (const [id, cents] of Object.entries(reparto.renglones)) {
      const row = porId.get(id)
      if (!row || cents > row.grossCents) throw new BadRequestError('El reparto no cabe en sus renglones; no se redistribuyó entre tasas.')
      row.grossCents -= cents
    }
    conocido += aplicado
  }
  const propio = rows.reduce((sum, row) => sum + row.propio, 0)
  const disponible = rows.reduce((sum, row) => sum + row.grossCents, 0)
  const restante = Math.min(disponible, Math.max(0, aCentavos(order?.discountAmount) - propio - conocido))
  const partes = repartirProporcional(
    restante,
    rows.map(row => row.grossCents),
  )
  const mix = grossByRateFromItems(
    rows.map((row, i) => ({
      unitPrice: (row.grossCents - partes[i]) / 100,
      quantity: 1,
      discountAmount: 0,
      taxRate: row.rate,
    })),
  ).sort((a, b) => a.rate - b.rate)
  const agregar = (rate: number, cents: number) => {
    if (cents <= 0) return
    const group = mix.find(g => g.rate === rate)
    if (group) group.grossCents += cents
    else mix.push({ rate, grossCents: cents })
  }
  const noGravable = charges.filter(c => !c.taxable).reduce((sum, c) => sum + Math.max(0, aCentavos(c.amount)), 0)
  const gravable = charges.filter(c => c.taxable).reduce((sum, c) => sum + Math.max(0, aCentavos(c.amount)), 0)
  // Importe libre: la cabecera conserva la venta aunque no existan renglones. Un cargo sin IVA no
  // puede absorber también esa venta; ésta mantiene el 16 % de los cobros libres anteriores.
  if (items.length === 0 && charges.length > 0) agregar(0.16, aCentavos(order?.total) - gravable - noGravable)
  // El cargo gravable sigue la mezcla NETA de mercancía. Sin mercancía cobrada, la regla explícita es 16 %.
  const cargo = repartirProporcional(
    gravable,
    mix.map(g => g.grossCents),
  )
  if (mix.length === 0) agregar(0.16, gravable)
  else
    mix.forEach((g, i) => {
      g.grossCents += cargo[i]
    })
  agregar(0, noGravable)
  return mix.sort((a, b) => a.rate - b.rate)
}

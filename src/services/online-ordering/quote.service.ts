// src/services/online-ordering/quote.service.ts
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { MAX_CART_LINES, MAX_LINE_QUANTITY, NOTE_MAX_LENGTH } from './constants'
import {
  exceedsQueryLimits,
  isUnsatisfiable,
  loadCategoryVisibility,
  ONLINE_PRODUCT_SELECT,
  ONLINE_PRODUCT_WHERE,
  toVisibleProduct,
  type CategorySchedule,
  type VisibleGroup,
  type VisibleModifier,
  type VisibleProduct,
} from './menu.service'
import { getSettings } from './settings.service'

export interface CartModifierInput {
  modifierId: string
  quantity?: number
}
export interface CartItemInput {
  productId: string
  quantity: number
  modifiers?: CartModifierInput[]
  note?: string | null
}
export interface PricedModifier {
  modifierId: string
  name: string
  /** Cuántos de este extra por UNA unidad del platillo. */
  quantity: number
  /** Precio por unidad del extra (F2: así se guarda, como la terminal). */
  unitPrice: Prisma.Decimal
}
export interface PricedLine {
  productId: string
  productName: string
  productSku: string | null
  categoryName: string
  quantity: number
  unitPrice: Prisma.Decimal
  modifiers: PricedModifier[]
  note: string | null
  lineTotal: Prisma.Decimal
}
export type QuoteIssueCode =
  | 'EMPTY_CART'
  | 'TOO_MANY_LINES'
  | 'QUANTITY_INVALID'
  | 'PRODUCT_UNAVAILABLE'
  | 'MODIFIER_INVALID'
  | 'MODIFIER_GROUP_REQUIRED'
  | 'MODIFIER_GROUP_SINGLE'
  | 'MODIFIER_GROUP_MAX'
  | 'BELOW_MINIMUM'
export interface QuoteIssue {
  code: QuoteIssueCode
  productId?: string
  groupId?: string
  /** M-5: índice (desde 0) del renglón del carrito; el mismo platillo puede ir dos veces. Falta en los avisos del carrito entero. */
  lineIndex?: number
  message: string
}
export interface QuoteResult {
  ok: boolean
  lines: PricedLine[]
  subtotal: Prisma.Decimal
  total: Prisma.Decimal
  minOrderAmount: Prisma.Decimal
  issues: QuoteIssue[]
}

const ZERO = new Prisma.Decimal(0)

/**
 * R17: el cotizador NO usa la carta recortada. Consulta directo los productos del carrito (≤ MAX_CART_LINES distintos) con
 * TODOS sus grupos y opciones, con las mismas reglas de la carta (`ONLINE_PRODUCT_WHERE`, categoría activa, horario propio de
 * la categoría y menú vigente, H4). Un producto que no cupo completo en la consulta no se cotiza: su renglón sale como no
 * disponible. Tampoco pasa por el caché de 60 s de `getPublicMenu`: un precio o una disponibilidad deben estar vigentes al
 * cotizar dinero.
 */
async function loadQuotableProducts(venueId: string, ids: string[], now: Date): Promise<Map<string, VisibleProduct>> {
  const out = new Map<string, VisibleProduct>()
  if (ids.length === 0) return out
  const rows = await prisma.product.findMany({
    where: { venueId, id: { in: ids }, ...ONLINE_PRODUCT_WHERE, category: { active: true } },
    take: MAX_CART_LINES,
    select: ONLINE_PRODUCT_SELECT,
  })
  if (rows.length === 0) return out
  // H4: sólo las categorías de lo pedido, cada una con su horario propio; sus menús se leen sólo para ellas.
  const categories = new Map<string, CategorySchedule>()
  for (const r of rows) {
    categories.set(r.categoryId, {
      id: r.categoryId,
      availableFrom: r.category.availableFrom,
      availableUntil: r.category.availableUntil,
      availableDays: r.category.availableDays,
    })
  }
  const isVisibleNow = await loadCategoryVisibility(venueId, now, [...categories.values()])
  for (const row of rows) {
    // M-4: lo que la carta no ofrece por imposible tampoco se cotiza.
    if (isVisibleNow(row.categoryId) && !exceedsQueryLimits(row) && !isUnsatisfiable(row)) out.set(row.id, toVisibleProduct(row))
  }
  return out
}

/**
 * ÚNICA fuente de verdad de precios para la tienda en línea. Recalcula todo contra los productos VIGENTES del servidor:
 * nunca confía en un total que mande el navegador. Precios con IVA incluido (`contratoDePrecio: IVA_INCLUIDO`).
 */
export async function quoteCart(venueId: string, items: CartItemInput[], opts: { now?: Date } = {}): Promise<QuoteResult> {
  const issues: QuoteIssue[] = []
  const lines: PricedLine[] = []
  const now = opts.now ?? new Date()

  if (items.length === 0) issues.push({ code: 'EMPTY_CART', message: 'Tu carrito está vacío.' })
  if (items.length > MAX_CART_LINES) {
    issues.push({ code: 'TOO_MANY_LINES', message: `Máximo ${MAX_CART_LINES} renglones por pedido.` })
  }
  const cart = items.slice(0, MAX_CART_LINES)

  const [products, settings] = await Promise.all([
    loadQuotableProducts(venueId, [...new Set(cart.map(i => i.productId))], now),
    getSettings(venueId),
  ])

  for (const [lineIndex, item] of cart.entries()) {
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > MAX_LINE_QUANTITY) {
      issues.push({
        code: 'QUANTITY_INVALID',
        productId: item.productId,
        lineIndex,
        message: `La cantidad debe ser un entero entre 1 y ${MAX_LINE_QUANTITY}.`,
      })
      continue
    }
    const product = products.get(item.productId)
    if (!product) {
      issues.push({
        code: 'PRODUCT_UNAVAILABLE',
        productId: item.productId,
        lineIndex,
        message: 'Un platillo de tu pedido ya no está disponible.',
      })
      continue
    }

    const index = new Map<string, { group: VisibleGroup; modifier: VisibleModifier }>()
    for (const g of product.groups) for (const m of g.modifiers) index.set(m.id, { group: g, modifier: m })

    const picked: PricedModifier[] = []
    const perGroupQty = new Map<string, number>()
    const perGroupDistinct = new Map<string, number>()
    let broken = false

    for (const sel of item.modifiers ?? []) {
      const qty = sel.quantity ?? 1
      const hit = index.get(sel.modifierId)
      if (!hit || !Number.isInteger(qty) || qty < 1 || qty > MAX_LINE_QUANTITY) {
        issues.push({ code: 'MODIFIER_INVALID', productId: item.productId, lineIndex, message: 'Una opción de tu pedido ya no es válida.' })
        broken = true
        continue
      }
      picked.push({ modifierId: hit.modifier.id, name: hit.modifier.name, quantity: qty, unitPrice: hit.modifier.price })
      perGroupQty.set(hit.group.id, (perGroupQty.get(hit.group.id) ?? 0) + qty)
      perGroupDistinct.set(hit.group.id, (perGroupDistinct.get(hit.group.id) ?? 0) + 1)
    }

    for (const g of product.groups) {
      const chosen = perGroupQty.get(g.id) ?? 0
      const min = g.required ? Math.max(1, g.minSelections) : g.minSelections
      if (chosen < min) {
        issues.push({
          code: 'MODIFIER_GROUP_REQUIRED',
          productId: item.productId,
          groupId: g.id,
          lineIndex,
          message: min > 1 ? `En «${g.name}» elige al menos ${min} opciones.` : `Elige una opción de «${g.name}».`,
        })
        broken = true
      }
      if (!g.allowMultiple && ((perGroupDistinct.get(g.id) ?? 0) > 1 || chosen > 1)) {
        issues.push({
          code: 'MODIFIER_GROUP_SINGLE',
          productId: item.productId,
          groupId: g.id,
          lineIndex,
          message: `En «${g.name}» sólo puedes elegir una opción.`,
        })
        broken = true
      }
      if (g.maxSelections !== null && chosen > g.maxSelections) {
        issues.push({
          code: 'MODIFIER_GROUP_MAX',
          productId: item.productId,
          groupId: g.id,
          lineIndex,
          message: `En «${g.name}» puedes elegir hasta ${g.maxSelections}.`,
        })
        broken = true
      }
    }
    if (broken) continue

    // F2: el precio del extra es POR UNIDAD (como la terminal); cada unidad del platillo lleva todos sus extras.
    const modsPerUnit = picked.reduce((s, m) => s.plus(m.unitPrice.mul(m.quantity)), ZERO)
    const lineTotal = product.price.plus(modsPerUnit).mul(item.quantity)
    lines.push({
      productId: product.id,
      productName: product.name,
      productSku: product.sku,
      categoryName: product.categoryName,
      quantity: item.quantity,
      unitPrice: product.price,
      modifiers: picked,
      note: item.note?.trim().slice(0, NOTE_MAX_LENGTH) || null,
      lineTotal,
    })
  }

  const subtotal = lines.reduce((s, l) => s.plus(l.lineTotal), ZERO)
  const minOrderAmount = new Prisma.Decimal(settings.minOrderAmount ?? 0)
  if (lines.length > 0 && minOrderAmount.gt(0) && subtotal.lt(minOrderAmount)) {
    issues.push({ code: 'BELOW_MINIMUM', message: `El pedido mínimo es de $${minOrderAmount.toFixed(2)}.` })
  }

  return { ok: issues.length === 0 && lines.length > 0, lines, subtotal, total: subtotal, minOrderAmount, issues }
}

export interface PublicQuote {
  ok: boolean
  lines: Array<{
    productId: string
    name: string
    quantity: number
    unitPrice: number
    modifiers: Array<{ modifierId: string; name: string; quantity: number; price: number }>
    note: string | null
    lineTotal: number
  }>
  subtotal: number
  total: number
  minOrderAmount: number
  issues: QuoteIssue[]
}

const n = (d: Prisma.Decimal): number => Number(d.toFixed(2))

export function toPublicQuote(q: QuoteResult): PublicQuote {
  return {
    ok: q.ok,
    lines: q.lines.map(l => ({
      productId: l.productId,
      name: l.productName,
      quantity: l.quantity,
      unitPrice: n(l.unitPrice),
      modifiers: l.modifiers.map(m => ({ modifierId: m.modifierId, name: m.name, quantity: m.quantity, price: n(m.unitPrice) })),
      note: l.note,
      lineTotal: n(l.lineTotal),
    })),
    subtotal: n(q.subtotal),
    total: n(q.total),
    minOrderAmount: n(q.minOrderAmount),
    issues: q.issues,
  }
}

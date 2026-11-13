/**
 * Apartado de 15 minutos por talla (liga por prenda, Task 3). Prisma simulado con una tabla en memoria: lo que se prueba es la
 * regla (disponible = existencia − fichas ACTIVE vigentes de OTROS navegadores), no la forma de la consulta. La concurrencia real
 * (candados) vive en `tests/integration/dashboard/paymentLinkStockHold.integration.test.ts`.
 */
import prisma from '@/utils/prismaClient'
import { ConflictError } from '@/errors/AppError'
import {
  attachIntent,
  consumeHoldInTx,
  freezeIntentParams,
  HOLD_TTL_MS,
  releaseHold,
  takeOrReuseHold,
  variantAvailability,
} from '@/services/dashboard/paymentLinkStockHold.service'

const db = prisma as any
const NOW = new Date('2026-11-12T18:00:00Z')
const VENUE = 'cvenue000000000000000000a'
const LINK = 'clink0000000000000000000a'
const GROUP = 'cgroup00000000000000000a'

type Row = Record<string, any>
let products: Row[]
let inventory: Row[]
let holds: Row[]
let seq = 0

/** Evaluador mínimo de `where` de Prisma: igualdad, in, gt, not, equals (nulo), NOT y OR. */
function match(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, c]) => {
    if (k === 'NOT') return !match(row, c)
    if (k === 'OR') return (c as Row[]).some(w => match(row, w))
    const v = row[k]
    if (c && typeof c === 'object' && !(c instanceof Date)) {
      if ('in' in c) return c.in.includes(v)
      if ('gt' in c) return v > c.gt
      if ('equals' in c) return v == null
      if ('not' in c) return v !== c.not
    }
    return v === c
  })
}

function hold(over: Row): Row {
  const h = {
    id: `chold${++seq}`,
    venueId: VENUE,
    paymentLinkId: LINK,
    quantity: 1,
    browserToken: 'otro',
    stripePaymentIntentId: null,
    amountCents: 50000,
    stripeAccountId: null,
    intentParams: null,
    checkoutSnapshot: null,
    status: 'ACTIVE',
    expiresAt: new Date(NOW.getTime() + 60_000),
    releasedReason: null,
    ...over,
  }
  holds.push(h)
  return h
}

function talla(id: string, stock: number | null, over: Row = {}) {
  products.push({
    id,
    venueId: VENUE,
    productGroupId: GROUP,
    deletedAt: null,
    trackInventory: true,
    inventoryMethod: 'QUANTITY',
    recipe: null,
    ...over,
  })
  if (stock !== null) inventory.push({ productId: id, venueId: VENUE, currentStock: stock })
}

beforeEach(() => {
  products = []
  inventory = []
  holds = []
  db.$transaction = jest.fn((fn: any) => fn(db))
  db.$executeRaw = jest.fn().mockResolvedValue(1)
  db.product.findMany = jest.fn(async ({ where, take }: Row) => products.filter(p => match(p, where)).slice(0, take ?? Infinity))
  db.inventory.findMany = jest.fn(async ({ where }: Row) => inventory.filter(i => match(i, where)))
  db.paymentLinkStockHold = {
    groupBy: jest.fn(async ({ where }: Row) => {
      const sums = new Map<string, number>()
      for (const h of holds.filter(h => match(h, where))) sums.set(h.productId, (sums.get(h.productId) ?? 0) + h.quantity)
      return [...sums].map(([productId, q]) => ({ productId, _sum: { quantity: q } }))
    }),
    findMany: jest.fn(async ({ where }: Row) => holds.filter(h => match(h, where))),
    findUniqueOrThrow: jest.fn(async ({ where }: Row) => holds.find(h => h.id === where.id)),
    create: jest.fn(async ({ data }: Row) => hold({ stripePaymentIntentId: null, ...data })),
    updateMany: jest.fn(async ({ where, data }: Row) => {
      const hit = holds.filter(h => match(h, where))
      hit.forEach(h => Object.assign(h, data))
      return { count: hit.length }
    }),
    updateManyAndReturn: jest.fn(async ({ where, data }: Row) => {
      const hit = holds.filter(h => match(h, where))
      hit.forEach(h => Object.assign(h, data))
      return hit
    }),
  }
})

const disp = (browserToken?: string) =>
  variantAvailability({ paymentLinkId: LINK, productGroupId: GROUP, venueId: VENUE, browserToken, now: NOW })
const tomar = (productId: string, browserToken = 'yo', amountCents = 50000) =>
  takeOrReuseHold({ paymentLinkId: LINK, venueId: VENUE, productId, browserToken, amountCents, now: NOW })
const de = <T extends { productId: string }>(r: T[], id: string) => r.find(x => x.productId === id)

describe('variantAvailability', () => {
  it('disponible = existencia − fichas vigentes', async () => {
    talla('cm', 2)
    talla('cl', 1)
    hold({ productId: 'cm' })
    hold({ productId: 'cl' })
    const r = await disp()
    expect(de(r, 'cm')).toEqual({ productId: 'cm', available: true, heldByYou: false, heldUntil: null })
    expect(de(r, 'cl')).toMatchObject({ available: false })
  })

  it('ficha vencida no resta', async () => {
    talla('cm', 1)
    hold({ productId: 'cm', expiresAt: new Date(NOW.getTime() - 1) })
    expect(de(await disp(), 'cm')!.available).toBe(true)
  })

  it('ficha CONSUMED o RELEASED no resta', async () => {
    talla('cm', 1)
    hold({ productId: 'cm', status: 'CONSUMED' })
    hold({ productId: 'cm', status: 'RELEASED' })
    expect(de(await disp(), 'cm')!.available).toBe(true)
  })

  it('las fichas del propio token no restan y salen heldByYou', async () => {
    talla('cm', 1)
    const mia = hold({ productId: 'cm', browserToken: 'yo' })
    expect(de(await disp('yo'), 'cm')).toEqual({ productId: 'cm', available: true, heldByYou: true, heldUntil: mia.expiresAt })
    // Para otro navegador, esa misma pieza está apartada.
    expect(de(await disp('tu'), 'cm')).toMatchObject({ available: false, heldByYou: false, heldUntil: null })
  })

  it('talla sin seguimiento siempre disponible (sin fila, trackInventory=false o método ≠ QUANTITY)', async () => {
    talla('csinfila', null)
    talla('cnotrack', 0, { trackInventory: false })
    talla('creceta', 0, { inventoryMethod: 'RECIPE' })
    for (const id of ['csinfila', 'cnotrack', 'creceta']) hold({ productId: id })
    const r = await disp()
    for (const id of ['csinfila', 'cnotrack', 'creceta']) expect(de(r, id)!.available).toBe(true)
  })

  it('una sola consulta agrupada de fichas y la familia acotada', async () => {
    for (let i = 0; i < 5; i++) talla(`c${i}`, 1)
    await disp('yo')
    expect(db.paymentLinkStockHold.groupBy).toHaveBeenCalledTimes(1)
    expect(db.product.findMany.mock.calls[0][0].take).toBeLessThanOrEqual(250)
  })
})

describe('takeOrReuseHold', () => {
  it('crea la ficha con 15 minutos y toma el candado del navegador ANTES que el del producto', async () => {
    talla('cm', 1)
    const r = await tomar('cm')
    expect(r.reused).toBe(false)
    expect(r.released).toEqual([])
    expect(r.hold).toMatchObject({ productId: 'cm', browserToken: 'yo', status: 'ACTIVE', amountCents: 50000, quantity: 1 })
    expect(r.hold.expiresAt.getTime()).toBe(NOW.getTime() + HOLD_TTL_MS)
    const llaves = db.$executeRaw.mock.calls.map((c: any[]) => c.slice(1).join('|'))
    expect(llaves).toEqual([`pl-hold-token:${LINK}:yo`, 'pl-hold:cm'])
  })

  it('reusar devuelve la misma ficha', async () => {
    talla('cm', 1)
    const a = await tomar('cm')
    const b = await tomar('cm')
    expect(b).toEqual({ hold: a.hold, reused: true, released: [] })
    expect(holds.filter(h => h.status === 'ACTIVE')).toHaveLength(1)
  })

  it('reusa también la ficha que todavía no congela importe', async () => {
    talla('cm', 1)
    const vieja = hold({ productId: 'cm', browserToken: 'yo', amountCents: null })
    const r = await tomar('cm')
    expect(r.reused).toBe(true)
    expect(r.hold.id).toBe(vieja.id)
  })

  it('cambiar de talla suelta la anterior y devuelve su intento', async () => {
    talla('cm', 1)
    talla('cl', 1)
    const m = hold({ productId: 'cm', browserToken: 'yo', stripePaymentIntentId: 'pi_m', stripeAccountId: 'acct_1' })
    const r = await tomar('cl')
    expect(r.reused).toBe(false)
    expect(r.hold.productId).toBe('cl')
    expect(r.released).toEqual([{ holdId: m.id, stripePaymentIntentId: 'pi_m', stripeAccountId: 'acct_1' }])
    expect(m).toMatchObject({ status: 'RELEASED', releasedReason: 'cambio_de_compra' })
  })

  it('misma talla con otro importe (propina) = ficha nueva y suelta la vieja', async () => {
    talla('cm', 1)
    const vieja = hold({ productId: 'cm', browserToken: 'yo', stripePaymentIntentId: 'pi_viejo' })
    const r = await tomar('cm', 'yo', 55000)
    expect(r.reused).toBe(false)
    expect(r.hold.id).not.toBe(vieja.id)
    expect(r.released.map(x => x.stripePaymentIntentId)).toEqual(['pi_viejo'])
  })

  it('sin existencia → 409 PAYMENT_LINK_VARIANT_SOLD_OUT', async () => {
    talla('cm', 1)
    hold({ productId: 'cm', browserToken: 'otra' })
    const e = await tomar('cm').catch(x => x)
    expect(e).toBeInstanceOf(ConflictError)
    expect(e).toMatchObject({ statusCode: 409, code: 'PAYMENT_LINK_VARIANT_SOLD_OUT', message: 'Esa talla se agotó' })
    expect(holds.filter(h => h.browserToken === 'yo')).toHaveLength(0)
  })

  it('talla sin seguimiento: sí crea ficha aunque no haya existencia', async () => {
    talla('cnotrack', 0, { trackInventory: false })
    hold({ productId: 'cnotrack', browserToken: 'otra' })
    const r = await tomar('cnotrack')
    expect(r.hold.id).toBeTruthy()
  })

  it('producto de otro negocio → no aparta', async () => {
    talla('cajeno', 5, { venueId: 'cotrovenue00000000000000a' })
    await expect(tomar('cajeno')).rejects.toMatchObject({ statusCode: 404 })
    expect(holds).toHaveLength(0)
  })
})

describe('congelar, ligar, soltar y consumir (CAS)', () => {
  const params = { amountCents: 50000, stripeAccountId: 'acct_1', intentParams: { amount: 50000 }, checkoutSnapshot: { amount: 500 } }

  it('freezeIntentParams congela una sola vez', async () => {
    const h = hold({ productId: 'cm' })
    expect(await freezeIntentParams(h.id, params)).toMatchObject({ intentParams: { amount: 50000 }, stripeAccountId: 'acct_1' })
    const otra = await freezeIntentParams(h.id, { ...params, amountCents: 1, intentParams: { amount: 1 } })
    expect(otra).toMatchObject({ amountCents: 50000, intentParams: { amount: 50000 } })
  })

  it('attachIntent liga una vez; el mismo intento otra vez pasa; otro intento falla', async () => {
    const h = hold({ productId: 'cm' })
    await attachIntent(h.id, 'pi_1')
    await attachIntent(h.id, 'pi_1')
    expect(h.stripePaymentIntentId).toBe('pi_1')
    await expect(attachIntent(h.id, 'pi_2')).rejects.toMatchObject({ statusCode: 409 })
    expect(h.stripePaymentIntentId).toBe('pi_1')
  })

  it('releaseHold sólo suelta una ficha ACTIVE', async () => {
    const viva = hold({ productId: 'cm' })
    const usada = hold({ productId: 'cm', status: 'CONSUMED' })
    await releaseHold(viva.id, 'vencida')
    await releaseHold(usada.id, 'vencida')
    expect(viva).toMatchObject({ status: 'RELEASED', releasedReason: 'vencida' })
    expect(usada.status).toBe('CONSUMED')
  })

  it('consumeHoldInTx pasa ACTIVE → CONSUMED por intento y cuenta', async () => {
    hold({ productId: 'cm', stripePaymentIntentId: 'pi_1' })
    hold({ productId: 'cm', stripePaymentIntentId: 'pi_1', status: 'RELEASED' })
    expect(await consumeHoldInTx(db, 'pi_1')).toBe(1)
    expect(await consumeHoldInTx(db, 'pi_1')).toBe(0)
  })
})

jest.mock('@/services/launchCampaigns/hybridListPrice.service', () => ({ listPriceBoard: jest.fn() }))
import prisma from '@/utils/prismaClient'
import { listPriceBoard } from '@/services/launchCampaigns/hybridListPrice.service'
import {
  getPublicPriceList,
  priceSelection,
  type PublicPriceList,
} from '@/services/launchCampaigns/publicPriceList.service'

const db = prisma as any
const board = listPriceBoard as jest.Mock

// Precios de la foto del SUPERADMIN del 26-oct (pesos, IVA incluido).
const PRICES: Record<string, number> = {
  INVENTORY_TRACKING: 399,
  AUTO_REORDER: 99,
  LOYALTY_PROGRAM: 349,
  RESERVATIONS: 449,
  ADVANCED_REPORTS: 99,
  AGGREGATOR_PASSES: 199,
  TABLE_SERVICE: 99,
  ONLINE_ORDERING: 199,
  CFDI: 229,
}
const PRO = ['LOYALTY_PROGRAM', 'RESERVATIONS', 'ADVANCED_REPORTS', 'AGGREGATOR_PASSES', 'TABLE_SERVICE', 'ONLINE_ORDERING']
const PREMIUM = [...PRO, 'INVENTORY_TRACKING', 'AUTO_REORDER', 'CFDI']

function row(productKey: string, price: number | null, status: 'ACTIVE' | 'PAUSED' | null = 'ACTIVE') {
  return { productKey, price, status, campaignId: 'camp_x', revision: 3, pendingPrice: null, activeGroups: [{ id: 'g', name: 'g', revision: 1 }] }
}

function setup(opts: { premiumStatus?: 'ACTIVE' | 'PAUSED'; proComposition?: string[] } = {}) {
  board.mockResolvedValue([
    ...Object.entries(PRICES).map(([code, price]) => row(`FEATURE:${code}`, price)),
    row('FEATURE:UPSELL', 99, 'PAUSED'),
    row('FEATURE:GIFT_CARDS', null, null),
    row('PLAN:PRO', 1158.84),
    row('PLAN:PREMIUM', 1970.84, opts.premiumStatus ?? 'ACTIVE'),
  ])
  db.hybridCampaign = {
    findMany: jest.fn(async () => [
      { listProductKey: 'PLAN:PRO', currentPublicationId: 'pub_pro' },
      { listProductKey: 'PLAN:PREMIUM', currentPublicationId: 'pub_premium' },
    ]),
  }
  db.hybridOfferPublication = {
    findMany: jest.fn(async () => [
      { id: 'pub_pro', includedFeatureCodes: opts.proComposition ?? PRO },
      { id: 'pub_premium', includedFeatureCodes: PREMIUM },
    ]),
  }
}

const byId = (list: PublicPriceList, id: string) => list.features.find(f => f.id === id)

describe('getPublicPriceList', () => {
  beforeEach(() => setup())

  it('clasifica las funciones base sin código como INCLUIDO, no como SE_COTIZA', async () => {
    const list = await getPublicPriceList()
    for (const id of ['BASE_POS', 'BASE_MENUORDERS', 'BASE_INVENTORYBASIC', 'BASE_DAILYREPORTS'])
      expect(byId(list, id)).toMatchObject({ kind: 'INCLUIDO', price: null })
    expect(list.features.filter(f => f.kind === 'SE_COTIZA').length).toBeGreaterThan(0)
    expect(list.features.filter(f => f.kind === 'SE_COTIZA').every(f => f.price === null)).toBe(true)
  })

  it('omite la función pausada y la que no tiene precio', async () => {
    const list = await getPublicPriceList()
    expect(byId(list, 'UPSELL')).toBeUndefined()
    expect(byId(list, 'GIFT_CARDS')).toBeUndefined()
    expect(byId(list, 'CFDI')).toMatchObject({ kind: 'SUELTA', price: 229, categoryLabel: 'Dinero y reportes' })
  })

  it('no expone datos internos del tablero', async () => {
    expect(JSON.stringify(await getPublicPriceList())).not.toMatch(/campaignId|revision|pendingPrice|activeGroups|stripe|pub_/i)
  })

  it('si el requisito pagado está pausado, la función que lo necesita tampoco se ofrece', async () => {
    board.mockResolvedValue([row('FEATURE:INVENTORY_TRACKING', 399, 'PAUSED'), row('FEATURE:AUTO_REORDER', 99), row('PLAN:PRO', 1158.84)])
    const list = await getPublicPriceList()
    expect(byId(list, 'AUTO_REORDER')).toBeUndefined()
    expect(() => priceSelection(list, ['AUTO_REORDER'])).toThrow(expect.objectContaining({ code: 'PRICE_LIST_CHANGED' }))
  })

  it('un plan sin lista ACTIVE no aparece', async () => {
    setup({ premiumStatus: 'PAUSED' })
    const list = await getPublicPriceList()
    expect(list.plans).toEqual([{ tier: 'PRO', name: 'Pro', price: 1158.84 }])
    expect(byId(list, 'CFDI')!.includedIn).toEqual([])
  })

  it('«incluido en el plan» sigue lo que el plan publicado vende, no la regla del código', async () => {
    setup({ proComposition: ['LOYALTY_PROGRAM'] })
    const list = await getPublicPriceList()
    expect(byId(list, 'LOYALTY_PROGRAM')!.includedIn).toEqual(['PRO', 'PREMIUM'])
    expect(byId(list, 'RESERVATIONS')!.includedIn).toEqual(['PREMIUM'])
  })

  it('trae los requisitos pagados y ordena por categoría como el SUPERADMIN', async () => {
    const list = await getPublicPriceList()
    expect(byId(list, 'AUTO_REORDER')!.requires).toEqual(['INVENTORY_TRACKING'])
    const order = ['sell', 'customers', 'inventory', 'money', 'team', 'ai', 'custom']
    const seen = list.features.map(f => order.indexOf(f.category))
    expect(seen).toEqual([...seen].sort((a, b) => a - b))
  })
})

describe('priceSelection', () => {
  let list: PublicPriceList
  beforeEach(async () => {
    setup()
    list = await getPublicPriceList()
  })

  it('suma en centavos y sin sugerencia cuando lo suelto es lo más barato', () => {
    const out = priceSelection(list, ['LOYALTY_PROGRAM', 'ADVANCED_REPORTS'])
    expect(out.best).toEqual({ kind: 'SUELTO', totalCents: 44800, extras: [] })
    expect(out.savingsCents).toBe(0)
  })

  it('agrega solo el requisito pagado y lo suma', () => {
    const out = priceSelection(list, ['AUTO_REORDER'])
    expect(out.chosen.map(f => f.id)).toEqual(['INVENTORY_TRACKING', 'AUTO_REORDER'])
    expect(out.addedByRequirement).toEqual(['INVENTORY_TRACKING'])
    expect(out.options[0]).toEqual({ kind: 'SUELTO', totalCents: 49800, extras: [] })
  })

  it('sugiere Pro cuando sale más barato que lo suelto', () => {
    const out = priceSelection(list, PRO)
    // 349 + 449 + 99 + 199 + 99 + 199 = 1,394 > 1,158.84
    expect(out.options[0].totalCents).toBe(139400)
    expect(out.best).toEqual({ kind: 'PRO', totalCents: 115884, extras: [] })
    expect(out.savingsCents).toBe(139400 - 115884)
  })

  it('Pro con una función de Premium suelta aparte', () => {
    const out = priceSelection(list, [...PRO, 'INVENTORY_TRACKING'])
    expect(out.options.find(o => o.kind === 'PRO')).toEqual({ kind: 'PRO', totalCents: 115884 + 39900, extras: ['INVENTORY_TRACKING'] })
    expect(out.best.kind).toBe('PRO')
  })

  it('sólo «Se cotiza»: total cero, sin sugerencia y listado aparte', () => {
    const quoted = list.features.find(f => f.kind === 'SE_COTIZA')!
    const out = priceSelection(list, [quoted.id])
    expect(out.best).toEqual({ kind: 'SUELTO', totalCents: 0, extras: [] })
    expect(out.quoted.map(f => f.id)).toEqual([quoted.id])
    expect(out.chosen).toEqual([])
  })

  it('rechaza un id incluido, desconocido o repetido con PRICE_LIST_CHANGED', () => {
    for (const ids of [['BASE_POS'], ['NO_EXISTE'], ['CFDI', 'CFDI'], ['UPSELL']])
      expect(() => priceSelection(list, ids)).toThrow(expect.objectContaining({ statusCode: 400, code: 'PRICE_LIST_CHANGED' }))
  })
})

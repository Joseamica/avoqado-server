/**
 * Planes editables B2, Task 10 (§11 D, b2-r1 #12): la lista de precios de /presentacion/precios con la versión del editor.
 *
 * - Sin versión del editor, todo del tablero de «Precios», como hoy: sin `offerVersion`, y la selección ignora el que llegue.
 * - Con ella, los planes salen de UNA foto reconstruida desde la versión: el precio mensual con IVA de su definición (en pesos), la
 *   composición de las publicaciones de su `hybridPublicationIds`, y un plan fuera de venta no sale ni se recomienda. Las funciones
 *   sueltas siguen saliendo del tablero. La lista dice su `offerVersion` y la selección de una pestaña con otra (o sin ella) → 409
 *   `PRICE_LIST_CHANGED`, que la página ya maneja recargando.
 *
 * La base es `prismaMock`; el tablero de «Precios» se simula en su borde.
 */
jest.mock('@/services/launchCampaigns/hybridListPrice.service', () => ({ listPriceBoard: jest.fn() }))
import { prismaMock } from '../../../__helpers__/setup'
import { listPriceBoard } from '@/services/launchCampaigns/hybridListPrice.service'
import {
  getPublicPriceList,
  priceSelection,
  PriceListVersionChangedError,
  type PublicPriceList,
} from '@/services/launchCampaigns/publicPriceList.service'
import { definicionDePrueba, idsDeLaVersion, punteroA, versionUno } from '@tests/__helpers__/planOfferFixtures'

const board = listPriceBoard as jest.Mock
const pointer = prismaMock.planOfferPointer.findUnique as jest.Mock
const version = prismaMock.planOfferVersion.findUnique as jest.Mock

// Precios del tablero (pesos, IVA incluido).
const PRICES: Record<string, number> = {
  LOYALTY_PROGRAM: 349,
  RESERVATIONS: 449,
  ADVANCED_REPORTS: 99,
  AGGREGATOR_PASSES: 199,
  TABLE_SERVICE: 99,
  ONLINE_ORDERING: 199,
  CFDI: 229,
  INVENTORY_TRACKING: 399,
}
/** Sueltas suman $1,394.00: con Pro a $1,158.84 en venta, Pro es lo que se recomienda. */
const PRO = ['LOYALTY_PROGRAM', 'RESERVATIONS', 'ADVANCED_REPORTS', 'AGGREGATOR_PASSES', 'TABLE_SERVICE', 'ONLINE_ORDERING']
const PREMIUM = [...PRO, 'CFDI', 'INVENTORY_TRACKING']
const row = (productKey: string, price: number | null, status: 'ACTIVE' | 'PAUSED' | null = 'ACTIVE') => ({
  productKey,
  price,
  status,
  campaignId: 'camp_x',
  revision: 3,
  pendingPrice: null,
  activeGroups: [],
})

/** Las publicaciones que existen: las de las listas del tablero (`pub_*_lista`) y las que cita cada versión. */
let publicaciones: Record<string, string[]> = {}

beforeEach(() => {
  board
    .mockReset()
    .mockResolvedValue([
      ...Object.entries(PRICES).map(([code, price]) => row(`FEATURE:${code}`, price)),
      row('PLAN:PRO', 1158.84),
      row('PLAN:PREMIUM', 1970.84),
    ])
  publicaciones = { pub_pro_lista: PRO, pub_premium_lista: PREMIUM }
  prismaMock.hybridCampaign.findMany.mockReset().mockResolvedValue([
    { listProductKey: 'PLAN:PRO', currentPublicationId: 'pub_pro_lista' },
    { listProductKey: 'PLAN:PREMIUM', currentPublicationId: 'pub_premium_lista' },
  ])
  prismaMock.hybridOfferPublication.findMany
    .mockReset()
    .mockImplementation(async ({ where }: any) =>
      (where.id.in as string[]).flatMap(id => (publicaciones[id] ? [{ id, includedFeatureCodes: publicaciones[id] }] : [])),
    )
  pointer.mockReset().mockResolvedValue(null)
  version.mockReset().mockResolvedValue(null)
})

/** Publica `definition` con ese número y sus dos listas híbridas (`PRO`, `PREMIUM`) con su composición. */
function vigente(number: number, definition: unknown, composicion: { PRO: string[]; PREMIUM: string[] }) {
  const ids = { PRO: `pub_pro_v${number}`, PREMIUM: `pub_premium_v${number}` }
  publicaciones[ids.PRO] = composicion.PRO
  publicaciones[ids.PREMIUM] = composicion.PREMIUM
  pointer.mockResolvedValue(punteroA(`ver_v${number}`, number, definition))
  version.mockImplementation(async ({ where }: any) => (where.id === `ver_v${number}` ? { hybridPublicationIds: ids } : null))
}

const byId = (list: PublicPriceList, id: string) => list.features.find(f => f.id === id)

describe('B2 Task 10 · la lista de precios lee una sola foto de la versión', () => {
  it('sin versión del editor: la lista de hoy (sin offerVersion) y la selección ignora offerVersion', async () => {
    for (const puntero of [null, punteroA('ver_v1', 1, versionUno())]) {
      pointer.mockResolvedValue(puntero)
      const list = await getPublicPriceList()
      expect(list).not.toHaveProperty('offerVersion')
      expect(list.plans).toEqual([
        { tier: 'PRO', name: 'Pro', price: 1158.84 },
        { tier: 'PREMIUM', name: 'Premium', price: 1970.84 },
      ])
      expect(byId(list, 'LOYALTY_PROGRAM')).toMatchObject({ price: 349, includedIn: ['PRO', 'PREMIUM'] })
      // Las listas de los planes se leen del tablero, como hoy; ninguna versión.
      expect(version).not.toHaveBeenCalled()
      const hoy = priceSelection(list, PRO)
      expect(hoy.best.kind).toBe('PRO')
      for (const cualquiera of [undefined, 1, 2, 2.5, Number.NaN]) expect(priceSelection(list, PRO, cualquiera)).toEqual(hoy)
    }
  })

  it('con la v2: offerVersion 2; la selección con 1 o sin offerVersion → 409 PRICE_LIST_CHANGED; con 2, la de siempre', async () => {
    const hoy = priceSelection(await getPublicPriceList(), PRO)
    // La v2 con los precios de hoy y las mismas composiciones: lo que se ve es lo mismo, pero ahora cita su versión.
    vigente(2, definicionDePrueba({ ids: idsDeLaVersion('v2') }), { PRO, PREMIUM })
    const list = await getPublicPriceList()
    expect(list.offerVersion).toBe(2)
    expect(list.plans).toMatchObject([
      { tier: 'PRO', name: 'Pro', price: 1158.84 },
      { tier: 'PREMIUM', name: 'Premium', price: 1970.84 },
    ])
    for (const vieja of [1, undefined, 2.5, 3]) {
      let error: unknown
      try {
        priceSelection(list, PRO, vieja)
      } catch (e) {
        error = e
      }
      expect(error).toBeInstanceOf(PriceListVersionChangedError)
      expect(error).toMatchObject({
        statusCode: 409,
        code: 'PRICE_LIST_CHANGED',
        message: 'Un módulo cambió o ya no está disponible. Recarga la página.',
      })
    }
    expect(priceSelection(list, PRO, 2)).toEqual(hoy)
  })

  it('B4 T1: con la v2 cada plan trae además sus términos (nombre, mensual y anual en centavos, prueba, tarjeta, venta), name y price como hoy', async () => {
    vigente(
      2,
      definicionDePrueba({
        ids: idsDeLaVersion('v2'),
        nombres: { PRO: 'Plus' },
        netos: { 'PRO:monthly': 79900, 'PRO:annual': 850000 },
        planes: { PRO: { trialDays: 14, requiresCard: false } },
      }),
      { PRO, PREMIUM },
    )
    const list = await getPublicPriceList()
    expect(list.plans[0]).toEqual({
      tier: 'PRO',
      name: 'Plus',
      price: 926.84,
      displayName: 'Plus',
      monthly: { netCents: 79900, grossCents: 92684 },
      annual: { netCents: 850000, grossCents: 986000 },
      trialDays: 14,
      requiresCard: false,
      onSale: true,
    })
    expect(JSON.stringify(list)).not.toContain('stripePriceId')
  })

  it('B4 T1: sin versión del editor los planes son EXACTAMENTE los de hoy, sin campos nuevos', async () => {
    const list = await getPublicPriceList()
    expect(list.plans).toStrictEqual([
      { tier: 'PRO', name: 'Pro', price: 1158.84 },
      { tier: 'PREMIUM', name: 'Premium', price: 1970.84 },
    ])
  })

  it('🔴 b2-r1 #12: con la v3 vigente y el tablero híbrido todavía con el precio de la v2, el GET da el precio de la v3 con offerVersion 3 y la composición de sus publicaciones', async () => {
    // El tablero sigue en $1,158.84 (la v2); la v3 baja Pro a $899 + IVA = $1,042.84 y su lista de Pro ya trae CFDI.
    vigente(3, definicionDePrueba({ ids: idsDeLaVersion('v3'), netos: { 'PRO:monthly': 89900 } }), {
      PRO: [...PRO, 'CFDI'],
      PREMIUM,
    })
    const list = await getPublicPriceList()
    expect(list.offerVersion).toBe(3)
    expect(list.plans).toMatchObject([
      { tier: 'PRO', name: 'Pro', price: 1042.84 },
      { tier: 'PREMIUM', name: 'Premium', price: 1970.84 },
    ])
    expect(byId(list, 'CFDI')).toMatchObject({ price: 229, includedIn: ['PRO', 'PREMIUM'] })
    // Los planes no se leen de las listas del tablero: sólo de las publicaciones que cita la v3.
    expect(prismaMock.hybridCampaign.findMany).not.toHaveBeenCalled()
    expect(prismaMock.hybridOfferPublication.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['pub_pro_v3', 'pub_premium_v3'] } } }),
    )
    // La selección hace la cuenta con la misma foto: Pro a $1,042.84 ya trae CFDI.
    const selection = priceSelection(list, ['CFDI', 'LOYALTY_PROGRAM', 'RESERVATIONS'], 3)
    expect(selection.options.find(o => o.kind === 'PRO')).toEqual({ kind: 'PRO', totalCents: 104284, extras: [] })
  })

  it('🔴 b2-r1 #12: la v3 saca Pro de venta y reusa su lista híbrida ACTIVE → Pro no sale en plans y la selección nunca lo recomienda', async () => {
    // El tablero todavía ofrece PLAN:PRO activo (la lista se reusó); la v3 dice que Pro ya no está a la venta.
    vigente(3, definicionDePrueba({ ids: idsDeLaVersion('v3'), planes: { PRO: { onSale: false } } }), { PRO, PREMIUM })
    const list = await getPublicPriceList()
    expect(list.offerVersion).toBe(3)
    expect(list.plans.map(p => p.tier)).toEqual(['PREMIUM'])
    expect(list.features.every(f => !f.includedIn.includes('PRO'))).toBe(true)
    // Lo que con Pro en venta sería «Pro» (sueltas $1,394.00 contra $1,158.84) nunca se recomienda: sólo suelto o Premium.
    const selection = priceSelection(list, PRO, 3)
    expect(selection.options.map(o => o.kind)).toEqual(['SUELTO', 'PREMIUM'])
    expect(selection.best).toEqual({ kind: 'SUELTO', totalCents: 139400, extras: [] })
  })
})

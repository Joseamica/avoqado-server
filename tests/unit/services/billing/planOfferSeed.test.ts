/**
 * Planes editables B1, Task 3: sembrar la versión 1 (una foto de lo de hoy) y su revisión previa.
 *
 * 🔴 Lo que no se negocia aquí:
 * - la revisión sólo lee; con una versión vigente no revisa nada más (EXISTS);
 * - la v1 sólo se escribe si las cuatro llaves viven en el producto de su plan con el monto de hoy y las dos listas `PLAN:*`
 *   están en venta a su precio y con la composición del código;
 * - la v1 que se escribe pasa `planOfferDefinition` (una v1 rota convertiría toda compra en un 503) y no trae nombre propio;
 * - dentro de la transacción (candado de la oferta y luego los de producto) se releen las listas: si cambiaron, no escribe.
 */
const mockPricesList = jest.fn()
const mockProductsRetrieve = jest.fn()
const mockSubscriptionsList = jest.fn()
jest.mock('stripe', () =>
  jest.fn().mockImplementation(() => ({
    prices: { list: mockPricesList },
    products: { retrieve: mockProductsRetrieve },
    subscriptions: { list: mockSubscriptionsList },
  })),
)
const mockGap = jest.fn()
jest.mock('@/services/launchCampaigns/hybridListPrice.service', () => ({
  ...jest.requireActual('@/services/launchCampaigns/hybridListPrice.service'),
  planListCompositionGap: (...args: unknown[]) => mockGap(...args),
}))

import {
  resultadoDelSembrado,
  revisarSembradoDeLaVersionUno,
  sembrarVersionUno,
  type ReporteDelSembrado,
} from '@/services/billing/planOfferSeed'
import { ofertaVigente, planOfferDefinition, versionQueCobra } from '@/services/billing/planOffer'
import { prismaMock } from '@tests/__helpers__/setup'
import {
  definicionDeLaListaDelPlan,
  escenarioDelSembrado,
  montarEscenarioDelSembrado,
  precioDeStripe,
  punteroA,
  versionUno,
  type EscenarioDelSembrado,
} from '@tests/__helpers__/planOfferFixtures'

function montar(e: EscenarioDelSembrado = escenarioDelSembrado()) {
  montarEscenarioDelSembrado(e, {
    prisma: prismaMock,
    pricesList: mockPricesList,
    productsRetrieve: mockProductsRetrieve,
    subscriptionsList: mockSubscriptionsList,
  })
  mockGap.mockReset().mockResolvedValue({ missing: [], extra: [] })
  return e
}

const ranura = (r: ReporteDelSembrado, nombre: string) => r.ranuras.find(x => x.ranura === nombre)!
const lista = (r: ReporteDelSembrado, tier: 'PRO' | 'PREMIUM') => r.listas.find(x => x.tier === tier)!

beforeEach(() => {
  prismaMock.$transaction.mockClear()
  prismaMock.$executeRaw.mockClear()
})

describe('revisarSembradoDeLaVersionUno', () => {
  it('CREATE: las cuatro llaves en el producto del plan, con su monto, y las dos listas en venta a su precio', async () => {
    montar()
    const reporte = await revisarSembradoDeLaVersionUno()

    expect(reporte.resultado).toBe('CREATE')
    expect(reporte.sinTablasDeB1).toBe(false)
    expect(
      reporte.ranuras.map(x => [x.ranura, x.lookupKey, x.priceId, x.productId, x.productoEsperado, x.unitAmount, x.esperado, x.resultado]),
    ).toEqual([
      ['PRO:monthly', 'plan_pro_monthly', 'price_key_pro_m', 'prod_pro', 'prod_pro', 115884, 115884, 'CREATE'],
      ['PRO:annual', 'plan_pro_annual', 'price_key_pro_a', 'prod_pro', 'prod_pro', 1158840, 1158840, 'CREATE'],
      ['PREMIUM:monthly', 'plan_premium_monthly', 'price_key_premium_m', 'prod_premium', 'prod_premium', 197084, 197084, 'CREATE'],
      ['PREMIUM:annual', 'plan_premium_annual', 'price_key_premium_a', 'prod_premium', 'prod_premium', 1970840, 1970840, 'CREATE'],
    ])
    expect(reporte.listas).toEqual([
      { tier: 'PRO', publicationId: 'pub_pro', price: 1158.84, resultado: 'CREATE', motivo: null },
      { tier: 'PREMIUM', publicationId: 'pub_premium', price: 1970.84, resultado: 'CREATE', motivo: null },
    ])
    expect(reporte.productos).toEqual([
      { tier: 'PRO', productId: 'prod_pro', nombre: 'Plan Avoqado Pro' },
      { tier: 'PREMIUM', productId: 'prod_premium', nombre: 'Plan Avoqado Premium' },
    ])
    // Cada llave se consulta sola, con la lista consistente de Stripe (sin recorrer el catálogo).
    expect(mockPricesList.mock.calls.map(c => c[0])).toEqual([
      { lookup_keys: ['plan_pro_monthly'], limit: 2 },
      { lookup_keys: ['plan_pro_annual'], limit: 2 },
      { lookup_keys: ['plan_premium_monthly'], limit: 2 },
      { lookup_keys: ['plan_premium_annual'], limit: 2 },
    ])
    expect(mockGap.mock.calls.map(c => c[0])).toEqual(['PRO', 'PREMIUM'])
    // Sólo lee.
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
    expect(prismaMock.planOfferVersion.create).not.toHaveBeenCalled()
    expect(prismaMock.planOfferPointer.upsert).not.toHaveBeenCalled()
  })

  it('WRONG_PRODUCT: plan_pro_annual vive en prod_viejo y no en Feature.stripeProductId', async () => {
    const e = escenarioDelSembrado()
    e.precios.plan_pro_annual = precioDeStripe('price_key_pro_a', 'prod_viejo', 1158840, 'year')
    montar(e)
    const reporte = await revisarSembradoDeLaVersionUno()

    expect(reporte.resultado).toBe('WRONG_PRODUCT')
    expect(ranura(reporte, 'PRO:annual')).toMatchObject({
      productId: 'prod_viejo',
      productoEsperado: 'prod_pro',
      resultado: 'WRONG_PRODUCT',
      motivo: expect.stringContaining('prod_viejo'),
    })
    expect(ranura(reporte, 'PRO:monthly').resultado).toBe('CREATE')
  })

  it.each<[string, (e: EscenarioDelSembrado) => void, (r: ReporteDelSembrado) => { resultado: string; motivo: string | null }]>([
    [
      'plan_premium_monthly a 197000 (no 197084)',
      e => (e.precios.plan_premium_monthly = precioDeStripe('price_key_premium_m', 'prod_premium', 197000, 'month')),
      r => ranura(r, 'PREMIUM:monthly'),
    ],
    [
      'plan_premium_monthly con tax_behavior exclusive',
      e =>
        (e.precios.plan_premium_monthly = precioDeStripe('price_key_premium_m', 'prod_premium', 197084, 'month', {
          tax_behavior: 'exclusive',
        })),
      r => ranura(r, 'PREMIUM:monthly'),
    ],
    [
      'la lista PLAN:PRO con un precio pendiente',
      e => (e.listas[0] = { ...e.listas[0], pendingPublicationId: 'pub_pro_pendiente' }),
      r => lista(r, 'PRO'),
    ],
    [
      'plan_pro_monthly en dólares',
      e => (e.precios.plan_pro_monthly = precioDeStripe('price_key_pro_m', 'prod_pro', 115884, 'month', { currency: 'usd' })),
      r => ranura(r, 'PRO:monthly'),
    ],
    [
      'plan_pro_monthly cada 3 meses',
      e =>
        (e.precios.plan_pro_monthly = precioDeStripe('price_key_pro_m', 'prod_pro', 115884, 'month', {
          recurring: { interval: 'month', interval_count: 3 },
        })),
      r => ranura(r, 'PRO:monthly'),
    ],
    [
      'plan_pro_annual cobrado al mes',
      e => (e.precios.plan_pro_annual = precioDeStripe('price_key_pro_a', 'prod_pro', 1158840, 'month')),
      r => ranura(r, 'PRO:annual'),
    ],
    [
      'plan_premium_annual archivado',
      e => (e.precios.plan_premium_annual = precioDeStripe('price_key_premium_a', 'prod_premium', 1970840, 'year', { active: false })),
      r => ranura(r, 'PREMIUM:annual'),
    ],
    ['la lista PLAN:PREMIUM pausada', e => (e.listas[1] = { ...e.listas[1], status: 'PAUSED' }), r => lista(r, 'PREMIUM')],
    [
      'la lista PLAN:PRO a otro precio',
      e => (e.publicaciones[0] = { id: 'pub_pro', definition: definicionDeLaListaDelPlan('PRO', 999) }),
      r => lista(r, 'PRO'),
    ],
  ])('MISMATCH: %s', async (_caso, cambiar, cual) => {
    const e = escenarioDelSembrado()
    cambiar(e)
    montar(e)
    const reporte = await revisarSembradoDeLaVersionUno()
    expect(reporte.resultado).toBe('MISMATCH')
    expect(cual(reporte)).toMatchObject({ resultado: 'MISMATCH', motivo: expect.any(String) })
  })

  it('MISMATCH: dos precios con la misma llave (o más por leer)', async () => {
    const e = montar()
    mockPricesList.mockImplementation(async (params: { lookup_keys: string[] }) =>
      params.lookup_keys[0] === 'plan_pro_monthly'
        ? { data: [e.precios.plan_pro_monthly, precioDeStripe('price_otro', 'prod_pro', 115884, 'month')], has_more: false }
        : { data: [e.precios[params.lookup_keys[0]]], has_more: false },
    )
    const reporte = await revisarSembradoDeLaVersionUno()
    expect(reporte.resultado).toBe('MISMATCH')
    expect(ranura(reporte, 'PRO:monthly')).toMatchObject({ resultado: 'MISMATCH', motivo: expect.stringContaining('más de un precio') })
  })

  it.each<[string, (e: EscenarioDelSembrado) => void, (r: ReporteDelSembrado) => { resultado: string; motivo: string | null }]>([
    ['sin precio para plan_pro_monthly', e => (e.precios.plan_pro_monthly = undefined), r => ranura(r, 'PRO:monthly')],
    ['sin Feature PLAN_PREMIUM', e => (e.features = e.features.filter(f => f.code !== 'PLAN_PREMIUM')), r => ranura(r, 'PREMIUM:monthly')],
    [
      'con la Feature PLAN_PRO apagada',
      e => (e.features = e.features.map(f => (f.code === 'PLAN_PRO' ? { ...f, active: false } : f))),
      r => ranura(r, 'PRO:annual'),
    ],
    [
      'con la Feature PLAN_PRO sin producto de Stripe',
      e => (e.features = e.features.map(f => (f.code === 'PLAN_PRO' ? { ...f, stripeProductId: null as unknown as string } : f))),
      r => ranura(r, 'PRO:monthly'),
    ],
    ['sin lista PLAN:PREMIUM', e => (e.listas = e.listas.filter(l => l.listProductKey !== 'PLAN:PREMIUM')), r => lista(r, 'PREMIUM')],
    [
      'con la lista PLAN:PRO sin precio en venta',
      e => (e.listas[0] = { ...e.listas[0], currentPublicationId: null, status: 'DRAFT' }),
      r => lista(r, 'PRO'),
    ],
  ])('MISSING: %s', async (_caso, cambiar, cual) => {
    const e = escenarioDelSembrado()
    cambiar(e)
    montar(e)
    const reporte = await revisarSembradoDeLaVersionUno()
    expect(reporte.resultado).toBe('MISSING')
    expect(cual(reporte)).toMatchObject({ resultado: 'MISSING', motivo: expect.any(String) })
  })

  it('EXISTS gana aunque Stripe no cuadre: con vigente no se revisa nada más', async () => {
    const e = escenarioDelSembrado()
    e.precios.plan_pro_monthly = undefined
    e.precios.plan_pro_annual = precioDeStripe('price_key_pro_a', 'prod_viejo', 1, 'year')
    montar(e)
    prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA('cv1', 1, versionUno()) as never)

    const reporte = await revisarSembradoDeLaVersionUno()
    expect(reporte).toMatchObject({ resultado: 'EXISTS', ranuras: [], listas: [], productos: [], sinTablasDeB1: false })
    expect(reporte.suscripcionesVivas).toEqual({ revisadas: 0, truncado: false, porProducto: [] })
    expect(mockPricesList).not.toHaveBeenCalled()
    expect(mockProductsRetrieve).not.toHaveBeenCalled()
    expect(mockSubscriptionsList).not.toHaveBeenCalled()
    expect(prismaMock.feature.findMany).not.toHaveBeenCalled()
    expect(prismaMock.hybridCampaign.findMany).not.toHaveBeenCalled()
  })

  it('🔴 MISMATCH si la lista PLAN:PRO vende una composición distinta del código (planListCompositionGap con missing: ["SERVICE_PAY"])', async () => {
    montar()
    mockGap.mockImplementation(async (tier: string) =>
      tier === 'PRO' ? { missing: ['SERVICE_PAY'], extra: [] } : { missing: [], extra: [] },
    )
    const reporte = await revisarSembradoDeLaVersionUno()
    expect(reporte.resultado).toBe('MISMATCH')
    expect(lista(reporte, 'PRO')).toMatchObject({
      resultado: 'MISMATCH',
      motivo: expect.stringContaining('seed-plan-list-prices.ts --apply'),
    })
    expect(lista(reporte, 'PRO').motivo).toContain('SERVICE_PAY')
    expect(lista(reporte, 'PREMIUM').resultado).toBe('CREATE')
  })

  it('🔴 una base sin las tablas de B1 (P2021 al leer el puntero) se revisa como «sin versión» y lo dice', async () => {
    montar()
    prismaMock.planOfferPointer.findUnique.mockRejectedValue(Object.assign(new Error('The table does not exist'), { code: 'P2021' }))
    const reporte = await revisarSembradoDeLaVersionUno()
    expect(reporte).toMatchObject({ resultado: 'CREATE', sinTablasDeB1: true })
    expect(mockPricesList).toHaveBeenCalledTimes(4)
  })

  it('otro error al leer el puntero no se toma como «sin versión»', async () => {
    montar()
    prismaMock.planOfferPointer.findUnique.mockRejectedValue(Object.assign(new Error('connection lost'), { code: 'P1001' }))
    await expect(revisarSembradoDeLaVersionUno()).rejects.toMatchObject({ code: 'P1001' })
    expect(mockPricesList).not.toHaveBeenCalled()
  })
})

describe('las suscripciones vivas de plan (informativas)', () => {
  const sub = (id: string, product: string, lookupKey: string | null, metadata: Record<string, string> = {}) => ({
    id,
    metadata,
    items: { data: [{ price: { id: `price_${id}`, product, lookup_key: lookupKey } }] },
  })

  it('cuenta por producto: PRODUCTO (el del plan), LLAVE (sólo la llave lo reconoce) y NINGUNO; lo que no es de plan no cuenta', async () => {
    montar()
    mockSubscriptionsList.mockImplementation(async (params: { status: string }) => {
      if (params.status === 'active')
        return {
          data: [
            sub('a1', 'prod_pro', 'plan_pro_monthly'),
            sub('a2', 'prod_pro', null),
            sub('a3', 'prod_viejo', 'plan_pro_annual'),
            sub('a4', 'prod_cfdi', null, { featureCode: 'CFDI' }),
          ],
          has_more: false,
        }
      if (params.status === 'past_due')
        return {
          data: [sub('p1', 'prod_historico', null, { featureCode: 'PLAN_PREMIUM' }), sub('p2', 'prod_premium', null)],
          has_more: false,
        }
      return { data: [], has_more: false }
    })
    const { suscripcionesVivas } = await revisarSembradoDeLaVersionUno()

    expect(mockSubscriptionsList.mock.calls.map(c => c[0].status)).toEqual(['active', 'trialing', 'past_due', 'unpaid'])
    expect(suscripcionesVivas).toEqual({
      revisadas: 6,
      truncado: false,
      porProducto: [
        { productId: 'prod_historico', reconocidoPor: 'NINGUNO', cuantas: 1 },
        { productId: 'prod_premium', reconocidoPor: 'PRODUCTO', cuantas: 1 },
        { productId: 'prod_pro', reconocidoPor: 'PRODUCTO', cuantas: 2 },
        { productId: 'prod_viejo', reconocidoPor: 'LLAVE', cuantas: 1 },
      ],
    })
  })

  it('el reporte de suscripciones vivas se detiene a las 2,000 y lo dice', async () => {
    montar()
    let n = 0
    mockSubscriptionsList.mockImplementation(async (params: { limit: number }) => ({
      data: Array.from({ length: params.limit }, () => sub(`s${++n}`, 'prod_pro', 'plan_pro_monthly')),
      has_more: true,
    }))
    const { suscripcionesVivas, resultado } = await revisarSembradoDeLaVersionUno()

    expect(suscripcionesVivas).toEqual({
      revisadas: 2000,
      truncado: true,
      porProducto: [{ productId: 'prod_pro', reconocidoPor: 'PRODUCTO', cuantas: 2000 }],
    })
    expect(mockSubscriptionsList).toHaveBeenCalledTimes(20)
    expect(mockSubscriptionsList.mock.calls.every(c => c[0].limit <= 100)).toBe(true)
    // Pagina con el cursor de Stripe, sin repetir la primera página.
    expect(mockSubscriptionsList.mock.calls[1][0]).toMatchObject({ status: 'active', starting_after: 's100' })
    // Es informativo: no cambia el resultado.
    expect(resultado).toBe('CREATE')
  })
})

describe('resultadoDelSembrado', () => {
  const r = (resultado: string) => ({ resultado }) as never
  it('EXISTS > MISSING > WRONG_PRODUCT > MISMATCH > CREATE', () => {
    expect(resultadoDelSembrado([r('MISSING')], [r('MISMATCH')], true)).toBe('EXISTS')
    expect(resultadoDelSembrado([r('WRONG_PRODUCT'), r('MISMATCH')], [r('MISSING')], false)).toBe('MISSING')
    expect(resultadoDelSembrado([r('MISMATCH'), r('WRONG_PRODUCT')], [r('CREATE')], false)).toBe('WRONG_PRODUCT')
    expect(resultadoDelSembrado([r('CREATE')], [r('MISMATCH')], false)).toBe('MISMATCH')
    expect(resultadoDelSembrado([r('CREATE'), r('CREATE')], [r('CREATE')], false)).toBe('CREATE')
  })
})

describe('sembrarVersionUno', () => {
  it('sembrar escribe la v1 con los priceId de las llaves, sin nombre propio y con las publicaciones híbridas vigentes', async () => {
    montar()
    const r = await sembrarVersionUno('staff_super')

    expect(r).toMatchObject({ resultado: 'CREATE', versionId: 'cv1' })
    const { data } = prismaMock.planOfferVersion.create.mock.calls[0][0]
    expect(data).toMatchObject({
      number: 1,
      status: 'PUBLISHED',
      createdById: 'staff_super',
      publishedById: 'staff_super',
      publishedAt: expect.any(Date),
      hybridPublicationIds: { PRO: 'pub_pro', PREMIUM: 'pub_premium' },
      definition: {
        PRO: { monthly: { stripePriceId: 'price_key_pro_m' }, annual: { stripePriceId: 'price_key_pro_a' }, stripeProductName: null },
        PREMIUM: {
          monthly: { stripePriceId: 'price_key_premium_m' },
          annual: { stripePriceId: 'price_key_premium_a' },
          stripeProductName: null,
        },
      },
    })
    // Lo de hoy, al centavo (escrito a mano: no desde las constantes).
    expect(data.definition).toMatchObject({
      FREE: { displayName: 'Gratis' },
      PRO: { displayName: 'Pro', onSale: true, requiresCard: true, trialDays: 30, monthly: { netCents: 99900, grossCents: 115884 } },
      PREMIUM: { displayName: 'Premium', annual: { netCents: 1699000, grossCents: 1970840 } },
    })
    expect(prismaMock.planOfferPointer.upsert).toHaveBeenCalledWith({
      where: { id: 'vigente' },
      create: { id: 'vigente', currentVersionId: 'cv1', revision: 1 },
      update: { currentVersionId: 'cv1', revision: 1 },
    })
    expect(prismaMock.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'PLAN_OFFER_SEEDED',
        entity: 'PlanOfferVersion',
        entityId: 'cv1',
        staffId: 'staff_super',
      }),
    })
    // La transacción tomó 'plan-offer-publish' y luego precio:PLAN:PREMIUM y precio:PLAN:PRO, en ese orden.
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    expect(prismaMock.$executeRaw.mock.calls.map((c: unknown[]) => c[1])).toEqual([
      'plan-offer-publish',
      'precio:PLAN:PREMIUM',
      'precio:PLAN:PRO',
    ])
    // Y los candados van antes de releer y de escribir; Stripe, antes de la transacción.
    const ultimoCandado = prismaMock.$executeRaw.mock.invocationCallOrder[2]
    expect(prismaMock.hybridCampaign.findMany.mock.invocationCallOrder[1]).toBeGreaterThan(ultimoCandado)
    expect(prismaMock.planOfferVersion.create.mock.invocationCallOrder[0]).toBeGreaterThan(ultimoCandado)
    expect(Math.max(...mockPricesList.mock.invocationCallOrder)).toBeLessThan(prismaMock.$executeRaw.mock.invocationCallOrder[0])
  })

  it('🔴 la v1 que se escribe pasa planOfferDefinition, publicada con número 1: ofertaVigente la lee y no cambia el camino del cobro', async () => {
    montar()
    await sembrarVersionUno('staff_super')
    const { data } = prismaMock.planOfferVersion.create.mock.calls[0][0]

    expect(planOfferDefinition.safeParse(data.definition).success).toBe(true)
    expect(data).toMatchObject({ number: 1, status: 'PUBLISHED' })

    // Lo que leen los cobros después del sembrado: la vigente es esta v1 (sin 503) y se sigue cobrando por la llave.
    prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA('cv1', data.number, data.definition) as never)
    await expect(ofertaVigente()).resolves.toMatchObject({ number: 1, versionId: 'cv1', respaldo: false })
    await expect(versionQueCobra()).resolves.toBeNull()
  })

  it('🔴 si dentro de la transacción la lista PLAN:PRO ya vende otra publicación → MISMATCH y no escribe', async () => {
    const e = montar()
    const cambiada = [{ ...e.listas[0], currentPublicationId: 'pub_pro_nueva' }, e.listas[1]]
    prismaMock.hybridCampaign.findMany.mockResolvedValueOnce(e.listas).mockResolvedValueOnce(cambiada)

    const r = await sembrarVersionUno('staff_super')
    expect(r).toMatchObject({ resultado: 'MISMATCH', versionId: null })
    expect(r.reporte.resultado).toBe('MISMATCH')
    expect(lista(r.reporte, 'PRO')).toMatchObject({ resultado: 'MISMATCH', motivo: expect.stringContaining('vuelve a correrlo') })
    expect(prismaMock.planOfferVersion.create).not.toHaveBeenCalled()
    expect(prismaMock.planOfferPointer.upsert).not.toHaveBeenCalled()
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
  })

  it('🔴 si dentro de la transacción la lista PLAN:PREMIUM ya tiene un precio pendiente → MISMATCH y no escribe', async () => {
    const e = montar()
    const cambiada = [e.listas[0], { ...e.listas[1], pendingPublicationId: 'pub_premium_pendiente' }]
    prismaMock.hybridCampaign.findMany.mockResolvedValueOnce(e.listas).mockResolvedValueOnce(cambiada)

    const r = await sembrarVersionUno('staff_super')
    expect(r).toMatchObject({ resultado: 'MISMATCH', versionId: null })
    expect(lista(r.reporte, 'PREMIUM')).toMatchObject({ resultado: 'MISMATCH', motivo: expect.stringContaining('vuelve a correrlo') })
    expect(prismaMock.planOfferVersion.create).not.toHaveBeenCalled()
  })

  it('si otra corrida sembró antes de tomar el candado → EXISTS y no escribe', async () => {
    montar()
    prismaMock.planOfferPointer.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(punteroA('cv_otra', 1, versionUno()) as never)

    const r = await sembrarVersionUno('staff_super')
    expect(r).toMatchObject({ resultado: 'EXISTS', versionId: null })
    expect(r.reporte.resultado).toBe('EXISTS')
    expect(prismaMock.planOfferVersion.create).not.toHaveBeenCalled()
    expect(prismaMock.planOfferPointer.upsert).not.toHaveBeenCalled()
  })

  it.each<[string, (e: EscenarioDelSembrado) => void, string]>([
    ['MISSING', e => (e.precios.plan_pro_monthly = undefined), 'MISSING'],
    ['WRONG_PRODUCT', e => (e.precios.plan_pro_annual = precioDeStripe('price_key_pro_a', 'prod_viejo', 1158840, 'year')), 'WRONG_PRODUCT'],
    ['MISMATCH', e => (e.listas[0] = { ...e.listas[0], pendingPublicationId: 'pub_pendiente' }), 'MISMATCH'],
  ])('sembrar con otro resultado no escribe nada (%s)', async (_caso, cambiar, esperado) => {
    const e = escenarioDelSembrado()
    cambiar(e)
    montar(e)
    const r = await sembrarVersionUno('staff_super')
    expect(r).toMatchObject({ resultado: esperado, versionId: null })
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
    expect(prismaMock.planOfferVersion.create).not.toHaveBeenCalled()
    expect(prismaMock.planOfferPointer.upsert).not.toHaveBeenCalled()
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
  })

  it('sembrar con una vigente → EXISTS sin revisar Stripe ni abrir la transacción', async () => {
    montar()
    prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA('cv1', 1, versionUno()) as never)
    const r = await sembrarVersionUno('staff_super')
    expect(r).toMatchObject({ resultado: 'EXISTS', versionId: null })
    expect(mockPricesList).not.toHaveBeenCalled()
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })
})

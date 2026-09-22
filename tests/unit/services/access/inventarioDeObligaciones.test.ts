/**
 * V5-A paso 3 (diseño v5, Codex v5 punto 1): el inventario de lo que el NEGOCIO tiene vivo en Stripe.
 *
 * No el acceso local: un plan suspendido que sigue cobrando es una obligación. Y no sólo el cliente actual: también
 * los clientes de TODOS los vínculos locales. Lectura incompleta o error ⇒ 503, nunca «no hay nada».
 */
import { prismaMock } from '../../../__helpers__/setup'

const mockRetrieve = jest.fn()
const mockList = jest.fn()
jest.mock('@/services/stripe.service', () => ({
  ...jest.requireActual('@/services/stripe.service'),
  stripe: { subscriptions: { retrieve: (...a: unknown[]) => mockRetrieve(...a), list: (...a: unknown[]) => mockList(...a) } },
}))
jest.mock('stripe')

import { inventarioDeObligaciones } from '@/services/access/inventarioDeObligaciones'

/** Una suscripción de Stripe con un ítem por producto. `lookup` opcional para planes. */
const sub = (id: string, status: string, customer: string, ...productos: Array<string | [string, string]>) => ({
  id,
  status,
  customer,
  items: {
    data: productos.map(p => {
      const [product, lookup_key] = Array.isArray(p) ? p : [p, null]
      return { price: { id: `price_${product}`, product, lookup_key } }
    }),
  },
})
const paginado = (subs: unknown[]) => ({
  autoPagingEach: async (cb: (s: any) => unknown) => {
    for (const s of subs) if ((await cb(s)) === false) return
  },
})

beforeEach(() => {
  mockRetrieve.mockReset()
  mockList.mockReset().mockReturnValue(paginado([]))
  prismaMock.venue.findUnique.mockResolvedValue({ stripeCustomerId: 'cus_1' } as never)
  prismaMock.venueFeature.findMany.mockResolvedValue([] as never)
  prismaMock.billingObligationConflict.findMany.mockResolvedValue([] as never)
  prismaMock.feature.findMany.mockResolvedValue([
    { code: 'PLAN_PRO', stripeProductId: 'prod_pro' },
    { code: 'INVENTORY_TRACKING', stripeProductId: 'prod_inv' },
  ] as never)
})

describe('inventarioDeObligaciones', () => {
  it('lista TODO lo del cliente actual y clasifica lo no terminal; lo terminal no cuenta', async () => {
    mockList.mockReturnValue(
      paginado([
        sub('s_pro', 'past_due', 'cus_1', 'prod_pro'),
        sub('s_muerta', 'canceled', 'cus_1', 'prod_inv'),
        sub('s_inv', 'active', 'cus_1', 'prod_inv'),
      ]),
    )

    const r = await inventarioDeObligaciones('cven1')

    expect(mockList).toHaveBeenCalledWith(expect.objectContaining({ customer: 'cus_1', status: 'all' }), expect.anything())
    expect(r.vivas).toEqual([
      { subscriptionId: 's_pro', proyecciones: [{ tipo: 'PLAN', tier: 'PRO' }] },
      { subscriptionId: 's_inv', proyecciones: [{ tipo: 'FUNCION', featureCode: 'INVENTORY_TRACKING' }] },
    ])
    expect(r.detalle.s_pro).toMatchObject({ status: 'past_due', customerId: 'cus_1', variosItems: false })
  })

  it('🔴 un plan con precio histórico se reconoce por lookup_key aunque su producto no esté en el catálogo', async () => {
    mockList.mockReturnValue(paginado([sub('s_viejo', 'active', 'cus_1', ['prod_retirado', 'plan_premium_monthly'])]))

    const r = await inventarioDeObligaciones('cven1')
    expect(r.vivas).toEqual([{ subscriptionId: 's_viejo', proyecciones: [{ tipo: 'PLAN', tier: 'PREMIUM' }] }])
  })

  it('🔴 un vínculo local bajo OTRO cliente de Stripe entra, y ese cliente también se recorre entero', async () => {
    prismaMock.venueFeature.findMany.mockResolvedValue([{ stripeSubscriptionId: 's_otro' }] as never)
    mockRetrieve.mockResolvedValue(sub('s_otro', 'active', 'cus_viejo', 'prod_pro'))
    mockList.mockImplementation(({ customer }: { customer: string }) =>
      paginado(
        customer === 'cus_viejo'
          ? [sub('s_otro', 'active', 'cus_viejo', 'prod_pro'), sub('s_hermana', 'unpaid', 'cus_viejo', 'prod_inv')]
          : [],
      ),
    )

    const r = await inventarioDeObligaciones('cven1')

    expect(r.vivas.map(v => v.subscriptionId).sort()).toEqual(['s_hermana', 's_otro'])
    expect(mockList).toHaveBeenCalledWith(expect.objectContaining({ customer: 'cus_viejo' }), expect.anything())
  })

  it('🔴 Codex C13: una obligación en CONFLICTO pendiente cuenta aunque ya no tenga fila, y su cliente se recorre', async () => {
    prismaMock.billingObligationConflict.findMany.mockResolvedValue([{ subscriptionId: 's_conflicto' }] as never)
    mockRetrieve.mockResolvedValue(sub('s_conflicto', 'active', 'cus_historico', 'prod_pro'))
    mockList.mockImplementation(({ customer }: { customer: string }) =>
      paginado(customer === 'cus_historico' ? [sub('s_conflicto', 'active', 'cus_historico', 'prod_pro')] : []),
    )

    const r = await inventarioDeObligaciones('cven1')

    expect(r.vivas.map(v => v.subscriptionId)).toEqual(['s_conflicto'])
    expect(mockList).toHaveBeenCalledWith(expect.objectContaining({ customer: 'cus_historico' }), expect.anything())
    expect(prismaMock.billingObligationConflict.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { venueId: 'cven1', status: 'PENDING' } }),
    )
  })

  it('🔴 más conflictos pendientes de los que se leen: 503 (la lectura no fue completa)', async () => {
    prismaMock.billingObligationConflict.findMany.mockResolvedValue(
      Array.from({ length: 201 }, (_, i) => ({ subscriptionId: `c${i}` })) as never,
    )

    await expect(inventarioDeObligaciones('cven1')).rejects.toMatchObject({ statusCode: 503 })
  })

  it('un vínculo local que Stripe AFIRMA que no existe no es obligación', async () => {
    prismaMock.venueFeature.findMany.mockResolvedValue([{ stripeSubscriptionId: 's_fantasma' }] as never)
    mockRetrieve.mockRejectedValue({ code: 'resource_missing', statusCode: 404, type: 'StripeInvalidRequestError' })

    await expect(inventarioDeObligaciones('cven1')).resolves.toMatchObject({ vivas: [] })
  })

  it.each([
    ['falla la consulta de un vínculo', () => mockRetrieve.mockRejectedValue(new Error('socket hang up')), true],
    ['falla el listado del cliente', () => mockList.mockReturnValue({ autoPagingEach: () => Promise.reject(new Error('timeout')) }), false],
  ])('🔴 si %s: 503, nunca «no hay nada»', async (_n, falla, conVinculo) => {
    if (conVinculo) prismaMock.venueFeature.findMany.mockResolvedValue([{ stripeSubscriptionId: 's_x' }] as never)
    falla()

    await expect(inventarioDeObligaciones('cven1')).rejects.toMatchObject({ statusCode: 503, code: 'OBLIGATIONS_UNVERIFIED' })
  })

  it('🔴 si el recorrido se topa: 503 (no se vio todo)', async () => {
    mockList.mockReturnValue(paginado(Array.from({ length: 1001 }, (_, i) => sub(`s${i}`, 'canceled', 'cus_1', 'prod_inv'))))

    await expect(inventarioDeObligaciones('cven1')).rejects.toMatchObject({ statusCode: 503 })
  })

  it('sin cliente y sin vínculos: nada vivo y ninguna llamada a Stripe', async () => {
    prismaMock.venue.findUnique.mockResolvedValue({ stripeCustomerId: null } as never)

    await expect(inventarioDeObligaciones('cven1')).resolves.toMatchObject({ vivas: [] })
    expect(mockList).not.toHaveBeenCalled()
    expect(mockRetrieve).not.toHaveBeenCalled()
  })

  it('el producto puede venir expandido como objeto', async () => {
    mockList.mockReturnValue(
      paginado([
        {
          id: 's_obj',
          status: 'active',
          customer: { id: 'cus_1' },
          items: { data: [{ price: { id: 'p', product: { id: 'prod_inv' }, lookup_key: null } }] },
        },
      ]),
    )

    const r = await inventarioDeObligaciones('cven1')
    expect(r.vivas).toEqual([{ subscriptionId: 's_obj', proyecciones: [{ tipo: 'FUNCION', featureCode: 'INVENTORY_TRACKING' }] }])
  })

  it('🔴 Codex P2-7: una suscripción con más ítems de los que trae la página: 503 (no se vieron todos sus renglones)', async () => {
    mockList.mockReturnValue(paginado([{ ...sub('s_larga', 'active', 'cus_1', 'prod_inv'), items: { data: [], has_more: true } }]))

    await expect(inventarioDeObligaciones('cven1')).rejects.toMatchObject({ statusCode: 503 })
  })

  it('🔴 Codex P2-7: un catálogo más grande del que se lee: 503 (clasificar con un catálogo trunco inventaría mal)', async () => {
    prismaMock.feature.findMany.mockResolvedValue(
      Array.from({ length: 1001 }, (_, i) => ({ code: `F${i}`, stripeProductId: `p${i}` })) as never,
    )

    await expect(inventarioDeObligaciones('cven1')).rejects.toMatchObject({ statusCode: 503 })
  })

  it('🔴 Codex P2-8: los cambios PROGRAMADOS (schedule, pending_update) se reportan para que la regla bloquee', async () => {
    mockList.mockReturnValue(
      paginado([
        { ...sub('s_prog', 'active', 'cus_1', 'prod_pro'), schedule: 'sub_sched_1' },
        { ...sub('s_pend', 'active', 'cus_1', 'prod_inv'), pending_update: { expires_at: 1 } },
        sub('s_normal', 'active', 'cus_1', 'prod_inv'),
      ]),
    )

    const r = await inventarioDeObligaciones('cven1')
    expect(r.conCambiosProgramados.sort()).toEqual(['s_pend', 's_prog'])
  })

  it('conserva la pausa de cobranza y el método de cobro (una pausa puede seguir `active`)', async () => {
    mockList.mockReturnValue(
      paginado([
        { ...sub('s_pausa', 'active', 'cus_1', 'prod_pro'), pause_collection: { behavior: 'void' }, collection_method: 'send_invoice' },
      ]),
    )

    const r = await inventarioDeObligaciones('cven1')
    expect(r.detalle.s_pausa).toMatchObject({ pausaDeCobranza: true, metodoDeCobro: 'send_invoice' })
  })

  it('🔴 un negocio con más vínculos locales de los que se leen: 503 (la lectura no fue completa)', async () => {
    prismaMock.venueFeature.findMany.mockResolvedValue(Array.from({ length: 201 }, (_, i) => ({ stripeSubscriptionId: `s${i}` })) as never)

    await expect(inventarioDeObligaciones('cven1')).rejects.toMatchObject({ statusCode: 503 })
  })
})

describe('🔴 Codex C3: el inventario corre bajo el candado de compra', () => {
  it('cada llamada a Stripe va con tiempo propio y SIN los reintentos del SDK', async () => {
    prismaMock.venueFeature.findMany.mockResolvedValue([{ stripeSubscriptionId: 's_x' }] as never)
    mockRetrieve.mockResolvedValue(sub('s_x', 'active', 'cus_1', 'prod_inv'))

    await inventarioDeObligaciones('cven1')

    expect(mockRetrieve).toHaveBeenCalledWith('s_x', {}, expect.objectContaining({ timeout: expect.any(Number), maxNetworkRetries: 0 }))
    expect(mockList).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ timeout: expect.any(Number), maxNetworkRetries: 0 }))
  })

  it('con el presupuesto agotado no hace más llamadas: 503', async () => {
    prismaMock.venueFeature.findMany.mockResolvedValue([{ stripeSubscriptionId: 's_x' }] as never)

    await expect(inventarioDeObligaciones('cven1', { limite: Date.now() - 1 })).rejects.toMatchObject({ statusCode: 503 })
    expect(mockRetrieve).not.toHaveBeenCalled()
  })
})

/**
 * 🔴 Codex R8 (ronda 2): el presupuesto de lecturas se revisaba una vez antes de empezar a paginar. `autoPagingEach` hace
 * una llamada de red por página, así que un cliente con muchas suscripciones se comía el presupuesto ENTERO de la regla
 * —que ya tiene su candado por negocio tomado— y lo dejaba tomado mucho más de lo previsto.
 */
it('🔴 R8: el presupuesto se revisa DENTRO del recorrido de páginas, no sólo antes de arrancar', async () => {
  const pedidas: string[] = []
  mockList.mockReturnValue({
    autoPagingEach: async (cb: (s: any) => unknown) => {
      for (const s of [sub('s1', 'active', 'cus_1', 'prod_pro'), sub('s2', 'active', 'cus_1', 'prod_inv'), sub('s3', 'active', 'cus_1')]) {
        await new Promise(r => setTimeout(r, 40)) // cada página cuesta una llamada de red
        pedidas.push(s.id)
        if ((await cb(s)) === false) return
      }
    },
  })

  await expect(inventarioDeObligaciones('cven1', { limite: Date.now() + 60 })).rejects.toMatchObject({
    statusCode: 503,
    message: expect.stringContaining('se agotó el tiempo'),
  })
  // Y dejó de pedir páginas en cuanto se pasó: no las recorrió todas.
  expect(pedidas.length).toBeLessThan(3)
})

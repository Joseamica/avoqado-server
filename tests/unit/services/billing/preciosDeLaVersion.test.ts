import { crearAlmacenDePrecios, FakeStripeError } from '@tests/__helpers__/fakeStripePrices'

// El almacén de precios de Stripe simulado vive en `tests/__helpers__/fakeStripePrices.ts` (lo comparte la integración de Task 9).
const almacen = crearAlmacenDePrecios()
const { store, idem, list, create } = almacen

jest.mock('@/services/stripe.service', () => ({
  stripe: { prices: { list: (...a: unknown[]) => list(...a), create: (...a: unknown[]) => create(...a) } },
}))

import {
  asegurarPrecioDeLaRanura,
  clasificarErrorDeStripe,
  ErrorDePreparacion,
  llaveDeBusqueda,
  llaveDeIdempotencia,
} from '@/services/billing/preciosDeLaVersion'

const V = 'cv2abcdefghijklmnopqrstuv'
const base = (over: Record<string, unknown> = {}) => ({
  versionId: V,
  ranura: 'PRO:monthly' as const,
  grossCents: 92684,
  productId: 'prod_pro',
  intento: 0,
  ...over,
})

beforeEach(() => {
  almacen.reset()
})

const precio = (lookup_key: string, over: Record<string, unknown> = {}) => {
  const [, , tier, interval] = lookup_key.split('_')
  return {
    id: `price_${lookup_key}`,
    active: true,
    product: 'prod_pro',
    lookup_key,
    currency: 'mxn',
    unit_amount: interval === 'annual' ? 1077120 : 92684,
    tax_behavior: 'inclusive',
    recurring: { interval: interval === 'annual' ? 'year' : 'month', interval_count: 1 },
    metadata: { kind: 'PLAN_OFFER_PRICE', planOfferVersionId: V, tier: tier.toUpperCase(), interval },
    ...over,
  }
}

describe('llaves', () => {
  it('llave de búsqueda e idempotencia con el formato fijo', () => {
    expect(llaveDeBusqueda(V, 'PRO:annual')).toBe(`po_${V}_pro_annual`)
    expect(llaveDeBusqueda(V, 'PREMIUM:monthly')).toBe(`po_${V}_premium_monthly`)
    expect(llaveDeIdempotencia(V, 'PREMIUM:annual', 2)).toBe(`plan-offer-price:${V}:PREMIUM:annual:2`)
  })
})

describe('asegurarPrecioDeLaRanura', () => {
  it('crea el mensual de Pro en el producto del plan, con su llave propia, IVA incluido y su metadata completa', async () => {
    const r = await asegurarPrecioDeLaRanura(base())
    expect(r.priceId).toBe('price_1')
    expect(list).toHaveBeenCalledWith({ lookup_keys: [`po_${V}_pro_monthly`], limit: 2 }, { timeout: 15000, maxNetworkRetries: 0 })
    expect(create).toHaveBeenCalledWith(
      {
        product: 'prod_pro',
        lookup_key: `po_${V}_pro_monthly`,
        currency: 'mxn',
        unit_amount: 92684,
        tax_behavior: 'inclusive',
        recurring: { interval: 'month', interval_count: 1 },
        metadata: { kind: 'PLAN_OFFER_PRICE', planOfferVersionId: V, tier: 'PRO', interval: 'monthly' },
      },
      { idempotencyKey: `plan-offer-price:${V}:PRO:monthly:0`, timeout: 15000, maxNetworkRetries: 0 },
    )
    expect(JSON.stringify(create.mock.calls[0][0])).not.toContain('plan_pro_monthly')
  })

  it('🔴 respuesta perdida del anual: el almacén ya tiene el mensual y el anual de la misma versión; recupera el ANUAL', async () => {
    store.push(precio(`po_${V}_pro_monthly`), precio(`po_${V}_pro_annual`))
    const r = await asegurarPrecioDeLaRanura(base({ ranura: 'PRO:annual', grossCents: 1077120 }))
    expect(r.priceId).toBe(`price_po_${V}_pro_annual`)
    expect(create).not.toHaveBeenCalled()
  })

  it('🔴 con la llave de idempotencia caducada y el precio ya creado, no se duplica: lo encuentra por su llave de búsqueda', async () => {
    await asegurarPrecioDeLaRanura(base())
    idem.clear() // la llave de idempotencia caducó
    const r = await asegurarPrecioDeLaRanura(base())
    expect(r.priceId).toBe('price_1')
    expect(create).toHaveBeenCalledTimes(1)
    expect(store).toHaveLength(1)
  })

  it('🔴 un precio archivado que la lista no devuelve: el create choca por la llave (400) → RECHAZADO, y el almacén sigue con uno solo', async () => {
    store.push(precio(`po_${V}_pro_monthly`, { active: false }))
    almacen.hideArchived = true
    await expect(asegurarPrecioDeLaRanura(base())).rejects.toMatchObject({
      motivo: 'RECHAZADO',
      ranura: 'PRO:monthly',
      stripeCode: 'lookup_key_already_used',
    })
    expect(store).toHaveLength(1)
  })

  it('un precio archivado que la lista sí trae → NO_COINCIDE', async () => {
    store.push(precio(`po_${V}_pro_monthly`, { active: false }))
    await expect(asegurarPrecioDeLaRanura(base())).rejects.toMatchObject({ motivo: 'NO_COINCIDE' })
    expect(create).not.toHaveBeenCalled()
  })

  it('dos con la llave → DUPLICADO; has_more → DUPLICADO; no crea', async () => {
    const k = `po_${V}_pro_monthly`
    store.push(precio(k), precio(k, { id: 'price_otro' }))
    await expect(asegurarPrecioDeLaRanura(base())).rejects.toMatchObject({ motivo: 'DUPLICADO' })
    list.mockResolvedValueOnce({ data: [precio(k)], has_more: true })
    await expect(asegurarPrecioDeLaRanura(base())).rejects.toMatchObject({ motivo: 'DUPLICADO' })
    expect(create).not.toHaveBeenCalled()
  })

  it.each([
    ['otro monto', { unit_amount: 1 }],
    ['inactivo', { active: false }],
    ['otro producto', { product: 'prod_otro' }],
    ['otra moneda', { currency: 'usd' }],
    ['sin IVA incluido', { tax_behavior: 'exclusive' }],
    ['otro intervalo', { recurring: { interval: 'year', interval_count: 1 } }],
    ['interval_count 2', { recurring: { interval: 'month', interval_count: 2 } }],
    ['metadata de otra versión', { metadata: { kind: 'PLAN_OFFER_PRICE', planOfferVersionId: 'x', tier: 'PRO', interval: 'monthly' } }],
    ['metadata sin kind', { metadata: { planOfferVersionId: V, tier: 'PRO', interval: 'monthly' } }],
  ])('uno con %s → NO_COINCIDE; no crea', async (_n, over) => {
    store.push(precio(`po_${V}_pro_monthly`, over))
    await expect(asegurarPrecioDeLaRanura(base())).rejects.toMatchObject({ motivo: 'NO_COINCIDE' })
    expect(create).not.toHaveBeenCalled()
  })

  it('uno que la lista trae con otra llave de búsqueda → NO_COINCIDE; no crea', async () => {
    list.mockResolvedValueOnce({ data: [precio(`po_${V}_pro_monthly`, { lookup_key: 'otra' })], has_more: false })
    await expect(asegurarPrecioDeLaRanura(base())).rejects.toMatchObject({ motivo: 'NO_COINCIDE' })
    expect(create).not.toHaveBeenCalled()
  })

  it('acepta el producto como objeto expandido', async () => {
    store.push(precio(`po_${V}_pro_monthly`, { product: { id: 'prod_pro' } }))
    await expect(asegurarPrecioDeLaRanura(base())).resolves.toEqual({ priceId: `price_po_${V}_pro_monthly` })
  })

  it('un create que devuelve algo distinto → NO_COINCIDE', async () => {
    create.mockResolvedValueOnce(precio(`po_${V}_pro_monthly`, { unit_amount: 5 }))
    await expect(asegurarPrecioDeLaRanura(base())).rejects.toMatchObject({ motivo: 'NO_COINCIDE' })
  })

  it('🔴 con un 500 se lanza INCIERTO y el siguiente intento usa la MISMA llave (intento 0); el 500 guardado se repite', async () => {
    almacen.failNextCreateWith = { statusCode: 500 }
    await expect(asegurarPrecioDeLaRanura(base())).rejects.toMatchObject({ motivo: 'INCIERTO' })
    await expect(asegurarPrecioDeLaRanura(base())).rejects.toMatchObject({ motivo: 'INCIERTO' })
    const keys = create.mock.calls.map(c => c[1].idempotencyKey)
    expect(keys).toEqual([`plan-offer-price:${V}:PRO:monthly:0`, `plan-offer-price:${V}:PRO:monthly:0`])
    expect(store).toHaveLength(0)
  })

  it('🔴 Stripe creó el precio y la respuesta se perdió: INCIERTO; la siguiente vuelta lo recupera por su llave de búsqueda sin crear otro', async () => {
    almacen.loseNextCreateResponse = true
    await expect(asegurarPrecioDeLaRanura(base())).rejects.toMatchObject({ motivo: 'INCIERTO' })
    expect(store).toHaveLength(1)
    await expect(asegurarPrecioDeLaRanura(base())).resolves.toEqual({ priceId: 'price_1' })
    expect(create).toHaveBeenCalledTimes(1)
    expect(store).toHaveLength(1)
  })

  it('con un 400 se lanza RECHAZADO; la llave del intento 1 es distinta y ya crea', async () => {
    almacen.failNextCreateWith = { statusCode: 400, code: 'parameter_invalid' }
    await expect(asegurarPrecioDeLaRanura(base())).rejects.toMatchObject({ motivo: 'RECHAZADO', stripeCode: 'parameter_invalid' })
    const r = await asegurarPrecioDeLaRanura(base({ intento: 1 }))
    expect(r.priceId).toBe('price_1')
    expect(create.mock.calls.map(c => c[1].idempotencyKey)).toEqual([
      `plan-offer-price:${V}:PRO:monthly:0`,
      `plan-offer-price:${V}:PRO:monthly:1`,
    ])
  })

  it('una búsqueda fallida con 401 es INCIERTO (la llave de idempotencia nunca se usó) y no crea', async () => {
    list.mockRejectedValueOnce(new FakeStripeError(401, 'api_key_invalid'))
    const e = await asegurarPrecioDeLaRanura(base()).catch(x => x)
    expect(e).toBeInstanceOf(ErrorDePreparacion)
    expect(e.motivo).toBe('INCIERTO')
    expect(e.message).toContain('búsqueda')
    expect(create).not.toHaveBeenCalled()
  })

  it('conserva el error original de Stripe como cause', async () => {
    almacen.failNextCreateWith = { statusCode: 400, code: 'parameter_invalid' }
    const e = await asegurarPrecioDeLaRanura(base()).catch(x => x)
    expect(e.cause).toBeInstanceOf(FakeStripeError)
    expect(e.cause.statusCode).toBe(400)
    const orig = new FakeStripeError(500)
    list.mockRejectedValueOnce(orig)
    const e2 = await asegurarPrecioDeLaRanura(base()).catch(x => x)
    expect(e2.cause).toBe(orig)
  })

  it.each([
    ['grossCents con decimales', { grossCents: 1000.5 }],
    ['grossCents bajo el mínimo', { grossCents: 999 }],
    ['grossCents sobre el máximo', { grossCents: 10_000_001 }],
    ['grossCents NaN', { grossCents: NaN }],
    ['productId vacío', { productId: '' }],
  ])('entrada inválida (%s): Error simple y no crea nada', async (_n, over) => {
    const e = await asegurarPrecioDeLaRanura(base(over)).catch(x => x)
    expect(e).toBeInstanceOf(Error)
    expect(e).not.toBeInstanceOf(ErrorDePreparacion)
    expect(create).not.toHaveBeenCalled()
    expect(store).toHaveLength(0)
  })

  it('un error de lista sin statusCode no se traga: se lanza como INCIERTO', async () => {
    list.mockRejectedValueOnce(new Error('ECONNRESET'))
    const e = await asegurarPrecioDeLaRanura(base()).catch(x => x)
    expect(e).toBeInstanceOf(ErrorDePreparacion)
    expect(e.motivo).toBe('INCIERTO')
  })

  it('premium anual usa year y su tier en mayúsculas en la metadata', async () => {
    await asegurarPrecioDeLaRanura(base({ ranura: 'PREMIUM:annual', grossCents: 2000000, productId: 'prod_prem' }))
    expect(create.mock.calls[0][0]).toMatchObject({
      lookup_key: `po_${V}_premium_annual`,
      recurring: { interval: 'year', interval_count: 1 },
      metadata: { tier: 'PREMIUM', interval: 'annual' },
    })
  })
})

describe('clasificarErrorDeStripe', () => {
  it.each([
    ['sin statusCode (conexión)', 'INCIERTO', new Error('ECONNRESET')],
    ['null', 'INCIERTO', null],
    ['500', 'INCIERTO', new FakeStripeError(500)],
    ['503', 'INCIERTO', { statusCode: 503 }],
    ['429', 'INCIERTO', new FakeStripeError(429)],
    ['409 idempotency_key_in_use', 'INCIERTO', new FakeStripeError(409, 'idempotency_key_in_use')],
    ['418 desconocido', 'INCIERTO', { statusCode: 418 }],
    ['400', 'DEFINITIVO', new FakeStripeError(400)],
    ['401', 'DEFINITIVO', { statusCode: 401 }],
    ['402', 'DEFINITIVO', { statusCode: 402 }],
    ['403', 'DEFINITIVO', { statusCode: 403 }],
    ['404', 'DEFINITIVO', new FakeStripeError(404)],
  ])('clasificarErrorDeStripe: %s → %s', (_n, esperado, err) => {
    expect(clasificarErrorDeStripe(err)).toBe(esperado)
  })
})

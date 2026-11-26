/**
 * Planes editables B1, Task 2: la fuente `ofertaVigente` y sus reglas.
 *
 * 🔴 Lo que no se negocia aquí: sin versión se cae al respaldo (lo de hoy), pero una versión guardada que no pasa el
 * esquema es un 503 y NUNCA el respaldo (cobrar lo de hoy encima de una versión publicada cobraría otro precio). Y la v1
 * no cambia el camino del cobro: `versionQueCobra` sólo devuelve una versión del editor (número 2 o más).
 */
import {
  BRUTO_MAXIMO_CENTS,
  BRUTO_MINIMO_CENTS,
  CANDADO_DE_LA_OFERTA,
  brutoDeNeto,
  definicionDesdeEntrada,
  entradaDesdeDefinicion,
  existeVersionDeLaOferta,
  exigirSinVersionDeLaOferta,
  nombreDelProductoEnStripe,
  ofertaDeRespaldo,
  ofertaPorId,
  ofertaVigente,
  planOfferDefinition,
  planOfferInput,
  precioDeLaOferta,
  priceIdVigente,
  problemasDeLaOferta,
  ranurasQueCambian,
  tomarCandadoDeLaOferta,
  versionQueCobra,
  type PlanOfferInput,
} from '@/services/billing/planOffer'
import { prismaMock } from '@tests/__helpers__/setup'
import { definicionDePrueba, idsDeLaVersion, punteroA, versionUno } from '@tests/__helpers__/planOfferFixtures'

beforeEach(() => {
  prismaMock.planOfferPointer.findUnique.mockReset()
  prismaMock.planOfferVersion.findUnique.mockReset()
})

/** La entrada del founder que corresponde a lo de hoy, para cambiarle un solo valor por prueba. */
function entradaDeHoy(): PlanOfferInput {
  return entradaDesdeDefinicion(ofertaDeRespaldo())
}

describe('el dinero', () => {
  it('brutoDeNeto con numerador entero', () => {
    expect([99900, 79900, 99999, 169900, 999000, 1699000].map(brutoDeNeto)).toEqual([115884, 92684, 115999, 197084, 1158840, 1970840])
  })

  it('los topes del bruto son los de Stripe ($10) y del híbrido ($100,000)', () => {
    expect([BRUTO_MINIMO_CENTS, BRUTO_MAXIMO_CENTS]).toEqual([1000, 10_000_000])
  })
})

describe('el respaldo', () => {
  it('el respaldo es lo de hoy', () => {
    const d = ofertaDeRespaldo()
    expect(d.FREE.displayName).toBe('Gratis')
    expect(d.PRO).toMatchObject({
      displayName: 'Pro',
      onSale: true,
      requiresCard: true,
      trialDays: 30,
      stripeProductName: null,
      monthly: { netCents: 99900, grossCents: 115884, stripePriceId: null },
      annual: { netCents: 999000, grossCents: 1158840 },
    })
    expect(d.PREMIUM.monthly.grossCents).toBe(197084)
    expect(d.PREMIUM).toMatchObject({ displayName: 'Premium', annual: { netCents: 1699000, grossCents: 1970840, stripePriceId: null } })
  })

  it('pasa su propio esquema y cada llamada da una copia nueva (nadie puede dejar el precio del proceso en otro número)', () => {
    const a = ofertaDeRespaldo()
    expect(planOfferDefinition.safeParse(a).success).toBe(true)
    a.PRO.monthly.grossCents = 1
    expect(ofertaDeRespaldo().PRO.monthly.grossCents).toBe(115884)
  })
})

describe('ofertaVigente', () => {
  it('sin renglón del puntero, ofertaVigente es el respaldo con número 1', async () => {
    prismaMock.planOfferPointer.findUnique.mockResolvedValue(null)
    const r = await ofertaVigente()
    expect(r).toMatchObject({ number: 1, versionId: null, respaldo: true })
    expect(r.definition).toEqual(ofertaDeRespaldo())
  })

  it('con el renglón del puntero pero sin versión vigente, también es el respaldo', async () => {
    prismaMock.planOfferPointer.findUnique.mockResolvedValue({ id: 'vigente', currentVersionId: null, currentVersion: null } as never)
    expect(await ofertaVigente()).toMatchObject({ number: 1, versionId: null, respaldo: true })
  })

  it('con puntero, lee la versión vigente y su número', async () => {
    prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA('cv1aaaaaaaaaaaaaaaaaaaaaa', 1, versionUno()) as never)
    const r = await ofertaVigente()
    expect(r).toMatchObject({ number: 1, versionId: 'cv1aaaaaaaaaaaaaaaaaaaaaa', respaldo: false })
    expect(r.definition.PRO.monthly.stripePriceId).toBe('price_v1_pro_m')
    // Una sola lectura (sin caché): el puntero y su versión vigente juntos.
    expect(prismaMock.planOfferPointer.findUnique).toHaveBeenCalledTimes(1)
    expect(prismaMock.planOfferPointer.findUnique.mock.calls[0][0].where).toEqual({ id: 'vigente' })
  })

  it('sin caché: dos lecturas seguidas preguntan dos veces', async () => {
    prismaMock.planOfferPointer.findUnique
      .mockResolvedValueOnce(punteroA('cv1', 1, versionUno()) as never)
      .mockResolvedValueOnce(punteroA('cv2', 2, definicionDePrueba({ ids: idsDeLaVersion('v2') })) as never)
    expect((await ofertaVigente()).number).toBe(1)
    expect((await ofertaVigente()).number).toBe(2)
  })

  it('lee con la transacción que le pasen', async () => {
    const tx = { planOfferPointer: { findUnique: jest.fn().mockResolvedValue(punteroA('cv1', 1, versionUno())) } }
    expect((await ofertaVigente(tx as never)).versionId).toBe('cv1')
    expect(prismaMock.planOfferPointer.findUnique).not.toHaveBeenCalled()
  })

  it.each([
    [
      'le falta PREMIUM',
      () => {
        const d: Record<string, unknown> = versionUno()
        delete d.PREMIUM
        return d
      },
    ],
    ['trae un campo de más', () => ({ ...versionUno(), extra: true })],
    [
      'el bruto no es el del neto',
      () => {
        const d = versionUno()
        d.PRO.monthly.grossCents = 115885
        return d
      },
    ],
    ['schemaVersion 2', () => ({ ...versionUno(), schemaVersion: 2 })],
  ])('una definición guardada rota da 503 PLAN_NOT_CONFIGURED y nunca el respaldo (%s)', async (_caso, rota) => {
    prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA('cv2', 2, rota()) as never)
    await expect(ofertaVigente()).rejects.toMatchObject({ statusCode: 503, code: 'PLAN_NOT_CONFIGURED' })
  })

  it('una versión vigente sin número o que no está publicada también es un 503 (nunca el respaldo)', async () => {
    const sinNumero = punteroA('cv2', 2, versionUno())
    ;(sinNumero.currentVersion as any).number = null
    prismaMock.planOfferPointer.findUnique.mockResolvedValueOnce(sinNumero as never)
    await expect(ofertaVigente()).rejects.toMatchObject({ statusCode: 503, code: 'PLAN_NOT_CONFIGURED' })

    const preparando = punteroA('cv2', 2, versionUno())
    ;(preparando.currentVersion as any).status = 'PREPARING'
    prismaMock.planOfferPointer.findUnique.mockResolvedValueOnce(preparando as never)
    await expect(ofertaVigente()).rejects.toMatchObject({ statusCode: 503, code: 'PLAN_NOT_CONFIGURED' })
  })
})

describe('versionQueCobra y priceIdVigente', () => {
  it('🔴 versionQueCobra: sin versiones → null; con sólo la v1 → null; con la v2 vigente → la v2', async () => {
    prismaMock.planOfferPointer.findUnique.mockResolvedValueOnce(null)
    expect(await versionQueCobra()).toBeNull()

    // La v1 es una foto de lo de hoy: no cambia el camino del cobro, que sigue por la llave como B0.
    prismaMock.planOfferPointer.findUnique.mockResolvedValueOnce(punteroA('cv1', 1, versionUno()) as never)
    expect(await versionQueCobra()).toBeNull()

    const v2 = definicionDePrueba({ ids: idsDeLaVersion('v2'), netos: { 'PRO:monthly': 79900 } })
    prismaMock.planOfferPointer.findUnique.mockResolvedValueOnce(punteroA('cv2', 2, v2) as never)
    expect(await versionQueCobra()).toMatchObject({ number: 2, versionId: 'cv2', respaldo: false, definition: v2 })
  })

  it('priceIdVigente: null sin versión del editor; el de la ranura con la v2 (sin tocar Stripe)', async () => {
    prismaMock.planOfferPointer.findUnique.mockResolvedValueOnce(null)
    expect(await priceIdVigente('PRO', 'monthly')).toBeNull()
    prismaMock.planOfferPointer.findUnique.mockResolvedValueOnce(punteroA('cv1', 1, versionUno()) as never)
    expect(await priceIdVigente('PRO', 'monthly')).toBeNull()
    prismaMock.planOfferPointer.findUnique.mockResolvedValueOnce(
      punteroA('cv2', 2, definicionDePrueba({ ids: idsDeLaVersion('v2') })) as never,
    )
    expect(await priceIdVigente('PREMIUM', 'annual')).toBe('price_v2_premium_a')
  })

  it('una versión del editor publicada sin el priceId de la ranura es un 503 (no se confunde con «sin versión»)', async () => {
    prismaMock.planOfferPointer.findUnique.mockResolvedValue(
      punteroA('cv2', 2, definicionDePrueba({ ids: { ...idsDeLaVersion('v2'), 'PRO:annual': null } })) as never,
    )
    await expect(priceIdVigente('PRO', 'annual')).rejects.toMatchObject({ statusCode: 503, code: 'PLAN_NOT_CONFIGURED' })
  })

  it('precioDeLaOferta da la ranura pedida', () => {
    const d = definicionDePrueba({ ids: idsDeLaVersion('v2') })
    expect(precioDeLaOferta(d, 'PREMIUM', 'monthly')).toEqual({ netCents: 169900, grossCents: 197084, stripePriceId: 'price_v2_premium_m' })
  })
})

describe('ofertaPorId', () => {
  it('devuelve número, estado y definición; una en preparación no tiene número', async () => {
    prismaMock.planOfferVersion.findUnique.mockResolvedValue({
      id: 'cv3',
      number: null,
      status: 'PREPARING',
      definition: versionUno(),
    } as never)
    const r = await ofertaPorId('cv3')
    expect(r).toEqual({ number: null, status: 'PREPARING', definition: versionUno() })
    expect(prismaMock.planOfferVersion.findUnique.mock.calls[0][0].where).toEqual({ id: 'cv3' })
  })

  it('una que no existe es 404; una con la definición rota es 503', async () => {
    prismaMock.planOfferVersion.findUnique.mockResolvedValueOnce(null)
    await expect(ofertaPorId('nope')).rejects.toMatchObject({ statusCode: 404 })
    prismaMock.planOfferVersion.findUnique.mockResolvedValueOnce({ id: 'cv3', number: null, status: 'PREPARING', definition: {} } as never)
    await expect(ofertaPorId('cv3')).rejects.toMatchObject({ statusCode: 503, code: 'PLAN_NOT_CONFIGURED' })
  })
})

describe('problemasDeLaOferta', () => {
  it('lo de hoy no tiene problemas', () => {
    expect(problemasDeLaOferta(entradaDeHoy())).toEqual([])
  })

  it.each([
    [true, 5, 'PRO.trialDays'],
    [false, 0, 'PRO.trialDays'],
    [true, 91, 'PRO.trialDays'],
    [false, 91, 'PRO.trialDays'],
  ])('activación inválida: tarjeta %s con %i días → problema en %s', (requiresCard, trialDays, path) => {
    const e = entradaDeHoy()
    e.PRO = { ...e.PRO, requiresCard, trialDays }
    const problemas = problemasDeLaOferta(e)
    expect(problemas.map(p => p.path)).toEqual([path])
    expect(problemas[0].message).toMatch(/días/)
  })

  it.each([
    [true, 0],
    [true, 10],
    [true, 90],
    [false, 1],
    [false, 90],
  ])('activación válida: tarjeta %s con %i días', (requiresCard, trialDays) => {
    const e = entradaDeHoy()
    e.PREMIUM = { ...e.PREMIUM, requiresCard, trialDays }
    expect(problemasDeLaOferta(e)).toEqual([])
  })

  it('bruto fuera de rango', () => {
    const e = entradaDeHoy()
    e.PRO = { ...e.PRO, monthlyNetCents: 800 } // 928 < 1000
    e.PREMIUM = { ...e.PREMIUM, annualNetCents: 8_620_691 } // 10_000_002 > 10_000_000
    expect(problemasDeLaOferta(e).map(p => p.path)).toEqual(['PRO.monthlyNetCents', 'PREMIUM.annualNetCents'])

    const justo = entradaDeHoy()
    justo.PREMIUM = { ...justo.PREMIUM, annualNetCents: 8_620_690 } // 10_000_000 vale
    expect(problemasDeLaOferta(justo)).toEqual([])
  })

  it('nombres de 2 a 24 y distintos sin importar mayúsculas: Pro y «pro» → problema en PREMIUM.displayName', () => {
    const e = entradaDeHoy()
    e.PREMIUM = { ...e.PREMIUM, displayName: 'pro' }
    expect(problemasDeLaOferta(e).map(p => p.path)).toEqual(['PREMIUM.displayName'])
  })

  it.each([
    ['FREE', 'G'],
    ['PRO', 'P'.repeat(25)],
    ['PRO', '   '],
    ['PREMIUM', '-Premium'],
    ['PREMIUM', 'Premium!'],
  ] as const)('nombre inválido en %s: «%s»', (tier, displayName) => {
    const e = entradaDeHoy()
    e[tier] = { ...e[tier], displayName } as never
    expect(problemasDeLaOferta(e).map(p => p.path)).toEqual([`${tier}.displayName`])
  })

  it.each(['Pro Plus', 'Plus+', 'Básico 2.0', '  Ñu-Pro  ', 'Pr'])('nombre válido: «%s» (se mide recortado)', displayName => {
    const e = entradaDeHoy()
    e.PRO = { ...e.PRO, displayName }
    expect(problemasDeLaOferta(e)).toEqual([])
  })
})

describe('planOfferInput (lo que escribe el founder, sin IVA)', () => {
  it('acepta la entrada de hoy', () => {
    expect(planOfferInput.safeParse(entradaDeHoy()).success).toBe(true)
  })

  it.each([
    ['centavos con decimales', (e: any) => (e.PRO.monthlyNetCents = 99900.5)],
    ['centavos en cero', (e: any) => (e.PRO.annualNetCents = 0)],
    ['un campo de más', (e: any) => (e.PRO.grossCents = 1)],
    ['FREE con precio', (e: any) => (e.FREE.monthlyNetCents = 1)],
    ['días negativos', (e: any) => (e.PREMIUM.trialDays = -1)],
  ])('rechaza %s, con el mensaje en español', (_caso, romper) => {
    const e: any = entradaDeHoy()
    romper(e)
    const r = planOfferInput.safeParse(e)
    expect(r.success).toBe(false)
    // Sin los textos por defecto de zod (en inglés): la pantalla los muestra tal cual.
    if (!r.success) expect(r.error.issues[0].message).not.toMatch(/Expected|Unrecognized|must be|Required|Invalid/)
  })
})

describe('definicionDesdeEntrada', () => {
  it('definicionDesdeEntrada copia el priceId de lo que no cambió y deja null lo que cambió', () => {
    const vigente = versionUno()
    const entrada = entradaDesdeDefinicion(vigente)
    entrada.PRO.monthlyNetCents = 79900
    const nueva = definicionDesdeEntrada(entrada, vigente)
    expect(nueva.PRO.monthly).toEqual({ netCents: 79900, grossCents: 92684, stripePriceId: null })
    expect(nueva.PRO.annual.stripePriceId).toBe('price_v1_pro_a')
    expect(nueva.PREMIUM.monthly.stripePriceId).toBe('price_v1_premium_m')
    expect(nueva.PREMIUM.annual.stripePriceId).toBe('price_v1_premium_a')
    expect(planOfferDefinition.safeParse(nueva).success).toBe(true)
  })

  it('el nombre del producto se hereda si el nombre no cambió y se arma si cambió', () => {
    const v1 = versionUno()
    // Mismo nombre: null (la v1 no tiene nombre propio; nadie lo revisa ni lo renombra).
    expect(definicionDesdeEntrada(entradaDesdeDefinicion(v1), v1).PRO.stripeProductName).toBeNull()

    const entrada = entradaDesdeDefinicion(v1)
    entrada.PRO.displayName = 'Pro Plus'
    const v2 = definicionDesdeEntrada(entrada, v1)
    expect(v2.PRO).toMatchObject({ displayName: 'Pro Plus', stripeProductName: 'Plan Avoqado Pro Plus' })
    expect(v2.PREMIUM.stripeProductName).toBeNull()

    // v3 con el mismo nombre que v2 (sólo cambia un precio): hereda el nombre del producto.
    const entradaV3 = entradaDesdeDefinicion(v2)
    entradaV3.PREMIUM.monthlyNetCents = 179900
    expect(definicionDesdeEntrada(entradaV3, v2).PRO.stripeProductName).toBe('Plan Avoqado Pro Plus')
  })

  it('guarda los nombres recortados', () => {
    const v1 = versionUno()
    const entrada = entradaDesdeDefinicion(v1)
    entrada.FREE.displayName = '  Gratis  '
    entrada.PRO.displayName = ' Pro '
    const nueva = definicionDesdeEntrada(entrada, v1)
    expect(nueva.FREE.displayName).toBe('Gratis')
    expect(nueva.PRO).toMatchObject({ displayName: 'Pro', stripeProductName: null })
  })

  it('nombreDelProductoEnStripe', () => {
    expect(nombreDelProductoEnStripe('Pro Plus')).toBe('Plan Avoqado Pro Plus')
  })

  it('entradaDesdeDefinicion devuelve los netos, sin IVA ni priceId', () => {
    expect(entradaDesdeDefinicion(versionUno())).toEqual({
      FREE: { displayName: 'Gratis' },
      PRO: { displayName: 'Pro', onSale: true, requiresCard: true, trialDays: 30, monthlyNetCents: 99900, annualNetCents: 999000 },
      PREMIUM: {
        displayName: 'Premium',
        onSale: true,
        requiresCard: true,
        trialDays: 30,
        monthlyNetCents: 169900,
        annualNetCents: 1699000,
      },
    })
  })
})

describe('ranurasQueCambian', () => {
  it('ranurasQueCambian → ["PRO:monthly"]', () => {
    const vigente = versionUno()
    const entrada = entradaDesdeDefinicion(vigente)
    entrada.PRO.monthlyNetCents = 79900
    entrada.PREMIUM.displayName = 'Premium Plus' // el nombre no es una ranura de precio
    expect(ranurasQueCambian(definicionDesdeEntrada(entrada, vigente), vigente)).toEqual(['PRO:monthly'])
  })

  it('todas, en orden fijo', () => {
    const vigente = versionUno()
    const nueva = definicionDePrueba({
      netos: { 'PRO:monthly': 1, 'PRO:annual': 2, 'PREMIUM:monthly': 3, 'PREMIUM:annual': 4 },
    })
    expect(ranurasQueCambian(nueva, vigente)).toEqual(['PRO:monthly', 'PRO:annual', 'PREMIUM:monthly', 'PREMIUM:annual'])
  })
})

describe('el candado y la negativa de los escritores viejos', () => {
  it('tomarCandadoDeLaOferta toma plan-offer-publish con la transacción', async () => {
    const tx = { $executeRaw: jest.fn().mockResolvedValue(1) }
    await tomarCandadoDeLaOferta(tx as never)
    expect(CANDADO_DE_LA_OFERTA).toBe('plan-offer-publish')
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1)
    const [plantilla, ...valores] = tx.$executeRaw.mock.calls[0]
    expect(plantilla.join('?')).toContain('pg_advisory_xact_lock(hashtext(?))')
    expect(valores).toEqual(['plan-offer-publish'])
  })

  it('existeVersionDeLaOferta: con vigente sí; sin renglón o sin vigente, no', async () => {
    prismaMock.planOfferPointer.findUnique.mockResolvedValueOnce(punteroA('cv1', 1, versionUno()) as never)
    expect(await existeVersionDeLaOferta()).toBe(true)
    prismaMock.planOfferPointer.findUnique.mockResolvedValueOnce(null)
    expect(await existeVersionDeLaOferta()).toBe(false)
    prismaMock.planOfferPointer.findUnique.mockResolvedValueOnce({ id: 'vigente', currentVersionId: null } as never)
    expect(await existeVersionDeLaOferta()).toBe(false)
  })

  it('exigirSinVersionDeLaOferta lanza 409 PLAN_OFFER_OWNS_PLAN_LISTS con versión vigente y no lanza sin ella', async () => {
    prismaMock.planOfferPointer.findUnique.mockResolvedValueOnce(punteroA('cv1', 1, versionUno()) as never)
    await expect(exigirSinVersionDeLaOferta('seed-plan-pro')).rejects.toMatchObject({
      statusCode: 409,
      code: 'PLAN_OFFER_OWNS_PLAN_LISTS',
      message: 'Los planes ya se publican desde «Planes» en el SUPERADMIN',
    })
    prismaMock.planOfferPointer.findUnique.mockResolvedValueOnce(null)
    await expect(exigirSinVersionDeLaOferta('seed-plan-pro')).resolves.toBeUndefined()
  })

  it('con db, exigirSinVersionDeLaOferta lee dentro de esa transacción', async () => {
    const tx = { planOfferPointer: { findUnique: jest.fn().mockResolvedValue({ id: 'vigente', currentVersionId: 'cv1' }) } }
    await expect(exigirSinVersionDeLaOferta('saveList', tx as never)).rejects.toMatchObject({ code: 'PLAN_OFFER_OWNS_PLAN_LISTS' })
    expect(tx.planOfferPointer.findUnique).toHaveBeenCalledTimes(1)
    expect(prismaMock.planOfferPointer.findUnique).not.toHaveBeenCalled()
  })
})

/**
 * Planes editables B1, Task 6: vista previa, publicar, reintentar y descartar una versión de la oferta.
 *
 * Corre sobre una base EN MEMORIA (`planOfferFakeDb`) con transacciones que se deshacen, candados que esperan y `jsonb_set` que sólo se
 * aplica con el `WHERE` que escribe el servicio: así las carreras (dos reintentos, un rechazo tardío, descartar o apagar a media
 * publicación) se prueban de verdad. Stripe es un almacén simulado como el de Task 5 (guarda la respuesta de cada llave de
 * idempotencia). Las listas híbridas `PLAN:*` corren con el código real (`prepararListaDelPlan`, `finalizarListaDelPlanEn`,
 * `soltarListaPendienteDelPlanEn`); sólo `ensureHybridPublicationPrices`, la regla de precio de lista y el interruptor se simulan.
 *
 * 🔴 En TODAS las pruebas: ninguna llamada a Stripe (ni `ensureHybridPublicationPrices`) ocurre con `plan-offer-publish` tomado.
 */
type PrecioDeStripe = Record<string, any>
const precios: PrecioDeStripe[] = []
const idem = new Map<string, { ok: boolean; value: any }>()
/** Las siguientes llamadas a `prices.create` fallan así (`guardar`: Stripe guarda la respuesta para esa llave, como un 500 real). */
const fallasDeCrear: Array<{ statusCode?: number; guardar: boolean }> = []
/** Las siguientes llamadas a `prices.create` se detienen aquí antes de hacer nada (la primera toma la primera). */
const pausasDeCrear: Array<Promise<void>> = []
/** Llamadas a Stripe o a `ensureHybridPublicationPrices` hechas con `plan-offer-publish` tomado. */
const violaciones: string[] = []
const stripeList = jest.fn()
const stripeCreate = jest.fn()
const mockEnsure = jest.fn()
const mockRotas = jest.fn()
const mockRegla = jest.fn()

class ErrorDeStripe extends Error {
  type = 'StripeAPIError'
  requestId = 'req_prueba'
  constructor(public statusCode?: number) {
    super(`stripe ${statusCode ?? 'sin respuesta'}`)
  }
}

jest.mock('@/services/stripe.service', () => ({
  stripe: { prices: { list: (...a: unknown[]) => stripeList(...a), create: (...a: unknown[]) => stripeCreate(...a) } },
}))
jest.mock('@/services/launchCampaigns/hybridPrices', () => ({ ensureHybridPublicationPrices: (...a: unknown[]) => mockEnsure(...a) }))
jest.mock('@/services/launchCampaigns/hybridPriceRule', () => ({
  promotionsBrokenByList: (...a: unknown[]) => mockRotas(...a),
  assertPriceRuleForList: (...a: unknown[]) => mockRegla(...a),
}))
/** `cache`: lo que contesta la lectura con caché; `real`: la fila (lo que lee una transacción). */
const interruptor = { cache: true, real: true }
const lecturasDelInterruptor: Array<{ opciones: Record<string, unknown>; candados: string[] }> = []
jest.mock('@/services/billing/interruptorPlanesEditables', () => ({
  planesEditablesPrendidos: async (opciones: { sinCache?: boolean; db?: object } = {}) => {
    lecturasDelInterruptor.push({ opciones: { ...opciones, db: opciones.db ? 'tx' : undefined }, candados: [] })
    if (opciones.db) lecturasDelInterruptor[lecturasDelInterruptor.length - 1].candados = mockCandadosDe(opciones.db)
    return opciones.db || opciones.sinCache ? interruptor.real : interruptor.cache
  },
  estadoDelInterruptor: async () => ({ prendido: interruptor.real, desde: null, actualizadoPor: null, faltan: [] }),
}))
let mockCandadosDe: (tx: object) => string[] = () => []
// Task 8: el intento inmediato del renombre en Stripe (el job propio se prueba en su suite).
const mockRunNow = jest.fn()
jest.mock('@/jobs/plan-offer-rename.job', () => ({ planOfferRenameJob: { runNow: (...a: unknown[]) => mockRunNow(...a) } }))

import logger from '@/config/logger'
import { ofertaVigente, tomarCandadoDeLaOferta } from '@/services/billing/planOffer'
import {
  descartarPublicacion,
  estadoDeLaOferta,
  estadoDespuesDeConfirmar,
  publicarVersion,
  reintentarPublicacion,
  vistaPreviaDeLaOferta,
} from '@/services/billing/planOfferPublisher'
import { prismaMock } from '@tests/__helpers__/setup'
import { crearBaseDePrueba, pausa, vueltas, type BaseDePrueba } from '@tests/__helpers__/planOfferFakeDb'
import { definicionDeLaListaDelPlan, idsDeLaVersion, versionUno } from '@tests/__helpers__/planOfferFixtures'

let base: BaseDePrueba
const STAFF = 'staff_super'

type EntradaDelPlan = {
  displayName: string
  onSale: boolean
  requiresCard: boolean
  trialDays: number
  monthlyNetCents: number
  annualNetCents: number
}
/** La entrada de hoy (la v1), escrita a mano, con los cambios pedidos por plan. */
function entrada(cambios: { FREE?: { displayName: string }; PRO?: Partial<EntradaDelPlan>; PREMIUM?: Partial<EntradaDelPlan> } = {}) {
  const plan = (displayName: string, monthlyNetCents: number, annualNetCents: number) => ({
    displayName,
    onSale: true,
    requiresCard: true,
    trialDays: 30,
    monthlyNetCents,
    annualNetCents,
  })
  return {
    FREE: { displayName: 'Gratis', ...cambios.FREE },
    PRO: { ...plan('Pro', 99900, 999000), ...cambios.PRO },
    PREMIUM: { ...plan('Premium', 169900, 1699000), ...cambios.PREMIUM },
  }
}
/** Pro mensual de $799 + IVA: $926.84 con IVA. */
const PRO_MENSUAL_NUEVO = { monthlyNetCents: 79900 }

const version = (id: string) => base.fila('planOfferVersion', id)!
const puntero = () => base.fila('planOfferPointer', 'vigente')!
const lista = (tier: 'PRO' | 'PREMIUM') => base.fila('hybridCampaign', tier === 'PRO' ? 'list_pro' : 'list_premium')!
const pendienteId = () => puntero().pendingVersionId as string
const llamadasAStripe = () => stripeList.mock.calls.length + stripeCreate.mock.calls.length
/** Las escrituras de `preparacion.ultimoError`, en orden. */
const notasDeUltimoError = () => base.historial.filter(h => h.columna === 'preparacion' && h.ruta[0] === 'ultimoError')
const ultimaNota = () => notasDeUltimoError()[notasDeUltimoError().length - 1]

function sembrarHoy() {
  base.sembrar('planOfferVersion', {
    id: 'cv1',
    number: 1,
    status: 'PUBLISHED',
    definition: versionUno(),
    hybridPublicationIds: { PRO: 'pub_pro', PREMIUM: 'pub_premium' },
    publishedAt: new Date('2026-11-25T12:00:00Z'),
    publishedById: 'staff_semilla',
  })
  base.sembrar('planOfferPointer', { id: 'vigente', currentVersionId: 'cv1', pendingVersionId: null, revision: 1, nombresEnStripe: null })
  for (const [tier, precio] of [
    ['PRO', 1158.84],
    ['PREMIUM', 1970.84],
  ] as const) {
    const sufijo = tier.toLowerCase()
    base.sembrar('hybridCampaign', {
      id: `list_${sufijo}`,
      purpose: 'LIST',
      listProductKey: `PLAN:${tier}`,
      code: `L_PLAN_${tier}`,
      slug: `lista-plan-${sufijo}`,
      name: `Plan ${tier === 'PRO' ? 'Pro' : 'Premium'}`,
      status: 'ACTIVE',
      revision: 3,
      currentPublicationId: `pub_${sufijo}`,
      pendingPublicationId: null,
    })
    base.sembrar('hybridOfferPublication', {
      id: `pub_${sufijo}`,
      campaignId: `list_${sufijo}`,
      version: 2,
      name: `Plan ${tier === 'PRO' ? 'Pro' : 'Premium'}`,
      definition: definicionDeLaListaDelPlan(tier, precio),
      stripePriceId: `price_h_${sufijo}`,
      stripeProductId: `prod_h_${sufijo}`,
    })
  }
  base.sembrar('feature', { id: 'f_pro', code: 'PLAN_PRO', active: true, stripeProductId: 'prod_pro' })
  base.sembrar('feature', { id: 'f_premium', code: 'PLAN_PREMIUM', active: true, stripeProductId: 'prod_premium' })
}

const campanaActiva = (planTier: 'PRO' | 'PREMIUM', id = 'lc_pos22') =>
  base.sembrar('launchCampaign', {
    id,
    code: 'POS22',
    name: 'Campaña de prueba',
    status: 'ACTIVE',
    planTier,
    createdAt: new Date('2026-11-01T00:00:00Z'),
  })

/** Una publicación que se quedó PREPARING: la primera creación de Stripe no llegó (sin respuesta, nada guardado). */
async function publicacionAtorada(cambios: Parameters<typeof entrada>[0] = { PRO: PRO_MENSUAL_NUEVO }) {
  fallasDeCrear.push({ statusCode: undefined, guardar: false })
  await expect(publicarVersion(entrada(cambios), 1, STAFF)).rejects.toMatchObject({ code: 'PLAN_OFFER_PREPARING' })
  return pendienteId()
}

beforeEach(() => {
  base = crearBaseDePrueba(prismaMock)
  mockCandadosDe = tx => base.candadosDe(tx)
  sembrarHoy()
  interruptor.cache = true
  interruptor.real = true
  lecturasDelInterruptor.length = 0
  precios.length = 0
  idem.clear()
  fallasDeCrear.length = 0
  pausasDeCrear.length = 0
  violaciones.length = 0
  const vigilar = (que: string) => {
    if (base.candadoTomado('plan-offer-publish')) violaciones.push(que)
  }
  stripeList.mockReset().mockImplementation(async (params: { lookup_keys: string[]; limit: number }) => {
    vigilar('prices.list')
    const data = precios.filter(p => params.lookup_keys.includes(p.lookup_key))
    return { object: 'list', data: data.slice(0, params.limit), has_more: data.length > params.limit }
  })
  stripeCreate.mockReset().mockImplementation(async (params: PrecioDeStripe, opciones: { idempotencyKey: string }) => {
    vigilar('prices.create')
    const detenida = pausasDeCrear.shift()
    if (detenida) await detenida
    const guardada = idem.get(opciones.idempotencyKey)
    if (guardada) {
      if (guardada.ok) return guardada.value
      throw guardada.value
    }
    const falla = fallasDeCrear.shift()
    if (falla) {
      const error = new ErrorDeStripe(falla.statusCode)
      if (falla.guardar) idem.set(opciones.idempotencyKey, { ok: false, value: error })
      throw error
    }
    const precio = { id: `price_n${precios.length + 1}`, object: 'price', active: true, ...params }
    precios.push(precio)
    idem.set(opciones.idempotencyKey, { ok: true, value: precio })
    return precio
  })
  mockEnsure.mockReset().mockImplementation(async (publicationId: string) => {
    vigilar('ensureHybridPublicationPrices')
    base.tablas.hybridOfferPublication.set(publicationId, {
      ...base.tablas.hybridOfferPublication.get(publicationId)!,
      stripePriceId: `price_h_${publicationId}`,
      stripeProductId: `prod_h_${publicationId}`,
    })
  })
  mockRotas.mockReset().mockResolvedValue([])
  mockRegla.mockReset().mockResolvedValue(undefined)
  mockRunNow.mockReset().mockResolvedValue(null)
})

afterEach(() => {
  expect(violaciones).toEqual([])
})

describe('el interruptor', () => {
  it('apagado: publicarVersion y reintentarPublicacion → 409 PLAN_EDIT_DISABLED; descartar sí funciona', async () => {
    const atorada = await publicacionAtorada()
    interruptor.cache = false
    interruptor.real = false
    stripeList.mockClear()
    stripeCreate.mockClear()

    await expect(publicarVersion(entrada({ PREMIUM: { trialDays: 14 } }), 2, STAFF)).rejects.toMatchObject({
      statusCode: 409,
      code: 'PLAN_EDIT_DISABLED',
    })
    await expect(reintentarPublicacion(atorada, STAFF)).rejects.toMatchObject({ statusCode: 409, code: 'PLAN_EDIT_DISABLED' })
    expect(llamadasAStripe()).toBe(0)
    expect(base.tablas.planOfferVersion.size).toBe(2)

    const estado = await descartarPublicacion(atorada, STAFF)
    expect(version(atorada)).toMatchObject({ status: 'DISCARDED', number: null, discardedById: STAFF })
    expect(estado.pendiente).toBeNull()
    expect(puntero()).toMatchObject({ currentVersionId: 'cv1', pendingVersionId: null })
  })

  it('🔴 apagar confirma mientras la publicación espera el candado: el inicio lee el interruptor con su tx y responde PLAN_EDIT_DISABLED sin crear la versión', async () => {
    const apagar = pausa()
    // «Apagar» ya tomó plan-offer-publish y está por confirmar.
    const apagado = prismaMock.$transaction(async (tx: any) => {
      await tomarCandadoDeLaOferta(tx)
      await apagar.promesa
      interruptor.real = false
    })
    await vueltas()

    const publicacion = publicarVersion(entrada({ PRO: PRO_MENSUAL_NUEVO }), 1, STAFF).catch(e => e)
    await vueltas()
    // Pasó la revisión rápida (caché: prendido) y espera el candado.
    expect(base.llamadasA('planOfferVersion', 'create')).toHaveLength(0)

    apagar.soltar()
    await apagado
    expect(await publicacion).toMatchObject({ statusCode: 409, code: 'PLAN_EDIT_DISABLED' })
    const enLaTransaccion = lecturasDelInterruptor.filter(l => l.opciones.db)
    expect(enLaTransaccion).toEqual([{ opciones: { sinCache: true, db: 'tx' }, candados: ['plan-offer-publish'] }])
    expect(base.llamadasA('planOfferVersion', 'create')).toHaveLength(0)
    expect(puntero()).toMatchObject({ currentVersionId: 'cv1', pendingVersionId: null, revision: 1 })
    expect(llamadasAStripe()).toBe(0)
  })
})

describe('validar', () => {
  it('publicarVersion y vistaPreviaDeLaOferta validan esquema y reglas (400 PLAN_OFFER_INVALID con details.issues); la vista previa no escribe', async () => {
    const enTexto = { ...entrada(), PRO: { ...entrada().PRO, monthlyNetCents: '79900' } }
    const pruebaCorta = entrada({ PRO: { trialDays: 5 } })
    for (const llamar of [(e: unknown) => publicarVersion(e, 1, STAFF), (e: unknown) => vistaPreviaDeLaOferta(e)]) {
      await expect(llamar(enTexto)).rejects.toMatchObject({
        statusCode: 400,
        code: 'PLAN_OFFER_INVALID',
        details: { issues: [{ path: 'PRO.monthlyNetCents', message: expect.any(String) }] },
      })
      await expect(llamar(pruebaCorta)).rejects.toMatchObject({
        statusCode: 400,
        code: 'PLAN_OFFER_INVALID',
        details: { issues: [{ path: 'PRO.trialDays', message: 'Con tarjeta, la prueba es de 0 días (paga hoy) o de 10 a 90 días.' }] },
      })
    }

    base.gruposDeSuscripciones.push({ stripePriceId: 'price_v1_pro_m', _count: { _all: 7 } })
    const vista = await vistaPreviaDeLaOferta(entrada({ PRO: PRO_MENSUAL_NUEVO }))
    expect(vista).toEqual({
      cambios: [{ plan: 'PRO', campo: 'monthlyNetCents', antes: 99900, despues: 79900 }],
      preciosNuevos: ['PRO:monthly'],
      bloqueos: { campanas: [], promociones: [] },
      conservanSuPrecio: { 'PRO:monthly': 7, 'PRO:annual': 0, 'PREMIUM:monthly': 0, 'PREMIUM:annual': 0 },
      problemas: [],
    })
    // La consulta de quién conserva su precio va acotada a los cuatro precios vigentes.
    const [grupos] = base.llamadasA('venueFeature', 'groupBy')
    expect(grupos.args.where).toEqual({
      active: true,
      stripeSubscriptionId: { not: null },
      stripePriceId: { in: Object.values(idsDeLaVersion('v1')) },
    })
    expect(mockRotas).toHaveBeenCalledWith(expect.anything(), 'PLAN:PRO', 926.84)
    // Nada se escribió.
    const escrituras = base.llamadas.filter(l => ['create', 'update', 'updateMany'].includes(l.metodo))
    expect(escrituras).toEqual([])
    expect(base.historial).toEqual([])
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
    expect(llamadasAStripe()).toBe(0)
  })

  it('publicar sin cambios → 400 PLAN_OFFER_UNCHANGED', async () => {
    await expect(publicarVersion(entrada(), 1, STAFF)).rejects.toMatchObject({ statusCode: 400, code: 'PLAN_OFFER_UNCHANGED' })
    // Un espacio de más en el nombre tampoco es un cambio.
    await expect(publicarVersion(entrada({ PRO: { displayName: ' Pro ' } }), 1, STAFF)).rejects.toMatchObject({
      code: 'PLAN_OFFER_UNCHANGED',
    })
    expect(base.tablas.planOfferVersion.size).toBe(1)
  })
})

describe('campañas y promociones', () => {
  it('con una campaña ACTIVE de Pro y el mensual de Pro cambiando → 409 PLAN_PRICE_BLOCKED_BY_CAMPAIGNS con la campaña y sin crear nada en Stripe', async () => {
    campanaActiva('PRO')
    const campana = { id: 'lc_pos22', code: 'POS22', name: 'Campaña de prueba', planTier: 'PRO' }

    await expect(publicarVersion(entrada({ PRO: PRO_MENSUAL_NUEVO }), 1, STAFF)).rejects.toMatchObject({
      statusCode: 409,
      code: 'PLAN_PRICE_BLOCKED_BY_CAMPAIGNS',
      details: { motivo: 'PRECIO', campaigns: [{ ...campana, motivo: 'PRECIO' }] },
    })
    expect(llamadasAStripe()).toBe(0)
    expect(base.tablas.planOfferVersion.size).toBe(1)
    expect(puntero().revision).toBe(1)
    expect((await vistaPreviaDeLaOferta(entrada({ PRO: PRO_MENSUAL_NUEVO }))).bloqueos.campanas).toEqual([campana])
  })

  it('cambiar sólo el anual de Pro con una campaña ACTIVE de Pro sí se publica', async () => {
    campanaActiva('PRO')
    const r = await publicarVersion(entrada({ PRO: { annualNetCents: 899000 } }), 1, STAFF)

    expect(r.number).toBe(2)
    expect(stripeCreate).toHaveBeenCalledTimes(1)
    expect(stripeCreate.mock.calls[0][0]).toMatchObject({ lookup_key: `po_${r.versionId}_pro_annual`, unit_amount: 1042840 })
  })

  it('sacar Pro de venta con una campaña ACTIVE de Pro → 409 motivo FUERA_DE_VENTA', async () => {
    campanaActiva('PRO')
    await expect(publicarVersion(entrada({ PRO: { onSale: false } }), 1, STAFF)).rejects.toMatchObject({
      statusCode: 409,
      code: 'PLAN_PRICE_BLOCKED_BY_CAMPAIGNS',
      details: { motivo: 'FUERA_DE_VENTA', campaigns: [expect.objectContaining({ id: 'lc_pos22', motivo: 'FUERA_DE_VENTA' })] },
    })
    // Una campaña de Premium no frena sacar Pro de venta.
    base.tablas.launchCampaign.clear()
    campanaActiva('PREMIUM', 'lc_premium')
    await expect(publicarVersion(entrada({ PRO: { onSale: false } }), 1, STAFF)).resolves.toMatchObject({ number: 2 })
  })

  it('una promoción que el mensual nuevo rompería → 409 HYBRID_LIST_BREAKS_PROMOTIONS sin crear nada', async () => {
    const rota = { campaignId: 'promo1', campaignName: 'Promo', price: 999, renewalPrice: null, listPrice: 926.84, revision: 1 }
    mockRotas.mockImplementation(async (_tx: unknown, key: string) => (key === 'PLAN:PRO' ? [rota] : []))
    await expect(publicarVersion(entrada({ PRO: PRO_MENSUAL_NUEVO }), 1, STAFF)).rejects.toMatchObject({
      statusCode: 409,
      code: 'HYBRID_LIST_BREAKS_PROMOTIONS',
      details: [rota],
    })
    expect(base.tablas.planOfferVersion.size).toBe(1)
    expect(llamadasAStripe()).toBe(0)
  })
})

describe('preparar los precios', () => {
  it('🔴 sólo se crean los precios que cambiaron: cambia Pro mensual → un prices.create; los otros tres priceId se copian', async () => {
    const r = await publicarVersion(entrada({ PRO: PRO_MENSUAL_NUEVO }), 1, STAFF)

    expect(stripeCreate).toHaveBeenCalledTimes(1)
    const [params, opciones] = stripeCreate.mock.calls[0]
    expect(params).toEqual({
      product: 'prod_pro',
      lookup_key: `po_${r.versionId}_pro_monthly`,
      currency: 'mxn',
      unit_amount: 92684,
      tax_behavior: 'inclusive',
      recurring: { interval: 'month', interval_count: 1 },
      metadata: { kind: 'PLAN_OFFER_PRICE', planOfferVersionId: r.versionId, tier: 'PRO', interval: 'monthly' },
    })
    expect(opciones).toMatchObject({ idempotencyKey: `plan-offer-price:${r.versionId}:PRO:monthly:0` })
    const v1 = idsDeLaVersion('v1')
    const def = version(r.versionId).definition
    expect(def.PRO.monthly).toEqual({ netCents: 79900, grossCents: 92684, stripePriceId: precios[0].id })
    expect([def.PRO.annual.stripePriceId, def.PREMIUM.monthly.stripePriceId, def.PREMIUM.annual.stripePriceId]).toEqual([
      v1['PRO:annual'],
      v1['PREMIUM:monthly'],
      v1['PREMIUM:annual'],
    ])
    // 🔴 Cada priceId se escribió con jsonb_set sobre su ranura, nunca reescribiendo el JSON entero.
    expect(base.llamadasA('planOfferVersion', 'update')).toHaveLength(0)
    expect(base.historial.filter(h => h.columna === 'definition')).toEqual([
      expect.objectContaining({ ruta: ['PRO', 'monthly', 'stripePriceId'], valor: precios[0].id, aplicada: true }),
    ])
  })

  it('cambiar sólo días de prueba o la tarjeta: cero precios y la lista híbrida reusada', async () => {
    const r = await publicarVersion(entrada({ PRO: { trialDays: 14 }, PREMIUM: { requiresCard: false, trialDays: 14 } }), 1, STAFF)

    expect(r.number).toBe(2)
    expect(llamadasAStripe()).toBe(0)
    expect(mockEnsure).not.toHaveBeenCalled()
    expect(version(r.versionId)).toMatchObject({
      status: 'PUBLISHED',
      hybridPublicationIds: { PRO: 'pub_pro', PREMIUM: 'pub_premium' },
      definition: { PRO: { trialDays: 14 }, PREMIUM: { requiresCard: false, trialDays: 14 } },
    })
    expect(lista('PRO')).toMatchObject({ currentPublicationId: 'pub_pro', pendingPublicationId: null, revision: 3 })
    expect(lista('PREMIUM')).toMatchObject({ currentPublicationId: 'pub_premium', pendingPublicationId: null, revision: 3 })
    expect(base.tablas.hybridOfferPublication.size).toBe(2)
  })

  it('la versión nace con preparacion.intentos en 0 para las cuatro ranuras y hybridPublicationIds { PRO: null, PREMIUM: null }', async () => {
    const atorada = await publicacionAtorada()

    const [creada] = base.llamadasA('planOfferVersion', 'create')
    expect(creada.args.data).toMatchObject({
      status: 'PREPARING',
      basedOnVersionId: 'cv1',
      createdById: STAFF,
      preparacion: { intentos: { PRO_monthly: 0, PRO_annual: 0, PREMIUM_monthly: 0, PREMIUM_annual: 0 }, ultimoError: null },
      hybridPublicationIds: { PRO: null, PREMIUM: null },
    })
    expect(creada.args.data.definition.PRO.monthly.stripePriceId).toBeNull()
    expect(puntero()).toMatchObject({ currentVersionId: 'cv1', pendingVersionId: atorada, revision: 2 })
  })

  it('🔴 Stripe falla en Pro mensual: 409 PLAN_OFFER_PREPARING, el puntero sigue en v1 y la pendiente queda; la vigente se sigue vendiendo', async () => {
    fallasDeCrear.push({ statusCode: 500, guardar: true })
    const err = await publicarVersion(entrada({ PRO: PRO_MENSUAL_NUEVO }), 1, STAFF).catch(e => e)
    const atorada = pendienteId()

    expect(err).toMatchObject({
      statusCode: 409,
      code: 'PLAN_OFFER_PREPARING',
      details: { versionId: atorada, etapa: 'PRECIO', ranura: 'PRO:monthly', motivo: 'INCIERTO' },
    })
    expect(err.message.endsWith('Si se repite, descarta esta versión y vuelve a publicarla.')).toBe(true)
    // La causa de Stripe va al log, nunca a la respuesta.
    expect(JSON.stringify(err.details)).not.toContain('stripe 500')
    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        causa: expect.objectContaining({ message: 'stripe 500', type: 'StripeAPIError', requestId: 'req_prueba' }),
      }),
    )
    expect(puntero()).toMatchObject({ currentVersionId: 'cv1', pendingVersionId: atorada, revision: 2 })
    expect(version(atorada)).toMatchObject({
      status: 'PREPARING',
      preparacion: {
        intentos: { PRO_monthly: 0 },
        ultimoError: { etapa: 'PRECIO', ranura: 'PRO:monthly', motivo: 'INCIERTO', at: expect.any(String) },
      },
    })
    expect(new Date(version(atorada).preparacion.ultimoError.at).toISOString()).toBe(version(atorada).preparacion.ultimoError.at)
    const vigente = await ofertaVigente()
    expect(vigente).toMatchObject({ number: 1, versionId: 'cv1' })
    expect(vigente.definition.PRO.monthly.stripePriceId).toBe(idsDeLaVersion('v1')['PRO:monthly'])
    expect(lista('PRO')).toMatchObject({ currentPublicationId: 'pub_pro', pendingPublicationId: null })
  })

  it('una segunda publicación mientras hay una PREPARING → 409 PLAN_OFFER_PENDING', async () => {
    const atorada = await publicacionAtorada()

    await expect(publicarVersion(entrada({ PREMIUM: { trialDays: 14 } }), 2, STAFF)).rejects.toMatchObject({
      statusCode: 409,
      code: 'PLAN_OFFER_PENDING',
      details: { pendingVersionId: atorada },
    })
    // Con la revisión de antes de la pendiente, la oferta ya cambió.
    await expect(publicarVersion(entrada({ PREMIUM: { trialDays: 14 } }), 1, STAFF)).rejects.toMatchObject({ code: 'PLAN_OFFER_STALE' })
    expect(base.tablas.planOfferVersion.size).toBe(2)
  })

  it('RECHAZADO guarda intento 1 antes de responder; INCIERTO deja intento 0', async () => {
    fallasDeCrear.push({ statusCode: 400, guardar: true })
    const rechazo = await publicarVersion(entrada({ PRO: PRO_MENSUAL_NUEVO }), 1, STAFF).catch(e => e)
    const atorada = pendienteId()
    expect(rechazo).toMatchObject({ code: 'PLAN_OFFER_PREPARING', details: { motivo: 'RECHAZADO', ranura: 'PRO:monthly' } })
    expect(version(atorada).preparacion.intentos.PRO_monthly).toBe(1)

    // El reintento usa una llave nueva (intento 1) y ya no repite el 400 guardado.
    await expect(reintentarPublicacion(atorada, STAFF)).resolves.toMatchObject({ number: 2, versionId: atorada })
    expect(stripeCreate.mock.calls.map(c => c[1].idempotencyKey)).toEqual([
      `plan-offer-price:${atorada}:PRO:monthly:0`,
      `plan-offer-price:${atorada}:PRO:monthly:1`,
    ])

    // INCIERTO: el contador no se mueve y el reintento repite la misma llave.
    sembrarHoyDeNuevo()
    fallasDeCrear.push({ statusCode: 503, guardar: false })
    await expect(publicarVersion(entrada({ PREMIUM: { monthlyNetCents: 149900 } }), 1, STAFF)).rejects.toMatchObject({
      details: { motivo: 'INCIERTO', ranura: 'PREMIUM:monthly' },
    })
    const otra = pendienteId()
    expect(version(otra).preparacion.intentos.PREMIUM_monthly).toBe(0)
    stripeCreate.mockClear()
    await reintentarPublicacion(otra, STAFF)
    expect(stripeCreate.mock.calls.map(c => c[1].idempotencyKey)).toEqual([`plan-offer-price:${otra}:PREMIUM:monthly:0`])
  })

  it('🔴 un rechazo del intento 0 que llega después de que otro reintento abrió el 1 no sube el contador a 2', async () => {
    const atorada = await publicacionAtorada()
    // A lee el intento 0 y se detiene antes de que Stripe conteste.
    const detenida = pausa()
    pausasDeCrear.push(detenida.promesa)
    const a = reintentarPublicacion(atorada, STAFF).catch(e => e)
    await vueltas()
    expect(stripeCreate).toHaveBeenCalledTimes(2)

    // B usa el mismo intento 0, Stripe lo rechaza (y guarda el 400 para esa llave) y B abre el 1.
    fallasDeCrear.push({ statusCode: 400, guardar: true })
    await expect(reintentarPublicacion(atorada, STAFF)).rejects.toMatchObject({ details: { motivo: 'RECHAZADO' } })
    expect(version(atorada).preparacion.intentos.PRO_monthly).toBe(1)

    // A vuelve con el mismo 400 (el guardado de su llave): su CAS ve el 1, no el 0, y no lo sube.
    detenida.soltar()
    expect(await a).toMatchObject({ code: 'PLAN_OFFER_PREPARING', details: { motivo: 'RECHAZADO' } })
    expect(version(atorada).preparacion.intentos.PRO_monthly).toBe(1)
    const subidas = base.historial.filter(h => h.columna === 'preparacion' && h.ruta[0] === 'intentos')
    expect(subidas.map(h => h.aplicada)).toEqual([true, false])
  })

  it('🔴 dos reintentos encimados: B guarda mensual y anual mientras A espera a Stripe en el mensual; al volver, A escribe sólo su ranura y el anual de B sigue ahí', async () => {
    const atorada = await publicacionAtorada({ PRO: { monthlyNetCents: 79900, annualNetCents: 799000 } })
    const detenida = pausa()
    pausasDeCrear.push(detenida.promesa)
    const a = reintentarPublicacion(atorada, STAFF)
    await vueltas()

    // B crea los dos precios y se queda en la lista híbrida (Stripe de la lista falla).
    mockEnsure.mockImplementationOnce(async () => {
      throw new Error('Stripe no contestó')
    })
    await expect(reintentarPublicacion(atorada, STAFF)).rejects.toMatchObject({ details: { etapa: 'LISTA' } })
    const [mensual, anual] = precios
    expect(version(atorada).definition.PRO.monthly.stripePriceId).toBe(mensual.id)
    expect(version(atorada).definition.PRO.annual.stripePriceId).toBe(anual.id)

    detenida.soltar()
    await expect(a).resolves.toMatchObject({ number: 2, versionId: atorada })

    // La escritura de A tocó sólo el mensual: en ese momento el anual de B seguía ahí.
    const escriturasDeA = base.historial.filter(h => h.columna === 'definition')
    expect(escriturasDeA.map(h => h.ruta.join('.'))).toEqual([
      'PRO.monthly.stripePriceId',
      'PRO.annual.stripePriceId',
      'PRO.monthly.stripePriceId',
    ])
    expect(escriturasDeA[2].fila!.definition.PRO.annual.stripePriceId).toBe(anual.id)
    // A no volvió a pedir el anual a Stripe y no hay duplicados.
    expect(precios).toHaveLength(2)
    expect(version(atorada)).toMatchObject({ status: 'PUBLISHED', number: 2 })
    expect(version(atorada).definition.PRO.annual.stripePriceId).toBe(anual.id)
  })
})

describe('las listas híbridas y el movimiento', () => {
  it('🔴 una lista ligada sin stripePriceId o sin stripeProductId frena el movimiento con PLAN_OFFER_PREPARING etapa LISTA', async () => {
    for (const falta of ['stripePriceId', 'stripeProductId'] as const) {
      sembrarHoyDeNuevo()
      mockEnsure.mockImplementationOnce(async (publicationId: string) => {
        const pub = base.tablas.hybridOfferPublication.get(publicationId)!
        base.tablas.hybridOfferPublication.set(publicationId, {
          ...pub,
          stripePriceId: 'price_x',
          stripeProductId: 'prod_x',
          [falta]: null,
        })
      })
      const err = await publicarVersion(entrada({ PRO: PRO_MENSUAL_NUEVO }), 1, STAFF).catch(e => e)
      const atorada = pendienteId()

      expect(err).toMatchObject({ statusCode: 409, code: 'PLAN_OFFER_PREPARING', details: { versionId: atorada, etapa: 'LISTA' } })
      const ligada = version(atorada).hybridPublicationIds.PRO
      expect(lista('PRO')).toMatchObject({ currentPublicationId: 'pub_pro', pendingPublicationId: ligada, revision: 4 })
      expect(puntero()).toMatchObject({ currentVersionId: 'cv1', pendingVersionId: atorada })
      expect(version(atorada).status).toBe('PREPARING')
      expect(base.bitacora.map(l => l.action)).not.toContain('HYBRID_LIST_PRICE_SAVED')
      // M2: la negativa del movimiento queda en ultimoError, escrita después de la transacción y sin candados.
      expect(version(atorada).preparacion.ultimoError).toEqual({
        etapa: 'LISTA',
        ranura: null,
        motivo: 'PLAN_OFFER_PREPARING',
        at: expect.any(String),
      })
      expect(ultimaNota()).toMatchObject({ tx: null, candadosTomados: [], aplicada: true })
    }
  })

  it('el movimiento pone número 2, PUBLISHED, la anterior SUPERSEDED y deja bitácora con las dos versiones', async () => {
    const r = await publicarVersion(entrada({ PRO: PRO_MENSUAL_NUEVO, PREMIUM: { monthlyNetCents: 149900 } }), 1, STAFF)

    expect(r).toEqual({ number: 2, versionId: expect.any(String) })
    expect(version(r.versionId)).toMatchObject({ status: 'PUBLISHED', number: 2, publishedById: STAFF, publishedAt: expect.any(Date) })
    expect(version('cv1')).toMatchObject({ status: 'SUPERSEDED', number: 1 })
    expect(puntero()).toMatchObject({ currentVersionId: r.versionId, pendingVersionId: null, revision: 3 })
    const ligadas = version(r.versionId).hybridPublicationIds
    expect(lista('PRO')).toMatchObject({ currentPublicationId: ligadas.PRO, pendingPublicationId: null })
    expect(lista('PREMIUM')).toMatchObject({ currentPublicationId: ligadas.PREMIUM, pendingPublicationId: null })
    expect(base.fila('hybridOfferPublication', ligadas.PRO)!.definition).toEqual(definicionDeLaListaDelPlan('PRO', 926.84))
    expect(base.fila('hybridOfferPublication', ligadas.PREMIUM)!.definition).toEqual(definicionDeLaListaDelPlan('PREMIUM', 1738.84))

    // PREMIUM se finaliza antes que PRO, y la bitácora de la oferta cierra con las dos versiones.
    expect(base.bitacora.map(l => [l.action, l.data?.productKey ?? null])).toEqual([
      ['PLAN_OFFER_PUBLISH_STARTED', null],
      ['HYBRID_LIST_PRICE_SAVED', 'PLAN:PREMIUM'],
      ['HYBRID_LIST_PRICE_SAVED', 'PLAN:PRO'],
      ['PLAN_OFFER_PUBLISHED', null],
    ])
    expect(base.bitacora[3]).toEqual({
      staffId: STAFF,
      action: 'PLAN_OFFER_PUBLISHED',
      entity: 'PlanOfferVersion',
      entityId: r.versionId,
      data: {
        desde: { versionId: 'cv1', number: 1 },
        hasta: { versionId: r.versionId, number: 2 },
        cambios: [
          { plan: 'PRO', campo: 'monthlyNetCents', antes: 99900, despues: 79900 },
          { plan: 'PREMIUM', campo: 'monthlyNetCents', antes: 169900, despues: 149900 },
        ],
      },
    })
    // El movimiento: candado de la oferta y luego los de producto, ordenados; el interruptor, con esa transacción.
    const movimiento = base.candados.filter(c => c.tx === base.candados[base.candados.length - 1].tx).map(c => c.llave)
    expect(movimiento).toEqual(['plan-offer-publish', 'precio:PLAN:PREMIUM', 'precio:PLAN:PRO'])
    const ultima = lecturasDelInterruptor[lecturasDelInterruptor.length - 1]
    expect(ultima).toEqual({ opciones: { sinCache: true, db: 'tx' }, candados: movimiento })
  })

  it('🔴 el movimiento lee el interruptor con la transacción que tomó plan-offer-publish (no con la caché)', async () => {
    // La caché dice «apagado» desde que empieza a preparar; la fila (lo que lee una transacción) sigue prendida.
    stripeCreate.mockImplementationOnce(async (params: PrecioDeStripe, opciones: { idempotencyKey: string }) => {
      interruptor.cache = false
      const precio = { id: 'price_cache', object: 'price', active: true, ...params }
      precios.push(precio)
      idem.set(opciones.idempotencyKey, { ok: true, value: precio })
      return precio
    })
    await expect(publicarVersion(entrada({ PRO: PRO_MENSUAL_NUEVO }), 1, STAFF)).resolves.toMatchObject({ number: 2 })
    const despuesDePreparar = lecturasDelInterruptor.slice(2)
    expect(despuesDePreparar).toEqual([
      { opciones: { sinCache: true, db: 'tx' }, candados: ['plan-offer-publish', 'precio:PLAN:PREMIUM', 'precio:PLAN:PRO'] },
    ])
  })

  it('🔴 apagar el interruptor a media publicación: el movimiento se niega con PLAN_EDIT_DISABLED y la versión sigue PREPARING', async () => {
    // Se apaga (bajo su candado) mientras se prepara la lista híbrida, ya con el precio guardado.
    mockEnsure.mockImplementationOnce(async (publicationId: string) => {
      await prismaMock.$transaction(async (tx: any) => {
        await tomarCandadoDeLaOferta(tx)
        interruptor.real = false
      })
      base.tablas.hybridOfferPublication.set(publicationId, {
        ...base.tablas.hybridOfferPublication.get(publicationId)!,
        stripePriceId: 'price_h',
        stripeProductId: 'prod_h',
      })
    })
    const err = await publicarVersion(entrada({ PRO: PRO_MENSUAL_NUEVO }), 1, STAFF).catch(e => e)
    const atorada = pendienteId()

    expect(err).toMatchObject({ statusCode: 409, code: 'PLAN_EDIT_DISABLED' })
    expect(version(atorada)).toMatchObject({ status: 'PREPARING', number: null })
    expect(version(atorada).definition.PRO.monthly.stripePriceId).toBe(precios[0].id)
    expect(puntero()).toMatchObject({ currentVersionId: 'cv1', pendingVersionId: atorada })
    expect(lista('PRO')).toMatchObject({ currentPublicationId: 'pub_pro', pendingPublicationId: version(atorada).hybridPublicationIds.PRO })
    expect(base.bitacora.map(l => l.action)).toEqual(['PLAN_OFFER_PUBLISH_STARTED'])
    expect(version(atorada).preparacion.ultimoError).toEqual({
      etapa: 'MOVIMIENTO',
      ranura: null,
      motivo: 'PLAN_EDIT_DISABLED',
      at: expect.any(String),
    })
    expect(ultimaNota()).toMatchObject({ tx: null, candadosTomados: [], aplicada: true })
  })

  it('el movimiento desfasado con la versión todavía PREPARING anota MOVIMIENTO / PLAN_OFFER_STALE en ultimoError', async () => {
    // Algo movió la vigente mientras se preparaba la lista: el movimiento ya no está sobre la base de la versión.
    mockEnsure.mockImplementationOnce(async (publicationId: string) => {
      base.tablas.hybridOfferPublication.set(publicationId, {
        ...base.tablas.hybridOfferPublication.get(publicationId)!,
        stripePriceId: 'price_h',
        stripeProductId: 'prod_h',
      })
      base.tablas.planOfferPointer.set('vigente', { ...puntero(), currentVersionId: 'cv_otra' })
    })
    const err = await publicarVersion(entrada({ PRO: PRO_MENSUAL_NUEVO }), 1, STAFF).catch(e => e)
    const atorada = pendienteId()

    expect(err).toMatchObject({ statusCode: 409, code: 'PLAN_OFFER_STALE' })
    expect(version(atorada).status).toBe('PREPARING')
    expect(version(atorada).preparacion.ultimoError).toEqual({
      etapa: 'MOVIMIENTO',
      ranura: null,
      motivo: 'PLAN_OFFER_STALE',
      at: expect.any(String),
    })
    expect(ultimaNota()).toMatchObject({ tx: null, candadosTomados: [], aplicada: true })
  })

  it('un paso que sale bien después de una falla limpia ultimoError (y la versión publicada no lo arrastra)', async () => {
    const atorada = await publicacionAtorada()
    expect(version(atorada).preparacion.ultimoError).toMatchObject({ etapa: 'PRECIO' })

    // El precio sale bien (limpia) y la lista falla (anota la suya).
    mockEnsure.mockImplementationOnce(async () => {
      throw new Error('Stripe no contestó')
    })
    await expect(reintentarPublicacion(atorada, STAFF)).rejects.toMatchObject({ details: { etapa: 'LISTA' } })
    expect(notasDeUltimoError().map(h => (h.valor as { etapa?: string } | null)?.etapa ?? null)).toEqual(['PRECIO', null, 'LISTA'])

    // El siguiente reintento: la lista sale bien (limpia) y se publica sin el error viejo.
    await expect(reintentarPublicacion(atorada, STAFF)).resolves.toMatchObject({ number: 2, versionId: atorada })
    expect(notasDeUltimoError().map(h => (h.valor as { etapa?: string } | null)?.etapa ?? null)).toEqual(['PRECIO', null, 'LISTA', null])
    expect(version(atorada)).toMatchObject({ status: 'PUBLISHED', preparacion: { ultimoError: null } })
  })
})

describe('reintentar y descartar', () => {
  it('el reintento de otra versión que ya no es la pendiente → 409 PLAN_OFFER_STALE', async () => {
    await publicacionAtorada()
    base.sembrar('planOfferVersion', { id: 'cv_vieja', status: 'DISCARDED', definition: versionUno() })
    stripeList.mockClear()
    stripeCreate.mockClear()

    await expect(reintentarPublicacion('cv_otra', STAFF)).rejects.toMatchObject({ statusCode: 409, code: 'PLAN_OFFER_STALE' })
    await expect(reintentarPublicacion('cv_vieja', STAFF)).rejects.toMatchObject({ statusCode: 409, code: 'PLAN_OFFER_STALE' })
    // M1: la versión que ya está en venta no es «otra»: reintentarla responde con ella, sin tocar nada.
    await expect(reintentarPublicacion('cv1', STAFF)).resolves.toEqual({ number: 1, versionId: 'cv1' })
    expect(llamadasAStripe()).toBe(0)
  })

  it('🔴 doble clic: dos reintentos encimados de la misma versión terminan los dos con la misma versión publicada y una sola bitácora', async () => {
    const atorada = await publicacionAtorada()
    // A se detiene en Stripe; B termina y publica.
    const detenida = pausa()
    pausasDeCrear.push(detenida.promesa)
    const a = reintentarPublicacion(atorada, STAFF)
    await vueltas()
    const b = await reintentarPublicacion(atorada, STAFF)
    expect(b).toEqual({ number: 2, versionId: atorada })

    // A vuelve: su escritura ya no aplica (la versión está PUBLISHED) y su STALE es el éxito de B.
    detenida.soltar()
    await expect(a).resolves.toEqual({ number: 2, versionId: atorada })
    const escrituras = base.historial.filter(h => h.columna === 'definition')
    expect(escrituras.map(h => h.aplicada)).toEqual([true, false])
    // Un tercer clic, después: la revisión corta ya ve la versión publicada.
    stripeList.mockClear()
    stripeCreate.mockClear()
    await expect(reintentarPublicacion(atorada, STAFF)).resolves.toEqual({ number: 2, versionId: atorada })
    expect(llamadasAStripe()).toBe(0)
    expect(base.bitacora.filter(l => l.action === 'PLAN_OFFER_PUBLISHED')).toHaveLength(1)
    expect(precios).toHaveLength(1)
  })

  it('M4: descartar una versión que renombró la lista y publicar una que reusa la vigente devuelve el nombre de la lista', async () => {
    mockEnsure.mockImplementationOnce(async () => {
      throw new Error('Stripe no contestó')
    })
    await expect(publicarVersion(entrada({ PRO: { displayName: 'Pro Plus' } }), 1, STAFF)).rejects.toMatchObject({
      details: { etapa: 'LISTA' },
    })
    expect(lista('PRO').name).toBe('Plan Pro Plus')
    await descartarPublicacion(pendienteId(), STAFF)
    // Soltar sólo limpia la pendiente: el nombre del descarte se queda.
    expect(lista('PRO')).toMatchObject({ name: 'Plan Pro Plus', pendingPublicationId: null, revision: 5 })

    const r = await publicarVersion(entrada({ PRO: { trialDays: 14 } }), 3, STAFF)
    expect(r.number).toBe(2)
    expect(version(r.versionId).hybridPublicationIds.PRO).toBe('pub_pro')
    expect(lista('PRO')).toMatchObject({ name: 'Plan Pro', currentPublicationId: 'pub_pro', pendingPublicationId: null, revision: 6 })
    expect(lista('PRO').name).toBe(base.fila('hybridOfferPublication', 'pub_pro')!.name)
  })

  it('🔴 un reintento con el interruptor ya apagado → 409 PLAN_EDIT_DISABLED con cero llamadas a Stripe (ni prices.list, ni prices.create, ni ensureHybridPublicationPrices) y la versión, sus ranuras y sus listas sin cambio', async () => {
    // Se queda después de ligar las listas: falló la preparación de Stripe de PLAN:PRO.
    mockEnsure.mockImplementationOnce(async () => {
      throw new Error('Stripe no contestó')
    })
    await expect(publicarVersion(entrada({ PRO: PRO_MENSUAL_NUEVO }), 1, STAFF)).rejects.toMatchObject({ details: { etapa: 'LISTA' } })
    const atorada = pendienteId()
    const antes = { version: version(atorada), listas: [lista('PRO'), lista('PREMIUM')], pubs: base.tablas.hybridOfferPublication.size }
    expect(antes.listas[0].pendingPublicationId).toBe(antes.version.hybridPublicationIds.PRO)
    stripeList.mockClear()
    stripeCreate.mockClear()
    mockEnsure.mockClear()

    interruptor.real = false
    await expect(reintentarPublicacion(atorada, STAFF)).rejects.toMatchObject({ statusCode: 409, code: 'PLAN_EDIT_DISABLED' })
    expect(llamadasAStripe()).toBe(0)
    expect(mockEnsure).not.toHaveBeenCalled()
    expect(version(atorada)).toEqual(antes.version)
    expect([lista('PRO'), lista('PREMIUM')]).toEqual(antes.listas)
    expect(base.tablas.hybridOfferPublication.size).toBe(antes.pubs)
  })

  it('🔴 descartar deja la vigente y suelta la lista híbrida pendiente de esa versión; no llama a Stripe', async () => {
    mockEnsure.mockImplementationOnce(async () => {
      throw new Error('Stripe no contestó')
    })
    await expect(publicarVersion(entrada({ PRO: PRO_MENSUAL_NUEVO }), 1, STAFF)).rejects.toMatchObject({ details: { etapa: 'LISTA' } })
    const atorada = pendienteId()
    const ligadas = version(atorada).hybridPublicationIds
    expect(ligadas.PREMIUM).toBe('pub_premium')
    expect(lista('PRO').pendingPublicationId).toBe(ligadas.PRO)
    stripeList.mockClear()
    stripeCreate.mockClear()
    mockEnsure.mockClear()
    const candadosAntes = base.candados.length

    const estado = await descartarPublicacion(atorada, STAFF)

    expect(llamadasAStripe()).toBe(0)
    expect(mockEnsure).not.toHaveBeenCalled()
    expect(version(atorada)).toMatchObject({ status: 'DISCARDED', number: null, discardedById: STAFF, discardedAt: expect.any(Date) })
    expect(puntero()).toMatchObject({ currentVersionId: 'cv1', pendingVersionId: null, revision: 3 })
    expect(lista('PRO')).toMatchObject({ currentPublicationId: 'pub_pro', pendingPublicationId: null, revision: 5 })
    expect(lista('PREMIUM')).toMatchObject({ currentPublicationId: 'pub_premium', pendingPublicationId: null, revision: 3 })
    expect(version('cv1')).toMatchObject({ status: 'PUBLISHED', number: 1 })
    expect(base.candados.slice(candadosAntes).map(c => c.llave)).toEqual(['plan-offer-publish', 'precio:PLAN:PREMIUM', 'precio:PLAN:PRO'])
    expect(base.bitacora[base.bitacora.length - 1]).toEqual({
      staffId: STAFF,
      action: 'PLAN_OFFER_DISCARDED',
      entity: 'PlanOfferVersion',
      entityId: atorada,
      data: { versionId: atorada, hybridPublicationIds: ligadas },
    })
    expect(estado).toMatchObject({ revision: 3, pendiente: null, vigente: { number: 1, versionId: 'cv1' } })
    // Descartar otra vez: ya no es la pendiente.
    await expect(descartarPublicacion(atorada, STAFF)).rejects.toMatchObject({ code: 'PLAN_OFFER_STALE' })
  })

  it('M7: si el estado no se puede leer después de descartar, el descarte responde con un estado mínimo (no un error)', async () => {
    const atorada = await publicacionAtorada()
    // La vigente guardada está rota: `estadoDeLaOferta` respondería 503.
    base.tablas.planOfferVersion.set('cv1', { ...version('cv1'), definition: { schemaVersion: 1 } })

    await expect(descartarPublicacion(atorada, STAFF)).resolves.toEqual({ revision: 3, pendiente: null, parcial: true })
    expect(version(atorada)).toMatchObject({ status: 'DISCARDED' })
    expect(puntero()).toMatchObject({ pendingVersionId: null, revision: 3 })
    expect(logger.warn).toHaveBeenCalledWith(
      '[PlanOffer] se descartó la versión, pero no se pudo leer el estado de la oferta',
      expect.objectContaining({ versionId: atorada }),
    )
  })

  it('🔴 una preparación que corría cuando se descartó no escribe su priceId (CAS PREPARING) ni mueve nada', async () => {
    const detenida = pausa()
    pausasDeCrear.push(detenida.promesa)
    const publicacion = publicarVersion(entrada({ PRO: PRO_MENSUAL_NUEVO }), 1, STAFF).catch(e => e)
    await vueltas()
    const atorada = pendienteId()
    expect(stripeCreate).toHaveBeenCalledTimes(1)

    await descartarPublicacion(atorada, STAFF)
    detenida.soltar()

    expect(await publicacion).toMatchObject({ statusCode: 409, code: 'PLAN_OFFER_STALE' })
    expect(version(atorada)).toMatchObject({ status: 'DISCARDED' })
    expect(version(atorada).definition.PRO.monthly.stripePriceId).toBeNull()
    expect(base.historial.filter(h => h.columna === 'definition')).toEqual([expect.objectContaining({ aplicada: false })])
    expect(puntero()).toMatchObject({ currentVersionId: 'cv1', pendingVersionId: null })
    expect(lista('PRO')).toMatchObject({ currentPublicationId: 'pub_pro', pendingPublicationId: null, revision: 3 })
    expect(base.tablas.hybridOfferPublication.size).toBe(2)
    expect(mockEnsure).not.toHaveBeenCalled()
  })
})

describe('el nombre en Stripe (Task 8)', () => {
  it('publicar con nombre nuevo llama a planOfferRenameJob.runNow() al terminar; si rechaza, igual responde la versión publicada', async () => {
    const alLlamar: Array<{ vigente: unknown; candados: boolean }> = []
    mockRunNow.mockImplementation(async () => {
      alLlamar.push({ vigente: puntero().currentVersionId, candados: base.candadoTomado('plan-offer-publish') })
      throw new Error('Stripe no contesta')
    })

    const r = await publicarVersion(entrada({ PRO: { displayName: 'Pro Plus' } }), 1, STAFF)
    await vueltas()

    expect(r).toEqual({ number: 2, versionId: expect.any(String) })
    expect(version(r.versionId).definition.PRO.stripeProductName).toBe('Plan Avoqado Pro Plus')
    expect(mockRunNow).toHaveBeenCalledTimes(1)
    // Después del movimiento (la vigente ya es la nueva) y con plan-offer-publish suelto.
    expect(alLlamar).toEqual([{ vigente: r.versionId, candados: false }])
    expect(logger.warn).toHaveBeenCalledWith('[PlanOffer] el renombre inmediato en Stripe falló; el job lo reintenta', {
      versionId: r.versionId,
      error: 'Stripe no contesta',
    })
  })

  it('M2: el reintento que encuentra la versión ya publicada (yaPublicada) también pide el renombre, sin esperarlo; si rechaza, igual responde el éxito', async () => {
    const atorada = await publicacionAtorada({ PRO: { displayName: 'Pro Plus', ...PRO_MENSUAL_NUEVO } })
    await expect(reintentarPublicacion(atorada, STAFF)).resolves.toEqual({ number: 2, versionId: atorada })
    await vueltas()
    expect(mockRunNow).toHaveBeenCalledTimes(1)

    // Otro clic después (su respuesta se perdió, o un doble clic): la versión ya es la vigente y se responde como éxito.
    const alLlamar: boolean[] = []
    mockRunNow.mockImplementation(async () => {
      alLlamar.push(base.candadoTomado('plan-offer-publish'))
      throw new Error('Stripe no contesta')
    })
    await expect(reintentarPublicacion(atorada, STAFF)).resolves.toEqual({ number: 2, versionId: atorada })
    await vueltas()
    expect(mockRunNow).toHaveBeenCalledTimes(2)
    expect(alLlamar).toEqual([false])
    expect(logger.warn).toHaveBeenCalledWith('[PlanOffer] el renombre inmediato en Stripe falló; el job lo reintenta', {
      versionId: atorada,
      error: 'Stripe no contesta',
    })
    expect(base.bitacora.filter(l => l.action === 'PLAN_OFFER_PUBLISHED')).toHaveLength(1)
  })

  it('una publicación que no llega al movimiento no llama al renombre', async () => {
    await publicacionAtorada({ PRO: { displayName: 'Pro Plus', ...PRO_MENSUAL_NUEVO } })
    await vueltas()
    expect(mockRunNow).not.toHaveBeenCalled()
  })
})

describe('estadoDeLaOferta', () => {
  it('trae la vigente con su entrada, la pendiente con su preparación, el interruptor, nombresEnStripe tal cual y destinatarios vacíos', async () => {
    base.tablas.planOfferPointer.set('vigente', { ...puntero(), nombresEnStripe: { PRO: 'pendiente' } })
    const atorada = await publicacionAtorada()

    const estado = await estadoDeLaOferta()
    expect(estado).toEqual({
      revision: 2,
      vigente: {
        number: 1,
        versionId: 'cv1',
        definition: versionUno(),
        entrada: entrada(),
        publishedAt: new Date('2026-11-25T12:00:00Z'),
        publishedById: 'staff_semilla',
      },
      pendiente: {
        versionId: atorada,
        definition: expect.objectContaining({
          PRO: expect.objectContaining({ monthly: { netCents: 79900, grossCents: 92684, stripePriceId: null } }),
        }),
        creadaAt: expect.any(Date),
        preparacion: expect.objectContaining({ ultimoError: expect.objectContaining({ etapa: 'PRECIO' }) }),
      },
      interruptor: { prendido: true, desde: null, actualizadoPor: null, faltan: [] },
      nombresEnStripe: { PRO: 'pendiente' },
      destinatarios: [],
    })
  })

  it('M7: la pendiente se lee en la misma consulta del puntero; una que ya no está PREPARING sale como null', async () => {
    const atorada = await publicacionAtorada()
    const antes = base.llamadasA('planOfferVersion', 'findUnique').length
    expect((await estadoDeLaOferta()).pendiente).toMatchObject({ versionId: atorada })
    // Ninguna lectura aparte de la versión pendiente.
    expect(base.llamadasA('planOfferVersion', 'findUnique')).toHaveLength(antes)

    // El puntero todavía la nombra, pero ya se descartó (la carrera que antes devolvía una descartada).
    base.tablas.planOfferVersion.set(atorada, { ...version(atorada), status: 'DISCARDED' })
    expect((await estadoDeLaOferta()).pendiente).toBeNull()
  })

  it('Task 9: trae los destinatarios de los avisos internos guardados en PlatformSettings', async () => {
    prismaMock.platformSettings.findUnique.mockResolvedValueOnce({ avisosDelAltaCorreos: ['ops@example.com', 'ventas@example.com'] })
    await expect(estadoDeLaOferta()).resolves.toMatchObject({ destinatarios: ['ops@example.com', 'ventas@example.com'] })
    expect(prismaMock.platformSettings.findUnique).toHaveBeenCalledWith({
      where: { id: 'default' },
      select: { avisosDelAltaCorreos: true },
    })
  })

  it('sin versiones: el respaldo con número 1 y revisión 0', async () => {
    base.tablas.planOfferPointer.clear()
    base.tablas.planOfferVersion.clear()
    const estado = await estadoDeLaOferta()
    expect(estado).toMatchObject({
      revision: 0,
      vigente: { number: 1, versionId: null, publishedAt: null },
      pendiente: null,
      nombresEnStripe: null,
    })
    expect(estado.vigente.entrada).toEqual(entrada())
  })
})

describe('estadoDespuesDeConfirmar (Task 9: lo que responden publicar, reintentar y descartar)', () => {
  it('con el estado legible, lo devuelve completo', async () => {
    await expect(estadoDespuesDeConfirmar('se publicó la versión', 'cv1')).resolves.toMatchObject({
      revision: 1,
      vigente: { number: 1, versionId: 'cv1' },
      pendiente: null,
    })
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('no se pudo leer el estado'), expect.anything())
  })

  it('si el estado ya no se puede leer, el mínimo con la revisión del puntero y un aviso en el log (nunca un error)', async () => {
    // La vigente guardada está rota: `estadoDeLaOferta` respondería 503.
    base.tablas.planOfferVersion.set('cv1', { ...version('cv1'), definition: { schemaVersion: 1 } })

    await expect(estadoDespuesDeConfirmar('se publicó la versión', 'cv2')).resolves.toEqual({ revision: 1, pendiente: null, parcial: true })
    expect(logger.warn).toHaveBeenCalledWith(
      '[PlanOffer] se publicó la versión, pero no se pudo leer el estado de la oferta',
      expect.objectContaining({ versionId: 'cv2' }),
    )
  })
})

/** Vuelve a la v1 sin pendiente (para una segunda publicación dentro de la misma prueba). */
function sembrarHoyDeNuevo() {
  for (const tabla of Object.values(base.tablas)) tabla.clear()
  sembrarHoy()
}

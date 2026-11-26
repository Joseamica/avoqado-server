/**
 * Planes editables B1, Task 6: las tres funciones con las que el publicador de la oferta escribe las listas `PLAN:PRO` y
 * `PLAN:PREMIUM` (`prepararListaDelPlan`, `finalizarListaDelPlanEn`, `soltarListaPendienteDelPlanEn`), sobre una base en memoria con
 * transacciones que se deshacen y candados que esperan (`planOfferFakeDb`).
 *
 * 🔴 Desde la v1 son el ÚNICO escritor de las listas de plan: NO llevan la negativa `PLAN_OFFER_OWNS_PLAN_LISTS` de los escritores
 * viejos (si la llevaran, el publicador se negaría a sí mismo). Los escritores viejos siguen negados, y `FEATURE:*` y el Plan Básico
 * se guardan igual que antes.
 */
const mockEnsure = jest.fn()
jest.mock('@/services/launchCampaigns/hybridPrices', () => ({ ensureHybridPublicationPrices: (...a: unknown[]) => mockEnsure(...a) }))
const mockRegla = jest.fn()
jest.mock('@/services/launchCampaigns/hybridPriceRule', () => ({ assertPriceRuleForList: (...a: unknown[]) => mockRegla(...a) }))

import type { Prisma } from '@prisma/client'
import { ConflictError } from '@/errors/AppError'
import {
  finalizarListaDelPlanEn,
  prepararListaDelPlan,
  retryListPrice,
  saveBasicPlan,
  saveListPrice,
  soltarListaPendienteDelPlanEn,
} from '@/services/launchCampaigns/hybridListPrice.service'
import { prismaMock } from '@tests/__helpers__/setup'
import { crearBaseDePrueba, pausa, vueltas, type BaseDePrueba } from '@tests/__helpers__/planOfferFakeDb'
import { definicionDeLaListaDelPlan, versionUno } from '@tests/__helpers__/planOfferFixtures'

let base: BaseDePrueba

/** La versión pendiente que liga las listas: `ligada` y `ligar` leen y escriben su fila con la transacción que reciben. */
function versionPendiente(opciones: { antesDeLigar?: () => Promise<void> } = {}) {
  return {
    ligada: jest.fn(async (tx: Prisma.TransactionClient) => {
      const fila = await tx.planOfferVersion.findUnique({ where: { id: 'cv2' } })
      if (fila?.status !== 'PREPARING') throw new ConflictError('La versión ya no es la pendiente.', 'PLAN_OFFER_STALE')
      return ((fila!.hybridPublicationIds as Record<string, string | null>).PRO ?? null) as string | null
    }),
    ligar: jest.fn(async (tx: Prisma.TransactionClient, r: { publicationId: string; reusada: boolean }) => {
      await opciones.antesDeLigar?.()
      const fila = await tx.planOfferVersion.findUnique({ where: { id: 'cv2' } })
      await tx.planOfferVersion.update({
        where: { id: 'cv2' },
        data: { hybridPublicationIds: { ...(fila!.hybridPublicationIds as object), PRO: r.publicationId } },
      })
    }),
  }
}

const listaPro = () => base.fila('hybridCampaign', 'list_pro')!
const publicaciones = () => [...base.tablas.hybridOfferPublication.values()]

beforeEach(() => {
  base = crearBaseDePrueba(prismaMock)
  // La v1 existe: los escritores viejos se niegan; las funciones del publicador no.
  base.sembrar('planOfferVersion', { id: 'cv1', number: 1, status: 'PUBLISHED', definition: versionUno(), hybridPublicationIds: null })
  base.sembrar('planOfferVersion', {
    id: 'cv2',
    number: null,
    status: 'PREPARING',
    definition: versionUno(),
    hybridPublicationIds: { PRO: null, PREMIUM: null },
  })
  base.sembrar('planOfferPointer', { id: 'vigente', currentVersionId: 'cv1', pendingVersionId: 'cv2', revision: 2 })
  base.sembrar('hybridCampaign', {
    id: 'list_pro',
    purpose: 'LIST',
    listProductKey: 'PLAN:PRO',
    code: 'L_PLAN_PRO',
    slug: 'lista-plan-pro',
    name: 'Plan Pro',
    status: 'ACTIVE',
    revision: 3,
    currentPublicationId: 'pub_pro',
    pendingPublicationId: null,
  })
  base.sembrar('hybridOfferPublication', {
    id: 'pub_pro',
    campaignId: 'list_pro',
    version: 2,
    name: 'Plan Pro',
    definition: definicionDeLaListaDelPlan('PRO', 1158.84),
    stripePriceId: 'price_h_pro',
    stripeProductId: 'prod_h_pro',
  })
  mockEnsure.mockReset().mockImplementation(async (publicationId: string) => {
    base.tablas.hybridOfferPublication.set(publicationId, {
      ...base.tablas.hybridOfferPublication.get(publicationId)!,
      stripePriceId: `price_h_${publicationId}`,
      stripeProductId: `prod_h_${publicationId}`,
    })
  })
  mockRegla.mockReset().mockResolvedValue(undefined)
})

describe('prepararListaDelPlan', () => {
  it('con el mismo precio y nombre reusa la vigente y no llama a Stripe', async () => {
    const version = versionPendiente()
    const r = await prepararListaDelPlan('PRO', { precio: 1158.84, nombre: 'Plan Pro' }, 'staff1', version)

    expect(r).toEqual({ publicationId: 'pub_pro', reusada: true })
    expect(mockEnsure).not.toHaveBeenCalled()
    expect(publicaciones()).toHaveLength(1)
    expect(listaPro()).toMatchObject({ currentPublicationId: 'pub_pro', pendingPublicationId: null, revision: 3 })
    expect(version.ligar).toHaveBeenCalledWith(expect.anything(), { publicationId: 'pub_pro', reusada: true })
    expect(base.fila('planOfferVersion', 'cv2')!.hybridPublicationIds).toEqual({ PRO: 'pub_pro', PREMIUM: null })
  })

  it('al reusar la vigente suelta una pendiente vieja de la lista', async () => {
    base.tablas.hybridCampaign.set('list_pro', { ...listaPro(), pendingPublicationId: 'pub_vieja' })
    const r = await prepararListaDelPlan('PRO', { precio: 1158.84, nombre: 'Plan Pro' }, 'staff1', versionPendiente())

    expect(r).toEqual({ publicationId: 'pub_pro', reusada: true })
    expect(listaPro()).toMatchObject({ currentPublicationId: 'pub_pro', pendingPublicationId: null, revision: 4 })
  })

  it('al reusar la vigente, el nombre que dejó una versión descartada vuelve al de la publicación en venta', async () => {
    base.tablas.hybridCampaign.set('list_pro', { ...listaPro(), name: 'Plan Pro Plus' })
    const r = await prepararListaDelPlan('PRO', { precio: 1158.84, nombre: 'Plan Pro' }, 'staff1', versionPendiente())

    expect(r).toEqual({ publicationId: 'pub_pro', reusada: true })
    expect(listaPro()).toMatchObject({ name: 'Plan Pro', currentPublicationId: 'pub_pro', pendingPublicationId: null, revision: 4 })
    expect(mockEnsure).not.toHaveBeenCalled()
  })

  it('con otro nombre crea una publicación pendiente «Plan Pro Plus» y renombra la lista', async () => {
    const r = await prepararListaDelPlan('PRO', { precio: 1158.84, nombre: 'Plan Pro Plus' }, 'staff1', versionPendiente())

    expect(r.reusada).toBe(false)
    const nueva = base.fila('hybridOfferPublication', r.publicationId)!
    expect(nueva).toMatchObject({
      campaignId: 'list_pro',
      version: 3,
      name: 'Plan Pro Plus',
      definition: definicionDeLaListaDelPlan('PRO', 1158.84),
      createdById: 'staff1',
    })
    expect(listaPro()).toMatchObject({
      name: 'Plan Pro Plus',
      currentPublicationId: 'pub_pro',
      pendingPublicationId: r.publicationId,
      revision: 4,
      draftDefinition: definicionDeLaListaDelPlan('PRO', 1158.84),
    })
    // Fuera de la transacción: Stripe prepara la publicación nueva.
    expect(mockEnsure).toHaveBeenCalledWith(r.publicationId)
    expect(base.fila('hybridOfferPublication', r.publicationId)).toMatchObject({ stripePriceId: expect.any(String) })
    expect(base.fila('planOfferVersion', 'cv2')!.hybridPublicationIds).toEqual({ PRO: r.publicationId, PREMIUM: null })
  })

  it('con otro precio crea la pendiente con ese precio (y revisa la regla de precio bajo el candado)', async () => {
    const r = await prepararListaDelPlan('PRO', { precio: 926.84, nombre: 'Plan Pro' }, 'staff1', versionPendiente())

    expect(base.fila('hybridOfferPublication', r.publicationId)!.definition).toEqual(definicionDeLaListaDelPlan('PRO', 926.84))
    expect(mockRegla).toHaveBeenCalledWith(expect.anything(), 'PLAN:PRO', 926.84)
  })

  it('con una publicación ya ligada a la versión (leída con ligada dentro del candado) la devuelve sin crear otra', async () => {
    base.tablas.planOfferVersion.set('cv2', {
      ...base.fila('planOfferVersion', 'cv2')!,
      hybridPublicationIds: { PRO: 'pub_pro', PREMIUM: null },
    })
    const version = versionPendiente()
    const candadosAlLeer: string[][] = []
    version.ligada.mockImplementationOnce(async (tx: any) => {
      candadosAlLeer.push(base.candadosDe(tx))
      return 'pub_pro'
    })

    // Otro precio y otro nombre: con una ligada, la ligada manda.
    const r = await prepararListaDelPlan('PRO', { precio: 999.99, nombre: 'Plan Otro' }, 'staff1', version)

    expect(r).toEqual({ publicationId: 'pub_pro', reusada: true })
    expect(candadosAlLeer).toEqual([['precio:PLAN:PRO']])
    expect(publicaciones()).toHaveLength(1)
    expect(mockEnsure).not.toHaveBeenCalled()
  })

  it('🔴 una ligada que sigue pendiente se devuelve con reusada false y vuelve a pasar por ensureHybridPublicationPrices', async () => {
    base.sembrar('hybridOfferPublication', {
      id: 'pub_nueva',
      campaignId: 'list_pro',
      version: 3,
      name: 'Plan Pro',
      definition: definicionDeLaListaDelPlan('PRO', 926.84),
      stripePriceId: null,
      stripeProductId: null,
    })
    base.tablas.hybridCampaign.set('list_pro', { ...listaPro(), pendingPublicationId: 'pub_nueva', revision: 4 })
    base.tablas.planOfferVersion.set('cv2', {
      ...base.fila('planOfferVersion', 'cv2')!,
      hybridPublicationIds: { PRO: 'pub_nueva', PREMIUM: null },
    })

    const r = await prepararListaDelPlan('PRO', { precio: 926.84, nombre: 'Plan Pro' }, 'staff1', versionPendiente())

    expect(r).toEqual({ publicationId: 'pub_nueva', reusada: false })
    expect(publicaciones()).toHaveLength(2)
    expect(mockEnsure).toHaveBeenCalledWith('pub_nueva')
    expect(base.fila('hybridOfferPublication', 'pub_nueva')).toMatchObject({ stripePriceId: 'price_h_pub_nueva' })
    expect(listaPro()).toMatchObject({ pendingPublicationId: 'pub_nueva', revision: 4 })
  })

  it('🔴 dos reintentos encimados de la misma versión: el segundo espera el candado, lee la ligada por el primero y termina en la misma', async () => {
    const detenido = pausa()
    const a = versionPendiente({ antesDeLigar: () => detenido.promesa })
    const b = versionPendiente()

    const primero = prepararListaDelPlan('PRO', { precio: 926.84, nombre: 'Plan Pro' }, 'staff1', a)
    await vueltas()
    expect(a.ligar).toHaveBeenCalled()
    const segundo = prepararListaDelPlan('PRO', { precio: 926.84, nombre: 'Plan Pro' }, 'staff1', b)
    await vueltas()
    // A tiene el candado del producto: B no ha leído nada.
    expect(b.ligada).not.toHaveBeenCalled()

    detenido.soltar()
    const [ra, rb] = await Promise.all([primero, segundo])

    expect(rb).toEqual(ra)
    expect(ra.reusada).toBe(false)
    expect(publicaciones()).toHaveLength(2)
    expect(listaPro()).toMatchObject({ pendingPublicationId: ra.publicationId, revision: 4 })
    // Los dos pasan por Stripe con la MISMA publicación (idempotente por su llave de búsqueda).
    expect(mockEnsure.mock.calls).toEqual([[ra.publicationId], [ra.publicationId]])
    expect(base.candados.map(c => c.llave)).toEqual(['precio:PLAN:PRO', 'precio:PLAN:PRO'])
  })

  it('si ligada o ligar lanzan, no queda publicación ni pendiente', async () => {
    const stale = versionPendiente()
    stale.ligada.mockRejectedValueOnce(new ConflictError('La versión ya no es la pendiente.', 'PLAN_OFFER_STALE'))
    await expect(prepararListaDelPlan('PRO', { precio: 926.84, nombre: 'Plan Pro' }, 'staff1', stale)).rejects.toMatchObject({
      code: 'PLAN_OFFER_STALE',
    })
    expect(base.llamadasA('hybridOfferPublication', 'create')).toHaveLength(0)

    const falla = versionPendiente()
    falla.ligar.mockRejectedValueOnce(new Error('la base se cayó'))
    await expect(prepararListaDelPlan('PRO', { precio: 926.84, nombre: 'Plan Pro Plus' }, 'staff1', falla)).rejects.toThrow(
      'la base se cayó',
    )
    // Se alcanzó a crear y a reclamar dentro de la transacción, y se deshizo todo.
    expect(base.llamadasA('hybridOfferPublication', 'create')).toHaveLength(1)
    expect(publicaciones()).toHaveLength(1)
    expect(listaPro()).toMatchObject({ name: 'Plan Pro', pendingPublicationId: null, revision: 3 })
    expect(base.fila('planOfferVersion', 'cv2')!.hybridPublicationIds).toEqual({ PRO: null, PREMIUM: null })
    expect(mockEnsure).not.toHaveBeenCalled()
  })

  it('si Stripe falla, lanza el HYBRID_LIST_PREPARING de hoy y la pendiente queda ligada para el reintento', async () => {
    mockEnsure.mockRejectedValueOnce(new Error('Stripe no contestó'))
    const err = await prepararListaDelPlan('PRO', { precio: 926.84, nombre: 'Plan Pro' }, 'staff1', versionPendiente()).catch(e => e)

    expect(err).toMatchObject({ statusCode: 409, code: 'HYBRID_LIST_PREPARING' })
    const ligada = (base.fila('planOfferVersion', 'cv2')!.hybridPublicationIds as Record<string, string>).PRO
    expect(listaPro()).toMatchObject({ currentPublicationId: 'pub_pro', pendingPublicationId: ligada })
  })

  it('🔴 con la versión de la oferta existente, prepararListaDelPlan escribe; los escritores viejos de PLAN:* siguen negados', async () => {
    await expect(prepararListaDelPlan('PRO', { precio: 926.84, nombre: 'Plan Pro' }, 'staff1', versionPendiente())).resolves.toMatchObject({
      reusada: false,
    })
    // Ninguna lectura de la negativa en el camino nuevo.
    expect(base.llamadasA('planOfferPointer', 'findUnique').filter(l => 'currentVersionId' in (l.args.select ?? {}))).toHaveLength(0)

    await expect(saveListPrice({ productKey: 'PLAN:PRO', price: 999, expectedRevision: 3 }, 'staff1')).rejects.toMatchObject({
      statusCode: 400,
      code: 'HYBRID_LIST_NOT_EDITABLE',
    })
    await expect(retryListPrice('PLAN:PRO', 'staff1')).rejects.toMatchObject({ statusCode: 409, code: 'PLAN_OFFER_OWNS_PLAN_LISTS' })
  })
})

describe('finalizarListaDelPlanEn y soltarListaPendienteDelPlanEn', () => {
  const pendiente = () => {
    base.sembrar('hybridOfferPublication', {
      id: 'pub_nueva',
      campaignId: 'list_pro',
      version: 3,
      name: 'Plan Pro',
      definition: definicionDeLaListaDelPlan('PRO', 926.84),
      stripePriceId: 'price_h_nueva',
      stripeProductId: 'prod_h_nueva',
    })
    base.tablas.hybridCampaign.set('list_pro', { ...listaPro(), pendingPublicationId: 'pub_nueva', revision: 4 })
  }
  const enTransaccion = (fn: (tx: Prisma.TransactionClient) => Promise<void>) => prismaMock.$transaction(fn)

  it('pone la pendiente a la venta, sube la revisión, revisa la regla y deja la bitácora de hoy', async () => {
    pendiente()
    await enTransaccion(tx => finalizarListaDelPlanEn(tx, 'PRO', 'pub_nueva', 'staff1'))

    expect(listaPro()).toMatchObject({ currentPublicationId: 'pub_nueva', pendingPublicationId: null, revision: 5, status: 'ACTIVE' })
    expect(mockRegla).toHaveBeenCalledWith(expect.anything(), 'PLAN:PRO', 926.84)
    expect(base.bitacora).toEqual([
      expect.objectContaining({
        action: 'HYBRID_LIST_PRICE_SAVED',
        entity: 'HybridCampaign',
        entityId: 'list_pro',
        staffId: 'staff1',
        data: { productKey: 'PLAN:PRO', before: 1158.84, after: 926.84, publicationId: 'pub_nueva' },
      }),
    ])
  })

  it('finalizarListaDelPlanEn: CAS perdido → 409 PLAN_OFFER_STALE; con la vigente igual no escribe', async () => {
    // La vigente ya es esa publicación: nada que escribir.
    await enTransaccion(tx => finalizarListaDelPlanEn(tx, 'PRO', 'pub_pro', 'staff1'))
    expect(base.llamadasA('hybridCampaign', 'updateMany')).toHaveLength(0)
    expect(base.bitacora).toHaveLength(0)

    // La pendiente de la lista es otra: el CAS no encuentra la fila.
    pendiente()
    await expect(enTransaccion(tx => finalizarListaDelPlanEn(tx, 'PRO', 'pub_otra', 'staff1'))).rejects.toMatchObject({
      statusCode: 409,
      code: 'PLAN_OFFER_STALE',
    })
    expect(listaPro()).toMatchObject({ currentPublicationId: 'pub_pro', pendingPublicationId: 'pub_nueva', revision: 4 })
    expect(base.bitacora).toHaveLength(0)
  })

  it('la regla de precio rota tumba la finalización y no queda nada', async () => {
    pendiente()
    mockRegla.mockRejectedValueOnce(new ConflictError('rompe promociones', 'HYBRID_LIST_BREAKS_PROMOTIONS'))
    await expect(enTransaccion(tx => finalizarListaDelPlanEn(tx, 'PRO', 'pub_nueva', 'staff1'))).rejects.toMatchObject({
      code: 'HYBRID_LIST_BREAKS_PROMOTIONS',
    })
    expect(listaPro()).toMatchObject({ currentPublicationId: 'pub_pro', pendingPublicationId: 'pub_nueva', revision: 4 })
  })

  it('soltarListaPendienteDelPlanEn sólo limpia esa pendiente', async () => {
    pendiente()
    await enTransaccion(tx => soltarListaPendienteDelPlanEn(tx, 'PRO', 'pub_otra'))
    expect(listaPro()).toMatchObject({ pendingPublicationId: 'pub_nueva', revision: 4 })

    await enTransaccion(tx => soltarListaPendienteDelPlanEn(tx, 'PRO', 'pub_nueva'))
    expect(listaPro()).toMatchObject({ currentPublicationId: 'pub_pro', pendingPublicationId: null, revision: 5 })
  })
})

describe('regresión: los escritores de hoy', () => {
  it('saveListPrice de FEATURE:* y saveBasicPlan se comportan igual que antes', async () => {
    const fila = await saveListPrice({ productKey: 'FEATURE:CFDI', price: 229, expectedRevision: null }, 'staff1')

    expect(fila).toMatchObject({ productKey: 'FEATURE:CFDI', price: 229, pendingPrice: null, status: 'ACTIVE', revision: 2 })
    const [lista] = base.llamadasA('hybridCampaign', 'create')
    expect(lista.args.data).toMatchObject({ purpose: 'LIST', listProductKey: 'FEATURE:CFDI', code: 'L_CFDI', name: 'Facturación CFDI' })
    const [reclamo, finalizacion] = base.llamadasA('hybridCampaign', 'updateMany').map(l => l.args)
    expect(base.llamadasA('hybridOfferPublication', 'create')).toHaveLength(1)
    const publicationId = reclamo.data.pendingPublicationId
    expect(reclamo.where).toEqual({ id: expect.any(String), revision: 0 })
    expect(Object.keys(reclamo.data).sort()).toEqual(['draftDefinition', 'pendingPublicationId', 'revision'])
    expect(finalizacion).toEqual({
      where: { id: reclamo.where.id, purpose: 'LIST', revision: 1, pendingPublicationId: publicationId },
      data: { currentPublicationId: publicationId, pendingPublicationId: null, revision: { increment: 1 }, status: 'ACTIVE' },
    })
    expect(mockEnsure).toHaveBeenCalledWith(publicationId)
    expect(mockRegla).toHaveBeenCalledWith(expect.anything(), 'FEATURE:CFDI', 229)
    // Ningún escritor de FEATURE:* lee la oferta de los planes.
    expect(base.llamadasA('planOfferPointer', 'findUnique')).toHaveLength(0)

    const basico = await saveBasicPlan(
      { name: 'Plan Básico', featureCodes: ['CFDI'], price: 578.84, seatCap: null, expectedRevision: null },
      'staff1',
    )
    expect(basico).toMatchObject({ productKey: 'PLAN:BASICO', price: 578.84, status: 'ACTIVE' })
    const listaBasica = base.llamadasA('hybridCampaign', 'create')[1].args.data
    expect(listaBasica).toMatchObject({ listProductKey: 'PLAN:BASICO', code: 'L_PLAN_BASICO', slug: 'plan-basico', name: 'Plan Básico' })
    const reclamoBasico = base.llamadasA('hybridCampaign', 'updateMany')[2].args
    expect(reclamoBasico.data).toMatchObject({ name: 'Plan Básico' })
    // La regla de precio de lista corre al guardar y al finalizar CFDI; el Básico no entra a ella.
    expect(mockRegla.mock.calls.map(c => c[1])).toEqual(['FEATURE:CFDI', 'FEATURE:CFDI'])
    expect(base.bitacora.map(l => l.action)).toEqual(['HYBRID_LIST_PRICE_SAVED', 'HYBRID_LIST_PRICE_SAVED', 'HYBRID_BASIC_PLAN_SAVED'])
  })
})

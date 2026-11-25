/**
 * Planes editables B1, Task 3: con la versión de la oferta sembrada, los escritores viejos de las listas `PLAN:PRO` y
 * `PLAN:PREMIUM` se niegan (409 `PLAN_OFFER_OWNS_PLAN_LISTS`).
 *
 * 🔴 Dos capas: la negativa rápida al inicio (`seedPlanList`, `recomposePlanList`; `retryListPrice` en cuanto ve un precio pendiente:
 * sin él devuelve la fila, como B0) y la misma negativa DENTRO
 * de la transacción de `saveList` y de `finalizeListPublication`, después del candado del producto: un escritor viejo que pasó
 * la revisión rápida antes del sembrado no prepara ni finaliza después. Con `FEATURE:*` y `PLAN:BASICO` nada cambia.
 */
const mockEnsure = jest.fn()
jest.mock('@/services/launchCampaigns/hybridPrices', () => ({ ensureHybridPublicationPrices: (...a: unknown[]) => mockEnsure(...a) }))
jest.mock('@/services/launchCampaigns/hybridPriceRule', () => ({ assertPriceRuleForList: jest.fn(async () => undefined) }))

import { retryListPrice, recomposePlanList, seedPlanList } from '@/services/launchCampaigns/hybridListPrice.service'
import { prismaMock } from '@tests/__helpers__/setup'
import { definicionDeLaListaDelPlan, punteroA, versionUno } from '@tests/__helpers__/planOfferFixtures'

const NEGATIVA = { statusCode: 409, code: 'PLAN_OFFER_OWNS_PLAN_LISTS' }
const PUNTERO = () => punteroA('cv1', 1, versionUno())

/** El puntero que ve cada lectura: se puede cambiar a media operación (el sembrado que llega entre dos pasos). */
let vigente: ReturnType<typeof punteroA> | null = null

beforeEach(() => {
  vigente = null
  prismaMock.planOfferPointer.findUnique.mockReset().mockImplementation(async () => vigente)
  mockEnsure.mockReset().mockResolvedValue(undefined)
  prismaMock.$queryRaw.mockReset().mockResolvedValue([])
  prismaMock.hybridCampaign.findMany.mockReset().mockResolvedValue([])
  prismaMock.hybridCampaign.findFirst.mockReset().mockResolvedValue(null)
  prismaMock.hybridCampaign.findUniqueOrThrow.mockReset()
  prismaMock.hybridCampaign.create.mockReset()
  prismaMock.hybridCampaign.updateMany.mockReset().mockResolvedValue({ count: 1 })
  prismaMock.hybridOfferPublication.findMany.mockReset().mockResolvedValue([])
  prismaMock.hybridOfferPublication.findUniqueOrThrow.mockReset()
  prismaMock.hybridOfferPublication.create.mockReset()
  prismaMock.activityLog.create.mockReset().mockResolvedValue({ id: 'log' })
})

/** Los valores con que se tomaron los candados de producto (`lockProducts`), en orden. */
const candados = () => prismaMock.$executeRaw.mock.calls.map((c: unknown[]) => c[1])
const movioElPuntero = () =>
  prismaMock.hybridCampaign.updateMany.mock.calls.some((c: [{ data: Record<string, unknown> }]) => 'currentPublicationId' in c[0].data)

describe('la negativa rápida', () => {
  it.each(['PLAN:PRO', 'PLAN:PREMIUM'])(
    'retryListPrice(%s) con versión y un precio PENDIENTE → 409 PLAN_OFFER_OWNS_PLAN_LISTS y no toca Stripe',
    async key => {
      vigente = PUNTERO()
      prismaMock.hybridCampaign.findFirst.mockResolvedValue({ id: 'list1', revision: 2, pendingPublicationId: 'pub_pend' })

      await expect(retryListPrice(key, 'staff1')).rejects.toMatchObject(NEGATIVA)
      // Codex B1 #4: primero se lee la lista (¿hay algo que terminar?); con pendiente, la negativa, y nada se prepara.
      expect(mockEnsure).not.toHaveBeenCalled()
      expect(prismaMock.$transaction).not.toHaveBeenCalled()
      expect(prismaMock.planOfferPointer.findUnique.mock.invocationCallOrder[0]).toBeGreaterThan(
        prismaMock.hybridCampaign.findFirst.mock.invocationCallOrder[0],
      )
    },
  )

  it.each(['PLAN:PRO', 'PLAN:PREMIUM'])(
    '🔴 Codex B1 #4: retryListPrice(%s) con versión y SIN pendiente devuelve la fila, como B0 (sin negativa ni Stripe)',
    async key => {
      vigente = PUNTERO()
      prismaMock.hybridCampaign.findFirst.mockResolvedValue({ id: 'list1', revision: 2, pendingPublicationId: null })

      await expect(retryListPrice(key, 'staff1')).resolves.toMatchObject({ productKey: key, pendingPrice: null })
      expect(mockEnsure).not.toHaveBeenCalled()
      expect(prismaMock.$transaction).not.toHaveBeenCalled()
      // Sin nada que terminar, ni siquiera se lee la oferta (como B0, que no la conocía).
      expect(prismaMock.planOfferPointer.findUnique).not.toHaveBeenCalled()
    },
  )

  it.each(['FEATURE:CFDI', 'PLAN:BASICO'])('retryListPrice de %s sigue igual: prepara y finaliza su pendiente', async key => {
    vigente = PUNTERO()
    prismaMock.hybridCampaign.findFirst.mockResolvedValue({ id: 'list1', revision: 2, pendingPublicationId: 'pub_pend' })
    prismaMock.hybridCampaign.findUniqueOrThrow.mockResolvedValue({ id: 'list1', currentPublicationId: null, status: 'DRAFT' })
    prismaMock.hybridOfferPublication.findUniqueOrThrow.mockResolvedValue({
      id: 'pub_pend',
      definition: {
        schemaVersion: 1,
        kind: 'FEATURES',
        featureCodes: ['CFDI'],
        terms: {
          currency: 'MXN',
          interval: 'MONTHLY',
          price: 229,
          taxIncluded: true,
          promotionCycles: null,
          renewal: { kind: 'SAME_PRICE' },
        },
      },
    })

    await retryListPrice(key, 'staff1')
    expect(mockEnsure).toHaveBeenCalledWith('pub_pend')
    expect(movioElPuntero()).toBe(true)
    // Ni la revisión rápida ni la de la transacción leen la oferta para un producto que no es un plan.
    expect(prismaMock.planOfferPointer.findUnique).not.toHaveBeenCalled()
  })

  it('seedPlanList y recomposePlanList con versión → 409 PLAN_OFFER_OWNS_PLAN_LISTS', async () => {
    vigente = PUNTERO()
    prismaMock.hybridCampaign.findFirst.mockResolvedValue({
      id: 'list_pro',
      revision: 3,
      currentPublicationId: 'pub_pro',
      pendingPublicationId: null,
    })

    await expect(seedPlanList('PRO', 1158.84, 'staff1')).rejects.toMatchObject(NEGATIVA)
    await expect(seedPlanList('PREMIUM', 1970.84, 'staff1')).rejects.toMatchObject(NEGATIVA)
    await expect(recomposePlanList('PRO', 'staff1')).rejects.toMatchObject(NEGATIVA)
    await expect(recomposePlanList('PREMIUM', 'staff1')).rejects.toMatchObject(NEGATIVA)
    expect(mockEnsure).not.toHaveBeenCalled()
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
    expect(prismaMock.hybridOfferPublication.create).not.toHaveBeenCalled()
  })
})

describe('🔴 la negativa dentro de la transacción', () => {
  it('🔴 recomposePlanList que pasó la revisión rápida y encuentra la versión dentro de la transacción de saveList → 409, sin publicación nueva', async () => {
    // La lista en venta trae una composición vieja: recomponer la republica.
    const list = { id: 'list_pro', revision: 3, currentPublicationId: 'pub_pro', pendingPublicationId: null }
    prismaMock.hybridCampaign.findFirst.mockResolvedValue(list)
    prismaMock.hybridOfferPublication.findUniqueOrThrow.mockResolvedValue({
      definition: definicionDeLaListaDelPlan('PRO', 1158.84),
      includedFeatureCodes: ['FUNCION_QUE_YA_NO_ESTA'],
    })
    // El sembrado llega justo después de la revisión rápida (antes de que saveList tome el candado del producto).
    prismaMock.planOfferPointer.findUnique.mockImplementationOnce(async () => {
      vigente = PUNTERO()
      return null
    })

    await expect(recomposePlanList('PRO', 'staff1')).rejects.toMatchObject(NEGATIVA)
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    expect(candados()).toEqual(['precio:PLAN:PRO'])
    // La negativa leyó la oferta DESPUÉS del candado del producto, con la transacción.
    expect(prismaMock.planOfferPointer.findUnique.mock.invocationCallOrder[1]).toBeGreaterThan(
      prismaMock.$executeRaw.mock.invocationCallOrder[0],
    )
    expect(prismaMock.hybridOfferPublication.create).not.toHaveBeenCalled()
    expect(prismaMock.hybridCampaign.updateMany).not.toHaveBeenCalled()
    expect(mockEnsure).not.toHaveBeenCalled()
  })

  it('🔴 finalizeListPublication de PLAN:PRO con versión (pendiente preparada antes del sembrado) → 409 y el puntero híbrido no se mueve', async () => {
    // seedPlanList crea la lista y su pendiente sin versión; el sembrado llega mientras se prepara Stripe.
    prismaMock.hybridCampaign.create.mockImplementation(async ({ data }: { data: object }) => ({ id: 'list_pro', revision: 0, ...data }))
    prismaMock.hybridOfferPublication.create.mockResolvedValue({ id: 'pub_new' })
    mockEnsure.mockImplementation(async () => {
      vigente = PUNTERO()
    })

    await expect(seedPlanList('PRO', 1158.84, 'staff1')).rejects.toMatchObject(NEGATIVA)
    expect(mockEnsure).toHaveBeenCalledWith('pub_new')
    // La pendiente se preparó, pero el puntero de la lista NO pasó a ella.
    expect(prismaMock.hybridCampaign.updateMany).toHaveBeenCalledTimes(1)
    expect(prismaMock.hybridCampaign.updateMany.mock.calls[0][0].data).toMatchObject({ pendingPublicationId: 'pub_new' })
    expect(movioElPuntero()).toBe(false)
    expect(prismaMock.hybridCampaign.findUniqueOrThrow).not.toHaveBeenCalled()
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
    // Dos transacciones (guardar y finalizar), cada una con el candado del producto antes de leer la oferta.
    expect(candados()).toEqual(['precio:PLAN:PRO', 'precio:PLAN:PRO'])
    expect(prismaMock.planOfferPointer.findUnique.mock.invocationCallOrder[2]).toBeGreaterThan(
      prismaMock.$executeRaw.mock.invocationCallOrder[1],
    )
  })

  it('sin versión, seedPlanList sigue sembrando como antes', async () => {
    prismaMock.hybridCampaign.create.mockImplementation(async ({ data }: { data: object }) => ({ id: 'list_pro', revision: 0, ...data }))
    prismaMock.hybridOfferPublication.create.mockResolvedValue({ id: 'pub_new' })
    prismaMock.hybridCampaign.findUniqueOrThrow.mockResolvedValue({ id: 'list_pro', currentPublicationId: null, status: 'DRAFT' })
    prismaMock.hybridOfferPublication.findUniqueOrThrow.mockResolvedValue({
      id: 'pub_new',
      definition: definicionDeLaListaDelPlan('PRO', 1158.84),
    })

    const { outcome } = await seedPlanList('PRO', 1158.84, 'staff1')
    expect(outcome).toBe('CREATE')
    expect(prismaMock.hybridCampaign.create.mock.calls[0][0].data).toMatchObject({
      listProductKey: 'PLAN:PRO',
      code: 'L_PLAN_PRO',
      name: 'Plan Pro',
    })
    expect(mockEnsure).toHaveBeenCalledWith('pub_new')
    expect(prismaMock.hybridCampaign.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'list_pro', purpose: 'LIST', revision: 1, pendingPublicationId: 'pub_new' },
      data: { currentPublicationId: 'pub_new', pendingPublicationId: null, revision: { increment: 1 }, status: 'ACTIVE' },
    })
    expect(prismaMock.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'HYBRID_LIST_PRICE_SAVED', entityId: 'list_pro' }),
    })
  })
})

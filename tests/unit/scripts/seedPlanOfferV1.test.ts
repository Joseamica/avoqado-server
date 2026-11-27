/**
 * Planes editables B1, Task 3: la entrada real de `scripts/seed-plan-offer-v1.ts`, con Stripe simulado y el `prismaMock`.
 *
 * 🔴 Sin --apply sólo imprime (la Mac lo corre contra producción ANTES de unir, cuando esa base todavía no tiene las tablas de
 * B1). Con --apply exige repetir host y base de DATABASE_URL, y contra una base sin las tablas de B1 se niega.
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

import { SeedRefusal, seedPlanOfferV1 } from '../../../scripts/seed-plan-offer-v1'
import { prismaMock } from '@tests/__helpers__/setup'
import { escenarioDelSembrado, montarEscenarioDelSembrado, type EscenarioDelSembrado } from '@tests/__helpers__/planOfferFixtures'

const URL_ANTES = process.env.DATABASE_URL
const APLICAR = { apply: true, confirmHost: 'localhost', confirmDb: 'avoqado_v1_test', staffId: 'st1' }

beforeAll(() => {
  process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/avoqado_v1_test'
})
afterAll(() => {
  process.env.DATABASE_URL = URL_ANTES
})

function montar(e: EscenarioDelSembrado = escenarioDelSembrado()) {
  montarEscenarioDelSembrado(e, {
    prisma: prismaMock,
    pricesList: mockPricesList,
    productsRetrieve: mockProductsRetrieve,
    subscriptionsList: mockSubscriptionsList,
  })
  mockGap.mockReset().mockResolvedValue({ missing: [], extra: [] })
  prismaMock.staff.findUnique.mockReset().mockResolvedValue({ id: 'st1' })
  return e
}

async function correr(options: Parameters<typeof seedPlanOfferV1>[0]) {
  const lines: string[] = []
  const resultado = await seedPlanOfferV1(options, line => lines.push(line))
  return { resultado, text: lines.join('\n') }
}

async function negativa(options: Parameters<typeof seedPlanOfferV1>[0]) {
  const lines: string[] = []
  const error = await seedPlanOfferV1(options, line => lines.push(line)).then(
    () => null,
    e => e,
  )
  return { error, text: lines.join('\n') }
}

const nadaEscrito = () => {
  expect(prismaMock.planOfferVersion.create).not.toHaveBeenCalled()
  expect(prismaMock.planOfferPointer.upsert).not.toHaveBeenCalled()
  expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
}

beforeEach(() => {
  prismaMock.$transaction.mockClear()
})

it('sin --apply imprime el reporte y no escribe', async () => {
  montar()
  const { resultado, text } = await correr({ apply: false })

  expect(resultado).toMatchObject({ host: 'localhost', resultado: 'CREATE', versionId: null })
  expect(text).toContain('Base: localhost  base de datos: avoqado_v1_test  modo: SIMULACIÓN')
  expect(text).toContain('Stripe: PRUEBAS')
  expect(text).toMatch(/se sembraría la versión 1/)
  expect(text).toContain('plan_pro_monthly')
  expect(text).toContain('price_key_premium_a')
  expect(text).toContain('PLAN:PRO')
  expect(text).toContain('Plan Avoqado Premium')
  expect(text).toMatch(/Suscripciones vivas de plan: 0 revisadas/)
  expect(prismaMock.$transaction).not.toHaveBeenCalled()
  expect(prismaMock.staff.findUnique).not.toHaveBeenCalled()
  nadaEscrito()
})

it('🔴 sin --apply contra una base sin las tablas de B1 (P2021 al leer el puntero) imprime el reporte con «sin versión»; con --apply → SeedRefusal', async () => {
  montar()
  const sinTablas = () =>
    prismaMock.planOfferPointer.findUnique.mockRejectedValue(Object.assign(new Error('The table does not exist'), { code: 'P2021' }))
  sinTablas()

  const simulacion = await correr({ apply: false })
  expect(simulacion.resultado.resultado).toBe('CREATE')
  expect(simulacion.text).toContain('sin versión')
  expect(simulacion.text).toContain('la base todavía no tiene las tablas de B1')
  expect(simulacion.text).toContain('plan_pro_monthly')

  mockPricesList.mockClear()
  const { error, text } = await negativa(APLICAR)
  expect(error).toBeInstanceOf(SeedRefusal)
  expect(error.message).toContain('aplica primero la migración de B1')
  expect(text).toContain('modo: APLICAR')
  // Se niega antes de revisar Stripe y de escribir.
  expect(mockPricesList).not.toHaveBeenCalled()
  expect(prismaMock.$transaction).not.toHaveBeenCalled()
  nadaEscrito()
})

it.each([
  ['sin --confirm-host', { apply: true, confirmDb: 'avoqado_v1_test' }],
  ['con un host distinto', { apply: true, confirmHost: 'otra-base.example.com', confirmDb: 'avoqado_v1_test' }],
  ['con otra base en el mismo host', { apply: true, confirmHost: 'localhost', confirmDb: 'avoqado_produccion' }],
])('con --apply %s se niega con SeedRefusal y no escribe', async (_caso, options) => {
  montar()
  const { error, text } = await negativa(options)
  expect(error).toBeInstanceOf(SeedRefusal)
  expect(error.message).toContain('--confirm-host localhost --confirm-db avoqado_v1_test')
  expect(text).toContain('modo: APLICAR')
  // Ni siquiera lee: la base y Stripe se tocan sólo después de la comprobación.
  expect(prismaMock.planOfferPointer.findUnique).not.toHaveBeenCalled()
  expect(mockPricesList).not.toHaveBeenCalled()
  nadaEscrito()
})

it('con --apply y la confirmación correcta siembra la v1', async () => {
  montar()
  const { resultado, text } = await correr(APLICAR)

  expect(resultado).toMatchObject({ resultado: 'CREATE', versionId: 'cv1' })
  expect(prismaMock.staff.findUnique).toHaveBeenCalledWith({ where: { id: 'st1' }, select: { id: true } })
  expect(prismaMock.planOfferVersion.create).toHaveBeenCalledTimes(1)
  expect(prismaMock.planOfferVersion.create.mock.calls[0][0].data).toMatchObject({ number: 1, status: 'PUBLISHED', createdById: 'st1' })
  expect(prismaMock.planOfferPointer.upsert).toHaveBeenCalledTimes(1)
  expect(text).toContain('modo: APLICAR')
  expect(text).toMatch(/sembrada la versión 1 \(cv1\)/)
})

it('con --apply y un resultado que no es CREATE (MISSING) imprime el reporte, se niega y no escribe', async () => {
  const e = escenarioDelSembrado()
  e.precios.plan_premium_annual = undefined
  montar(e)
  const { error, text } = await negativa(APLICAR)
  expect(error).toBeInstanceOf(SeedRefusal)
  expect(error.message).toMatch(/No se sembró.*MISSING/)
  expect(text).toContain('plan_premium_annual')
  nadaEscrito()
})

it('con --apply y una vigente es EXISTS: no escribe y no falla', async () => {
  montar()
  prismaMock.planOfferPointer.findUnique.mockResolvedValue({ currentVersionId: 'cv1' })
  const { resultado, text } = await correr(APLICAR)
  expect(resultado).toMatchObject({ resultado: 'EXISTS', versionId: null })
  expect(text).toMatch(/ya existe una versión vigente/)
  nadaEscrito()
})

it('con --apply sin --staff toma al primer SUPERADMIN; sin ninguno se niega', async () => {
  montar()
  prismaMock.staff.findFirst.mockReset().mockResolvedValue(null)
  const { error } = await negativa({ ...APLICAR, staffId: undefined })
  expect(error).toBeInstanceOf(SeedRefusal)
  expect(error.message).toContain('--staff')
  nadaEscrito()
})

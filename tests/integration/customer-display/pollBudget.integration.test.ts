// tests/integration/customer-display/pollBudget.integration.test.ts
// 🔴 Las pruebas dependen del ORDEN (pool → caliente → sin versión → tope lleno → …): correr una sola con `-t` cambia sus cuentas.
import express from 'express'
import request from 'supertest'

/**
 * La regresión del presupuesto del poll (spec §5.7.4; I1 de la revisión de la Task 13): FIJA lo que el spec promete contar
 * —falla si alguien lo rompe— con un fixture chico, y corre SIEMPRE (CI y cierres de fase). Ninguna de estas cuentas
 * depende del tamaño del catálogo. La medición pesada (planes, latencias, tormentas, 25,000 productos) vive en
 * `pollBudget.measure.integration.test.ts` y sólo corre con MEDIR_POLL=1.
 */
jest.mock('@/utils/prismaClient', () => jest.requireActual('./pollBudget').clienteDeMedicion())
jest.mock('@/middlewares/authenticateToken.middleware', () => jest.requireActual('./pollBudget').autenticacionDeMedicion())
jest.mock('@/middlewares/validateVenueAccess.middleware', () => jest.requireActual('./pollBudget').membresiaDeMedicion())

import prisma from '@/utils/prismaClient'
import mobileRoutes from '@/routes/mobile.routes'
import { readVenuePlanSnapshot } from '@/services/customer-display/venuePlanSnapshot'
import { refreshCarousel, resetCarouselCacheForTests } from '@/services/customer-display/promotionCarousel.service'
import { venueSignaturesSql } from '@/services/customer-display/venueSignatures'
import { POLL_WORK_MAX_IN_FLIGHT, pollWorkLimiter } from '@/services/customer-display/pollWork'
import { esLigeraPorAbrir, esperarQuietudDe, tablaDeLaSentencia, type Sentencia } from './pollBudget'

const { sentencias, urlDeMedicion } = jest.requireMock('@/utils/prismaClient') as { sentencias: Sentencia[]; urlDeMedicion: string }
const suffix = `pb-${Date.now()}`
const TABLETS = 3
const REFRESCOS = 50
let orgId: string
let venueId: string

const app = express()
app.use(express.json())
app.use('/api/v1/mobile', mobileRoutes)
// Sin X-Device-Platform: el registro pasivo de aparatos no corre y no ensucia la cuenta.
const poll = (deviceUid: string) => request(app).get(`/api/v1/mobile/venues/${venueId}/display-mode-request`).set('x-device-id', deviceUid)
const conAparato = (ruta: 'promotions' | 'settings', deviceUid?: string) => {
  const r = request(app).get(`/api/v1/mobile/venues/${venueId}/${ruta}`)
  return deviceUid ? r.set('x-device-id', deviceUid) : r
}
const tablet = (i: number) => `dev-${suffix}-${i}`
const tablas = () => sentencias.map(s => tablaDeLaSentencia(s.query, venueSignaturesSql(venueId).text))
const esperarQuietud = (quieto?: number) => esperarQuietudDe(sentencias, { quieto })

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `Org ${suffix}`, email: `${suffix}@example.test`, phone: '0000000000' },
      select: { id: true },
    })
  ).id
  // Exento (heredado): pasa `checkFeatureAccess('PROMOTIONS')` de /promotions y los dos grants salen en `true`.
  venueId = (
    await prisma.venue.create({
      data: { organizationId: orgId, name: `V ${suffix}`, slug: `v-${suffix}`, timezone: 'America/Mexico_City', seatCapExempt: true },
      select: { id: true },
    })
  ).id
  await prisma.venueSettings.create({ data: { venueId } })
  const categoria = await prisma.menuCategory.create({ data: { venueId, name: 'Todo', slug: `todo-${suffix}` }, select: { id: true } })
  const productos = await Promise.all(
    [0, 1].map(i =>
      prisma.product.create({
        data: { venueId, categoryId: categoria.id, sku: `S${i}-${suffix}`, name: `Producto ${i}`, price: '50.00' },
        select: { id: true },
      }),
    ),
  )
  await prisma.promotion.createMany({
    data: [0, 1].map(i => ({
      venueId,
      name: `Promo ${i}`,
      type: 'DISCOUNT' as const,
      pricingMode: 'FIXED_TOTAL' as const,
      priceCents: 8_000,
      status: 'PUBLISHED' as const,
    })),
  })
  await prisma.promotion.create({
    data: {
      venueId,
      name: 'Combo',
      type: 'COMBO',
      pricingMode: 'FIXED_TOTAL',
      priceCents: 9_900,
      status: 'PUBLISHED',
      groups: { create: { name: 'Elige', options: { create: productos.map(p => ({ productId: p.id })) } } },
    },
  })
  await prisma.terminal.createMany({
    data: Array.from({ length: TABLETS }, (_, i) => ({
      venueId,
      name: `Caja ${i}`,
      type: 'POS_ANDROID' as const,
      deviceUid: tablet(i),
      customerDisplayDesignVersion: 2,
      customerDisplayInstallationId: `inst-${i}`,
    })),
  })
  await prisma.terminal.create({ data: { venueId, name: 'Vieja', type: 'POS_ANDROID', deviceUid: `dev-${suffix}-vieja` } })
}, 120_000)

afterAll(async () => {
  // M4: por organización, no por lo que alcanzó a anotarse: un `beforeAll` caído a la mitad no deja residuo.
  if (!orgId) return // sin esta guarda, un id undefined vaciaría tablas enteras (8-oct)
  const todos = (await prisma.venue.findMany({ where: { organizationId: orgId }, select: { id: true }, take: 10 })).map(v => v.id)
  await prisma.promotion.deleteMany({ where: { venueId: { in: todos } } })
  await prisma.product.deleteMany({ where: { venueId: { in: todos } } })
  await prisma.menuCategory.deleteMany({ where: { venueId: { in: todos } } })
  await prisma.terminal.deleteMany({ where: { venueId: { in: todos } } })
  await prisma.venue.deleteMany({ where: { id: { in: todos } } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
  await prisma.$disconnect()
}, 60_000)

it('🔴 el cliente usa el pool REAL (Codex r1 #11, M1): la URL lleva el connection_limit y el pool abre EXACTAMENTE ese número', async () => {
  const limite = process.env.DATABASE_CONNECTION_LIMIT || '18'
  expect(new URL(urlDeMedicion).searchParams.get('connection_limit')).toBe(limite)
  // La URL sola no basta: un cliente armado sin ella usaría el default de Prisma (núcleos × 2 + 1). Con tres oleadas de
  // consultas lentas el pool abre todas sus conexiones: más o menos que el límite, cae en cualquier máquina.
  const pids = await Promise.all(
    Array.from(
      { length: Number(limite) * 3 },
      () => prisma.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid, pg_sleep(0.3)::text AS s`,
    ),
  )
  expect(new Set(pids.map(([f]) => f.pid)).size).toBe(Number(limite))
}, 60_000)

it('🔴 cuerpo del poll EN CALIENTE (sin sesión ni membresía): DOS sentencias, la terminal y la de firmas — spec §5.7.4', async () => {
  await poll(tablet(0)) // calienta la ficha, el plan y el carrusel
  await esperarQuietud()
  sentencias.length = 0
  const r = await poll(tablet(0))
  expect(r.body.data.fingerprints).toMatchObject({ customerDisplay: expect.any(String), promotions: expect.any(String) })
  await esperarQuietud() // la de firmas corre SIEMPRE: se espera a que su evento llegue antes de contar
  expect(tablas()).toEqual(['Terminal', 'firmas (cruda)'])
}, 60_000)

it('🔴 cuerpo del poll de un aparato SIN versión: UNA sentencia, como hoy (decisión 1)', async () => {
  sentencias.length = 0
  const r = await poll(`dev-${suffix}-vieja`)
  expect(r.status).toBe(200)
  expect(r.body.data.fingerprints).toEqual({})
  await esperarQuietud()
  expect(sentencias).toHaveLength(1)
})

// 🔴 Ésta es la que protege el invariante del tope (I2): con los 8 lugares ocupados, ninguna lectura del poll corre fuera.
it('🔴 con el tope LLENO, el poll no arranca trabajo de base fuera de él: sólo la sentencia de la terminal (Codex r1 #2)', async () => {
  // El plan en caché y el carrusel NO: la huella de promociones tendría que construir el carrusel, y no hay lugar.
  await readVenuePlanSnapshot(venueId)
  resetCarouselCacheForTests()
  const liberar: Array<() => void> = []
  for (let i = 0; i < POLL_WORK_MAX_IN_FLIGHT; i++) pollWorkLimiter.intentar(() => new Promise<void>(res => liberar.push(res)))
  try {
    expect(pollWorkLimiter.enVuelo).toBe(POLL_WORK_MAX_IN_FLIGHT)
    sentencias.length = 0
    const r = await poll(tablet(0))
    expect(r.status).toBe(200)
    // M2: un segundo ENTERO sin ninguna sentencia nueva (el tope sigue lleno a propósito), no un plazo fijo.
    await esperarQuietudDe(sentencias, { quieto: 1_000, conTope: false })
    expect(r.body.data.fingerprints).not.toHaveProperty('promotions')
    expect(r.body.data.fingerprints).not.toHaveProperty('settings')
    expect(tablas()).toEqual(['Terminal'])
  } finally {
    for (const soltar of liberar) soltar()
  }
  await esperarQuietud()
})

it('🔴 la consulta del aparato que /promotions y /settings pagan con X-Device-ID aunque no sea una tablet v2: +1 sentencia, y nada más', async () => {
  // Un deviceUid que NO está en el negocio: aísla el binding (con un aparato real, /settings además lee SUS ajustes).
  const contar = async (hacer: () => request.Test) => {
    expect((await hacer()).status).toBe(200) // calienta lo que tenga caché
    await esperarQuietud(300)
    sentencias.length = 0
    expect((await hacer()).status).toBe(200)
    await esperarQuietud(300)
    return sentencias.length
  }
  const ajeno = `no-existe-${suffix}`
  expect((await contar(() => conAparato('promotions', ajeno))) - (await contar(() => conAparato('promotions')))).toBe(1)
  expect((await contar(() => conAparato('settings', ajeno))) - (await contar(() => conAparato('settings')))).toBe(1)
}, 60_000)

it(`🔴 ${REFRESCOS} refrescos del carrusel A LA VEZ = UNA construcción (la ventana de REFRESH_COALESCE_MS)`, async () => {
  resetCarouselCacheForTests() // sin un refresh reciente guardado: los 50 tienen que unirse al MISMO vuelo
  await esperarQuietud(300)
  sentencias.length = 0
  await Promise.all(Array.from({ length: REFRESCOS }, () => refreshCarousel(venueId)))
  await esperarQuietud(300)
  expect(sentencias.filter(esLigeraPorAbrir)).toHaveLength(1)
}, 60_000)

it('🔴 /settings de una tablet v2: el bloque de la pantalla sale bien y trae SU huella de ajustes', async () => {
  const r = await conAparato('settings', tablet(0))
  expect(r.status).toBe(200)
  expect(r.body.data.componentsStatus).toMatchObject({ customerDisplay: 'ok' })
  expect(r.body.data.fingerprints).toEqual({ settings: expect.stringMatching(/^[0-9a-f]{32}$/) })
  await esperarQuietud()
})

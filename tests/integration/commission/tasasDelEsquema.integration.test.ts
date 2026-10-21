// tests/integration/commission/tasasDelEsquema.integration.test.ts
/**
 * Fase 3 de Pago al personal, final-fijo-niveles (parte del servidor), contra Postgres REAL y por la RUTA real (app + token).
 *
 * Una tasa de comisión va de 0 % a 100 % (`defaultRate` 0.0300 = 3 %). Pero un esquema de MONTO FIJO guarda sus PESOS en esa
 * misma columna (`commission-calculation.service.ts:177-179`: FIXED paga `defaultRate` tal cual). El asistente del dashboard,
 * con «Monto fijo» y niveles prendidos, mandaba `calcType: 'TIERED'` con `defaultRate = fixedAmount`: un fijo de $10 sería
 * una tasa de 1000 % para quien no cae en un nivel. La frontera lo rechaza con 400 y texto humano: la regla de 0-100 % vale
 * para porcentaje, niveles y las demás tasas (niveles, por rol, por persona, por meta), y NO para el monto de un fijo.
 *
 * Correr: TZ=UTC TEST_DATABASE_URL="$PAGO_F3_DB" npx jest --selectProjects=integration \
 *   --runTestsByPath tests/integration/commission/tasasDelEsquema.integration.test.ts --ci --runInBand
 */
import type { Server } from 'http'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import app from '@/app'
import prisma from '@/utils/prismaClient'
import {
  asegurarBaseDePrueba,
  borrarMundoComisiones,
  cobro,
  crearMundoComisiones,
  MundoComisiones,
  orden,
  planear,
  procesarEfectos,
} from './_mundoComisiones'

// El plan (Comisiones es Premium) va simulado: aquí se prueba la validación de lo que se guarda.
jest.mock('@/services/access/basePlan.service', () => ({
  ...jest.requireActual('@/services/access/basePlan.service'),
  venueHasCommissionsAccess: jest.fn(async () => true),
}))

let m: MundoComisiones
let server: Server
beforeAll(async () => {
  asegurarBaseDePrueba()
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>(listo => server.once('listening', () => listo()))
})
afterAll(async () => {
  await new Promise<void>(listo => server.close(() => listo()))
})
beforeEach(async () => {
  m = await crearMundoComisiones('tasas-del-esquema')
})
afterEach(async () => {
  const mundo = m
  m = undefined as unknown as MundoComisiones
  if (mundo) {
    // Las comisiones de las ventas de la prueba apuntan también a los esquemas de la organización: van primero.
    await prisma.commissionCalculation.deleteMany({ where: { venueId: mundo.venueId } })
    await prisma.commissionTier.deleteMany({ where: { config: { orgId: mundo.orgId } } })
    await prisma.commissionOverride.deleteMany({ where: { venueId: mundo.venueId } })
    await prisma.commissionConfig.deleteMany({ where: { orgId: mundo.orgId, venueId: null } })
  }
  await borrarMundoComisiones(mundo)
})

const token = () =>
  jwt.sign({ sub: m.owner, orgId: m.orgId, venueId: m.venueId, role: 'OWNER' }, process.env.ACCESS_TOKEN_SECRET as string, {
    expiresIn: '15m',
  })
const ruta = (r: string) => `/api/v1/dashboard/commissions/venues/${m.venueId}${r}`
const post = (r: string, cuerpo: object) => request(server).post(ruta(r)).set('Authorization', `Bearer ${token()}`).send(cuerpo)
const put = (r: string, cuerpo: object) => request(server).put(ruta(r)).set('Authorization', `Bearer ${token()}`).send(cuerpo)

/**
 * El cuerpo EXACTO que mandaba el asistente (`CreateCommissionWizard.tsx:180-208`, dashboard `7024d9b5`) con «Monto fijo» de
 * `monto` y «Comisión por Niveles» prendida: `calcType` TIERED y `defaultRate = fixedAmount`.
 */
const fijoConNiveles = (monto: number) => ({
  name: `Fijo $${monto} con niveles`,
  recipient: 'SERVER',
  calcType: 'TIERED',
  defaultRate: monto,
  minAmount: null,
  maxAmount: null,
  includeTips: false,
  includeDiscount: false,
  includeTax: false,
  roleRates: null,
  filterByCategories: false,
  categoryIds: [],
  useGoalAsTier: false,
  goalBonusRate: null,
  priority: 1,
  effectiveFrom: '2026-10-08T06:00:00.000Z',
  effectiveTo: null,
  aggregationPeriod: 'MONTHLY',
})
/** Lo que manda el asistente con «Monto fijo» SIN niveles. */
const fijo = (monto: number) => ({ ...fijoConNiveles(monto), name: `Fijo $${monto}`, calcType: 'FIXED' })
const porcentaje = (tasa: number) => ({ ...fijoConNiveles(tasa), name: `Porcentaje ${tasa}`, calcType: 'PERCENTAGE' })

/** Una venta de `monto` cobrada ahora y su comisión materializada como en la terminal; devuelve los netos de ESE cobro. */
async function comisionDeUnaVenta(monto: number): Promise<string[]> {
  const pago = await cobro(m, await orden(m, { subtotal: monto }), monto, { createdAt: new Date() })
  await planear(pago)
  await procesarEfectos(m)
  return (await prisma.commissionCalculation.findMany({ where: { paymentId: pago }, select: { netCommission: true } })).map(c =>
    c.netCommission.toFixed(2),
  )
}

/** Los esquemas que crearon las llamadas de la prueba: de la sede (`orgId` null) y de la organización (`venueId` null). */
const esquemasNuevos = () =>
  prisma.commissionConfig.count({ where: { OR: [{ venueId: m.venueId }, { orgId: m.orgId }], NOT: { id: m.configId } } })
const esquemasDeLaSede = () => prisma.commissionConfig.count({ where: { venueId: m.venueId, NOT: { id: m.configId } } })

describe('final-fijo-niveles · la API rechaza una tasa de más de 100 % (400, texto humano)', () => {
  it('🔴 el cuerpo exacto del asistente (fijo $10 con niveles ⇒ TIERED, defaultRate 10): 400 y no se guarda nada, en la sede y en la organización', async () => {
    for (const r of ['/configs', '/org-configs']) {
      const res = await post(r, fijoConNiveles(10))
      expect({ r, status: res.status, message: res.body.message }).toEqual({
        r,
        status: 400,
        message:
          'La tasa de comisión va de 0 % a 100 %: 1000 % no es válida. Si querías pagar un monto fijo por venta, elige «Monto fijo».',
      })
    }
    const pct150 = await post('/configs', porcentaje(1.5))
    expect([pct150.status, pct150.body.message]).toEqual([400, expect.stringContaining('150 % no es válida')])
    // Un fijo de $5 con niveles cabe en la columna: en la organización se guardaba como una tasa de 500 %.
    expect((await post('/org-configs', fijoConNiveles(5))).status).toBe(400)
    expect(await esquemasNuevos()).toBe(0)
  })

  it('🔴 D-FIJO: un fijo de $10 y uno de $2 se guardan EN PESOS por la sede y por la organización, y la venta paga $10 / $2', async () => {
    const sede10 = await post('/configs', fijo(10))
    expect([sede10.status, Number(sede10.body.defaultRate)]).toEqual([201, 10])
    const org2 = await post('/org-configs', fijo(2))
    expect([org2.status, Number(org2.body.data.defaultRate)]).toEqual([201, 2])

    // La venta, por el camino de la terminal (efecto durable + worker). Sólo el fijo de la sede está activo en la sede.
    await prisma.commissionConfig.update({ where: { id: m.configId }, data: { active: false } })
    expect(await comisionDeUnaVenta(116)).toEqual(['10.00'])
    // Sin esquemas activos propios, la sede usa los de su organización: el fijo de $2.
    await prisma.commissionConfig.update({ where: { id: sede10.body.id }, data: { active: false } })
    expect(await comisionDeUnaVenta(116)).toEqual(['2.00'])

    // Los límites del monto: de más de $0 a $999,999.99, con 400 y texto humano (nunca 500).
    for (const r of ['/configs', '/org-configs']) {
      for (const [monto, message] of [
        [1_000_000, 'El monto fijo por venta puede ser de hasta $999,999.99.'],
        [0, 'El monto fijo por venta debe ser mayor que $0.'],
        [-1, 'El monto fijo por venta debe ser mayor que $0.'],
      ] as const) {
        const res = await post(r, fijo(monto))
        expect({ r, monto, status: res.status, message: res.body.message }).toEqual({ r, monto, status: 400, message })
      }
    }
    expect((await post('/configs', fijo(999_999.99))).status).toBe(201)
    expect(await esquemasNuevos()).toBe(3)
  })

  it('🔴 actualizar: pasar un fijo de $5 a niveles sin cambiar el monto, o subir la tasa a más de 100 %, se rechaza (sede y organización)', async () => {
    const deSede = (await post('/configs', fijo(5))).body.id
    const deOrganizacion = (await post('/org-configs', fijo(5))).body.data.id
    const pct = (await post('/org-configs', porcentaje(0.03))).body.data.id

    const aNiveles = await put(`/configs/${deSede}`, { calcType: 'TIERED' })
    expect([aNiveles.status, aNiveles.body.message]).toEqual([400, expect.stringContaining('500 % no es válida')])
    expect((await put(`/org-configs/${deOrganizacion}`, { calcType: 'TIERED' })).status).toBe(400)
    expect((await put(`/org-configs/${pct}`, { defaultRate: 2 })).status).toBe(400)
    expect(
      (await prisma.commissionConfig.findMany({ where: { id: { in: [deSede, deOrganizacion, pct] } }, orderBy: { id: 'asc' } })).map(c => [
        c.id,
        c.calcType,
        Number(c.defaultRate),
      ]),
    ).toEqual(
      [
        [deSede, 'FIXED', 5],
        [deOrganizacion, 'FIXED', 5],
        [pct, 'PERCENTAGE', 0.03],
      ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    )
    // Lo que no toca la tasa sigue pasando.
    expect((await put(`/configs/${deSede}`, { name: 'Fijo cajeros' })).status).toBe(200)
  })

  it('🔴 las demás tasas también: un nivel, una tasa por rol, una tasa propia y la tasa por meta superada de más de 100 % ⇒ 400', async () => {
    // S-NIVELES-ATÓMICO: un esquema por niveles nace con sus niveles; un nivel de más de 100 % es 400 al crear y al agregar.
    const alCrear = await post('/configs', {
      ...porcentaje(0.03),
      calcType: 'TIERED',
      tiers: [{ tierLevel: 1, name: 'Bronce', minThreshold: 0, maxThreshold: null, rate: 1.5 }],
    })
    expect([alCrear.status, alCrear.body.message]).toEqual([400, 'La tasa de un nivel va de 0 % a 100 %: 150 % no es válida.'])
    const niveles = (
      await post('/configs', {
        ...porcentaje(0.03),
        calcType: 'TIERED',
        tiers: [{ tierLevel: 1, name: 'Bronce', minThreshold: 0, maxThreshold: 1000, rate: 0.02 }],
      })
    ).body.id
    const nivel = await post(`/configs/${niveles}/tiers/batch`, {
      tiers: [{ tierLevel: 2, name: 'Plata', minThreshold: 1000, maxThreshold: null, rate: 1.5 }],
    })
    expect([nivel.status, nivel.body.message]).toEqual([400, 'La tasa de un nivel va de 0 % a 100 %: 150 % no es válida.'])

    const porRol = await post('/configs', { ...porcentaje(0.03), roleRates: { WAITER: 3 } })
    expect([porRol.status, porRol.body.message]).toEqual([400, 'La tasa del rol WAITER va de 0 % a 100 %: 300 % no es válida.'])
    const porMeta = await post('/org-configs', { ...porcentaje(0.03), useGoalAsTier: true, goalBonusRate: 6 })
    expect([porMeta.status, porMeta.body.message]).toEqual([400, 'La tasa por meta superada va de 0 % a 100 %: 600 % no es válida.'])

    const propia = await post(`/configs/${m.configId}/overrides`, { staffId: m.ana, customRate: 1.2 })
    expect([propia.status, propia.body.message]).toEqual([400, 'La tasa propia de una persona va de 0 % a 100 %: 120 % no es válida.'])
    expect(await esquemasDeLaSede()).toBe(1)
  })

  it('regresión: lo válido se sigue guardando (porcentaje, niveles con sus tasas, por rol, tasa propia, de organización)', async () => {
    expect((await post('/configs', porcentaje(1))).status).toBe(201) // 100 % es el tope, incluido
    // S-NIVELES-ATÓMICO: los niveles van en la misma creación; `/tiers/batch` sigue agregando más.
    const creado = await post('/configs', {
      ...porcentaje(0.03),
      calcType: 'TIERED',
      roleRates: { WAITER: 0.04 },
      tiers: [
        { tierLevel: 1, name: 'Bronce', minThreshold: 0, maxThreshold: 10000, rate: 0.02 },
        { tierLevel: 2, name: 'Plata', minThreshold: 10000, maxThreshold: 20000, rate: 0.03 },
      ],
    })
    expect(creado.status).toBe(201)
    const batch = await post(`/configs/${creado.body.id}/tiers/batch`, {
      tiers: [{ tierLevel: 3, name: 'Oro', minThreshold: 20000, maxThreshold: null, rate: 0.04 }],
    })
    expect(batch.status).toBe(201)
    expect((await post(`/configs/${m.configId}/overrides`, { staffId: m.ana, customRate: 0.05 })).status).toBe(201)
    expect((await post('/org-configs', { ...porcentaje(0.03), useGoalAsTier: true, goalBonusRate: 0.06 })).status).toBe(201)
  })
})

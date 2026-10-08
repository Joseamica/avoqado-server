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
import { asegurarBaseDePrueba, borrarMundoComisiones, crearMundoComisiones, MundoComisiones } from './_mundoComisiones'

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
const post = (r: string, cuerpo: unknown) => request(server).post(ruta(r)).set('Authorization', `Bearer ${token()}`).send(cuerpo)
const put = (r: string, cuerpo: unknown) => request(server).put(ruta(r)).set('Authorization', `Bearer ${token()}`).send(cuerpo)

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
    // Un fijo de $5 con niveles cabe en la columna: en la organización se guardaba como una tasa de 500 %.
    expect((await post('/org-configs', fijoConNiveles(5))).status).toBe(400)
    expect(await esquemasNuevos()).toBe(0)
  })

  it('🔴 el monto de un esquema FIJO no es una tasa: $5 se guarda (en pesos); más de lo que cabe, 400 con el límite', async () => {
    const cinco = await post('/configs', fijo(5))
    expect(cinco.status).toBe(201)
    expect(Number(cinco.body.defaultRate)).toBe(5)
    const deOrganizacion = await post('/org-configs', fijo(7.5))
    expect(deOrganizacion.status).toBe(201)

    for (const r of ['/configs', '/org-configs']) {
      const diez = await post(r, fijo(10))
      expect({ r, status: diez.status, message: diez.body.message }).toEqual({
        r,
        status: 400,
        message: 'Por ahora el monto fijo por venta puede ser de hasta $9.99.',
      })
    }
    expect((await post('/configs', fijo(-1))).body.message).toBe('El monto fijo por venta no puede ser negativo.')
    expect(await esquemasNuevos()).toBe(2)
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
    const niveles = (await post('/configs', { ...porcentaje(0.03), calcType: 'TIERED' })).body.id
    const nivel = await post(`/configs/${niveles}/tiers/batch`, {
      tiers: [{ tierLevel: 1, name: 'Bronce', minThreshold: 0, maxThreshold: null, rate: 1.5 }],
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
    const niveles = (await post('/configs', { ...porcentaje(0.03), calcType: 'TIERED', roleRates: { WAITER: 0.04 } })).body.id
    const batch = await post(`/configs/${niveles}/tiers/batch`, {
      tiers: [
        { tierLevel: 1, name: 'Bronce', minThreshold: 0, maxThreshold: 10000, rate: 0.02 },
        { tierLevel: 2, name: 'Plata', minThreshold: 10000, maxThreshold: null, rate: 0.03 },
      ],
    })
    expect(batch.status).toBe(201)
    expect((await post(`/configs/${m.configId}/overrides`, { staffId: m.ana, customRate: 0.05 })).status).toBe(201)
    expect((await post('/org-configs', { ...porcentaje(0.03), useGoalAsTier: true, goalBonusRate: 0.06 })).status).toBe(201)
  })
})

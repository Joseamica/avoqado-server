// tests/integration/commission/dobleEnvio.integration.test.ts
/**
 * Fase 3 de Pago al personal, FT-GRAVES D1 (defecto de dinero), contra Postgres REAL y por la RUTA real (app + token).
 *
 * Medido en el /full-testing final (8-oct): un doble clic en «Crear Configuración» mandó 2 POST y dejó dos esquemas activos
 * idénticos. Con filtro de categorías los dos pagan: una venta de María le dio $20 en vez de $10. El reintento de axios del
 * dashboard (`src/api.ts`: un error de red reenvía la MISMA petición al segundo) hace lo mismo sin que nadie haga doble clic.
 *
 * El servidor es el guardia de verdad. Contrato con el dashboard: cada intento de guardar manda `Idempotency-Key`.
 * - Misma clave y mismo cuerpo ⇒ la MISMA respuesta del primer intento, con su id, sin crear otro.
 * - Misma clave con otro cuerpo ⇒ 409 en español, sin crear nada.
 * - Sin clave ⇒ como hoy (los clientes viejos no se rompen).
 * La clave vale para ESA ruta (con su sede y su esquema): la misma clave en otra ruta es otra operación.
 *
 * Correr: TZ=UTC TEST_DATABASE_URL="$PAGO_F3_DB" npx jest --selectProjects=integration \
 *   --runTestsByPath tests/integration/commission/dobleEnvio.integration.test.ts --ci --runInBand
 */
import { randomUUID } from 'crypto'
import type { Server } from 'http'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import app from '@/app'
import prisma from '@/utils/prismaClient'
import { logAction } from '@/services/dashboard/activity-log.service'
import { asegurarBaseDePrueba, borrarMundoComisiones, crearMundoComisiones, MundoComisiones, ventaConComision } from './_mundoComisiones'

// El plan (Comisiones es Premium) va simulado: aquí se prueba el doble envío.
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
  m = await crearMundoComisiones('doble-envio')
})
afterEach(async () => {
  const mundo = m
  m = undefined as unknown as MundoComisiones
  if (mundo) {
    await prisma.idempotencyRequest.deleteMany({ where: { organizationId: mundo.orgId } })
    await prisma.commissionCalculation.deleteMany({ where: { venueId: mundo.venueId } })
    await prisma.commissionConfig.deleteMany({ where: { orgId: mundo.orgId, venueId: null } })
    await prisma.venueModule.deleteMany({ where: { venueId: mundo.venueId } })
  }
  await borrarMundoComisiones(mundo)
})

const token = () =>
  jwt.sign({ sub: m.owner, orgId: m.orgId, venueId: m.venueId, role: 'OWNER' }, process.env.ACCESS_TOKEN_SECRET as string, {
    expiresIn: '15m',
  })
const ruta = (r: string) => `/api/v1/dashboard/commissions/venues/${m.venueId}${r}`
const post = (r: string, cuerpo: object, clave?: string) => {
  const req = request(server).post(ruta(r)).set('Authorization', `Bearer ${token()}`)
  return (clave ? req.set('Idempotency-Key', clave) : req).send(cuerpo)
}
const idDe = (body: any): string => body?.id ?? body?.data?.id
const esquemasDeLaSede = () => prisma.commissionConfig.count({ where: { venueId: m.venueId, deletedAt: null } })
const nuevo = { name: 'Doble clic', defaultRate: 0.05, recipient: 'SERVER', filterByCategories: false, categoryIds: [] }

describe('D1 · crear un esquema dos veces con la misma clave crea UNO', () => {
  it('🔴 misma clave y mismo cuerpo: la segunda respuesta es la MISMA (201, mismo id) y queda un solo esquema', async () => {
    const antes = await esquemasDeLaSede()
    const clave = randomUUID()
    const a = await post('/configs', nuevo, clave)
    const b = await post('/configs', nuevo, clave)
    expect([a.status, b.status]).toEqual([201, 201])
    expect(idDe(b.body)).toBe(idDe(a.body))
    expect(await esquemasDeLaSede()).toBe(antes + 1)
    // El reintento no es otro cambio: una sola auditoría de creación (`logAction`, simulado en la integración).
    const creados = jest.mocked(logAction).mock.calls.filter(([p]) => p.action === 'COMMISSION_CONFIG_CREATED' && p.venueId === m.venueId)
    expect(creados).toHaveLength(1)
  })

  it('🔴 dos envíos a la vez con la misma clave (doble clic que se escapó): un solo esquema', async () => {
    const antes = await esquemasDeLaSede()
    const clave = randomUUID()
    const [a, b] = await Promise.all([post('/configs', nuevo, clave), post('/configs', nuevo, clave)])
    expect(await esquemasDeLaSede()).toBe(antes + 1)
    // El que llega mientras el otro trabaja recibe la respuesta del primero o un 409 «en curso»; nunca crea otro.
    for (const r of [a, b]) expect([201, 409]).toContain(r.status)
    expect([a, b].filter(r => r.status === 201).every(r => idDe(r.body) === idDe(a.status === 201 ? a.body : b.body))).toBe(true)
  })

  it('🔴 misma clave con OTRO cuerpo: 409 en español y no se crea el segundo', async () => {
    const antes = await esquemasDeLaSede()
    const clave = randomUUID()
    expect((await post('/configs', nuevo, clave)).status).toBe(201)
    const r = await post('/configs', { ...nuevo, defaultRate: 0.07 }, clave)
    expect(r.status).toBe(409)
    expect(r.body.message).toBe('La llave de idempotencia se usó previamente con un cuerpo diferente.')
    expect(await esquemasDeLaSede()).toBe(antes + 1)
  })

  it('un intento que falló (400) no deja la clave tomada: el reintento corregido con la misma clave se crea', async () => {
    const clave = randomUUID()
    const malo = await post('/configs', { ...nuevo, defaultRate: 1.5 }, clave)
    expect(malo.status).toBe(400)
    // Otro cuerpo con la misma clave: como el primero no se guardó, NO es un 409.
    expect((await post('/configs', nuevo, clave)).status).toBe(201)
  })

  it('sin clave, como hoy: dos envíos crean dos esquemas (los clientes viejos no cambian)', async () => {
    const antes = await esquemasDeLaSede()
    expect((await post('/configs', nuevo)).status).toBe(201)
    expect((await post('/configs', nuevo)).status).toBe(201)
    expect(await esquemasDeLaSede()).toBe(antes + 2)
  })
})

describe('D1 · los hermanos: todo POST que crea algo en Comisiones', () => {
  /** Manda dos veces lo mismo con la misma clave y devuelve las dos respuestas. */
  async function dosVeces(r: string, cuerpo: object) {
    const clave = randomUUID()
    const a = await post(r, cuerpo, clave)
    const b = await post(r, cuerpo, clave)
    return { a, b }
  }

  it('🔴 copiar un esquema: una sola copia, con la misma respuesta', async () => {
    const { a, b } = await dosVeces(`/configs/${m.configId}/copy`, { name: 'Copia' })
    expect([a.status, b.status]).toEqual([201, 201])
    expect(idDe(b.body)).toBe(idDe(a.body))
    expect(await prisma.commissionConfig.count({ where: { venueId: m.venueId, name: 'Copia' } })).toBe(1)
  })

  it('la clave es de ESA ruta: la misma clave al copiar OTRO esquema hace su propia copia', async () => {
    const otro = await prisma.commissionConfig.create({
      data: { venueId: m.venueId, name: 'Otro', createdById: m.owner, defaultRate: 0.02, categoryIds: [] },
    })
    const clave = randomUUID()
    const a = await post(`/configs/${m.configId}/copy`, {}, clave)
    const b = await post(`/configs/${otro.id}/copy`, {}, clave)
    expect([a.status, b.status]).toEqual([201, 201])
    expect(idDe(b.body)).not.toBe(idDe(a.body))
    expect(b.body.name).toBe('Otro (Copy)')
  })

  it('🔴 excepción por persona: la segunda respuesta es la misma (antes: 400 por traslape en inglés)', async () => {
    const { a, b } = await dosVeces(`/configs/${m.configId}/overrides`, { staffId: m.bea, customRate: 0.2 })
    expect([a.status, b.status]).toEqual([201, 201])
    expect(idDe(b.body)).toBe(idDe(a.body))
    expect(await prisma.commissionOverride.count({ where: { configId: m.configId, staffId: m.bea } })).toBe(1)
  })

  it('🔴 nivel y niveles en lote: un solo nivel', async () => {
    await prisma.commissionConfig.update({ where: { id: m.configId }, data: { calcType: 'TIERED', defaultRate: 0.05 } })
    const nivel = { tierLevel: 1, name: 'Base', minThreshold: 0, maxThreshold: 1000, rate: 0.05 }
    const uno = await dosVeces(`/configs/${m.configId}/tiers`, nivel)
    expect([uno.a.status, uno.b.status]).toEqual([201, 201])
    expect(idDe(uno.b.body)).toBe(idDe(uno.a.body))
    const lote = await dosVeces(`/configs/${m.configId}/tiers/batch`, {
      tiers: [{ tierLevel: 2, name: 'Alto', minThreshold: 1000, maxThreshold: null, rate: 0.08 }],
    })
    expect([lote.a.status, lote.b.status]).toEqual([201, 201])
    expect(await prisma.commissionTier.count({ where: { configId: m.configId } })).toBe(2)
  })

  it('🔴 bono por meta alcanzada (hito): uno solo', async () => {
    const hito = {
      name: 'Meta',
      targetType: 'SALES_AMOUNT',
      targetValue: 1000,
      bonusType: 'FIXED_AMOUNT',
      bonusValue: 100,
      period: 'MONTHLY',
    }
    const { a, b } = await dosVeces(`/configs/${m.configId}/milestones`, hito)
    expect([a.status, b.status]).toEqual([201, 201])
    expect(await prisma.commissionMilestone.count({ where: { configId: m.configId } })).toBe(1)
  })

  it('🔴 meta de ventas: la segunda respuesta es la misma (antes: 400 «already exists» en inglés)', async () => {
    const { a, b } = await dosVeces('/goals', { staffId: m.ana, goal: 10000, period: 'MONTHLY' })
    expect([a.status, b.status]).toEqual([201, 201])
    expect(idDe(b.body)).toBe(idDe(a.body))
  })

  it('🔴 esquema de la organización: uno solo', async () => {
    const { a, b } = await dosVeces('/org-configs', { name: 'De la organización', defaultRate: 0.04 })
    expect([a.status, b.status]).toEqual([201, 201])
    expect(await prisma.commissionConfig.count({ where: { orgId: m.orgId, venueId: null } })).toBe(1)
  })

  it('🔴 comisión manual (dinero): una sola fila', async () => {
    const { a, b } = await dosVeces('/calculations/manual', { staffId: m.ana, amount: 50, reason: 'Bono de apertura' })
    expect([a.status, b.status]).toEqual([201, 201])
    expect(await prisma.commissionCalculation.count({ where: { venueId: m.venueId, calcType: 'MANUAL' } })).toBe(1)
  })

  it('🔴 clawback (anula la comisión): el reintento devuelve la misma respuesta en vez de fallar', async () => {
    const { comision } = await ventaConComision(m)
    const { a, b } = await dosVeces(`/calculations/${comision.id}/clawback`, { reason: 'REFUND' })
    expect([a.status, b.status]).toEqual([201, 201])
    expect(b.body).toEqual(a.body)
  })
})

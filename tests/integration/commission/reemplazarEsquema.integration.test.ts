// tests/integration/commission/reemplazarEsquema.integration.test.ts
/**
 * Fase 3 de Pago al personal, FT-GRAVES S-REPLACE, contra Postgres REAL y por la RUTA real (app + token).
 *
 * «Duplicar con cambios» REEMPLAZA al original (decisión del founder, 8-oct): nunca pagan los dos a la vez. El dashboard lo
 * hacía con dos llamadas (copiar y luego desactivar): entre las dos pagaban los dos, y si fallaban los niveles o las
 * excepciones el nuevo se quedaba activo junto al original. Ahora es UNA operación:
 * `POST /venues/:venueId/configs/:configId/copy` con `{ replace: true, …cambios }`, en una sola transacción.
 *
 * Correr: TZ=UTC TEST_DATABASE_URL="<base de prueba>" npx jest --selectProjects=integration \
 *   --runTestsByPath tests/integration/commission/reemplazarEsquema.integration.test.ts --ci --runInBand
 */
import { randomUUID } from 'crypto'
import type { Server } from 'http'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { Prisma } from '@prisma/client'
import app from '@/app'
import prisma from '@/utils/prismaClient'
import { writeLegacyActivityAuditTx } from '@/services/activityAudit.service'
import { asegurarBaseDePrueba, borrarMundoComisiones, crearMundoComisiones, MundoComisiones } from './_mundoComisiones'

// El plan (Comisiones es Premium) va simulado: aquí se prueba el reemplazo.
jest.mock('@/services/access/basePlan.service', () => ({
  ...jest.requireActual('@/services/access/basePlan.service'),
  venueHasCommissionsAccess: jest.fn(async () => true),
}))
// La auditoría real, con una forma de hacer fallar la ÚLTIMA escritura de la transacción (la prueba de «a la mitad»).
jest.mock('@/services/activityAudit.service', () => {
  const real = jest.requireActual('@/services/activityAudit.service')
  return { ...real, writeLegacyActivityAuditTx: jest.fn(real.writeLegacyActivityAuditTx) }
})
const auditoriaReal = jest.requireActual('@/services/activityAudit.service').writeLegacyActivityAuditTx

let m: MundoComisiones
let otro: MundoComisiones | undefined
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
  jest.mocked(writeLegacyActivityAuditTx).mockImplementation(auditoriaReal)
  m = await crearMundoComisiones('reemplazar-esquema')
  // El original: por niveles (dos), sólo para Ana y Bea, con una excepción para Bea (tasa propia de 20 %).
  await prisma.commissionConfig.update({
    where: { id: m.configId },
    data: { calcType: 'TIERED', defaultRate: new Prisma.Decimal(0.05), filterByStaff: true, staffIds: [m.ana, m.bea] },
  })
  await prisma.commissionTier.createMany({
    data: [
      {
        configId: m.configId,
        tierLevel: 1,
        tierName: 'Base',
        tierType: 'BY_AMOUNT',
        tierPeriod: 'MONTHLY',
        minThreshold: 0,
        maxThreshold: 1000,
        rate: 0.05,
      },
      {
        configId: m.configId,
        tierLevel: 2,
        tierName: 'Alto',
        tierType: 'BY_AMOUNT',
        tierPeriod: 'MONTHLY',
        minThreshold: 1000,
        rate: 0.08,
      },
    ],
  })
  await prisma.commissionOverride.create({
    data: { configId: m.configId, venueId: m.venueId, staffId: m.bea, customRate: 0.2, createdById: m.owner },
  })
})
afterEach(async () => {
  for (const mundo of [m, otro]) {
    if (!mundo) continue
    await prisma.idempotencyRequest.deleteMany({ where: { organizationId: mundo.orgId } })
    await prisma.commissionOverride.deleteMany({ where: { venueId: mundo.venueId } })
    await borrarMundoComisiones(mundo)
  }
  m = undefined as unknown as MundoComisiones
  otro = undefined
})

const token = (mundo = m) =>
  jwt.sign({ sub: mundo.owner, orgId: mundo.orgId, venueId: mundo.venueId, role: 'OWNER' }, process.env.ACCESS_TOKEN_SECRET as string, {
    expiresIn: '15m',
  })
const reemplazar = (cuerpo: object, o: { configId?: string; clave?: string } = {}) =>
  request(server)
    .post(`/api/v1/dashboard/commissions/venues/${m.venueId}/configs/${o.configId ?? m.configId}/copy`)
    .set('Authorization', `Bearer ${token()}`)
    .set('Idempotency-Key', o.clave ?? randomUUID())
    .send({ replace: true, ...cuerpo })
const esquemas = () =>
  prisma.commissionConfig.findMany({
    where: { venueId: m.venueId, deletedAt: null },
    include: { tiers: { orderBy: { tierLevel: 'asc' } }, overrides: true },
    orderBy: { createdAt: 'asc' },
    take: 10,
  })

describe('S-REPLACE · «Duplicar con cambios» reemplaza al original en una sola operación', () => {
  it('🔴 éxito: un esquema nuevo ACTIVO con los cambios, sus niveles, su excepción y «a quién aplica»; el original inactivo', async () => {
    const r = await reemplazar({ name: 'Niveles nuevos', defaultRate: 0.06 })
    expect(r.status).toBe(201)
    expect(r.body).toMatchObject({ name: 'Niveles nuevos', active: true, reemplazado: { id: m.configId, active: false } })

    const [original, nuevo, ...mas] = await esquemas()
    expect(mas).toEqual([])
    expect(original).toMatchObject({ id: m.configId, active: false })
    expect(nuevo).toMatchObject({ id: r.body.id, active: true, calcType: 'TIERED', filterByStaff: true, staffIds: [m.ana, m.bea] })
    expect(nuevo.defaultRate.toFixed(4)).toBe('0.0600')
    expect(nuevo.tiers.map(t => [t.tierLevel, t.tierName, t.rate.toFixed(4)])).toEqual([
      [1, 'Base', '0.0500'],
      [2, 'Alto', '0.0800'],
    ])
    expect(nuevo.overrides.map(o => [o.staffId, o.customRate.toFixed(4)])).toEqual([[m.bea, '0.2000']])

    const audit = await prisma.activityLog.findMany({ where: { venueId: m.venueId }, orderBy: { createdAt: 'asc' }, take: 10 })
    expect(audit.map(a => [a.action, a.entityId, a.staffId])).toEqual([
      ['COMMISSION_CONFIG_CREATED', r.body.id, m.owner],
      ['COMMISSION_CONFIG_UPDATED', m.configId, m.owner],
    ])
    expect(audit[0].data).toMatchObject({ reemplazaA: m.configId, niveles: 2, excepciones: 1 })
    expect(audit[1].data).toMatchObject({ active: false, reemplazadoPor: r.body.id })
  })

  it('🔴 si la última escritura falla, no queda NADA a medias: el original sigue activo y el nuevo no existe', async () => {
    jest.mocked(writeLegacyActivityAuditTx).mockImplementation(async (tx, input) => {
      if (input.action === 'COMMISSION_CONFIG_UPDATED') throw new Error('falla simulada a la mitad del reemplazo')
      return auditoriaReal(tx, input)
    })
    const r = await reemplazar({ name: 'No debe existir', defaultRate: 0.06 })
    expect(r.status).toBe(500)

    const todos = await esquemas()
    expect(todos.map(e => [e.id, e.active])).toEqual([[m.configId, true]])
    expect(await prisma.commissionTier.count({ where: { config: { venueId: m.venueId } } })).toBe(2)
    expect(await prisma.commissionOverride.count({ where: { venueId: m.venueId } })).toBe(1)
    expect(await prisma.activityLog.count({ where: { venueId: m.venueId, entity: 'CommissionConfig' } })).toBe(0)
  })

  it('🔴 la misma Idempotency-Key dos veces: un solo esquema nuevo y la misma respuesta', async () => {
    const clave = randomUUID()
    const a = await reemplazar({ defaultRate: 0.07 }, { clave })
    const b = await reemplazar({ defaultRate: 0.07 }, { clave })
    expect([a.status, b.status]).toEqual([201, 201])
    expect(b.body.id).toBe(a.body.id)
    expect((await esquemas()).map(e => e.active)).toEqual([false, true])
  })

  it('🔴 dos reemplazos a la vez con claves distintas (doble clic que se escapó): uno gana y el otro recibe 409', async () => {
    const [a, b] = await Promise.all([reemplazar({ defaultRate: 0.07 }), reemplazar({ defaultRate: 0.07 })])
    expect([a.status, b.status].sort()).toEqual([201, 409])
    expect([a, b].find(r => r.status === 409)?.body.code).toBe('ESQUEMA_YA_INACTIVO')
    expect((await esquemas()).map(e => e.active)).toEqual([false, true])
  })

  it('🔴 el id de un esquema de OTRO negocio: 404 y el de ese negocio sigue intacto', async () => {
    otro = await crearMundoComisiones('reemplazar-ajeno')
    const r = await reemplazar({ defaultRate: 0.07 }, { configId: otro.configId })
    expect(r.status).toBe(404)
    expect(r.body.message).toBe('No encontré ese esquema de comisión en este negocio.')
    expect((await prisma.commissionConfig.findUniqueOrThrow({ where: { id: otro.configId } })).active).toBe(true)
    expect(await prisma.commissionConfig.count({ where: { venueId: otro.venueId } })).toBe(1)
    expect((await esquemas()).map(e => e.active)).toEqual([true])
  })

  it('🔴 una fecha de inicio FUTURA se rechaza en español: dejaría un hueco en el que no paga ninguno', async () => {
    const r = await reemplazar({ effectiveFrom: new Date(Date.now() + 2 * 86_400_000).toISOString() })
    expect(r.status).toBe(400)
    expect(r.body.message).toMatch(/no puede ser futura/)
    expect((await esquemas()).map(e => e.active)).toEqual([true])
  })

  it('🔴 lo que queda pasa las reglas de siempre: una tasa de 150 % es un 400 y no cambia nada', async () => {
    const r = await reemplazar({ defaultRate: 1.5 })
    expect(r.status).toBe(400)
    expect(r.body.message).toMatch(/150 % no es válida/)
    expect((await esquemas()).map(e => e.active)).toEqual([true])
  })

  it('🔴 la lista de esquemas dice quién reemplazó a quién (`reemplazadoPor`)', async () => {
    const r = await reemplazar({ name: 'Niveles nuevos', defaultRate: 0.06 })
    const lista = await request(server)
      .get(`/api/v1/dashboard/commissions/venues/${m.venueId}/configs?includeInactive=true`)
      .set('Authorization', `Bearer ${token()}`)
    const porId = Object.fromEntries(lista.body.data.map((c: { id: string; reemplazadoPor: unknown }) => [c.id, c.reemplazadoPor]))
    expect(porId[m.configId]).toEqual({ id: r.body.id, name: 'Niveles nuevos' })
    expect(porId[r.body.id]).toBeNull()
  })

  // ── Regresión: copiar SIN reemplazar sigue como antes (el original se queda activo) ──
  it('copiar sin `replace` deja el original activo y la copia con «(Copy)», como hoy', async () => {
    const r = await request(server)
      .post(`/api/v1/dashboard/commissions/venues/${m.venueId}/configs/${m.configId}/copy`)
      .set('Authorization', `Bearer ${token()}`)
      .send({})
    expect(r.status).toBe(201)
    expect(r.body.name).toBe('Comisión 10 % (Copy)')
    expect((await esquemas()).map(e => e.active)).toEqual([true, true])
  })
})

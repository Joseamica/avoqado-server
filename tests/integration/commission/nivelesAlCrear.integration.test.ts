// tests/integration/commission/nivelesAlCrear.integration.test.ts
/**
 * Fase 3 de Pago al personal, FT-GRAVES S-NIVELES-ATÓMICO, contra Postgres REAL y por la RUTA real (app + token).
 *
 * Medido en la QA (D2): crear un esquema por niveles era una cadena, primero `POST /configs` y luego `/tiers/batch`. Si fallaba
 * lo segundo, quedaba un esquema ACTIVO con tasa plana (3 %) que sí pagaba. Ahora `POST /configs` (de la sede y de la
 * organización) acepta `tiers`, con el MISMO formato del cuerpo de `/tiers/batch`:
 * - con `calcType: 'TIERED'`, `tiers` es obligatorio (al menos uno) y se crea en la MISMA transacción;
 * - si algo es inválido, 400 en español y no se crea NADA;
 * - sin `tiers` y sin niveles, todo sigue igual.
 *
 * Correr: TZ=UTC TEST_DATABASE_URL="<base de prueba>" npx jest --selectProjects=integration \
 *   --runTestsByPath tests/integration/commission/nivelesAlCrear.integration.test.ts --ci --runInBand
 */
import { randomUUID } from 'crypto'
import type { Server } from 'http'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import app from '@/app'
import prisma from '@/utils/prismaClient'
import { asegurarBaseDePrueba, borrarMundoComisiones, crearMundoComisiones, MundoComisiones } from './_mundoComisiones'

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
  m = await crearMundoComisiones('niveles-al-crear')
})
afterEach(async () => {
  const mundo = m
  m = undefined as unknown as MundoComisiones
  if (mundo) {
    await prisma.idempotencyRequest.deleteMany({ where: { organizationId: mundo.orgId } })
    await prisma.commissionConfig.deleteMany({ where: { orgId: mundo.orgId, venueId: null } })
  }
  await borrarMundoComisiones(mundo)
})

const token = () =>
  jwt.sign({ sub: m.owner, orgId: m.orgId, venueId: m.venueId, role: 'OWNER' }, process.env.ACCESS_TOKEN_SECRET as string, {
    expiresIn: '15m',
  })
const post = (r: string, cuerpo: object, clave?: string) => {
  const req = request(server).post(`/api/v1/dashboard/commissions/venues/${m.venueId}${r}`).set('Authorization', `Bearer ${token()}`)
  return (clave ? req.set('Idempotency-Key', clave) : req).send(cuerpo)
}
/** Dos niveles válidos, en el formato del cuerpo de `/tiers/batch`. */
const dosNiveles = () => [
  { tierLevel: 1, name: 'Base', minThreshold: 0, maxThreshold: 1000, rate: 0.03 },
  { tierLevel: 2, name: 'Alto', minThreshold: 1000, maxThreshold: null, rate: 0.05 },
]
const porNiveles = (extra: object = {}) => ({ name: 'Por niveles', calcType: 'TIERED', defaultRate: 0.03, tiers: dosNiveles(), ...extra })
const esquemas = () => prisma.commissionConfig.count({ where: { venueId: m.venueId } })
const niveles = () => prisma.commissionTier.count({ where: { config: { venueId: m.venueId } } })

describe('S-NIVELES-ATÓMICO · un esquema por niveles nace con sus niveles, o no nace', () => {
  it('🔴 TIERED con niveles: nace con los dos niveles en la misma respuesta', async () => {
    const r = await post('/configs', porNiveles())
    expect(r.status).toBe(201)
    expect(r.body.calcType).toBe('TIERED')
    expect(r.body.tiers.map((t: { tierLevel: number; rate: string }) => [t.tierLevel, Number(t.rate)])).toEqual([
      [1, 0.03],
      [2, 0.05],
    ])
    expect(await prisma.commissionTier.count({ where: { configId: r.body.id } })).toBe(2)
  })

  it('🔴 TIERED SIN niveles: 400 en español y no nace el esquema', async () => {
    const antes = await esquemas()
    const r = await post('/configs', porNiveles({ tiers: undefined }))
    expect([r.status, r.body.message]).toEqual([400, 'Un esquema por niveles necesita al menos un nivel.'])
    expect(await esquemas()).toBe(antes)
  })

  it('🔴 un nivel inválido (tasa de 150 %, rangos encimados o sin nombre): 400 en español y no nace NADA', async () => {
    const antes = await esquemas()
    const tasa = await post('/configs', porNiveles({ tiers: [{ ...dosNiveles()[0], rate: 1.5 }] }))
    expect([tasa.status, tasa.body.message]).toEqual([400, 'La tasa de un nivel va de 0 % a 100 %: 150 % no es válida.'])
    const encimados = await post('/configs', porNiveles({ tiers: [dosNiveles()[0], { ...dosNiveles()[1], minThreshold: 500 }] }))
    expect(encimados.status).toBe(400)
    expect(encimados.body.message).toMatch(/se sobrepone/)
    const sinNombre = await post('/configs', porNiveles({ tiers: [{ ...dosNiveles()[0], name: undefined }] }))
    expect([sinNombre.status, sinNombre.body.message]).toEqual([400, 'Cada nivel necesita un nombre.'])
    expect([await esquemas(), await niveles()]).toEqual([antes, 0])
  })

  it('🔴 niveles en un esquema que NO es por niveles (el panel de la QA): 400 en español, no nace un esquema plano', async () => {
    const antes = await esquemas()
    const r = await post('/configs', porNiveles({ calcType: 'PERCENTAGE' }))
    expect([r.status, r.body.message]).toEqual([400, 'Los niveles sólo aplican a un esquema por niveles: manda calcType «TIERED».'])
    expect(await esquemas()).toBe(antes)
  })

  it('🔴 si la base rechaza un nivel al guardarlo (umbral fuera de rango), tampoco queda el esquema', async () => {
    const antes = await esquemas()
    const r = await post('/configs', porNiveles({ tiers: [{ ...dosNiveles()[0], minThreshold: 1e13, maxThreshold: null }] }))
    expect(r.status).not.toBe(201)
    expect([await esquemas(), await niveles()]).toEqual([antes, 0])
  })

  it('🔴 la misma Idempotency-Key dos veces: un solo esquema con sus dos niveles', async () => {
    const clave = randomUUID()
    const a = await post('/configs', porNiveles(), clave)
    const b = await post('/configs', porNiveles(), clave)
    expect([a.status, b.status]).toEqual([201, 201])
    expect(b.body.id).toBe(a.body.id)
    expect(await prisma.commissionTier.count({ where: { configId: a.body.id } })).toBe(2)
  })

  it('🔴 esquema de la ORGANIZACIÓN: con niveles nace con ellos; sin niveles, 400 y nada', async () => {
    const ok = await post('/org-configs', porNiveles())
    expect(ok.status).toBe(201)
    expect(await prisma.commissionTier.count({ where: { configId: ok.body.data.id } })).toBe(2)
    const sin = await post('/org-configs', porNiveles({ name: 'Sin niveles', tiers: undefined }))
    expect(sin.status).toBe(400)
    expect(await prisma.commissionConfig.count({ where: { orgId: m.orgId, venueId: null } })).toBe(1)
  })

  it('🔴 TIERED con «meta como nivel» no exige `tiers` (el nivel es la meta de cada quien)', async () => {
    const r = await post('/configs', porNiveles({ tiers: undefined, useGoalAsTier: true, goalBonusRate: 0.06 }))
    expect([r.status, r.body.calcType, r.body.useGoalAsTier]).toEqual([201, 'TIERED', true])
    const org = await post('/org-configs', porNiveles({ tiers: undefined, useGoalAsTier: true, goalBonusRate: 0.06 }))
    expect(org.status).toBe(201)
  })

  // ── Hermanos: pasar a TIERED editando o con «Duplicar con cambios» también exige niveles en la misma operación ──
  const put = (r: string, cuerpo: object) =>
    request(server).put(`/api/v1/dashboard/commissions/venues/${m.venueId}${r}`).set('Authorization', `Bearer ${token()}`).send(cuerpo)
  const tipo = async (id: string) => (await prisma.commissionConfig.findUniqueOrThrow({ where: { id } })).calcType

  it('🔴 editar un esquema plano a TIERED sin niveles: 400 y no cambia; con niveles, cambia con ellos; con «meta como nivel», sin ellos', async () => {
    const sin = await put(`/configs/${m.configId}`, { calcType: 'TIERED' })
    expect([sin.status, sin.body.message]).toEqual([400, 'Un esquema por niveles necesita al menos un nivel.'])
    expect(await tipo(m.configId)).toBe('PERCENTAGE')
    const con = await put(`/configs/${m.configId}`, { calcType: 'TIERED', tiers: dosNiveles() })
    expect(con.status).toBe(200)
    expect([await tipo(m.configId), await prisma.commissionTier.count({ where: { configId: m.configId } })]).toEqual(['TIERED', 2])
    const otro = (await post('/configs', { name: 'Plano', defaultRate: 0.05 })).body.id
    expect((await put(`/configs/${otro}`, { calcType: 'TIERED', useGoalAsTier: true, goalBonusRate: 0.06 })).status).toBe(200)
  })

  it('🔴 editar un esquema plano de la organización a TIERED sin niveles: 400 y no cambia', async () => {
    const org = (await post('/org-configs', { name: 'Org plano', defaultRate: 0.05 })).body.data.id
    const r = await request(server)
      .put(`/api/v1/dashboard/commissions/venues/${m.venueId}/org-configs/${org}`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ calcType: 'TIERED' })
    expect(r.status).toBe(400)
    expect(await tipo(org)).toBe('PERCENTAGE')
  })

  it('🔴 «Duplicar con cambios» de un plano a TIERED: sin niveles 400 y el original sigue; con niveles, el nuevo nace con ellos', async () => {
    const sin = await post(`/configs/${m.configId}/copy`, { replace: true, calcType: 'TIERED' })
    expect([sin.status, sin.body.message]).toEqual([400, 'Un esquema por niveles necesita al menos un nivel.'])
    expect((await prisma.commissionConfig.findUniqueOrThrow({ where: { id: m.configId } })).active).toBe(true)
    const con = await post(`/configs/${m.configId}/copy`, { replace: true, calcType: 'TIERED', tiers: dosNiveles() })
    expect(con.status).toBe(201)
    expect(await prisma.commissionTier.count({ where: { configId: con.body.id } })).toBe(2)
  })

  // ── Regresión: sin niveles, como siempre ──
  it('un porcentaje sin `tiers` se crea como siempre', async () => {
    const r = await post('/configs', { name: 'Plano', defaultRate: 0.05 })
    expect([r.status, r.body.calcType]).toEqual([201, 'PERCENTAGE'])
    expect(await prisma.commissionTier.count({ where: { configId: r.body.id } })).toBe(0)
  })
})

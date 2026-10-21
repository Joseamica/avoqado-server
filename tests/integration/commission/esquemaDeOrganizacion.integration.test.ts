// tests/integration/commission/esquemaDeOrganizacion.integration.test.ts
/**
 * Fase 3 de Pago al personal, FT-GRAVES T1 (seguridad), contra Postgres REAL y por la RUTA real (app + token).
 *
 * `createOrgCommissionConfig` y `updateOrgCommissionConfig` (`commission-resolution.service.ts`) guardaban el cuerpo TAL CUAL
 * (`{ ...data }`): asignación masiva. Quien tiene `commissions:org-manage` podía cambiar `orgId`, `venueId`, `deletedAt` o el
 * `id`, y con escrituras anidadas de Prisma crear filas en OTRO negocio (una excepción por persona en una sede ajena). Además, el
 * de la organización no tenía el candado de la sede: con comisiones calculadas se podía cambiar la tasa.
 *
 * Lo correcto: la MISMA lista blanca de campos que acepta la sede, y el mismo candado («con comisiones calculadas no cambia la
 * tasa, el tipo, a quién ni cuándo»).
 *
 * Correr: TZ=UTC TEST_DATABASE_URL="<base de prueba>" npx jest --selectProjects=integration \
 *   --runTestsByPath tests/integration/commission/esquemaDeOrganizacion.integration.test.ts --ci --runInBand
 */
import type { Server } from 'http'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { Prisma } from '@prisma/client'
import app from '@/app'
import prisma from '@/utils/prismaClient'
import { asegurarBaseDePrueba, borrarMundoComisiones, crearMundoComisiones, MundoComisiones, ventaConComision } from './_mundoComisiones'

jest.mock('@/services/access/basePlan.service', () => ({
  ...jest.requireActual('@/services/access/basePlan.service'),
  venueHasCommissionsAccess: jest.fn(async () => true),
}))

let m: MundoComisiones
let ajeno: MundoComisiones
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
  m = await crearMundoComisiones('esquema-org')
  ajeno = await crearMundoComisiones('esquema-org-ajeno')
})
afterEach(async () => {
  for (const mundo of [m, ajeno]) {
    if (!mundo) continue
    await prisma.commissionCalculation.deleteMany({ where: { venueId: mundo.venueId } })
    await prisma.commissionOverride.deleteMany({ where: { venueId: mundo.venueId } })
  }
  // Los esquemas de la organización (y cualquiera que una inyección hubiera movido) se borran por las dos organizaciones.
  await prisma.commissionConfig.deleteMany({ where: { orgId: { in: [m.orgId, ajeno.orgId] }, venueId: null } })
  await prisma.commissionConfig.deleteMany({ where: { id: 'cfg-inyectado-por-el-cuerpo' } })
  for (const mundo of [m, ajeno]) await borrarMundoComisiones(mundo)
})

const token = () =>
  jwt.sign({ sub: m.owner, orgId: m.orgId, venueId: m.venueId, role: 'OWNER' }, process.env.ACCESS_TOKEN_SECRET as string, {
    expiresIn: '15m',
  })
const ruta = (r: string) => `/api/v1/dashboard/commissions/venues/${m.venueId}${r}`
const post = (r: string, cuerpo: object) => request(server).post(ruta(r)).set('Authorization', `Bearer ${token()}`).send(cuerpo)
const put = (r: string, cuerpo: object) => request(server).put(ruta(r)).set('Authorization', `Bearer ${token()}`).send(cuerpo)

/** Un esquema de la organización de `m` (10 %, a quien cobró), creado directo en la base. */
const esquemaDeOrg = (extra: Partial<Prisma.CommissionConfigUncheckedCreateInput> = {}) =>
  prisma.commissionConfig.create({
    data: {
      orgId: m.orgId,
      venueId: null,
      name: 'De la organización',
      createdById: m.owner,
      recipient: 'PROCESSOR',
      defaultRate: new Prisma.Decimal(0.1),
      includeTax: true,
      categoryIds: [],
      effectiveFrom: new Date('2020-01-01T00:00:00Z'),
      ...extra,
    },
  })

describe('T1 · el cuerpo no puede mover ni inyectar nada en un esquema de la organización', () => {
  it('🔴 PUT hostil (otra organización, otra sede, borrado, autor): sólo cambia el nombre y el esquema sigue en su organización', async () => {
    const cfg = await esquemaDeOrg()
    const r = await put(`/org-configs/${cfg.id}`, {
      name: 'Nombre nuevo',
      orgId: ajeno.orgId,
      venueId: ajeno.venueId,
      deletedAt: '2020-01-01T00:00:00.000Z',
      deletedBy: ajeno.owner,
      createdById: ajeno.owner,
    })
    expect(r.status).toBe(200)
    const despues = await prisma.commissionConfig.findUniqueOrThrow({ where: { id: cfg.id } })
    expect(despues).toMatchObject({
      name: 'Nombre nuevo',
      orgId: m.orgId,
      venueId: null,
      deletedAt: null,
      deletedBy: null,
      createdById: m.owner,
    })
    // Y quedó auditado con quién lo hizo.
    const audit = await prisma.activityLog.findFirst({ where: { entityId: cfg.id, action: 'ORG_COMMISSION_CONFIG_UPDATED' } })
    expect(audit).toMatchObject({ staffId: m.owner, venueId: m.venueId })
  })

  it('🔴 PUT hostil con una escritura ANIDADA: no crea una excepción en la sede de otro negocio', async () => {
    const cfg = await esquemaDeOrg()
    await put(`/org-configs/${cfg.id}`, {
      name: 'Con anidado',
      overrides: { create: [{ venueId: ajeno.venueId, staffId: ajeno.ana, customRate: 0.5, createdById: ajeno.owner }] },
    })
    expect(await prisma.commissionOverride.count({ where: { venueId: ajeno.venueId } })).toBe(0)
  })

  it('🔴 POST hostil: no elige el id, no nace borrado y no inyecta filas en otro negocio', async () => {
    const r = await post('/org-configs', {
      name: 'Nuevo de la organización',
      defaultRate: 0.05,
      id: 'cfg-inyectado-por-el-cuerpo',
      deletedAt: '2020-01-01T00:00:00.000Z',
      overrides: { create: [{ venueId: ajeno.venueId, staffId: ajeno.ana, customRate: 0.5, createdById: ajeno.owner }] },
    })
    expect(r.status).toBe(201)
    const creado = await prisma.commissionConfig.findUniqueOrThrow({ where: { id: r.body.data.id } })
    expect(creado.id).not.toBe('cfg-inyectado-por-el-cuerpo')
    expect(creado).toMatchObject({ orgId: m.orgId, venueId: null, deletedAt: null, createdById: m.owner })
    expect(await prisma.commissionOverride.count({ where: { venueId: ajeno.venueId } })).toBe(0)
  })

  it('🔴 con comisiones calculadas, cambiar la tasa de un esquema de la organización da el 400 de la sede; lo igual pasa', async () => {
    // La sede no tiene esquema propio activo: aplica el de la organización.
    await prisma.commissionConfig.update({ where: { id: m.configId }, data: { active: false } })
    const cfg = await esquemaDeOrg()
    const { comision } = await ventaConComision(m)
    expect(comision.configId).toBe(cfg.id)

    const igual = await put(`/org-configs/${cfg.id}`, { name: 'Renombrado', defaultRate: 0.1, recipient: 'PROCESSOR' })
    expect(igual.status).toBe(200)
    const r = await put(`/org-configs/${cfg.id}`, { defaultRate: 0.2 })
    expect(r.status).toBe(400)
    expect(r.body).toMatchObject({ code: 'ESQUEMA_CON_COMISIONES', details: { campo: 'defaultRate', comisiones: 1 } })
    expect((await prisma.commissionConfig.findUniqueOrThrow({ where: { id: cfg.id } })).defaultRate.toFixed(4)).toBe('0.1000')
  })

  // ── Regresión: los cambios legítimos siguen funcionando ──
  it('sin comisiones calculadas se cambian tasa, «con IVA» y desactivar', async () => {
    const cfg = await esquemaDeOrg()
    const r = await put(`/org-configs/${cfg.id}`, { defaultRate: 0.07, includeTax: false, active: false, roleRates: null })
    expect(r.status).toBe(200)
    const e = await prisma.commissionConfig.findUniqueOrThrow({ where: { id: cfg.id } })
    expect([e.defaultRate.toFixed(4), e.includeTax, e.active]).toEqual(['0.0700', false, false])
  })

  it('un esquema de OTRA organización no se edita desde esta sede (404)', async () => {
    const otro = await prisma.commissionConfig.create({
      data: { orgId: ajeno.orgId, venueId: null, name: 'Ajeno', createdById: ajeno.owner, defaultRate: 0.1, categoryIds: [] },
    })
    const r = await put(`/org-configs/${otro.id}`, { name: 'Robado' })
    expect(r.status).toBe(404)
    expect((await prisma.commissionConfig.findUniqueOrThrow({ where: { id: otro.id } })).name).toBe('Ajeno')
  })
})

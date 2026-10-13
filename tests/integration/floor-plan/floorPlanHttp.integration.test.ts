/**
 * Plano de mesas — tamaño libre por la RUTA real (app + token) contra Postgres real (spec 2026-10-12 §9: PUT → GET).
 *   TEST_DATABASE_URL='postgresql://…/avoqado_planotamano_test_20261012' \
 *     npx jest --selectProjects=integration --runInBand --runTestsByPath tests/integration/floor-plan/floorPlanHttp.integration.test.ts
 * Sin limpieza a propósito (como mobileFloorPlan): venue único por prueba, base desechable. NUNCA av-db-25.
 */
import { randomUUID } from 'crypto'
import type { Server } from 'http'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import app from '@/app'
import prisma from '@/utils/prismaClient'

// El candado del plan (Servicio de mesas, Pro) ya lo prueba floor-plan-auth.api.test.ts: aquí se deja pasar.
jest.mock('@/middlewares/checkFeatureAccess.middleware', () => ({
  ...jest.requireActual('@/middlewares/checkFeatureAccess.middleware'),
  checkFeatureAccess: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}))

const target = new URL(process.env.TEST_DATABASE_URL ?? '')
if (!['localhost', '127.0.0.1'].includes(target.hostname) || !/^\/avoqado_[a-z0-9]+_test_/.test(target.pathname)) {
  throw new Error('Exige una base de prueba local y desechable (p. ej. avoqado_planotamano_test_20261012).')
}

let server: Server
let venueId = ''
let orgId = ''
let ownerId = ''

beforeAll(async () => {
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>(listo => server.once('listening', () => listo()))
})
afterAll(async () => {
  await new Promise<void>(listo => server.close(() => listo()))
  await prisma.$disconnect()
})
beforeEach(async () => {
  const key = `plano-http-${randomUUID()}`
  orgId = (await prisma.organization.create({ data: { name: key, email: `${key}@example.test`, phone: '5500000000' } })).id
  venueId = (await prisma.venue.create({ data: { organizationId: orgId, name: key, slug: key } })).id
  ownerId = (await prisma.staff.create({ data: { email: `${key}@staff.test`, firstName: 'Plano', lastName: 'Dueña', active: true } })).id
  await prisma.staffVenue.create({ data: { staffId: ownerId, venueId, role: 'OWNER', active: true } })
})

const auth = () =>
  `Bearer ${jwt.sign({ sub: ownerId, orgId, venueId, role: 'OWNER' }, process.env.ACCESS_TOKEN_SECRET as string, { expiresIn: '15m' })}`
const ruta = () => `/api/v1/dashboard/venues/${venueId}/floor-plan`
const leer = async () => {
  const r = await request(server).get(ruta()).set('Authorization', auth())
  expect(r.status).toBe(200)
  return r.body.data
}
const guardar = (baseFingerprint: string, areas: object[], tables: object[]) =>
  request(server).put(ruta()).set('Authorization', auth()).send({ saveId: randomUUID(), baseFingerprint, areas, tables, elements: [] })
const salonNuevo = { clientId: 'a1', name: 'Salón', floorShape: 'WIDE', sortOrder: 0 }
const mesa = (extra: Record<string, unknown>) => ({ number: '1', capacity: 4, shape: 'RECTANGLE', rotation: 0, positionX: 0.5, positionY: 0.5, ...extra })

describe('PUT → GET del plano por la ruta real: tamaño libre (spec 2026-10-12)', () => {
  it('guardar el tamaño y leerlo; sin los campos se conserva; null vuelve a automático', async () => {
    const vacio = await leer()
    expect((await guardar(vacio.fingerprint, [salonNuevo], [mesa({ clientId: 't1', areaRef: 'a1', width: 0.075, height: 0.16 })])).status).toBe(200)
    let plano = await leer()
    const salon = { id: plano.areas[0].id, name: 'Salón', floorShape: 'WIDE', sortOrder: 0 }
    const id = plano.tables[0].id
    expect(plano.tables[0]).toMatchObject({ width: 0.075, height: 0.16 })

    // Un dashboard de antes: la mesa SIN los campos. La mueve y el tamaño se queda.
    expect((await guardar(plano.fingerprint, [salon], [mesa({ id, areaRef: salon.id, positionX: 0.3 })])).status).toBe(200)
    plano = await leer()
    expect(plano.tables[0]).toMatchObject({ positionX: 0.3, width: 0.075, height: 0.16 })

    // «Automático»: null en los dos.
    const auto = await guardar(plano.fingerprint, [salon], [mesa({ id, areaRef: salon.id, positionX: 0.3, width: null, height: null })])
    expect(auto.status).toBe(200)
    expect((await leer()).tables[0]).toMatchObject({ width: null, height: null })
  })

  it('un solo lado: 400 en español y no se guarda nada', async () => {
    const vacio = await leer()
    const r = await guardar(vacio.fingerprint, [salonNuevo], [mesa({ clientId: 't1', areaRef: 'a1', width: 0.1 })])
    expect(r.status).toBe(400)
    expect(JSON.stringify(r.body)).toContain('La mesa necesita ancho y alto juntos, o ninguno de los dos')
    expect((await leer()).tables).toEqual([])
  })
})

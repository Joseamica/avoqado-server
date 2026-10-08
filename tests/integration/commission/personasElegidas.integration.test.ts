// tests/integration/commission/personasElegidas.integration.test.ts
/**
 * Fase 3 de Pago al personal, D-ELEGIDOS (defecto viejo; el founder aprobó arreglarlo el 8-oct-2026), contra Postgres REAL y por
 * la RUTA real (app + token).
 *
 * El panel de comisiones ofrece «Sólo seleccionados» («La comisión solo aplica a los empleados que agregues»), pero sólo creaba
 * excepciones para los elegidos y el servidor les pagaba a TODOS. Ahora el esquema dice a quién aplica: `filterByStaff` +
 * `staffIds`, el mismo patrón que las categorías. Con `filterByStaff`, SÓLO cobra de ese esquema quien está en la lista, en todo
 * lector que decide a quién se le calcula (el cobro normal por el camino de la terminal y la liga de pago dividida).
 *
 * Correr: TZ=UTC TEST_DATABASE_URL="$PAGO_F3_DB" npx jest --selectProjects=integration \
 *   --runTestsByPath tests/integration/commission/personasElegidas.integration.test.ts --ci --runInBand
 */
import type { Server } from 'http'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import app from '@/app'
import prisma from '@/utils/prismaClient'
import { createSplitCommissionForPayment } from '@/services/dashboard/commission/commission-calculation.service'
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

// El plan (Comisiones es Premium) va simulado: aquí se prueba a quién se le calcula.
jest.mock('@/services/access/basePlan.service', () => ({
  ...jest.requireActual('@/services/access/basePlan.service'),
  venueHasCommissionsAccess: jest.fn(async () => true),
}))

let m: MundoComisiones
let server: Server
/** Las cinco personas del equipo: ana y bea del mundo, y tres más. */
let equipo: Record<'ana' | 'bea' | 'carla' | 'dani' | 'eli', string>

beforeAll(async () => {
  asegurarBaseDePrueba()
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>(listo => server.once('listening', () => listo()))
})
afterAll(async () => {
  await new Promise<void>(listo => server.close(() => listo()))
})
beforeEach(async () => {
  m = await crearMundoComisiones('personas-elegidas')
  const persona = async (n: string) => {
    const id = (await prisma.staff.create({ data: { email: `${m.key}-${n}@example.test`, firstName: n, lastName: 'QA', active: true } })).id
    await prisma.staffVenue.create({ data: { staffId: id, venueId: m.venueId, role: 'WAITER', active: true } })
    return id
  }
  equipo = { ana: m.ana, bea: m.bea, carla: await persona('carla'), dani: await persona('dani'), eli: await persona('eli') }
  // Sólo el esquema de la prueba decide: el del mundo (10 %, a quien cobró) se apaga.
  await prisma.commissionConfig.update({ where: { id: m.configId }, data: { active: false } })
})
afterEach(async () => {
  const mundo = m
  m = undefined as unknown as MundoComisiones
  if (mundo) {
    await prisma.commissionCalculation.deleteMany({ where: { venueId: mundo.venueId } })
    await prisma.commissionConfig.deleteMany({ where: { orgId: mundo.orgId, venueId: null } })
  }
  await borrarMundoComisiones(mundo)
})

const token = () =>
  jwt.sign({ sub: m.owner, orgId: m.orgId, venueId: m.venueId, role: 'OWNER' }, process.env.ACCESS_TOKEN_SECRET as string, {
    expiresIn: '15m',
  })
const ruta = (r: string) => `/api/v1/dashboard/commissions/venues/${m.venueId}${r}`
const conToken = (t: request.Test) => t.set('Authorization', `Bearer ${token()}`)
const post = (r: string, cuerpo: object) => conToken(request(server).post(ruta(r))).send(cuerpo)
const put = (r: string, cuerpo: object) => conToken(request(server).put(ruta(r))).send(cuerpo)
const get = (r: string) => conToken(request(server).get(ruta(r)))

/** Un esquema del 10 % a quien cobra, vigente desde 2020 (las ventas de la prueba son de hoy). */
const esquema = (extra: object = {}) => ({
  name: 'Sólo algunos',
  recipient: 'PROCESSOR',
  calcType: 'PERCENTAGE',
  defaultRate: 0.1,
  includeTax: true,
  effectiveFrom: '2020-01-01T00:00:00.000Z',
  ...extra,
})

/** Una venta de $100 cobrada por cada persona, por el camino de la terminal; devuelve quién cobró comisión y cuánto. */
async function unaVentaPorPersona(): Promise<Record<string, string>> {
  const pagos: string[] = []
  for (const staffId of Object.values(equipo)) {
    const pago = await cobro(m, await orden(m, { subtotal: 100 }), 100, { staffId, createdAt: new Date() })
    await planear(pago)
    pagos.push(pago)
  }
  await procesarEfectos(m)
  const filas = await prisma.commissionCalculation.findMany({
    where: { paymentId: { in: pagos } },
    select: { staffId: true, netCommission: true },
  })
  const nombre = new Map(Object.entries(equipo).map(([n, id]) => [id, n]))
  return Object.fromEntries(filas.map(f => [nombre.get(f.staffId) ?? f.staffId, f.netCommission.toFixed(2)]).sort())
}

describe('D-ELEGIDOS · «sólo personas elegidas» restringe de verdad a quién se le calcula la comisión', () => {
  it('🔴 un esquema con 3 elegidos de 5: sólo esos 3 cobran comisión; al volver a «todos», cobran los 5', async () => {
    const creado = await post('/configs', esquema({ filterByStaff: true, staffIds: [equipo.ana, equipo.carla, equipo.dani] }))
    expect(creado.status).toBe(201)
    expect(await unaVentaPorPersona()).toEqual({ ana: '10.00', carla: '10.00', dani: '10.00' })

    const todos = await put(`/configs/${creado.body.id}`, { filterByStaff: false })
    expect(todos.status).toBe(200)
    expect(await unaVentaPorPersona()).toEqual({ ana: '10.00', bea: '10.00', carla: '10.00', dani: '10.00', eli: '10.00' })
  })

  it('🔴 la liga de pago dividida también respeta la lista: quien no está elegido no recibe su parte', async () => {
    await post('/configs', esquema({ filterByStaff: true, staffIds: [equipo.ana, equipo.carla] }))
    const pago = await cobro(m, await orden(m, { subtotal: 300 }), 300, { createdAt: new Date() })
    await createSplitCommissionForPayment(pago, [equipo.ana, equipo.bea, equipo.carla])
    const filas = await prisma.commissionCalculation.findMany({ where: { paymentId: pago }, select: { staffId: true } })
    expect(filas.map(f => f.staffId).sort()).toEqual([equipo.ana, equipo.carla].sort())
  })

  it('🔴 crear, leer y actualizar lo aceptan y lo devuelven (sede y organización); sin pedirlo, «todos» como hoy', async () => {
    const creado = await post('/configs', esquema({ filterByStaff: true, staffIds: [equipo.bea, equipo.bea, equipo.eli] }))
    expect(creado.status).toBe(201)
    expect([creado.body.filterByStaff, [...creado.body.staffIds].sort()]).toEqual([true, [equipo.bea, equipo.eli].sort()]) // sin repetidos
    const leido = await get(`/configs/${creado.body.id}`)
    expect([leido.body.filterByStaff, [...leido.body.staffIds].sort()]).toEqual([true, [equipo.bea, equipo.eli].sort()])
    const lista = await get('/configs')
    expect(lista.body.data.find((c: { id: string }) => c.id === creado.body.id)).toMatchObject({ filterByStaff: true })
    const cambiado = await put(`/configs/${creado.body.id}`, { staffIds: [equipo.dani] })
    expect([cambiado.status, cambiado.body.filterByStaff, cambiado.body.staffIds]).toEqual([200, true, [equipo.dani]])

    const deOrganizacion = await post('/org-configs', esquema({ filterByStaff: true, staffIds: [equipo.ana] }))
    expect([deOrganizacion.status, deOrganizacion.body.data.filterByStaff, deOrganizacion.body.data.staffIds]).toEqual([
      201,
      true,
      [equipo.ana],
    ])
    const orgCambiado = await put(`/org-configs/${deOrganizacion.body.data.id}`, { filterByStaff: false })
    expect([orgCambiado.status, orgCambiado.body.data.filterByStaff]).toEqual([200, false])

    const sinPedirlo = await post('/configs', esquema({ name: 'Todos' }))
    expect([sinPedirlo.body.filterByStaff, sinPedirlo.body.staffIds]).toEqual([false, []])
  })

  it('🔴 400 con texto humano: «sólo elegidos» sin nadie, o alguien que no es del equipo de la sede o la organización', async () => {
    const otraOrg = await crearMundoComisiones('personas-ajenas')
    try {
      for (const r of ['/configs', '/org-configs']) {
        const nadie = await post(r, esquema({ filterByStaff: true, staffIds: [] }))
        expect({ r, status: nadie.status, message: nadie.body.message }).toEqual({
          r,
          status: 400,
          message: 'Elige al menos a una persona, o aplica el esquema a todo el equipo.',
        })
        const ajena = await post(r, esquema({ filterByStaff: true, staffIds: [equipo.ana, otraOrg.ana] }))
        expect({ r, status: ajena.status, message: ajena.body.message }).toEqual({
          r,
          status: 400,
          message: 'Una de las personas elegidas no es del equipo de este negocio.',
        })
        const noLista = await post(r, esquema({ filterByStaff: true, staffIds: 'ana' }))
        expect([noLista.status, noLista.body.message]).toEqual([400, 'Las personas elegidas deben ser una lista.'])
      }
      // Actualizar a «sólo elegidos» sin lista en un esquema que no tiene a nadie también es 400.
      const todos = (await post('/configs', esquema())).body.id
      expect((await put(`/configs/${todos}`, { filterByStaff: true })).status).toBe(400)
    } finally {
      await borrarMundoComisiones(otraOrg)
    }
  })
})

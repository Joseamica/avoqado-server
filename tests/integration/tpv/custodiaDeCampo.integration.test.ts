/**
 * La custodia del celular (App de campo, bloque 0) por la RUTA real (app + token) y contra Postgres REAL.
 *
 * Lo que el unit no puede probar: que la organización sale de la sucursal de la dirección aunque el token sea de otra (Codex
 * C2), y que una aceptación o un rechazo viejo no cae sobre una entrega nueva de la misma SIM (Codex C3, con la
 * `custodyVersion` de verdad que sube el servicio de custodia).
 *
 * Correr (va a la nube con su base propia; nunca contra av-db-25):
 *   AVQ_TREE=<worktree> ./scripts/avq-verify.sh avoqado-server npx jest --selectProjects=integration \
 *     --testPathPattern "tpv/custodiaDeCampo" --detectOpenHandles=false --ci
 */
import type { Server } from 'http'
import { randomUUID } from 'crypto'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import app from '@/app'
import prisma from '@/utils/prismaClient'

jest.setTimeout(120000)

const sufijo = randomUUID().slice(0, 8)
let server: Server
let orgA: string
let orgB: string
let venueA: string
let venueB: string
let promotorId: string
let categoria: string

/** El token es de la organización A. */
const token = () =>
  jwt.sign({ sub: promotorId, orgId: orgA, venueId: venueA, role: 'CASHIER' }, process.env.ACCESS_TOKEN_SECRET as string, {
    expiresIn: '15m',
  })
const post = (sucursal: string, accion: 'aceptar' | 'rechazar', body: unknown) =>
  request(server).post(`/api/v1/tpv/campo/venues/${sucursal}/custodia/${accion}`).set('Authorization', `Bearer ${token()}`).send(body)

let consecutivo = 0
/** Una SIM de la organización A entregada al promotor, pendiente de aceptar. */
async function simPendiente() {
  consecutivo += 1
  return prisma.serializedItem.create({
    data: {
      venueId: venueA,
      categoryId: categoria,
      serialNumber: `8952${String(Date.now()).slice(-9)}${String(consecutivo).padStart(6, '0')}`,
      createdBy: promotorId,
      custodyState: 'PROMOTER_PENDING',
      assignedPromoterId: promotorId,
      custodyVersion: 3,
    },
  })
}
/** El supervisor la recolecta y se la vuelve a asignar: pendiente otra vez, con otra versión. */
const recolectarYReasignar = (id: string) =>
  prisma.serializedItem.update({
    where: { id },
    data: { custodyState: 'PROMOTER_PENDING', custodyVersion: { increment: 2 }, promoterAcceptedAt: null, promoterRejectedAt: null },
  })
const eventos = (serializedItemId: string, eventType: 'ACCEPTED_BY_PROMOTER' | 'REJECTED_BY_PROMOTER') =>
  prisma.serializedItemCustodyEvent.count({ where: { serializedItemId, eventType } })

beforeAll(async () => {
  const org = (n: string) =>
    prisma.organization.create({
      data: { name: `Custodia ${n} ${sufijo}`, email: `custodia-${n}-${sufijo}@example.test`, phone: '5500000000' },
    })
  orgA = (await org('a')).id
  orgB = (await org('b')).id
  venueA = (await prisma.venue.create({ data: { organizationId: orgA, name: `Custodia A ${sufijo}`, slug: `custodia-a-${sufijo}` } })).id
  venueB = (await prisma.venue.create({ data: { organizationId: orgB, name: `Custodia B ${sufijo}`, slug: `custodia-b-${sufijo}` } })).id
  promotorId = (
    await prisma.staff.create({
      data: {
        email: `custodia-promotor-${sufijo}@example.test`,
        firstName: 'Promotor',
        lastName: 'Custodia',
        organizations: {
          create: [
            { organizationId: orgA, role: 'MEMBER', isPrimary: true, isActive: true },
            { organizationId: orgB, role: 'MEMBER', isPrimary: false, isActive: true },
          ],
        },
        venues: {
          create: [
            { venueId: venueA, role: 'CASHIER', active: true },
            { venueId: venueB, role: 'CASHIER', active: true },
          ],
        },
      },
    })
  ).id
  categoria = (await prisma.itemCategory.create({ data: { venueId: venueA, name: 'Chip', suggestedPrice: 0 } })).id
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>(listo => server.once('listening', () => listo()))
})

afterAll(async () => {
  await new Promise<void>(listo => server.close(() => listo()))
  await prisma.serializedItemCustodyEvent.deleteMany({ where: { serializedItem: { venueId: venueA } } })
  await prisma.serializedItem.deleteMany({ where: { venueId: venueA } })
  await prisma.itemCategory.deleteMany({ where: { venueId: venueA } })
  await prisma.activityLog.deleteMany({ where: { venueId: { in: [venueA, venueB] } } })
  await prisma.staffVenue.deleteMany({ where: { staffId: promotorId } })
  await prisma.staffOrganization.deleteMany({ where: { staffId: promotorId } })
  await prisma.staff.deleteMany({ where: { id: promotorId } })
  await prisma.venue.deleteMany({ where: { id: { in: [venueA, venueB] } } })
  await prisma.organization.deleteMany({ where: { id: { in: [orgA, orgB] } } })
})

describe('POST /tpv/campo/venues/:venueId/custodia/*', () => {
  it('con un token de A y la dirección de B, una SIM de A no se toca (la organización sale de la sucursal de la dirección)', async () => {
    const sim = await simPendiente()
    const cuerpo = { serialNumber: sim.serialNumber, custodyVersion: 3 }

    const aceptar = await post(venueB, 'aceptar', { sims: [cuerpo] })
    const rechazar = await post(venueB, 'rechazar', cuerpo)

    expect(aceptar.status).toBe(200)
    expect(aceptar.body.results).toEqual([
      { serialNumber: sim.serialNumber, status: 'error', code: 'NOT_FOUND', message: expect.any(String) },
    ])
    expect(rechazar.status).toBe(404)
    expect(rechazar.body).toEqual({ code: 'NOT_FOUND', message: expect.any(String) })
    expect(await prisma.serializedItem.findUniqueOrThrow({ where: { id: sim.id } })).toMatchObject({
      custodyState: 'PROMOTER_PENDING',
      custodyVersion: 3,
    })
    expect(await eventos(sim.id, 'ACCEPTED_BY_PROMOTER')).toBe(0)
  })

  it('aceptar: la primera vez acepta, la misma petición otra vez es repetida, y tras recolectarla y reasignarla la vieja ya no acepta', async () => {
    const sim = await simPendiente()
    const cuerpo = { sims: [{ serialNumber: sim.serialNumber, custodyVersion: 3 }] }

    const primera = await post(venueA, 'aceptar', cuerpo)
    expect(primera.status).toBe(200)
    expect(primera.body.results).toEqual([{ serialNumber: sim.serialNumber, status: 'ok', repetida: false }])
    expect((await prisma.serializedItem.findUniqueOrThrow({ where: { id: sim.id } })).custodyState).toBe('PROMOTER_HELD')

    const repetida = await post(venueA, 'aceptar', cuerpo)
    expect(repetida.status).toBe(200)
    expect(repetida.body.results).toEqual([{ serialNumber: sim.serialNumber, status: 'ok', repetida: true }])

    await recolectarYReasignar(sim.id)
    const vieja = await post(venueA, 'aceptar', cuerpo)
    expect(vieja.status).toBe(200)
    expect(vieja.body.results).toEqual([
      { serialNumber: sim.serialNumber, status: 'error', code: 'ASIGNACION_CAMBIO', message: expect.any(String) },
    ])
    expect((await prisma.serializedItem.findUniqueOrThrow({ where: { id: sim.id } })).custodyState).toBe('PROMOTER_PENDING')
    expect(await eventos(sim.id, 'ACCEPTED_BY_PROMOTER')).toBe(1)
  })

  it('rechazar: la primera vez rechaza, otra vez es repetida, y tras recolectarla y reasignarla el rechazo viejo → 409 ASIGNACION_CAMBIO', async () => {
    const sim = await simPendiente()
    const cuerpo = { serialNumber: sim.serialNumber, custodyVersion: 3 }

    const primera = await post(venueA, 'rechazar', cuerpo)
    expect(primera.status).toBe(200)
    expect(primera.body).toEqual({ custodyState: 'PROMOTER_REJECTED', repetida: false })

    const repetida = await post(venueA, 'rechazar', cuerpo)
    expect(repetida.status).toBe(200)
    expect(repetida.body).toEqual({ custodyState: 'PROMOTER_REJECTED', repetida: true })

    await recolectarYReasignar(sim.id)
    const vieja = await post(venueA, 'rechazar', cuerpo)
    expect(vieja.status).toBe(409)
    expect(vieja.body).toEqual({ code: 'ASIGNACION_CAMBIO', message: expect.any(String) })
    expect((await prisma.serializedItem.findUniqueOrThrow({ where: { id: sim.id } })).custodyState).toBe('PROMOTER_PENDING')
    expect(await eventos(sim.id, 'REJECTED_BY_PROMOTER')).toBe(1)
  })

  it('un cuerpo sin custodyVersion → 400', async () => {
    const sim = await simPendiente()
    expect((await post(venueA, 'aceptar', { sims: [{ serialNumber: sim.serialNumber }] })).status).toBe(400)
    expect((await post(venueA, 'rechazar', { serialNumber: sim.serialNumber })).status).toBe(400)
  })
})

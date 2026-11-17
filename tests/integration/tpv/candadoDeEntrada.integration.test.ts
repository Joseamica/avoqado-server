/**
 * Dos «Entrada» de la MISMA persona a la vez (POS y TPV, o el reintento de una app) contra Postgres real: una sola checada.
 *
 * Antes las dos leían «no tiene entrada» y creaban dos checadas abiertas (Codex r1 #4 de la foto de entrada, 15-nov-2026).
 * El cruce se FUERZA: la primera transacción se aparca con su candado tomado y se COMPRUEBA en `pg_stat_activity` que la
 * segunda la espera; no se supone por tiempos.
 *
 * Correr (va a la nube con su base propia; nunca contra av-db-25):
 *   npx jest --selectProjects=integration --testPathPattern "tpv/candadoDeEntrada" --detectOpenHandles=false --ci
 */
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import { BadRequestError } from '@/errors/AppError'
import { clockIn as entradaPos } from '@/services/mobile/time-entry.mobile.service'
import { clockIn as entradaTpv } from '@/services/tpv/time-entry.tpv.service'
import { aparcarLaSiguienteTransaccion, aTiempo, esperarBloqueado } from '@tests/__helpers__/candadosDePostgres'

jest.setTimeout(120000)

const sufijo = randomUUID().slice(0, 8)
const PIN = String(100000 + Math.floor(Math.random() * 899999))
let orgId: string
let venueId: string
let staffId: string

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({ data: { name: `Entrada ${sufijo}`, email: `entrada-${sufijo}@example.test`, phone: '5500000000' } })
  ).id
  venueId = (await prisma.venue.create({ data: { organizationId: orgId, name: `Entrada ${sufijo}`, slug: `entrada-${sufijo}` } })).id
  staffId = (
    await prisma.staff.create({
      data: {
        email: `entrada-${sufijo}@example.test`,
        firstName: 'Ana',
        lastName: 'Entrada',
        organizations: { create: { organizationId: orgId, role: 'MEMBER', isPrimary: true, isActive: true } },
        venues: { create: [{ venueId, role: 'CASHIER', active: true, pin: PIN }] },
      },
    })
  ).id
})

beforeEach(async () => {
  // Sin staffId (falló la preparación), `{ staffId: undefined }` borraría TODAS las checadas (Codex r3 #4).
  if (!staffId) throw new Error('La preparación no creó a la persona de prueba')
  await prisma.timeEntry.deleteMany({ where: { staffId } })
})

afterAll(async () => {
  if (!orgId || !venueId || !staffId) return // la preparación falló: no hay nada propio que limpiar
  await prisma.timeEntry.deleteMany({ where: { staffId } })
  await prisma.staffVenue.deleteMany({ where: { venueId } })
  await prisma.staffOrganization.deleteMany({ where: { organizationId: orgId } })
  await prisma.staff.deleteMany({ where: { id: staffId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
})

it('la segunda espera a la primera y contesta «ya tienes entrada»: queda UNA checada abierta', async () => {
  const aparcada = aparcarLaSiguienteTransaccion(prisma)
  let primera: Promise<unknown> | undefined
  let segunda: Promise<unknown> | undefined
  try {
    primera = entradaPos({ venueId, pin: PIN })
    const pidPrimera = await aTiempo(aparcada.pid, 10_000, 'la primera entrada no llegó a su candado')

    segunda = entradaTpv({ venueId, staffId, pin: PIN })
    const espera = await esperarBloqueado(prisma, { bloqueadoPor: [pidPrimera], consulta: /pg_advisory_xact_lock/ })
    expect(espera).not.toBeNull()
  } finally {
    aparcada.soltar()
    aparcada.restaurar()
  }

  const [r1, r2] = await Promise.allSettled([primera!, segunda!])
  expect(r1.status).toBe('fulfilled')
  expect(r2.status).toBe('rejected')
  expect((r2 as PromiseRejectedResult).reason).toBeInstanceOf(BadRequestError)
  expect(await prisma.timeEntry.count({ where: { staffId, status: { in: ['CLOCKED_IN', 'ON_BREAK'] } } })).toBe(1)
})

it('regresión: una sola entrada sigue funcionando y la segunda, ya en orden, se rechaza', async () => {
  await entradaPos({ venueId, pin: PIN })
  await expect(entradaPos({ venueId, pin: PIN })).rejects.toBeInstanceOf(BadRequestError)
  expect(await prisma.timeEntry.count({ where: { staffId } })).toBe(1)
})

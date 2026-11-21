/**
 * Apagador del SDK propio (fase 3): el disparador de Postgres `Terminal_inHouseSdk_identity_trigger` lo pone en false si
 * cambia la identidad física de la terminal (serie, tipo o marca), para que el permiso nunca viaje a otro aparato.
 * Cualquier otro cambio (nombre, estado, latido, negocio) no lo toca. Postgres real; series ficticias.
 *
 * Correr (va a la nube con su base propia; nunca contra av-db-25):
 *   npx jest --selectProjects=integration --runTestsByPath tests/integration/tpv/apagadorSdkPropio.disparador.integration.test.ts --ci
 */
import { randomUUID } from 'crypto'
import { TerminalType } from '@prisma/client'
import prisma from '@/utils/prismaClient'

const sufijo = randomUUID().slice(0, 8)
let orgId: string
let venueId: string
let otroVenueId: string

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `Negocio de prueba ${sufijo}`, email: `apagador-${sufijo}@example.test`, phone: '5500000000' },
    })
  ).id
  venueId = (await prisma.venue.create({ data: { organizationId: orgId, name: 'Negocio de prueba', slug: `apagador-${sufijo}` } })).id
  otroVenueId = (await prisma.venue.create({ data: { organizationId: orgId, name: 'Negocio de prueba 2', slug: `apagador-2-${sufijo}` } }))
    .id
})

afterAll(async () => {
  // Si la preparación falló a medias, se limpia lo que sí alcanzó a crearse (antes un id faltante dejaba la organización).
  const venues = [venueId, otroVenueId].filter(Boolean)
  if (venues.length) {
    await prisma.terminal.deleteMany({ where: { venueId: { in: venues } } })
    await prisma.venue.deleteMany({ where: { id: { in: venues } } })
  }
  if (orgId) await prisma.organization.deleteMany({ where: { id: orgId } })
})

async function terminalPrendida(serialNumber: string) {
  const t = await prisma.terminal.create({
    data: { venueId, name: 'Caja 1', type: TerminalType.TPV_ANDROID, brand: 'PAX', serialNumber },
  })
  return prisma.terminal.update({ where: { id: t.id }, data: { inHouseSdkEnabled: true } })
}

const leer = async (id: string) => (await prisma.terminal.findUniqueOrThrow({ where: { id } })).inHouseSdkEnabled

it.each([
  ['serialNumber', 'AVQD-9900000001', { serialNumber: 'AVQD-9900000002' }],
  ['type', 'AVQD-9900000003', { type: TerminalType.TPV_IOS }],
  ['brand', 'AVQD-9900000004', { brand: 'NEXGO' }],
])('prendida + cambia %s ⇒ queda en false', async (_campo, serie, cambio) => {
  const t = await terminalPrendida(serie)
  expect(t.inHouseSdkEnabled).toBe(true)
  await prisma.terminal.update({ where: { id: t.id }, data: cambio })
  expect(await leer(t.id)).toBe(false)
})

it('prendida + cambian nombre, estado, lastHeartbeat y venueId ⇒ sigue en true', async () => {
  const t = await terminalPrendida('AVQD-9900000005')
  await prisma.terminal.update({
    where: { id: t.id },
    data: { name: 'Caja renombrada', status: 'ACTIVE', lastHeartbeat: new Date(), venueId: otroVenueId },
  })
  expect(await leer(t.id)).toBe(true)
})

it('prendida + update con la MISMA serie, tipo y marca ⇒ sigue en true', async () => {
  const t = await terminalPrendida('AVQD-9900000006')
  await prisma.terminal.update({
    where: { id: t.id },
    data: { serialNumber: 'AVQD-9900000006', type: TerminalType.TPV_ANDROID, brand: 'PAX' },
  })
  expect(await leer(t.id)).toBe(true)
})

it('una ficha nueva nace en false', async () => {
  const t = await prisma.terminal.create({
    data: { venueId, name: 'Caja nueva', type: TerminalType.TPV_ANDROID, brand: 'PAX', serialNumber: 'AVQD-9900000007' },
  })
  expect(t.inHouseSdkEnabled).toBe(false)
})

it('el SQL crudo (UPDATE "Terminal" SET "serialNumber" = …) también la apaga', async () => {
  const t = await terminalPrendida('AVQD-9900000008')
  await prisma.$executeRaw`UPDATE "Terminal" SET "serialNumber" = ${'AVQD-9900000009'} WHERE "id" = ${t.id}`
  expect(await leer(t.id)).toBe(false)
})

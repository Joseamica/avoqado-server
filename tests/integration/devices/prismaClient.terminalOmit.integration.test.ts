// tests/integration/devices/prismaClient.terminalOmit.integration.test.ts
import prisma from '@/utils/prismaClient'

/**
 * El reporte de dibujo del POS (hz:a5fa2439:D1) vive en Terminal, pero la omisión global del cliente (`serverOnlyOmit`)
 * lo saca de toda lectura: ninguna respuesta vieja que devuelve la fila (o la anida) lo filtra. Sólo quien lo pide por
 * nombre lo recibe. La omisión es del motor de Prisma, por eso se prueba contra la base.
 */
const suffix = `omit-${Date.now()}`
const DIAGNOSTICS = { renderer: 'software', probe: 1 }
let orgId: string
let venueId: string
let terminalId: string

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `Org ${suffix}`, email: `${suffix}@example.test`, phone: '0000000000' },
      select: { id: true },
    })
  ).id
  venueId = (
    await prisma.venue.create({
      data: { organizationId: orgId, name: `Venue ${suffix}`, slug: `venue-${suffix}`, timezone: 'America/Mexico_City' },
      select: { id: true },
    })
  ).id
  terminalId = (
    await prisma.terminal.create({
      data: { venueId, name: 'PC', type: 'POS_DESKTOP', deviceDiagnostics: DIAGNOSTICS },
      select: { id: true },
    })
  ).id
})

afterAll(async () => {
  if (!venueId || !orgId) return // sin esta guarda, un id undefined vaciaría tablas enteras (8-oct)
  await prisma.terminal.deleteMany({ where: { venueId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
  await prisma.$disconnect()
})

it('una lectura normal de Terminal, directa o anidada, no trae el reporte de dibujo', async () => {
  const [direct, nested] = await Promise.all([
    prisma.terminal.findUniqueOrThrow({ where: { id: terminalId } }),
    prisma.venue.findUniqueOrThrow({ where: { id: venueId }, include: { terminals: true } }),
  ])

  expect(direct).toHaveProperty('id', terminalId)
  expect(direct).not.toHaveProperty('deviceDiagnostics')
  expect(nested.terminals).toHaveLength(1)
  expect(nested.terminals[0]).not.toHaveProperty('deviceDiagnostics')
})

it('con omit: { deviceDiagnostics: false } sí lo trae', async () => {
  const row = await prisma.terminal.findUniqueOrThrow({ where: { id: terminalId }, omit: { deviceDiagnostics: false } })

  expect(row).toHaveProperty('deviceDiagnostics', DIAGNOSTICS)
})

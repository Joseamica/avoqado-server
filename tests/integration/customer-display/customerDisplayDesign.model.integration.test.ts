// tests/integration/customer-display/customerDisplayDesign.model.integration.test.ts
import prisma from '@/utils/prismaClient'

const suffix = `cdd-${Date.now()}`
let venueId: string
let orgId: string
let terminalId: string

beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { name: `Org ${suffix}`, email: `${suffix}@example.test`, phone: '0000000000' },
    select: { id: true },
  })
  orgId = org.id
  const venue = await prisma.venue.create({
    data: { organizationId: orgId, name: `Venue ${suffix}`, slug: `venue-${suffix}`, timezone: 'America/Mexico_City' },
    select: { id: true },
  })
  venueId = venue.id
  const terminal = await prisma.terminal.create({
    data: { venueId, name: `Caja ${suffix}`, type: 'POS_ANDROID' },
    select: { id: true },
  })
  terminalId = terminal.id
})

afterAll(async () => {
  if (!venueId || !orgId) return
  await prisma.customerDisplayAsset.deleteMany({ where: { venueId } })
  await prisma.terminal.deleteMany({ where: { venueId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
})

describe('CustomerDisplayDesign', () => {
  it('nace con los defaults del spec y una revisión en 1', async () => {
    const design = await prisma.customerDisplayDesign.create({
      data: { terminalId },
      select: { id: true, theme: true, slideSeconds: true, showPromotions: true, revision: true, schemaVersion: true },
    })

    expect(design).toMatchObject({ theme: 'LIGHT', slideSeconds: 8, showPromotions: false, revision: 1, schemaVersion: 1 })
  })

  it('sólo admite UN diseño por terminal', async () => {
    await expect(prisma.customerDisplayDesign.create({ data: { terminalId } })).rejects.toMatchObject({ code: 'P2002' })
  })

  it('se borra con su terminal, sin dejar huérfanos', async () => {
    const otra = await prisma.terminal.create({ data: { venueId, name: `Caja 2 ${suffix}`, type: 'POS_ANDROID' }, select: { id: true } })
    await prisma.customerDisplayDesign.create({ data: { terminalId: otra.id } })

    await prisma.terminal.delete({ where: { id: otra.id } })

    expect(await prisma.customerDisplayDesign.findUnique({ where: { terminalId: otra.id } })).toBeNull()
  })
})

describe('CustomerDisplayAsset', () => {
  it('guarda el hash y la ruta, y la ruta es única', async () => {
    const objectPath = `dev/customer-display-assets/${venueId}/${suffix}.png`
    await prisma.customerDisplayAsset.create({
      data: { venueId, kind: 'SLIDE', objectPath, sha256: 'a'.repeat(64), mime: 'image/png', width: 1280, height: 720, bytes: 2048 },
    })

    await expect(
      prisma.customerDisplayAsset.create({
        data: { venueId, kind: 'SLIDE', objectPath, sha256: 'b'.repeat(64), mime: 'image/png', width: 1280, height: 720, bytes: 2048 },
      }),
    ).rejects.toMatchObject({ code: 'P2002' })
  })
})

describe('Terminal: columnas de la pantalla del cliente', () => {
  it('nacen vacías y aceptan el reporte del aparato', async () => {
    const antes = await prisma.terminal.findUniqueOrThrow({
      where: { id: terminalId },
      select: { customerDisplayDesignVersion: true, customerDisplayInstallationId: true, customerDisplayAck: true },
    })
    expect(antes).toEqual({ customerDisplayDesignVersion: null, customerDisplayInstallationId: null, customerDisplayAck: null })

    const despues = await prisma.terminal.update({
      where: { id: terminalId },
      data: {
        customerDisplayDesignVersion: 1,
        customerDisplayInstallationId: 'inst-1',
        customerDisplayInstallationSince: new Date(),
        customerDisplayInstallationSwitches: [new Date().toISOString()],
        customerDisplayAck: { fingerprint: 'abc', seq: 1 },
      },
      select: { customerDisplayDesignVersion: true, customerDisplayInstallationId: true },
    })
    expect(despues).toEqual({ customerDisplayDesignVersion: 1, customerDisplayInstallationId: 'inst-1' })
  })
})

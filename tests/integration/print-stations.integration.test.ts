/**
 * PRINT_STATIONS — integration tests against the REAL local Postgres (av-db-25).
 *
 * These verify the DB-level invariants that unit mocks CANNOT: the I9 partial unique
 * index (one default station per venue), the tenant-scoped PrintJob dedupe key, the
 * print-config round-trip, and the FK SetNull cascades. Creates a throwaway
 * organization + 2 venues + a category + product, and cleans everything up.
 */
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { createStation, deletePrinter, deleteStation, assignRouting } from '@/services/dashboard/printStation.dashboard.service'
import { buildPrintConfig } from '@/services/printing/printConfig.service'

const SUF = `ptest_${Date.now()}`
let orgId: string
let venue1: string
let venue2: string
let categoryId: string
let productId: string

beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { name: `PrintTest Org ${SUF}`, email: `${SUF}@test.local`, phone: '0000000000' },
  })
  orgId = org.id
  const v1 = await prisma.venue.create({ data: { organizationId: orgId, name: `V1 ${SUF}`, slug: `v1-${SUF}` } })
  const v2 = await prisma.venue.create({ data: { organizationId: orgId, name: `V2 ${SUF}`, slug: `v2-${SUF}` } })
  venue1 = v1.id
  venue2 = v2.id
  const cat = await prisma.menuCategory.create({ data: { venueId: venue1, name: 'Alimentos', slug: `alimentos-${SUF}` } })
  categoryId = cat.id
  const prod = await prisma.product.create({
    data: { venueId: venue1, sku: `SKU-${SUF}`, name: 'Taco', categoryId, price: new Prisma.Decimal(50) },
  })
  productId = prod.id
})

afterAll(async () => {
  const venues = [venue1, venue2].filter(Boolean)
  if (venues.length) {
    await prisma.printJob.deleteMany({ where: { venueId: { in: venues } } })
    await prisma.printGateway.deleteMany({ where: { venueId: { in: venues } } })
    await prisma.printStation.deleteMany({ where: { venueId: { in: venues } } })
    await prisma.printer.deleteMany({ where: { venueId: { in: venues } } })
    await prisma.product.deleteMany({ where: { venueId: { in: venues } } })
    await prisma.menuCategory.deleteMany({ where: { venueId: { in: venues } } })
    await prisma.venue.deleteMany({ where: { id: { in: venues } } })
  }
  if (orgId) await prisma.organization.delete({ where: { id: orgId } })
})

describe('PRINT_STATIONS — DB invariants (real Postgres)', () => {
  // ── I9: exactly one default station per venue (partial unique index) ──
  it('the partial unique index REJECTS a second default station in the same venue', async () => {
    await prisma.printStation.create({ data: { venueId: venue1, name: 'DefA', isDefault: true } })
    await expect(prisma.printStation.create({ data: { venueId: venue1, name: 'DefB', isDefault: true } })).rejects.toMatchObject({
      code: 'P2002',
    })
    // cleanup for the next test
    await prisma.printStation.deleteMany({ where: { venueId: venue1 } })
  })

  it('another venue CAN have its own default (index is per-venue, not global)', async () => {
    const a = await prisma.printStation.create({ data: { venueId: venue1, name: 'Cocina', isDefault: true } })
    const b = await prisma.printStation.create({ data: { venueId: venue2, name: 'Cocina', isDefault: true } })
    expect(a.isDefault).toBe(true)
    expect(b.isDefault).toBe(true)
    await prisma.printStation.deleteMany({ where: { venueId: { in: [venue1, venue2] } } })
  })

  it('service createStation clears the prior default in the same txn (I9 end-to-end, no index violation)', async () => {
    const first = await createStation(venue1, { name: 'Cocina', isDefault: true } as any)
    const second = await createStation(venue1, { name: 'Barra', isDefault: true } as any)
    const firstAfter = await prisma.printStation.findUnique({ where: { id: first.id } })
    expect(firstAfter?.isDefault).toBe(false) // prior default cleared
    expect(second.isDefault).toBe(true)
    const defaults = await prisma.printStation.count({ where: { venueId: venue1, isDefault: true } })
    expect(defaults).toBe(1)
    await prisma.printStation.deleteMany({ where: { venueId: venue1 } })
  })

  // ── PrintJob tenant-scoped dedupe key (venueId, eventId, reason, seq) ──
  it('two DIFFERENT venues can hold the same (eventId, reason, seq); a same-venue duplicate is rejected', async () => {
    const base = { eventId: `ev-${SUF}`, reason: 'ORIGINAL' as const, seq: 1, type: 'KITCHEN_TICKET' as const, status: 'DONE' as const }
    await prisma.printJob.create({ data: { id: `pj1-${SUF}`, venueId: venue1, ...base } })
    // cross-venue same causal key → allowed
    await expect(prisma.printJob.create({ data: { id: `pj2-${SUF}`, venueId: venue2, ...base } })).resolves.toBeTruthy()
    // same venue duplicate → rejected by the venue-scoped unique
    await expect(prisma.printJob.create({ data: { id: `pj3-${SUF}`, venueId: venue1, ...base } })).rejects.toMatchObject({
      code: 'P2002',
    })
    await prisma.printJob.deleteMany({ where: { venueId: { in: [venue1, venue2] } } })
  })

  // ── buildPrintConfig round-trips the venue's real config ──
  it('buildPrintConfig returns the venue printers, stations, routing + a stable non-empty version', async () => {
    const printer = await prisma.printer.create({
      data: { venueId: venue1, name: 'Impresora Cocina', connectionType: 'NETWORK', address: '192.168.1.50:9100' },
    })
    const station = await createStation(venue1, { name: 'Cocina', printerId: printer.id, isDefault: true } as any)
    await assignRouting(venue1, { categories: [{ id: categoryId, printStationId: station.id }] } as any)

    const config = await buildPrintConfig(venue1)
    expect(config.printers.map(p => p.id)).toContain(printer.id)
    expect(config.stations.map(s => s.id)).toContain(station.id)
    expect(config.defaultStationId).toBe(station.id)
    expect(config.categoryRouting).toEqual(expect.arrayContaining([{ categoryId, printStationId: station.id }]))
    expect(config.version).toMatch(/^[a-f0-9]{16}$/)

    // stable: same content → same version
    const again = await buildPrintConfig(venue1)
    expect(again.version).toBe(config.version)

    // cleanup routing + station + printer for later tests
    await assignRouting(venue1, { categories: [{ id: categoryId, printStationId: null }] } as any)
    await prisma.printStation.deleteMany({ where: { venueId: venue1 } })
    await prisma.printer.deleteMany({ where: { venueId: venue1 } })
  })

  // ── FK SetNull cascades ──
  it('deleting a station NULLs the category/product routing that pointed to it (FK SetNull)', async () => {
    const station = await createStation(venue1, { name: 'Barra' } as any)
    await assignRouting(venue1, {
      categories: [{ id: categoryId, printStationId: station.id }],
      products: [{ id: productId, printStationId: station.id }],
    } as any)
    expect((await prisma.menuCategory.findUnique({ where: { id: categoryId } }))?.printStationId).toBe(station.id)

    await deleteStation(venue1, station.id)

    expect((await prisma.menuCategory.findUnique({ where: { id: categoryId } }))?.printStationId).toBeNull()
    expect((await prisma.product.findUnique({ where: { id: productId } }))?.printStationId).toBeNull()
  })

  it('deleting a printer NULLs the station.printerId that referenced it (FK SetNull)', async () => {
    const printer = await prisma.printer.create({ data: { venueId: venue1, name: 'Temp', connectionType: 'NETWORK' } })
    const station = await createStation(venue1, { name: 'ConImpresora', printerId: printer.id } as any)
    await deletePrinter(venue1, printer.id)
    expect((await prisma.printStation.findUnique({ where: { id: station.id } }))?.printerId).toBeNull()
    await prisma.printStation.deleteMany({ where: { venueId: venue1 } })
  })
})

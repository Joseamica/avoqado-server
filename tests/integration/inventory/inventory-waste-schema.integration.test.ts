import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'

const fixture = `waste-schema-${randomUUID()}`
let organizationId = ''
let venueId = ''
let staffId = ''

beforeAll(async () => {
  const declared = new URL(process.env.TEST_DATABASE_URL ?? '')
  expect(['localhost', '127.0.0.1']).toContain(declared.hostname)
  expect(declared.pathname.toLowerCase()).toContain('test')

  const organization = await prisma.organization.create({
    data: { name: fixture, email: `${fixture}@example.test`, phone: '5500000000' },
  })
  organizationId = organization.id
  const venue = await prisma.venue.create({
    data: { organizationId, name: fixture, slug: fixture, timezone: 'America/Mexico_City', currency: 'MXN' },
  })
  venueId = venue.id
  const staff = await prisma.staff.create({
    data: { email: `staff-${fixture}@example.test`, firstName: 'Prueba', lastName: 'Schema' },
  })
  staffId = staff.id
})

afterAll(async () => {
  await prisma.inventoryWasteReport.deleteMany({ where: { venueId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.organization.deleteMany({ where: { id: organizationId } })
  await prisma.staff.deleteMany({ where: { id: staffId } })
})

const lapida = () => ({
  venueId,
  idempotencyKey: randomUUID(),
  status: 'VOIDED' as const,
  costState: 'NONE' as const,
  reportedByStaffId: staffId,
  source: 'POS' as const,
})

test('una lápida VOIDED mínima es válida', async () => {
  await expect(prisma.inventoryWasteReport.create({ data: lapida() })).resolves.toMatchObject({ status: 'VOIDED' })
})

test('🔴 una lápida no puede cargar datos de una declaración', async () => {
  await expect(prisma.inventoryWasteReport.create({ data: { ...lapida(), note: 'no debería' } })).rejects.toThrow(
    /InventoryWasteReport_state_check/,
  )
})

test('🔴 APPLIED sin hash, sin artículo o sin cantidad se rechaza en la base', async () => {
  await expect(
    prisma.inventoryWasteReport.create({ data: { ...lapida(), status: 'APPLIED' } }),
  ).rejects.toThrow(/InventoryWasteReport_state_check/)
})

test('🔴 el mismo folio dos veces en el mismo venue choca con el índice único', async () => {
  const data = lapida()
  await prisma.inventoryWasteReport.create({ data })
  await expect(prisma.inventoryWasteReport.create({ data })).rejects.toMatchObject({ code: 'P2002' })
})

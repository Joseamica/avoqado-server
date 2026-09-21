import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'

const fixture = `waste-schema-${randomUUID()}`
let organizationId = ''
let venueId = ''
let staffId = ''
let categoryId = ''

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
  const category = await prisma.menuCategory.create({ data: { venueId, name: fixture, slug: fixture } })
  categoryId = category.id
})

afterAll(async () => {
  // De la hoja a la raíz: los movimientos referencian el folio, y el folio al artículo.
  await prisma.rawMaterialMovement.deleteMany({ where: { venueId } })
  await prisma.inventoryMovement.deleteMany({ where: { wasteReport: { venueId } } })
  await prisma.inventoryWasteReport.deleteMany({ where: { venueId } })
  await prisma.inventory.deleteMany({ where: { venueId } })
  await prisma.product.deleteMany({ where: { venueId } })
  await prisma.rawMaterial.deleteMany({ where: { venueId } })
  await prisma.menuCategory.deleteMany({ where: { venueId } })
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

// Una declaración APPLIED que cumple los tres CHECK: hash de 64 hex, artículo, unidad, motivo,
// declarada = descontada + no registrada, y costo KNOWN con importe.
const aplicada = (articulo: { itemType: 'PRODUCT'; productId: string } | { itemType: 'RAW_MATERIAL'; rawMaterialId: string }, unit: string) => ({
  venueId,
  idempotencyKey: randomUUID(),
  status: 'APPLIED' as const,
  payloadHash: 'a'.repeat(64),
  unit,
  reasonCode: 'EXPIRED',
  declaredQuantity: 2,
  deductedQuantity: 2,
  unrecordedQuantity: 0,
  costImpact: 10,
  costState: 'KNOWN' as const,
  reportedByStaffId: staffId,
  source: 'POS' as const,
  ...articulo,
})

const crearInsumo = () =>
  prisma.rawMaterial.create({
    data: {
      venueId,
      name: 'Leche',
      sku: `rm-${randomUUID()}`,
      currentStock: 8,
      unit: 'LITER',
      unitType: 'VOLUME',
      minimumStock: 0,
      reorderPoint: 0,
      costPerUnit: 5,
      avgCostPerUnit: 5,
    },
  })

const crearMovimientoDeInsumo = (rawMaterialId: string, wasteReportId: string) =>
  prisma.rawMaterialMovement.create({
    data: { rawMaterialId, venueId, type: 'SPOILAGE', quantity: -2, unit: 'LITER', previousStock: 10, newStock: 8, wasteReportId },
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

test('🔴 borrar un PRODUCTO se lleva su merma y el movimiento ligado, como el kardex', async () => {
  const product = await prisma.product.create({
    data: { venueId, sku: `sku-${randomUUID()}`, name: 'Pan', categoryId, price: 10 },
  })
  const inventory = await prisma.inventory.create({ data: { productId: product.id, venueId, currentStock: 8 } })
  const report = await prisma.inventoryWasteReport.create({ data: aplicada({ itemType: 'PRODUCT', productId: product.id }, 'UNIT') })
  const movement = await prisma.inventoryMovement.create({
    data: { inventoryId: inventory.id, type: 'LOSS', quantity: -2, previousStock: 10, newStock: 8, wasteReportId: report.id },
  })

  await expect(prisma.product.delete({ where: { id: product.id } })).resolves.toMatchObject({ id: product.id })

  expect(await prisma.inventoryWasteReport.findUnique({ where: { id: report.id } })).toBeNull()
  expect(await prisma.inventoryMovement.findUnique({ where: { id: movement.id } })).toBeNull()
})

test('🔴 borrar un INSUMO se lleva su merma y el movimiento ligado, como el kardex', async () => {
  const rawMaterial = await crearInsumo()
  const report = await prisma.inventoryWasteReport.create({
    data: aplicada({ itemType: 'RAW_MATERIAL', rawMaterialId: rawMaterial.id }, 'LITER'),
  })
  const movement = await crearMovimientoDeInsumo(rawMaterial.id, report.id)

  await expect(prisma.rawMaterial.delete({ where: { id: rawMaterial.id } })).resolves.toMatchObject({ id: rawMaterial.id })

  expect(await prisma.inventoryWasteReport.findUnique({ where: { id: report.id } })).toBeNull()
  expect(await prisma.rawMaterialMovement.findUnique({ where: { id: movement.id } })).toBeNull()
})

test('🔴 un folio no se puede borrar solo mientras un movimiento lo referencia', async () => {
  const rawMaterial = await crearInsumo()
  const report = await prisma.inventoryWasteReport.create({
    data: aplicada({ itemType: 'RAW_MATERIAL', rawMaterialId: rawMaterial.id }, 'LITER'),
  })
  const movement = await crearMovimientoDeInsumo(rawMaterial.id, report.id)

  await expect(prisma.inventoryWasteReport.delete({ where: { id: report.id } })).rejects.toMatchObject({ code: 'P2003' })

  expect(await prisma.inventoryWasteReport.findUnique({ where: { id: report.id } })).not.toBeNull()
  expect(await prisma.rawMaterialMovement.findUnique({ where: { id: movement.id } })).not.toBeNull()
})

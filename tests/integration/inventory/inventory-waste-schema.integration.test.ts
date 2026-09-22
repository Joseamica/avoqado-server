import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
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
const aplicada = (
  articulo: { itemType: 'PRODUCT'; productId: string } | { itemType: 'RAW_MATERIAL'; rawMaterialId: string },
  unit: string,
) => ({
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

const crearInsumo = (db: Prisma.TransactionClient = prisma) =>
  db.rawMaterial.create({
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

const crearMovimientoDeInsumo = (rawMaterialId: string, wasteReportId: string, db: Prisma.TransactionClient = prisma) =>
  db.rawMaterialMovement.create({
    data: { rawMaterialId, venueId, type: 'SPOILAGE', quantity: -2, unit: 'LITER', previousStock: 10, newStock: 8, wasteReportId },
  })

class Revertir extends Error {}
const PRIMERO = 'RI_ConstraintTrigger_a_0'

const triggerDeBorrado = async (db: Prisma.TransactionClient, tabla: 'Product' | 'RawMaterial', constraint: string) => {
  const [fila] = await db.$queryRawUnsafe<Array<{ tgname: string }>>(
    `SELECT t.tgname FROM pg_trigger t JOIN pg_constraint c ON c.oid = t.tgconstraint
      WHERE t.tgrelid = '"${tabla}"'::regclass AND c.conname = '${constraint}' AND t.tgfoid = '"RI_FKey_cascade_del"'::regproc`,
  )
  return fila.tgname
}

/**
 * Postgres dispara los triggers RI de un mismo evento en orden ALFABÉTICO de nombre, y el nombre
 * lleva el OID (`RI_ConstraintTrigger_a_<oid>`): el orden en producción es impredecible. Para
 * probar el orden desfavorable sin depender de los OIDs de esta base, se renombra el trigger de la
 * cascada artículo → folio a uno que ordena antes que cualquier OID. Todo corre en una transacción
 * que SIEMPRE se revierte (nombre y datos vuelven a su estado). Un FK diferido sólo se verifica al
 * COMMIT, que aquí nunca llega: `SET CONSTRAINTS ALL IMMEDIATE` fuerza esa verificación antes.
 */
async function enOrdenDesfavorable(
  tabla: 'Product' | 'RawMaterial',
  folioFk: string,
  kardexFk: string,
  escenario: (tx: Prisma.TransactionClient) => Promise<void>,
) {
  try {
    await prisma.$transaction(
      async tx => {
        const folio = await triggerDeBorrado(tx, tabla, folioFk)
        const kardex = await triggerDeBorrado(tx, tabla, kardexFk)
        await tx.$executeRawUnsafe(`ALTER TRIGGER "${folio}" ON "${tabla}" RENAME TO "${PRIMERO}"`)
        expect(PRIMERO < kardex).toBe(true) // la cascada del folio dispara antes que la del kardex
        await escenario(tx)
        await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE')
        throw new Revertir()
      },
      { timeout: 60_000 },
    )
  } catch (error) {
    if (!(error instanceof Revertir)) throw error
  }
}

test('una lápida VOIDED mínima es válida', async () => {
  await expect(prisma.inventoryWasteReport.create({ data: lapida() })).resolves.toMatchObject({ status: 'VOIDED' })
})

test('🔴 una lápida no puede cargar datos de una declaración', async () => {
  await expect(prisma.inventoryWasteReport.create({ data: { ...lapida(), note: 'no debería' } })).rejects.toThrow(
    /InventoryWasteReport_state_check/,
  )
})

test('🔴 APPLIED sin hash, sin artículo o sin cantidad se rechaza en la base', async () => {
  await expect(prisma.inventoryWasteReport.create({ data: { ...lapida(), status: 'APPLIED' } })).rejects.toThrow(
    /InventoryWasteReport_state_check/,
  )
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

// El kardex del producto cuelga a DOS niveles (Product → Inventory → InventoryMovement) y el folio a
// uno (Product → InventoryWasteReport): si la cascada del folio dispara primero, la verificación del
// FK del movimiento se encola ANTES que el borrado del movimiento. Sólo un FK diferido sobrevive.
test('🔴 borrar un PRODUCTO funciona aunque la cascada del folio dispare antes que la del kardex', async () => {
  await enOrdenDesfavorable('Product', 'InventoryWasteReport_productId_fkey', 'Inventory_productId_fkey', async tx => {
    const product = await tx.product.create({
      data: { venueId, sku: `sku-${randomUUID()}`, name: 'Pan', categoryId, price: 10 },
    })
    const inventory = await tx.inventory.create({ data: { productId: product.id, venueId, currentStock: 8 } })
    const report = await tx.inventoryWasteReport.create({ data: aplicada({ itemType: 'PRODUCT', productId: product.id }, 'UNIT') })
    const movement = await tx.inventoryMovement.create({
      data: { inventoryId: inventory.id, type: 'LOSS', quantity: -2, previousStock: 10, newStock: 8, wasteReportId: report.id },
    })

    await tx.product.delete({ where: { id: product.id } })

    expect(await tx.inventoryWasteReport.findUnique({ where: { id: report.id } })).toBeNull()
    expect(await tx.inventoryMovement.findUnique({ where: { id: movement.id } })).toBeNull()
  })
})

// Mismo orden forzado para el insumo. Aquí kardex y folio cuelgan a UN nivel, así que la
// verificación se encola detrás del borrado del movimiento: pasa con o sin diferir. Queda como guarda.
test('borrar un INSUMO funciona aunque la cascada del folio dispare antes que la del kardex', async () => {
  await enOrdenDesfavorable(
    'RawMaterial',
    'InventoryWasteReport_rawMaterialId_fkey',
    'RawMaterialMovement_rawMaterialId_fkey',
    async tx => {
      const rawMaterial = await crearInsumo(tx)
      const report = await tx.inventoryWasteReport.create({
        data: aplicada({ itemType: 'RAW_MATERIAL', rawMaterialId: rawMaterial.id }, 'LITER'),
      })
      const movement = await crearMovimientoDeInsumo(rawMaterial.id, report.id, tx)

      await tx.rawMaterial.delete({ where: { id: rawMaterial.id } })

      expect(await tx.inventoryWasteReport.findUnique({ where: { id: report.id } })).toBeNull()
      expect(await tx.rawMaterialMovement.findUnique({ where: { id: movement.id } })).toBeNull()
    },
  )
})

// Ruling 27: la migración inicial crea las llaves movimiento → folio NOT VALID y los índices de
// "wasteReportId" van aparte, CONCURRENTLY. El estado FINAL tiene que ser el mismo de antes: las seis
// llaves validadas (las del kardex, además, diferidas) y los dos índices válidos. Si una migración de
// validación o de índice faltara o fallara en silencio, esto lo dice.
test('🔴 tras migrar: las seis llaves validadas, las del kardex diferidas, y los índices de wasteReportId válidos', async () => {
  const llaves = await prisma.$queryRaw<Array<{ conname: string; condeferrable: boolean; condeferred: boolean; convalidated: boolean }>>`
    SELECT conname::text AS conname, condeferrable, condeferred, convalidated
    FROM pg_constraint
    WHERE conname IN (
      'InventoryWasteReport_venueId_fkey', 'InventoryWasteReport_rawMaterialId_fkey',
      'InventoryWasteReport_productId_fkey', 'InventoryWasteReport_reportedByStaffId_fkey',
      'RawMaterialMovement_wasteReportId_fkey', 'InventoryMovement_wasteReportId_fkey'
    )
    ORDER BY conname
  `
  const inmediata = { condeferrable: false, condeferred: false, convalidated: true }
  const diferida = { condeferrable: true, condeferred: true, convalidated: true }
  expect(llaves).toEqual([
    { conname: 'InventoryMovement_wasteReportId_fkey', ...diferida },
    { conname: 'InventoryWasteReport_productId_fkey', ...inmediata },
    { conname: 'InventoryWasteReport_rawMaterialId_fkey', ...inmediata },
    { conname: 'InventoryWasteReport_reportedByStaffId_fkey', ...inmediata },
    { conname: 'InventoryWasteReport_venueId_fkey', ...inmediata },
    { conname: 'RawMaterialMovement_wasteReportId_fkey', ...diferida },
  ])

  const indices = await prisma.$queryRaw<Array<{ indice: string; indisvalid: boolean; indisready: boolean; definicion: string }>>`
    SELECT i.indexrelid::regclass::text AS indice, i.indisvalid, i.indisready, pg_get_indexdef(i.indexrelid) AS definicion
    FROM pg_index i
    WHERE i.indexrelid IN (to_regclass('"RawMaterialMovement_wasteReportId_idx"'), to_regclass('"InventoryMovement_wasteReportId_idx"'))
    ORDER BY 1
  `
  expect(indices).toEqual([
    {
      indice: '"InventoryMovement_wasteReportId_idx"',
      indisvalid: true,
      indisready: true,
      definicion: 'CREATE INDEX "InventoryMovement_wasteReportId_idx" ON public."InventoryMovement" USING btree ("wasteReportId")',
    },
    {
      indice: '"RawMaterialMovement_wasteReportId_idx"',
      indisvalid: true,
      indisready: true,
      definicion: 'CREATE INDEX "RawMaterialMovement_wasteReportId_idx" ON public."RawMaterialMovement" USING btree ("wasteReportId")',
    },
  ])
})

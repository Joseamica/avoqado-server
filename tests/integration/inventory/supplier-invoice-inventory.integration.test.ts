import { randomUUID } from 'node:crypto'
import prisma from '@/utils/prismaClient'
import { previewSupplierInvoiceInventory, confirmSupplierInvoiceInventory } from '@/services/dashboard/supplierInvoiceInventory.service'
import { approvePurchaseOrder } from '@/services/dashboard/purchaseOrderWorkflow.service'
import { updatePurchaseOrderItemStatus } from '@/services/dashboard/purchaseOrder.service'

// The existing disposable-DB launcher migrates and drops this database. Never run on av-db-25.
beforeAll(() => {
  const url = new URL(process.env.TEST_DATABASE_URL!)
  if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname) || !url.pathname.startsWith('/avoqado_h1a_test_')) {
    throw new Error('Use scripts/run-with-launch-campaigns-test-db.cjs for this suite.')
  }
})

async function seed(twoLines = false) {
  const suffix = randomUUID()
  const organization = await prisma.organization.create({ data: { name: 'XML QA', email: `${suffix}@avoqado.test`, phone: '5550000000' } })
  const venue = await prisma.venue.create({ data: { organizationId: organization.id, name: 'XML QA', slug: suffix } })
  const staff = await prisma.staff.create({ data: { email: `${suffix}-staff@avoqado.test`, firstName: 'XML', lastName: 'QA' } })
  const supplier = await prisma.supplier.create({ data: { venueId: venue.id, name: 'Proveedor', taxId: 'AAA010101AAA' } })
  const raws = []
  for (let n = 0; n < (twoLines ? 2 : 1); n++)
    raws.push(
      await prisma.rawMaterial.create({
        data: {
          venueId: venue.id,
          name: `Harina ${n}`,
          sku: `HARINA-${n}`,
          unit: 'GRAM',
          unitType: 'WEIGHT',
          currentStock: 0,
          minimumStock: 0,
          reorderPoint: 0,
          costPerUnit: 0,
          avgCostPerUnit: 0,
        },
      }),
    )
  const count = raws.length
  const invoice = await prisma.purchaseOrderInvoice.create({
    data: {
      venueId: venue.id,
      supplierId: supplier.id,
      uuid: suffix,
      emisorRfc: supplier.taxId!,
      emisorNombre: supplier.name,
      fechaEmision: new Date(),
      currency: 'MXN',
      cfdiType: 'I',
      subtotalCents: 100000 * count,
      descuentoCents: 10000 * count,
      ivaCents: 14400 * count,
      totalCents: 104400 * count,
      matchStatus: 'NO_ORDER',
      lines: {
        create: raws.map((raw, n) => ({
          id: `${suffix}-${n}`,
          rawMaterialId: raw.id,
          cantidad: 3,
          claveUnidad: 'KGM',
          purchaseUnit: 'KILOGRAM',
          supplierItemCode: `H-${n}`,
          descripcion: raw.name,
          valorUnitarioCents: 33333,
          importeCents: 100000,
          descuentoCents: 10000,
        })),
      },
    },
    include: { lines: { orderBy: { id: 'asc' } } },
  })
  return { venue, staff, supplier, raws, invoice }
}

async function prepare(f: Awaited<ReturnType<typeof seed>>) {
  const preview = await previewSupplierInvoiceInventory(f.venue.id, f.invoice.id)
  return confirmSupplierInvoiceInventory(f.venue.id, f.invoice.id, preview.confirmationToken, f.staff.id)
}

it('the existing item route cannot receive a prepared XML before approval', async () => {
  const f = await seed()
  const prepared = await prepare(f)
  const item = await prisma.purchaseOrderItem.findFirstOrThrow({ where: { purchaseOrderId: prepared.purchaseOrderId } })
  await expect(
    updatePurchaseOrderItemStatus(
      f.venue.id,
      prepared.purchaseOrderId,
      item.id,
      { receiveStatus: 'RECEIVED', quantityReceived: 3 },
      f.staff.id,
    ),
  ).rejects.toMatchObject({ statusCode: 409 })
  expect(await prisma.stockBatch.count({ where: { venueId: f.venue.id } })).toBe(0)
  expect(await prisma.rawMaterialMovement.count({ where: { venueId: f.venue.id } })).toBe(0)
  expect((await prisma.rawMaterial.findUniqueOrThrow({ where: { id: f.raws[0].id } })).currentStock.toString()).toBe('0')
  expect((await prisma.purchaseOrderItem.findUniqueOrThrow({ where: { id: item.id } })).quantityReceived.toString()).toBe('0')
})

it('concurrent legacy item receipts of an approved XML add stock exactly once', async () => {
  const f = await seed()
  const prepared = await prepare(f)
  await approvePurchaseOrder(f.venue.id, prepared.purchaseOrderId, f.staff.id)
  const item = await prisma.purchaseOrderItem.findFirstOrThrow({ where: { purchaseOrderId: prepared.purchaseOrderId } })
  await Promise.all(
    [1, 2].map(() =>
      updatePurchaseOrderItemStatus(
        f.venue.id,
        prepared.purchaseOrderId,
        item.id,
        { receiveStatus: 'RECEIVED', quantityReceived: 3 },
        f.staff.id,
      ),
    ),
  )
  expect((await prisma.rawMaterial.findUniqueOrThrow({ where: { id: f.raws[0].id } })).currentStock.toString()).toBe('3000')
  expect(await prisma.stockBatch.count({ where: { venueId: f.venue.id } })).toBe(1)
  expect(await prisma.rawMaterialMovement.count({ where: { venueId: f.venue.id } })).toBe(1)
})

it('migration + preparation + actual approval + concurrent receipt: one batch, one movement, net cost', async () => {
  const f = await seed()
  const initial = await previewSupplierInvoiceInventory(f.venue.id, f.invoice.id)
  const preparation = await Promise.allSettled([
    confirmSupplierInvoiceInventory(f.venue.id, f.invoice.id, initial.confirmationToken, f.staff.id),
    confirmSupplierInvoiceInventory(f.venue.id, f.invoice.id, initial.confirmationToken, f.staff.id),
  ])
  expect(preparation.filter(r => r.status === 'fulfilled')).toHaveLength(1)
  const order = await prisma.purchaseOrder.findFirstOrThrow({ where: { venueId: f.venue.id }, include: { items: true } })
  expect(order.status).toBe('PENDING_APPROVAL')
  expect(order.subtotal.toString()).toBe('900')
  expect(order.total.toString()).toBe('1044')
  expect(await prisma.stockBatch.count({ where: { venueId: f.venue.id } })).toBe(0)
  expect((await prisma.rawMaterial.findUniqueOrThrow({ where: { id: f.raws[0].id } })).currentStock.toString()).toBe('0')
  await approvePurchaseOrder(f.venue.id, order.id, f.staff.id)
  const review = await previewSupplierInvoiceInventory(f.venue.id, f.invoice.id)
  const results = await Promise.allSettled([
    confirmSupplierInvoiceInventory(f.venue.id, f.invoice.id, review.confirmationToken, f.staff.id),
    confirmSupplierInvoiceInventory(f.venue.id, f.invoice.id, review.confirmationToken, f.staff.id),
  ])
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
  const batches = await prisma.stockBatch.findMany({ where: { venueId: f.venue.id }, take: 10 })
  expect(batches).toHaveLength(1)
  expect(batches[0].initialQuantity.toString()).toBe('3000')
  expect(batches[0].costPerUnit.toString()).toBe('0.3')
  expect(await prisma.rawMaterialMovement.count({ where: { venueId: f.venue.id } })).toBe(1)
  const receipt = await prisma.purchaseOrderInvoice.findUniqueOrThrow({ where: { id: f.invoice.id } })
  expect(receipt.inventoryReceivedAt).not.toBeNull()
  expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: order.id } })).receivedBy).toBe(f.staff.id)
  // Calling the existing order path with the same quantity also cannot add stock twice.
  await updatePurchaseOrderItemStatus(
    f.venue.id,
    order.id,
    order.items[0].id,
    { receiveStatus: 'RECEIVED', quantityReceived: 3 },
    f.staff.id,
  )
  expect((await prisma.rawMaterial.findUniqueOrThrow({ where: { id: f.raws[0].id } })).currentStock.toString()).toBe('3000')
  expect(await prisma.stockBatch.count({ where: { venueId: f.venue.id } })).toBe(1)
})

it('a failure on the second item rolls back the first stock movement and both receipt stamps', async () => {
  const f = await seed(true)
  const order = await prepare(f)
  await approvePurchaseOrder(f.venue.id, order.purchaseOrderId, f.staff.id)
  await prisma.rawMaterial.update({ where: { id: f.raws[1].id }, data: { currentStock: '999999999.999' } })
  const review = await previewSupplierInvoiceInventory(f.venue.id, f.invoice.id)
  await expect(confirmSupplierInvoiceInventory(f.venue.id, f.invoice.id, review.confirmationToken, f.staff.id)).rejects.toThrow()
  expect(await prisma.stockBatch.count({ where: { venueId: f.venue.id } })).toBe(0)
  expect(await prisma.rawMaterialMovement.count({ where: { venueId: f.venue.id } })).toBe(0)
  expect((await prisma.rawMaterial.findUniqueOrThrow({ where: { id: f.raws[0].id } })).currentStock.toString()).toBe('0')
  expect((await prisma.purchaseOrderInvoice.findUniqueOrThrow({ where: { id: f.invoice.id } })).inventoryReceivedAt).toBeNull()
  expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: order.purchaseOrderId } })).status).toBe('APPROVED')
})

it('freezes the presentation factor at preparation and rejects an invoice from another venue', async () => {
  const f = await seed()
  await prisma.rawMaterialPresentation.create({
    data: { venueId: f.venue.id, rawMaterialId: f.raws[0].id, name: 'caja', factorToBase: 12000 },
  })
  await prisma.purchaseOrderInvoiceLine.update({
    where: { id: f.invoice.lines[0].id },
    data: { presentationName: 'caja', purchaseUnit: 'GRAM' },
  })
  const order = await prepare(f)
  await prisma.rawMaterialPresentation.updateMany({ where: { rawMaterialId: f.raws[0].id }, data: { factorToBase: 24000 } })
  await approvePurchaseOrder(f.venue.id, order.purchaseOrderId, f.staff.id)
  const review = await previewSupplierInvoiceInventory(f.venue.id, f.invoice.id)
  expect(review.lines[0].baseQuantity).toBe('36000')
  await expect(previewSupplierInvoiceInventory('another-venue', f.invoice.id)).rejects.toThrow(/no encontrada/i)
  await confirmSupplierInvoiceInventory(f.venue.id, f.invoice.id, review.confirmationToken, f.staff.id)
  expect((await prisma.rawMaterial.findUniqueOrThrow({ where: { id: f.raws[0].id } })).currentStock.toString()).toBe('36000')
  const code = await prisma.supplierItemCode.findFirstOrThrow({ where: { venueId: f.venue.id, code: 'H-0' } })
  expect(code.presentationName).toBe('caja')
})

it('receives resale products through Inventory, without creating raw-material FIFO batches', async () => {
  const f = await seed()
  const category = await prisma.menuCategory.create({ data: { venueId: f.venue.id, name: 'Tienda', slug: 'tienda' } })
  const product = await prisma.product.create({
    data: { venueId: f.venue.id, categoryId: category.id, name: 'Mercancía', sku: 'MERC', price: 350, unit: 'PIECE', trackInventory: true },
  })
  const inventory = await prisma.inventory.create({ data: { venueId: f.venue.id, productId: product.id, currentStock: 2 } })
  await prisma.purchaseOrderInvoiceLine.update({
    where: { id: f.invoice.lines[0].id },
    data: { rawMaterialId: null, productId: product.id, claveUnidad: 'H87', purchaseUnit: 'PIECE' },
  })
  const order = await prepare(f)
  await approvePurchaseOrder(f.venue.id, order.purchaseOrderId, f.staff.id)
  const review = await previewSupplierInvoiceInventory(f.venue.id, f.invoice.id)
  await confirmSupplierInvoiceInventory(f.venue.id, f.invoice.id, review.confirmationToken, f.staff.id)
  expect((await prisma.inventory.findUniqueOrThrow({ where: { id: inventory.id } })).currentStock.toString()).toBe('5')
  const movement = await prisma.inventoryMovement.findFirstOrThrow({ where: { inventoryId: inventory.id } })
  expect(movement.unitCost?.toString()).toBe('300')
  expect(movement.type).toBe('PURCHASE')
  expect(await prisma.stockBatch.count({ where: { venueId: f.venue.id } })).toBe(0)
})

it('credit note with positive quantities cannot create a purchase or stock', async () => {
  const f = await seed()
  await prisma.purchaseOrderInvoice.update({ where: { id: f.invoice.id }, data: { cfdiType: 'E' } })
  await expect(previewSupplierInvoiceInventory(f.venue.id, f.invoice.id)).rejects.toThrow(/tipo I/)
  await expect(confirmSupplierInvoiceInventory(f.venue.id, f.invoice.id, 'a'.repeat(64), f.staff.id)).rejects.toThrow(/tipo I/)
  expect(await prisma.purchaseOrder.count({ where: { venueId: f.venue.id } })).toBe(0)
  expect(await prisma.stockBatch.count({ where: { venueId: f.venue.id } })).toBe(0)
  expect((await prisma.purchaseOrderInvoice.findUniqueOrThrow({ where: { id: f.invoice.id } })).inventoryPreparedAt).toBeNull()
})

it('an approved order whose total changes after preview cannot receive stock from the XML', async () => {
  const f = await seed()
  const order = await prepare(f)
  await approvePurchaseOrder(f.venue.id, order.purchaseOrderId, f.staff.id)
  const review = await previewSupplierInvoiceInventory(f.venue.id, f.invoice.id)
  await prisma.purchaseOrder.update({ where: { id: order.purchaseOrderId }, data: { total: 1045 } })
  await expect(confirmSupplierInvoiceInventory(f.venue.id, f.invoice.id, review.confirmationToken, f.staff.id)).rejects.toThrow(
    /modificada/,
  )
  expect(await prisma.stockBatch.count({ where: { venueId: f.venue.id } })).toBe(0)
  expect(await prisma.rawMaterialMovement.count({ where: { venueId: f.venue.id } })).toBe(0)
  expect((await prisma.rawMaterial.findUniqueOrThrow({ where: { id: f.raws[0].id } })).currentStock.toString()).toBe('0')
  expect((await prisma.purchaseOrderInvoice.findUniqueOrThrow({ where: { id: f.invoice.id } })).inventoryReceivedAt).toBeNull()
  expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: order.purchaseOrderId } })).status).toBe('APPROVED')
})

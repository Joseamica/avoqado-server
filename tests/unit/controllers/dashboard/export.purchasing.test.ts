/**
 * Purchase-order and supplier exports.
 *
 * The purchase-order export ships ONE ROW PER LINE, not per order. A controller reconciling
 * against a supplier invoice audits the line — an order-level file hides exactly the thing
 * being checked. The order header repeats on every row so the file still groups cleanly in a
 * pivot table.
 *
 * The quiet failure worth a test is the article name. A purchase-order line points at a raw
 * material OR a resale product (XOR, enforced by a CHECK constraint). Reading only
 * `rawMaterial` leaves every convenience-store line anonymous, and the 18 PITS stores are
 * resale merchandise — the file would look complete with a blank column where the article goes.
 */
import type { Request, Response } from 'express'

const getPurchaseOrders = jest.fn()
const countPurchaseOrdersForExport = jest.fn()
jest.mock('@/services/dashboard/purchaseOrder.service', () => ({ getPurchaseOrders, countPurchaseOrdersForExport }))

const getSuppliers = jest.fn()
const countSuppliersForExport = jest.fn()
jest.mock('@/services/dashboard/supplier.service', () => ({ getSuppliers, countSuppliersForExport }))

// The controller also hosts the raw-material exports; nothing here calls them, but the module
// graph still loads the service. Stubbed so this suite never reaches Prisma.
jest.mock('@/services/dashboard/rawMaterial.service', () => ({}))

const encodeExport = jest.fn().mockResolvedValue({ body: Buffer.from(''), contentType: 'text/csv', extension: 'csv' })
const sendExport = jest.fn()
jest.mock('@/services/dashboard/export.helpers', () => ({
  ...jest.requireActual('@/services/dashboard/export.helpers'),
  encodeExport,
  sendExport,
}))

import { exportPurchaseOrders, exportSuppliers } from '@/controllers/dashboard/inventory/export.controller'
import { EXPORT_PDF_ROW_CAP } from '@/services/dashboard/export.helpers'

const res = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() }) as unknown as Response
const req = (query: Record<string, string> = {}) =>
  ({ params: { venueId: 'venue-1' }, query, authContext: { venueId: 'venue-1', userId: 'staff-1' } }) as unknown as Request

beforeEach(() => {
  jest.clearAllMocks()

  countPurchaseOrdersForExport.mockResolvedValue(2)
  getPurchaseOrders.mockResolvedValue([
    {
      id: 'po-1',
      orderNumber: 'OC-001',
      status: 'RECEIVED',
      orderDate: new Date('2026-08-01T10:00:00.000Z'),
      total: 1000,
      supplier: { name: 'Distribuidora del Bajío' },
      items: [
        {
          id: 'i1',
          rawMaterial: { name: 'Harina', sku: 'H-01' },
          product: null,
          quantityOrdered: 10,
          quantityReceived: 10,
          unit: 'KILOGRAM',
          unitPrice: 20,
          total: 200,
          receiveStatus: 'RECEIVED',
        },
        {
          id: 'i2',
          rawMaterial: null,
          product: { name: 'Refresco 600ml', sku: 'R-600' },
          quantityOrdered: 24,
          quantityReceived: 0,
          unit: 'PIECE',
          unitPrice: 12,
          total: 288,
          receiveStatus: 'PENDING',
        },
      ],
    },
  ])

  countSuppliersForExport.mockResolvedValue(1)
  getSuppliers.mockResolvedValue([
    {
      id: 'sup-1',
      name: 'Distribuidora del Bajío',
      contactName: 'Rosa Pérez',
      email: 'rosa@bajio.mx',
      phone: '4421234567',
      taxId: 'DBA010101AAA',
      leadTimeDays: 3,
      minimumOrder: 1500,
      rating: 4.5,
      active: true,
    },
  ])
})

describe('exportPurchaseOrders', () => {
  it('🔴 one row per LINE, not per order', async () => {
    // A buyer reconciling against an invoice needs the line. An order-level export hides the
    // one thing being audited.
    getPurchaseOrders.mockResolvedValue([
      { id: 'po-1', orderNumber: 'OC-001', status: 'RECEIVED', total: 1000, items: [{ id: 'i1' }, { id: 'i2' }] },
    ])

    await exportPurchaseOrders(req(), res(), jest.fn())

    expect(encodeExport.mock.calls[0][1].rows).toHaveLength(2)
  })

  it('repeats the order header on every line so the file groups cleanly', async () => {
    await exportPurchaseOrders(req(), res(), jest.fn())

    const rows = encodeExport.mock.calls[0][1].rows
    expect(rows[0].orderNumber).toBe('OC-001')
    expect(rows[1].orderNumber).toBe('OC-001')
    expect(rows[0].supplierName).toBe('Distribuidora del Bajío')
    expect(rows[1].supplierName).toBe('Distribuidora del Bajío')
  })

  it('🔴 names the article for BOTH kinds of line', async () => {
    // A purchase-order line is either a raw material or a resale product (XOR). Reading only
    // `rawMaterial` leaves every convenience-store line anonymous — and the 18 stores are
    // resale merchandise.
    await exportPurchaseOrders(req(), res(), jest.fn())

    const col = encodeExport.mock.calls[0][1].allColumns.find((c: { id: string }) => c.id === 'article')
    expect(col.value({ rawMaterial: { name: 'Harina' }, product: null })).toBe('Harina')
    expect(col.value({ rawMaterial: null, product: { name: 'Refresco 600ml' } })).toBe('Refresco 600ml')
  })

  it('🔴 takes the SKU from whichever side of the XOR the line points at', async () => {
    // Same defect as the name, one column over: a resale line with a blank SKU is unmatchable
    // against the supplier's invoice, which is the whole reason the file exists.
    await exportPurchaseOrders(req(), res(), jest.fn())

    const col = encodeExport.mock.calls[0][1].allColumns.find((c: { id: string }) => c.id === 'sku')
    expect(col.value({ rawMaterial: { sku: 'H-01' }, product: null })).toBe('H-01')
    expect(col.value({ rawMaterial: null, product: { sku: 'R-600' } })).toBe('R-600')
  })

  it('🔴 refuses over the cap instead of truncating', async () => {
    // A file with the first N rows reads as complete. Refusing is the honest answer.
    countPurchaseOrdersForExport.mockResolvedValue(999_999)
    const r = res()

    await exportPurchaseOrders(req(), r, jest.fn())

    expect(r.status).toHaveBeenCalledWith(413)
    expect(encodeExport).not.toHaveBeenCalled()
  })

  it('TENANT: only ever asks for the venue in the auth context', async () => {
    await exportPurchaseOrders(req(), res(), jest.fn())

    expect(countPurchaseOrdersForExport).toHaveBeenCalledWith('venue-1', expect.anything())
    expect(getPurchaseOrders).toHaveBeenCalledWith('venue-1', expect.anything())
  })

  it('exports the SAME filters the screen is showing', async () => {
    // The listing screen sends `status` as a repeated query param; parsing it differently here
    // produces a plausible file for a different set of orders.
    await exportPurchaseOrders(req({ supplierId: 'sup-1', status: 'RECEIVED' }), res(), jest.fn())

    expect(getPurchaseOrders).toHaveBeenCalledWith('venue-1', expect.objectContaining({ supplierId: 'sup-1', status: ['RECEIVED'] }))
  })

  it('reports the order status in Spanish, not the enum', async () => {
    await exportPurchaseOrders(req(), res(), jest.fn())

    const col = encodeExport.mock.calls[0][1].allColumns.find((c: { id: string }) => c.id === 'status')
    expect(col.value({ status: 'PARTIAL' })).toBe('Recibida parcial')
    expect(col.value({ status: 'SOMETHING_NEW' })).toBe('SOMETHING_NEW')
  })

  it('names the file for what it is', async () => {
    await exportPurchaseOrders(req(), res(), jest.fn())

    expect(sendExport).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'ordenes-de-compra')
  })
})

describe('exportSuppliers', () => {
  it('ships the columns a buyer needs, labelled in Spanish', async () => {
    await exportSuppliers(req(), res(), jest.fn())

    const columns = encodeExport.mock.calls[0][1].allColumns.map((c: { id: string }) => c.id)
    expect(columns).toEqual(
      expect.arrayContaining(['name', 'contactName', 'email', 'phone', 'taxId', 'leadTimeDays', 'minimumOrder', 'rating', 'active']),
    )
    const labels = encodeExport.mock.calls[0][1].allColumns.map((c: { label: string }) => c.label)
    expect(labels).toContain('RFC')
  })

  it('🔴 counts BEFORE fetching, and refuses over the cap instead of truncating', async () => {
    // `getSuppliers` is unpaginated and drags each supplier's pricing rows and five latest
    // purchase orders with it. Deciding after the fetch pulls the whole directory into memory
    // in exactly the case we mean to refuse.
    countSuppliersForExport.mockResolvedValue(EXPORT_PDF_ROW_CAP + 1)
    const r = res()

    await exportSuppliers(req({ format: 'pdf' }), r, jest.fn())

    expect(r.status).toHaveBeenCalledWith(413)
    expect(getSuppliers).not.toHaveBeenCalled()
    expect(encodeExport).not.toHaveBeenCalled()
  })

  it('🔴 still refuses when the fetched rows exceed the cap the count did not see', async () => {
    // The count is a pre-flight, not the guarantee. Whatever it said, the file itself never
    // goes past the cap — a truncated sheet reads as complete.
    countSuppliersForExport.mockResolvedValue(1)
    getSuppliers.mockResolvedValue(Array.from({ length: EXPORT_PDF_ROW_CAP + 1 }, (_, i) => ({ id: `sup-${i}`, name: `Proveedor ${i}` })))
    const r = res()

    await exportSuppliers(req({ format: 'pdf' }), r, jest.fn())

    expect(r.status).toHaveBeenCalledWith(413)
    expect(encodeExport).not.toHaveBeenCalled()
  })

  it('TENANT: only ever asks for the venue in the auth context', async () => {
    await exportSuppliers(req(), res(), jest.fn())

    expect(countSuppliersForExport).toHaveBeenCalledWith('venue-1', expect.anything())
    expect(getSuppliers).toHaveBeenCalledWith('venue-1', expect.anything())
  })

  it('exports the SAME filters the screen is showing', async () => {
    await exportSuppliers(req({ search: 'bajío', active: 'true' }), res(), jest.fn())

    expect(getSuppliers).toHaveBeenCalledWith('venue-1', expect.objectContaining({ search: 'bajío', active: true }))
  })

  it('names the file for what it is', async () => {
    await exportSuppliers(req(), res(), jest.fn())

    expect(sendExport).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'proveedores')
  })
})

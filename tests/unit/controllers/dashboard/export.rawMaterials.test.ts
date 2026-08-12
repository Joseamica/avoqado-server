/**
 * Raw-material stock export.
 *
 * The matrix answers "exportable" for inventory and it was not: the generic export helper
 * existed and was wired to exactly three listings (payments, orders, sales summary).
 *
 * The two failure modes worth a test are the quiet ones — exporting a different row set than
 * the screen is showing, and truncating instead of refusing. Both produce a file that looks
 * complete and is not.
 */
import type { Request, Response } from 'express'

const getRawMaterials = jest.fn()
const countRawMaterialsForExport = jest.fn()
jest.mock('@/services/dashboard/rawMaterial.service', () => ({ getRawMaterials, countRawMaterialsForExport }))

const encodeExport = jest.fn().mockResolvedValue({ body: Buffer.from(''), contentType: 'text/csv', extension: 'csv' })
const sendExport = jest.fn()
jest.mock('@/services/dashboard/export.helpers', () => ({
  ...jest.requireActual('@/services/dashboard/export.helpers'),
  encodeExport,
  sendExport,
}))

import { exportRawMaterials } from '@/controllers/dashboard/inventory/export.controller'
import { EXPORT_ROW_CAP } from '@/services/dashboard/export.helpers'

const res = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() }) as unknown as Response
const req = (query: Record<string, string> = {}) =>
  ({ params: { venueId: 'venue-1' }, query, authContext: { venueId: 'venue-1', userId: 'staff-1' } }) as unknown as Request

beforeEach(() => {
  jest.clearAllMocks()
  countRawMaterialsForExport.mockResolvedValue(3)
  getRawMaterials.mockResolvedValue([
    {
      id: 'rm-1',
      name: 'Harina',
      sku: 'H-01',
      category: 'FOOD',
      unit: 'GRAM',
      currentStock: 1000,
      reorderPoint: 200,
      costPerUnit: 0.01,
      active: true,
    },
  ])
})

describe('exportRawMaterials', () => {
  it('🔴 exports the SAME filters the screen is showing', async () => {
    // Exporting "everything" while the user looks at a filtered view is found late and badly:
    // the file is plausible, just wrong.
    await exportRawMaterials(req({ search: 'harina', category: 'FOOD', active: 'true' }), res(), jest.fn())

    expect(getRawMaterials).toHaveBeenCalledWith('venue-1', expect.objectContaining({ search: 'harina', category: 'FOOD', active: true }))
  })

  it('🔴 refuses over the cap instead of truncating', async () => {
    // A file with the first N rows reads as complete. Refusing is the honest answer.
    countRawMaterialsForExport.mockResolvedValue(999_999)
    const r = res()

    await exportRawMaterials(req(), r, jest.fn())

    expect(r.status).toHaveBeenCalledWith(413)
    expect(encodeExport).not.toHaveBeenCalled()
  })

  it('🔴 does NOT refuse a low-stock export because the pre-count is an upper bound', async () => {
    // `lowStock` compares two columns of the same row, so the listing applies it in memory and
    // the count cannot see it. Refusing on that number 413s a fifty-row file and the user has
    // no filter left to narrow — the answer is to decide on the rows that actually ship.
    countRawMaterialsForExport.mockResolvedValue(999_999)
    getRawMaterials.mockResolvedValue([{ id: 'rm-1', name: 'Harina', currentStock: 1, reorderPoint: 200 }])
    const r = res()

    await exportRawMaterials(req({ lowStock: 'true' }), r, jest.fn())

    expect(r.status).not.toHaveBeenCalledWith(413)
    expect(encodeExport).toHaveBeenCalled()
  })

  it('🔴 still refuses a low-stock export when the ROWS themselves exceed the cap', async () => {
    // The count being an upper bound removes the pre-flight, not the guarantee.
    countRawMaterialsForExport.mockResolvedValue(999_999)
    getRawMaterials.mockResolvedValue(Array.from({ length: EXPORT_ROW_CAP + 1 }, (_, i) => ({ id: `rm-${i}`, name: `Insumo ${i}` })))
    const r = res()

    await exportRawMaterials(req({ lowStock: 'true' }), r, jest.fn())

    expect(r.status).toHaveBeenCalledWith(413)
    expect(encodeExport).not.toHaveBeenCalled()
  })

  it('TENANT: only ever asks for the venue in the auth context', async () => {
    await exportRawMaterials(req(), res(), jest.fn())
    expect(getRawMaterials).toHaveBeenCalledWith('venue-1', expect.anything())
  })

  it('ships the columns a stock take needs, labelled in Spanish', async () => {
    await exportRawMaterials(req(), res(), jest.fn())

    const columns = encodeExport.mock.calls[0][1].allColumns.map((c: { id: string }) => c.id)
    expect(columns).toEqual(
      expect.arrayContaining(['name', 'sku', 'category', 'unit', 'currentStock', 'reorderPoint', 'costPerUnit', 'stockValue']),
    )
    const labels = encodeExport.mock.calls[0][1].allColumns.map((c: { label: string }) => c.label)
    expect(labels).toContain('Existencia')
  })

  it('computes stock value rather than making the reader do it', async () => {
    await exportRawMaterials(req(), res(), jest.fn())

    const col = encodeExport.mock.calls[0][1].allColumns.find((c: { id: string }) => c.id === 'stockValue')
    expect(col.value({ currentStock: 1000, costPerUnit: 0.01 })).toBe(10)
  })
})

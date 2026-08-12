/**
 * Raw-material movement (kardex) export.
 *
 * A kardex is read for two reasons and both are anti-fraud: WHO moved stock and WHY. An export
 * that ships bare numbers is a list nobody can act on.
 *
 * The other failure mode is quieter. The listing service behind the screen defaults to `take: 100`
 * — an export that inherits that default hands over the first 100 movements of a year and reads
 * as the whole year. Counting first and refusing over the cap is the honest answer; silently
 * stopping at 100 is not.
 */
import type { Request, Response } from 'express'

const countStockMovementsForExport = jest.fn()
const fetchStockMovementsForExport = jest.fn()
jest.mock('@/services/dashboard/rawMaterial.service', () => ({ countStockMovementsForExport, fetchStockMovementsForExport }))

const encodeExport = jest.fn().mockResolvedValue({ body: Buffer.from(''), contentType: 'text/csv', extension: 'csv' })
const sendExport = jest.fn()
jest.mock('@/services/dashboard/export.helpers', () => ({
  ...jest.requireActual('@/services/dashboard/export.helpers'),
  encodeExport,
  sendExport,
}))

import { exportStockMovements } from '@/controllers/dashboard/inventory/export.controller'
import { EXPORT_ROW_CAP } from '@/services/dashboard/export.helpers'

const res = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() }) as unknown as Response
const req = (query: Record<string, string> = {}) =>
  ({
    params: { venueId: 'venue-1', rawMaterialId: 'rm-1' },
    query,
    authContext: { venueId: 'venue-1', userId: 'staff-1' },
  }) as unknown as Request

beforeEach(() => {
  jest.clearAllMocks()
  countStockMovementsForExport.mockResolvedValue(3)
  fetchStockMovementsForExport.mockResolvedValue([
    {
      id: 'mv-1',
      createdAt: new Date('2026-08-01T10:00:00.000Z'),
      rawMaterialName: 'Harina',
      type: 'ADJUSTMENT',
      quantity: -5,
      unit: 'KILOGRAM',
      previousStock: 100,
      newStock: 95,
      costImpact: -50,
      reason: 'Humedad en bodega',
      reference: null,
      staffName: 'Rosa Pérez',
    },
  ])
})

describe('exportStockMovements', () => {
  it('🔴 the movement columns answer WHO moved stock and WHY', async () => {
    // A kardex without the actor and the reason is a list of numbers. The reason this report
    // exists is anti-fraud: someone adjusted stock and the owner wants to know who.
    await exportStockMovements(req(), res(), jest.fn())

    const columns = encodeExport.mock.calls[0][1].allColumns.map((c: { id: string }) => c.id)
    expect(columns).toEqual(
      expect.arrayContaining(['createdAt', 'rawMaterialName', 'type', 'quantity', 'previousStock', 'newStock', 'reason', 'staffName']),
    )
  })

  it('🔴 refuses over the cap instead of truncating', async () => {
    // A file with the first N rows reads as complete. Refusing is the honest answer.
    countStockMovementsForExport.mockResolvedValue(999_999)
    const r = res()

    await exportStockMovements(req(), r, jest.fn())

    expect(r.status).toHaveBeenCalledWith(413)
    expect(encodeExport).not.toHaveBeenCalled()
  })

  it('🔴 asks the listing for up to the cap, never its default page size', async () => {
    // `getStockMovements` defaults to `take: 100`. Inheriting that default is the same bug as
    // truncating, except nobody even gets the 413 that would have told them.
    await exportStockMovements(req(), res(), jest.fn())

    expect(fetchStockMovementsForExport).toHaveBeenCalledWith('venue-1', 'rm-1', expect.anything(), EXPORT_ROW_CAP)
  })

  it('TENANT: only ever asks for the venue in the auth context', async () => {
    await exportStockMovements(req(), res(), jest.fn())

    expect(countStockMovementsForExport).toHaveBeenCalledWith('venue-1', 'rm-1', expect.anything())
    expect(fetchStockMovementsForExport).toHaveBeenCalledWith('venue-1', 'rm-1', expect.anything(), expect.any(Number))
  })

  it('exports the SAME date range the screen is showing', async () => {
    // Exporting a wider range than the dialog is displaying produces a plausible, wrong file.
    await exportStockMovements(req({ startDate: '2026-08-01T00:00:00.000Z', endDate: '2026-08-07T23:59:59.999Z' }), res(), jest.fn())

    expect(fetchStockMovementsForExport).toHaveBeenCalledWith(
      'venue-1',
      'rm-1',
      expect.objectContaining({
        startDate: new Date('2026-08-01T00:00:00.000Z'),
        endDate: new Date('2026-08-07T23:59:59.999Z'),
      }),
      expect.any(Number),
    )
  })

  it('reports the movement type in Spanish, not the enum', async () => {
    // "SPOILAGE" in a column an owner reads is a leak of our schema into their report.
    await exportStockMovements(req(), res(), jest.fn())

    const col = encodeExport.mock.calls[0][1].allColumns.find((c: { id: string }) => c.id === 'type')
    expect(col.value({ type: 'SPOILAGE' })).toBe('Merma')
    expect(col.value({ type: 'PURCHASE' })).toBe('Compra')
  })

  it('falls back to the raw type rather than a blank cell when the enum grows', async () => {
    // A new movement type shipping as an empty column is worse than an untranslated one: the
    // row loses its meaning instead of just its polish.
    await exportStockMovements(req(), res(), jest.fn())

    const col = encodeExport.mock.calls[0][1].allColumns.find((c: { id: string }) => c.id === 'type')
    expect(col.value({ type: 'SOMETHING_NEW' })).toBe('SOMETHING_NEW')
  })

  it('names the file for what it is', async () => {
    await exportStockMovements(req(), res(), jest.fn())

    expect(sendExport).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'kardex')
  })
})

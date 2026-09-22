/**
 * Export del kardex de un insumo — los campos de merma (Codex P3-2, spec §4.6).
 *
 * El comportamiento contra Postgres (reconstruir 5 = 3 + 2) lo fija
 * tests/integration/inventory/dashboard-waste-adapter.integration.test.ts. Aquí, lo que la
 * integración no ve: la carga. Los folios se leen en UNA consulta acotada por los ids de ESTA
 * página (sin N+1, regla bounded-queries), dentro del venue, y un kardex sin merma no paga nada.
 */
import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import { fetchStockMovementsForExport } from '@/services/dashboard/rawMaterial.service'

const D = (value: Prisma.Decimal.Value) => new Prisma.Decimal(value)

const movement = (id: string, wasteReportId: string | null) => ({
  id,
  venueId: 'venue-1',
  rawMaterialId: 'rm-1',
  batchId: null,
  type: wasteReportId ? 'SPOILAGE' : 'ADJUSTMENT',
  quantity: D(-1),
  unit: 'PIECE',
  previousStock: D(5),
  newStock: D(4),
  costImpact: null,
  reason: 'Prueba',
  reference: null,
  createdBy: null,
  wasteReportId,
  createdAt: new Date('2026-09-01T12:00:00.000Z'),
})

beforeEach(() => {
  prismaMock.rawMaterial.findFirst.mockResolvedValue({ name: 'Leche' } as never)
  prismaMock.inventoryWasteReport.findMany.mockResolvedValue([
    { id: 'wr-1', reasonCode: 'SPOILED', unrecordedQuantity: D(2), rawMovements: [{ id: 'mv-a' }] },
    { id: 'wr-2', reasonCode: 'EXPIRED', unrecordedQuantity: D(0), rawMovements: [{ id: 'mv-c' }] },
  ] as never)
})

describe('fetchStockMovementsForExport — merma', () => {
  it('🔴 lee los folios de la página en UNA consulta acotada por sus ids y el venue', async () => {
    prismaMock.rawMaterialMovement.findMany.mockResolvedValue([
      movement('mv-b', 'wr-1'),
      movement('mv-a', 'wr-1'),
      movement('mv-c', 'wr-2'),
      movement('mv-d', null),
    ] as never)

    await fetchStockMovementsForExport('venue-1', 'rm-1', undefined, 5000)

    expect(prismaMock.inventoryWasteReport.findMany).toHaveBeenCalledTimes(1)
    const args = prismaMock.inventoryWasteReport.findMany.mock.calls[0][0] as {
      where: { venueId: string; id: { in: string[] } }
      take: number
    }
    expect(args.where.venueId).toBe('venue-1')
    expect([...args.where.id.in].sort()).toEqual(['wr-1', 'wr-2'])
    // Tope explícito: no más filas que folios distintos en la página.
    expect(args.take).toBe(2)
  })

  it('el excedente va sólo en el ancla del folio; motivo y folio en todos sus renglones; vacío fuera de la merma', async () => {
    prismaMock.rawMaterialMovement.findMany.mockResolvedValue([
      movement('mv-b', 'wr-1'),
      movement('mv-a', 'wr-1'),
      movement('mv-d', null),
    ] as never)

    const rows = await fetchStockMovementsForExport('venue-1', 'rm-1', undefined, 5000)

    expect(rows.map(row => [row.id, row.wasteReportId, row.wasteReasonCode, row.wasteUnrecorded])).toEqual([
      ['mv-b', 'wr-1', 'SPOILED', null],
      ['mv-a', 'wr-1', 'SPOILED', 2],
      ['mv-d', null, null, null],
    ])
  })

  it('un kardex sin merma no consulta folios', async () => {
    prismaMock.rawMaterialMovement.findMany.mockResolvedValue([movement('mv-d', null)] as never)

    const rows = await fetchStockMovementsForExport('venue-1', 'rm-1', undefined, 5000)

    expect(prismaMock.inventoryWasteReport.findMany).not.toHaveBeenCalled()
    expect(rows[0]).toMatchObject({ wasteReportId: null, wasteReasonCode: null, wasteUnrecorded: null })
  })
})

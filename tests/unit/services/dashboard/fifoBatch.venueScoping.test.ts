/**
 * Regression tests — aislamiento multi-tenant en deductStockFIFO.
 *
 * Bug (auditoría FIFO 2026-06-11): deductStockFIFO recibía venueId pero NO lo
 * usaba: el lock SQL filtraba solo por rawMaterialId y el RawMaterial se leía
 * con findUnique({id}) sin verificar venue. Cualquier caller interno con un
 * rawMaterialId ajeno podía deducir stock de OTRO venue (defensa en
 * profundidad: el scoping HTTP lo mitigaba, pero la función debe ser segura
 * por sí misma).
 */

import prisma from '@/utils/prismaClient'
import { deductStockFIFO } from '@/services/dashboard/fifoBatch.service'
import AppError from '@/errors/AppError'
import { Decimal } from '@prisma/client/runtime/library'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    rawMaterial: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
    stockBatch: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
    rawMaterialMovement: { create: jest.fn() },
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
  },
}))

jest.mock('@/services/dashboard/activity-log.service', () => ({
  logAction: jest.fn(),
}))

const VENUE_ID = 'venue-A'
const RM_ID = 'rm-1'

const rawMaterialVenueA = {
  id: RM_ID,
  venueId: VENUE_ID,
  name: 'Carne',
  unit: 'GRAM',
  currentStock: new Decimal(1000),
}

const lockedBatches = [
  {
    id: 'batch-1',
    remainingQuantity: new Decimal(500),
    costPerUnit: new Decimal(0.01),
    receivedDate: new Date('2026-06-01'),
    batchNumber: 'B001',
    unit: 'GRAM',
  },
]

function wireTx({ rawMaterialInVenue }: { rawMaterialInVenue: boolean }) {
  const txQueryRaw = jest.fn().mockResolvedValue(lockedBatches)
  ;(prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) =>
    cb({
      $queryRaw: txQueryRaw,
      stockBatch: { update: jest.fn().mockResolvedValue({}) },
      rawMaterialMovement: { create: jest.fn().mockResolvedValue({}) },
      rawMaterial: {
        // Path viejo (sin scoping): findUnique encuentra el RM aunque sea de otro venue
        findUnique: jest.fn().mockResolvedValue(rawMaterialVenueA),
        // Path nuevo (con scoping): findFirst respeta el venue
        findFirst: jest.fn().mockResolvedValue(rawMaterialInVenue ? rawMaterialVenueA : null),
        update: jest.fn().mockResolvedValue({}),
      },
    }),
  )
  return { txQueryRaw }
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe('deductStockFIFO — scoping por venue', () => {
  it('rechaza la deducción cuando el rawMaterial NO pertenece al venue', async () => {
    wireTx({ rawMaterialInVenue: false })

    await expect(deductStockFIFO('venue-B', RM_ID, 100, 'USAGE', { reason: 'cross-tenant', reference: 'x' })).rejects.toThrow(AppError)
  })

  it('el lock SQL de lotes incluye el venueId como filtro', async () => {
    const { txQueryRaw } = wireTx({ rawMaterialInVenue: true })

    await deductStockFIFO(VENUE_ID, RM_ID, 100, 'USAGE', { reason: 'ok', reference: 'y' })

    expect(txQueryRaw).toHaveBeenCalled()
    const [, ...values] = txQueryRaw.mock.calls[0]
    expect(values).toContain(RM_ID)
    expect(values).toContain(VENUE_ID)
  })
})

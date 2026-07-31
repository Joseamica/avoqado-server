/**
 * deductStockFIFO — reintento de conflictos transitorios de concurrencia.
 *
 * Bug real (Mindform, 17-18 jul 2026): un cajero tocó "Cobrar" 3 veces en 8
 * segundos. Cada toque generó un pago con idempotencyKey distinta, así que los
 * tres corrieron su propia pasada de deducción de inventario sobre los MISMOS
 * insumos. Postgres abortó las colisiones con
 *   "Transaction failed due to a write conflict or a deadlock. Please retry your transaction"  (P2034)
 * y el clasificador de payment.tpv.service las metió en 'UNKNOWN', que tumba la
 * orden. Resultado: venta cancelada por un tropiezo de milisegundos.
 *
 * El docstring de deductStockFIFO YA decía "Client can retry after short delay"
 * desde el día uno — nunca se implementó.
 *
 * 🔴 LA INVARIANTE QUE ESTOS TESTS PROTEGEN: el reintento envuelve la
 * TRANSACCIÓN COMPLETA, nunca una operación suelta. La receta de un producto
 * (~10 insumos) NO es atómica entre insumos, así que reintentar a nivel
 * producto descontaría doble los insumos que ya pasaron. Un insumo solo SÍ es
 * atómico (Serializable + FOR UPDATE NOWAIT), y por eso este es el único nivel
 * donde reintentar es seguro. Si alguien mueve el retry hacia arriba
 * (deductStockForRecipe / deductInventoryForProduct), rompe esto en silencio.
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
const RM_ID = 'rm-pera'

const prismaMock = prisma as unknown as {
  $transaction: jest.Mock
}

/** Error con la forma real que Prisma emite en un deadlock / write conflict. */
function p2034(): Error {
  return Object.assign(new Error('Transaction failed due to a write conflict or a deadlock. Please retry your transaction'), {
    code: 'P2034',
  })
}

/** 55P03 = lock_not_available, lo que lanza FOR UPDATE NOWAIT. */
function lockNotAvailable(): Error {
  return Object.assign(new Error('could not obtain lock on row in relation "StockBatch"'), { code: '55P03' })
}

const movimientosOk = [{ id: 'mov-1', quantity: new Decimal(-0.33) }]

function deducir() {
  return deductStockFIFO(VENUE_ID, RM_ID, 0.33, 'USAGE' as any, { reason: 'venta', reference: 'order-1' })
}

beforeEach(() => {
  // resetAllMocks (no clearAllMocks): clearAllMocks NO borra las
  // implementaciones de mockResolvedValue/mockRejectedValue, así que se
  // filtraban de un caso al siguiente y un test pasaba por la razón equivocada.
  jest.resetAllMocks()
})

describe('deductStockFIFO — conflictos transitorios', () => {
  // ─── LO NUEVO ───────────────────────────────────────────────────────────

  it('reintenta un write conflict (P2034) y completa la deducción', async () => {
    prismaMock.$transaction.mockRejectedValueOnce(p2034()).mockResolvedValueOnce(movimientosOk)

    await expect(deducir()).resolves.toEqual(movimientosOk)
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(2)
  })

  it('reintenta 55P03 (lock no disponible por FOR UPDATE NOWAIT)', async () => {
    prismaMock.$transaction.mockRejectedValueOnce(lockNotAvailable()).mockResolvedValueOnce(movimientosOk)

    await expect(deducir()).resolves.toEqual(movimientosOk)
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(2)
  })

  it('reintenta la TRANSACCIÓN COMPLETA, con aislamiento Serializable en cada intento', async () => {
    prismaMock.$transaction.mockRejectedValueOnce(p2034()).mockResolvedValueOnce(movimientosOk)

    await deducir()

    // Cada intento re-ejecuta el $transaction entero — es lo que garantiza que
    // Postgres deshizo cualquier trabajo parcial antes del reintento.
    for (const llamada of prismaMock.$transaction.mock.calls) {
      expect(typeof llamada[0]).toBe('function')
      expect(llamada[1]).toMatchObject({ isolationLevel: 'Serializable' })
    }
  })

  it('se rinde con un número ACOTADO de intentos (sin bucle infinito ni demora abierta)', async () => {
    prismaMock.$transaction.mockRejectedValue(p2034())

    await expect(deducir()).rejects.toThrow()
    // Acotado: la ruta de cobro no puede quedarse reintentando para siempre.
    expect(prismaMock.$transaction.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(prismaMock.$transaction.mock.calls.length).toBeLessThanOrEqual(4)
  })

  // ─── 🔴 LO QUE NO DEBE CAMBIAR (el riesgo real del cambio) ──────────────

  it('NO reintenta falta de stock REAL — el candado de inventario sigue firme', async () => {
    // Este es el caso de los chais de mayo: la pera de verdad no alcanzaba.
    // Si esto se volviera reintentable, dejaríamos pasar ventas sin insumos.
    prismaMock.$transaction.mockRejectedValue(new AppError('Insufficient stock. Needed: 0.33, Available: 0.01', 400))

    await expect(deducir()).rejects.toThrow('Insufficient stock')
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
  })

  it('NO reintenta un insumo inexistente / de otro venue (error de negocio)', async () => {
    prismaMock.$transaction.mockRejectedValue(new AppError('Raw material not found', 404))

    await expect(deducir()).rejects.toThrow('Raw material not found')
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
  })

  it('NO reintenta "sin lotes activos"', async () => {
    prismaMock.$transaction.mockRejectedValue(new AppError(`No active batches available for raw material ${RM_ID}`, 400))

    await expect(deducir()).rejects.toThrow('No active batches')
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
  })

  it('sigue funcionando el camino feliz sin reintentos', async () => {
    prismaMock.$transaction.mockResolvedValue(movimientosOk)

    await expect(deducir()).resolves.toEqual(movimientosOk)
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
  })
})

/**
 * adaptDashboardWaste — lo que la integración contra Postgres no puede forzar barato.
 *
 * El comportamiento real (folio, descuento, costo, idempotencia) lo cubre
 * tests/integration/inventory/dashboard-waste-adapter.integration.test.ts. Aquí sólo:
 *  - el adaptador ya NO evalúa la alerta de existencia baja: la evalúa `logWaste` después del COMMIT,
 *    igual para POS, dashboard y MCP (Opus I1; lo fija inventory-waste.integration.test.ts);
 *  - el adaptador no es un segundo candado de permiso (Rulings 18 y 20);
 *  - el artículo que responde la ruta se lee DENTRO de la transacción de `logWaste`, después de los
 *    efectos y antes del COMMIT (Codex P2-2): ningún fallo posterior al COMMIT puede devolver error
 *    con la merma ya aplicada (el dashboard de hoy reintentaría sin folio y descontaría otra vez).
 */
import { prismaMock } from '../../../__helpers__/setup'

const logWaste = jest.fn()
const requireWastePermission = jest.fn()
const requireWasteActivation = jest.fn()
jest.mock('@/services/shared/inventoryWaste.service', () => ({
  ...jest.requireActual('@/services/shared/inventoryWaste.service'),
  logWaste: (...a: unknown[]) => logWaste(...a),
  requireWastePermission: (...a: unknown[]) => requireWastePermission(...a),
  requireWasteActivation: (...a: unknown[]) => requireWasteActivation(...a),
}))
const checkAndCreateLowStockAlert = jest.fn()
jest.mock('@/services/dashboard/rawMaterial.service', () => ({
  checkAndCreateLowStockAlert: (...a: unknown[]) => checkAndCreateLowStockAlert(...a),
}))

import { adaptDashboardWaste, canRecordDashboardWaste } from '@/services/shared/dashboardWasteAdapter'

const RESUMEN = { reportId: 'clwastereport00000000001', declared: '3', deducted: '3', unrecorded: '0' }
const INSUMO = { id: 'rm-1', venueId: 'venue-1', name: 'Aguacate', currentStock: '7' }
const INVENTARIO = { id: 'inv-1', venueId: 'venue-1', productId: 'p-1', currentStock: '7' }

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.inventoryWasteReport.findUnique.mockResolvedValue(null)
  prismaMock.rawMaterial.findFirst.mockResolvedValue({ unit: 'KILOGRAM' })
  prismaMock.product.findFirst.mockResolvedValue({
    unit: null,
    trackInventory: true,
    inventoryMethod: 'QUANTITY',
    inventory: { id: 'inv-1' },
  })
  prismaMock.rawMaterial.findFirstOrThrow.mockResolvedValue(INSUMO)
  prismaMock.inventory.findFirstOrThrow.mockResolvedValue(INVENTARIO)
  // Como el servicio real: arma la respuesta con la proyección, dentro de «su» transacción.
  logWaste.mockImplementation(
    async (_venue: unknown, _actor: unknown, _input: unknown, project: (tx: unknown, summary: typeof RESUMEN) => Promise<unknown>) =>
      project(prismaMock, RESUMEN),
  )
  checkAndCreateLowStockAlert.mockResolvedValue(undefined)
})

describe('adaptDashboardWaste', () => {
  it('🔴 ya no evalúa la alerta de existencia baja: la evalúa logWaste después del COMMIT, para las tres entradas', async () => {
    await adaptDashboardWaste('venue-1', 'staff-1', 'RAW_MATERIAL', 'rm-1', { quantity: -3 })
    await adaptDashboardWaste('venue-1', 'staff-1', 'PRODUCT', 'p-1', { quantity: -3 })
    expect(checkAndCreateLowStockAlert).not.toHaveBeenCalled()
  })

  it('🔴 no es un segundo candado: nunca evalúa permiso ni activación', async () => {
    await adaptDashboardWaste('venue-1', 'staff-1', 'RAW_MATERIAL', 'rm-1', { quantity: -3 })
    await adaptDashboardWaste('venue-1', 'staff-1', 'PRODUCT', 'p-1', { quantity: -3 })
    expect(requireWastePermission).not.toHaveBeenCalled()
    expect(requireWasteActivation).not.toHaveBeenCalled()
  })

  it('traduce el contrato viejo: cantidad positiva, UNSPECIFIED, nota = reason, folio generado, source DASHBOARD', async () => {
    await adaptDashboardWaste('venue-1', 'staff-1', 'PRODUCT', 'p-1', { quantity: -2.5, reason: 'Roto', unitCost: 0 })

    const [venueId, actor, input] = logWaste.mock.calls[0]
    expect(venueId).toBe('venue-1')
    expect(actor).toBe('staff-1')
    expect(input).toMatchObject({
      itemType: 'PRODUCT',
      itemId: 'p-1',
      unit: 'UNIT',
      reasonCode: 'UNSPECIFIED',
      note: 'Roto',
      unitCost: 0,
      source: 'DASHBOARD',
    })
    expect(input.quantity.toString()).toBe('2.5')
    expect(input.idempotencyKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})

describe('adaptDashboardWaste — la respuesta dentro de la transacción', () => {
  it('🔴 obtiene el artículo después de los efectos y antes del COMMIT, acotado al venue', async () => {
    const orden: string[] = []
    logWaste.mockImplementation(
      async (_venue: unknown, _actor: unknown, _input: unknown, project: (tx: unknown, summary: typeof RESUMEN) => Promise<unknown>) => {
        orden.push('efectos')
        const result = await project(prismaMock, RESUMEN)
        orden.push('commit')
        return result
      },
    )
    prismaMock.rawMaterial.findFirstOrThrow.mockImplementation((async () => {
      orden.push('respuesta')
      return INSUMO
    }) as never)

    await expect(adaptDashboardWaste('venue-1', 'staff-1', 'RAW_MATERIAL', 'rm-1', { quantity: -3 })).resolves.toEqual({
      waste: RESUMEN,
      item: INSUMO,
    })
    expect(orden).toEqual(['efectos', 'respuesta', 'commit'])
    expect(prismaMock.rawMaterial.findFirstOrThrow).toHaveBeenCalledWith({ where: { id: 'rm-1', venueId: 'venue-1' } })

    await expect(adaptDashboardWaste('venue-1', 'staff-1', 'PRODUCT', 'p-1', { quantity: -3 })).resolves.toEqual({
      waste: RESUMEN,
      item: INVENTARIO,
    })
    expect(prismaMock.inventory.findFirstOrThrow).toHaveBeenCalledWith({ where: { venueId: 'venue-1', productId: 'p-1' } })
  })

  it.each([
    ['RAW_MATERIAL', () => adaptDashboardWaste('venue-1', 'staff-1', 'RAW_MATERIAL', 'rm-1', { quantity: -3 }), INSUMO],
    ['PRODUCT', () => adaptDashboardWaste('venue-1', 'staff-1', 'PRODUCT', 'p-1', { quantity: -3 }), INVENTARIO],
  ] as const)(
    '🔴 %s: un fallo de la base DESPUÉS del COMMIT ya no convierte la merma aplicada en error',
    async (_itemType, adapt, item) => {
      // La transacción de logWaste contesta; el cliente global —lo que se usaría después del COMMIT— falla.
      const tx = {
        rawMaterial: { findFirstOrThrow: jest.fn().mockResolvedValue(INSUMO) },
        inventory: { findFirstOrThrow: jest.fn().mockResolvedValue(INVENTARIO) },
      }
      logWaste.mockImplementation(
        async (_venue: unknown, _actor: unknown, _input: unknown, project: (tx: unknown, summary: typeof RESUMEN) => Promise<unknown>) =>
          project(tx, RESUMEN),
      )
      prismaMock.rawMaterial.findFirstOrThrow.mockRejectedValue(new Error('conexión perdida'))
      prismaMock.inventory.findFirstOrThrow.mockRejectedValue(new Error('conexión perdida'))

      await expect(adapt()).resolves.toEqual({ waste: RESUMEN, item })
      expect(prismaMock.rawMaterial.findFirstOrThrow).not.toHaveBeenCalled()
      expect(prismaMock.inventory.findFirstOrThrow).not.toHaveBeenCalled()
    },
  )
})

describe('canRecordDashboardWaste', () => {
  it('sólo un autor con fila en Staff entra al libro', () => {
    expect(canRecordDashboardWaste('clstaff0000000000000001')).toBe(true)
    expect(canRecordDashboardWaste(undefined)).toBe(false)
    expect(canRecordDashboardWaste('')).toBe(false)
    expect(canRecordDashboardWaste('MASTER_ADMIN')).toBe(false)
  })
})

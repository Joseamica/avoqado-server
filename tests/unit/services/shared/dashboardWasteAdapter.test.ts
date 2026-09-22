/**
 * adaptDashboardWaste — lo que la integración contra Postgres no puede forzar barato.
 *
 * El comportamiento real (folio, descuento, costo, idempotencia) lo cubre
 * tests/integration/inventory/dashboard-waste-adapter.integration.test.ts. Aquí sólo:
 *  - el adaptador ya NO evalúa la alerta de existencia baja: la evalúa `logWaste` después del COMMIT,
 *    igual para POS, dashboard y MCP (Opus I1; lo fija inventory-waste.integration.test.ts);
 *  - el adaptador no es un segundo candado de permiso (Rulings 18 y 20);
 *  - devuelve el artículo RELEÍDO del venue después de la merma, para que la ruta no lea la base.
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
  logWaste.mockResolvedValue(RESUMEN)
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

describe('adaptDashboardWaste — el artículo releído', () => {
  it('🔴 relee el insumo o el inventario DESPUÉS de registrar, acotado al venue', async () => {
    const orden: string[] = []
    logWaste.mockImplementation(async () => {
      orden.push('logWaste')
      return RESUMEN
    })
    prismaMock.rawMaterial.findFirstOrThrow.mockImplementation((async () => {
      orden.push('relectura')
      return INSUMO
    }) as never)

    await expect(adaptDashboardWaste('venue-1', 'staff-1', 'RAW_MATERIAL', 'rm-1', { quantity: -3 })).resolves.toEqual({
      waste: RESUMEN,
      item: INSUMO,
    })
    expect(orden).toEqual(['logWaste', 'relectura'])
    expect(prismaMock.rawMaterial.findFirstOrThrow).toHaveBeenCalledWith({ where: { id: 'rm-1', venueId: 'venue-1' } })

    await expect(adaptDashboardWaste('venue-1', 'staff-1', 'PRODUCT', 'p-1', { quantity: -3 })).resolves.toEqual({
      waste: RESUMEN,
      item: INVENTARIO,
    })
    expect(prismaMock.inventory.findFirstOrThrow).toHaveBeenCalledWith({ where: { venueId: 'venue-1', productId: 'p-1' } })
  })
})

describe('canRecordDashboardWaste', () => {
  it('sólo un autor con fila en Staff entra al libro', () => {
    expect(canRecordDashboardWaste('clstaff0000000000000001')).toBe(true)
    expect(canRecordDashboardWaste(undefined)).toBe(false)
    expect(canRecordDashboardWaste('')).toBe(false)
    expect(canRecordDashboardWaste('MASTER_ADMIN')).toBe(false)
  })
})

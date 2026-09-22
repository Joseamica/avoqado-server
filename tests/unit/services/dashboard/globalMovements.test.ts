import { Prisma } from '@prisma/client'
import { prismaMock } from '../../../__helpers__/setup'
import { getGlobalMovements } from '@/services/dashboard/productInventory.service'

/**
 * El historial de inventario del dashboard sale de aquí. Cuatro defectos reales
 * hacían que la pantalla mintiera (encontrados 2026-08-12 investigando "hice un
 * conteo y el historial dice otra cosa"):
 *
 *  1. `total` era el literal `1000` con el comentario "Dummy total" — la UI
 *     paginaba sobre un número inventado.
 *  2. Filtrar por VENTAS devolvía TODOS los tipos de producto: la condición
 *     caía en `{}` (sin filtro) en vez de filtrar por SALE.
 *  3. Filtrar por RECIBIDO reventaba los insumos: mandaba `type: 'RECEIVED'`,
 *     que NO existe en `RawMaterialMovementType` (ahí se llama PURCHASE).
 *  4. El costo usaba `Math.abs`, así que perder 10 cervezas y comprar 10 se
 *     veían idénticos.
 */
describe('getGlobalMovements — el historial no puede mentir', () => {
  const venueId = 'venue-1'

  const productMovement = (over: Partial<any> = {}) => ({
    id: 'mov-prod-1',
    createdAt: new Date('2026-08-12T18:00:00Z'),
    type: 'COUNT',
    quantity: { toNumber: () => -10 },
    previousStock: { toNumber: () => 42 },
    newStock: { toNumber: () => 32 },
    reason: 'Conteo de inventario',
    reference: null,
    createdBy: 'staff-1',
    inventory: { product: { name: 'Cerveza Corona', sku: 'BEB-003', unit: 'UNIT', cost: { toNumber: () => 20 } } },
    ...over,
  })

  const rawMovement = (over: Partial<any> = {}) => ({
    id: 'mov-raw-1',
    createdAt: new Date('2026-08-12T17:00:00Z'),
    type: 'COUNT',
    quantity: { toNumber: () => -16 },
    unit: 'KILOGRAM',
    previousStock: { toNumber: () => 20 },
    newStock: { toNumber: () => 4 },
    costImpact: { toNumber: () => -160 },
    reason: 'Conteo de inventario',
    reference: null,
    createdBy: 'staff-1',
    rawMaterial: { name: 'Champiñones', sku: 'ING-01', costPerUnit: { toNumber: () => 10 } },
    ...over,
  })

  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.inventoryMovement.findMany.mockResolvedValue([productMovement()] as any)
    prismaMock.rawMaterialMovement.findMany.mockResolvedValue([rawMovement()] as any)
    prismaMock.inventoryMovement.count.mockResolvedValue(120)
    prismaMock.rawMaterialMovement.count.mockResolvedValue(35)
  })

  it('devuelve el total REAL, no un número inventado', async () => {
    const result = await getGlobalMovements(venueId, { page: 1, limit: 50 })

    expect(result.meta.total).toBe(155) // 120 productos + 35 insumos
    expect(result.meta.total).not.toBe(1000)
  })

  it('filtrar por VENTAS sí filtra: sólo movimientos SALE de producto', async () => {
    await getGlobalMovements(venueId, { page: 1, limit: 50, type: 'SALE' })

    const where = prismaMock.inventoryMovement.findMany.mock.calls[0][0].where
    expect(where).toMatchObject({ type: 'SALE' })
  })

  it('filtrar por RECIBIDO usa PURCHASE en AMBAS tablas (RECEIVED no existe en insumos)', async () => {
    await getGlobalMovements(venueId, { page: 1, limit: 50, type: 'RECEIVED' })

    const productWhere = prismaMock.inventoryMovement.findMany.mock.calls[0][0].where
    const rawWhere = prismaMock.rawMaterialMovement.findMany.mock.calls[0][0].where
    expect(productWhere).toMatchObject({ type: 'PURCHASE' })
    expect(rawWhere).toMatchObject({ type: 'PURCHASE' })
  })

  it('el costo lleva SIGNO: una salida no se ve igual que una compra', async () => {
    const result = await getGlobalMovements(venueId, { page: 1, limit: 50 })

    const producto = result.data.find(m => m.itemName === 'Cerveza Corona')!
    expect(producto.totalCost).toBe(-200) // 10 unidades perdidas × $20
  })

  it('expone el proveedor (la columna del dashboard lo esperaba y nunca llegaba)', async () => {
    const result = await getGlobalMovements(venueId, { page: 1, limit: 50 })

    expect(result.data[0]).toHaveProperty('supplierName')
  })

  // ── Regresión: lo que ya funcionaba sigue igual ──────────────────────────
  it('mezcla productos e insumos ordenados por fecha descendente', async () => {
    const result = await getGlobalMovements(venueId, { page: 1, limit: 50 })

    expect(result.data).toHaveLength(2)
    expect(result.data[0].itemName).toBe('Cerveza Corona') // 18:00
    expect(result.data[1].itemName).toBe('Champiñones') // 17:00
    expect(result.data[1].category).toBe('INGREDIENT')
  })

  // ── Tarea 10: el Historial lee el folio de merma y no inventa costo ─────────
  const report = (over: Partial<any> = {}) => ({
    reasonCode: 'EXPIRED',
    unrecordedQuantity: { toNumber: () => 2 },
    rawMovements: [],
    productMovements: [],
    ...over,
  })

  it('🔴 merma de producto con folio y sin costo congelado: totalCost null, no costo actual × cantidad', async () => {
    prismaMock.inventoryMovement.findMany.mockResolvedValue([
      productMovement({
        type: 'LOSS',
        wasteReportId: 'clwaste1',
        unitCost: null,
        wasteReport: report({ productMovements: [{ id: 'mov-prod-1' }] }),
      }),
    ] as any)

    const result = await getGlobalMovements(venueId, { page: 1, limit: 50 })
    const row = result.data.find(m => m.itemName === 'Cerveza Corona')!
    expect(row).toMatchObject({ totalCost: null, wasteReportId: 'clwaste1', wasteReasonCode: 'EXPIRED', wasteUnrecorded: 2 })
  })

  it('merma de producto con folio: usa el costo CONGELADO del movimiento, con signo', async () => {
    prismaMock.inventoryMovement.findMany.mockResolvedValue([
      productMovement({
        type: 'LOSS',
        wasteReportId: 'clwaste1',
        // Prisma entrega `Decimal` en `quantity` y `unitCost`; el Historial multiplica en Decimal
        // (`unitCost.mul(quantity)`), así que un objeto con sólo `toNumber` ya no representa lo real.
        quantity: new Prisma.Decimal(-10),
        unitCost: new Prisma.Decimal(4),
        wasteReport: report({ productMovements: [{ id: 'mov-prod-1' }] }),
      }),
    ] as any)

    const result = await getGlobalMovements(venueId, { page: 1, limit: 50 })
    expect(result.data.find(m => m.itemName === 'Cerveza Corona')!.totalCost).toBe(-40) // 10 × $4, no × $20 actual
  })

  it('🔴 merma de insumo con folio sin costo: null; y el excedente sólo en el primer movimiento del folio', async () => {
    prismaMock.rawMaterialMovement.findMany.mockResolvedValue([
      rawMovement({
        id: 'mov-raw-2',
        type: 'SPOILAGE',
        costImpact: null,
        wasteReportId: 'clwaste2',
        wasteReport: report({ rawMovements: [{ id: 'mov-raw-1' }] }),
      }),
      rawMovement({
        id: 'mov-raw-1',
        type: 'SPOILAGE',
        wasteReportId: 'clwaste2',
        wasteReport: report({ rawMovements: [{ id: 'mov-raw-1' }] }),
      }),
    ] as any)

    const result = await getGlobalMovements(venueId, { page: 1, limit: 50 })
    const hermano = result.data.find(m => m.id === 'mov-raw-2')!
    const primero = result.data.find(m => m.id === 'mov-raw-1')!
    expect(hermano).toMatchObject({ totalCost: null, wasteReportId: 'clwaste2', wasteUnrecorded: null })
    expect(primero).toMatchObject({ totalCost: -160, wasteReportId: 'clwaste2', wasteUnrecorded: 2 })
  })

  it('un movimiento SIN folio (merma vieja incluida) conserva la cuenta de siempre y trae los campos nuevos en null', async () => {
    prismaMock.rawMaterialMovement.findMany.mockResolvedValue([
      rawMovement({ type: 'SPOILAGE', costImpact: null, wasteReportId: null, wasteReport: null }),
    ] as any)

    const result = await getGlobalMovements(venueId, { page: 1, limit: 50 })
    expect(result.data.find(m => m.itemName === 'Champiñones')).toMatchObject({
      totalCost: -160, // costo actual × cantidad, como hoy
      wasteReportId: null,
      wasteReasonCode: null,
      wasteUnrecorded: null,
    })
  })

  it('pide el folio en las DOS consultas de movimientos', async () => {
    await getGlobalMovements(venueId, { page: 1, limit: 50 })

    expect(prismaMock.inventoryMovement.findMany.mock.calls[0][0].include).toHaveProperty('wasteReport')
    expect(prismaMock.rawMaterialMovement.findMany.mock.calls[0][0].include).toHaveProperty('wasteReport')
  })

  it('sin filtro de tipo no restringe ninguna de las dos tablas', async () => {
    await getGlobalMovements(venueId, { page: 1, limit: 50 })

    const productWhere = prismaMock.inventoryMovement.findMany.mock.calls[0][0].where
    expect(productWhere.type).toBeUndefined()
  })
})

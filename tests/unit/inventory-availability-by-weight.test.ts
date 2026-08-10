import { computeInventoryAvailability } from '../../src/services/dashboard/product.dashboard.service'

/**
 * Disponibilidad de productos vendidos POR PESO.
 *
 * `Math.floor` es correcto para piezas —nadie vende 8.065 hamburguesas— pero
 * para una cremería tira existencia real: 8.065 kg de jamón se mostraba como
 * "8" en Inventario, escondiendo 65 g. Con jamón a $240/kg eso es dinero que
 * el dueño no ve, y en el peor caso 999 g fantasma por producto.
 *
 * Encontrado en la prueba física de vales por área (2026-08-08): tras vender
 * 0.435 kg y 1.5 kg de un inventario de 10 kg, la app mostraba "8" con 8.065
 * kg reales en la base.
 */
describe('computeInventoryAvailability — producto por peso', () => {
  const weightedHam = (currentStock: string) => ({
    trackInventory: true,
    inventoryMethod: 'QUANTITY',
    soldByWeight: true,
    unit: 'KILOGRAM',
    inventory: { currentStock },
  })

  it('expone los kilos exactos en el campo nuevo', () => {
    expect(computeInventoryAvailability(weightedHam('8.065')).availableQuantityExact).toBe(8.065)
    expect(computeInventoryAvailability(weightedHam('9.565')).availableQuantityExact).toBe(9.565)
  })

  it('mantiene availableQuantity ENTERO para no romper apps ya instaladas', () => {
    // Android declara `availableQuantity: Int?`. Un 8.065 aquí revienta la
    // deserialización de TODO el catálogo en las versiones ya publicadas.
    const value = computeInventoryAvailability(weightedHam('8.065')).availableQuantity
    expect(Number.isInteger(value)).toBe(true)
    expect(value).toBe(8)
  })

  it('deja de reportar agotado cuando queda menos de un kilo', () => {
    // El bug caro: con floor, 0.435 kg salían como 0 y el cliente lo pinta
    // "agotado" (isOutOfStock = availableQuantity <= 0) con casi medio kilo
    // en el mostrador.
    const almostEmpty = computeInventoryAvailability(weightedHam('0.435'))
    expect(almostEmpty.availableQuantity).toBe(1)
    expect(almostEmpty.availableQuantityExact).toBe(0.435)
  })

  it('sí reporta cero cuando de verdad se acabó', () => {
    const empty = computeInventoryAvailability(weightedHam('0'))
    expect(empty.availableQuantity).toBe(0)
    expect(empty.availableQuantityExact).toBe(0)
  })

  it('sigue truncando a piezas enteras cuando NO se vende por peso', () => {
    const burger = {
      trackInventory: true,
      inventoryMethod: 'QUANTITY',
      soldByWeight: false,
      unit: 'PIECE',
      inventory: { currentStock: '8.9' },
    }
    const result = computeInventoryAvailability(burger)
    expect(result.availableQuantity).toBe(8)
    expect(result.availableQuantityExact).toBe(8)
  })

  it('trata un producto sin soldByWeight como pieza (clientes/datos viejos)', () => {
    const legacy = {
      trackInventory: true,
      inventoryMethod: 'QUANTITY',
      inventory: { currentStock: '8.9' },
    }
    expect(computeInventoryAvailability(legacy).availableQuantity).toBe(8)
  })

  it('no inventa existencia cuando el producto no rastrea inventario', () => {
    const untracked = computeInventoryAvailability({
      trackInventory: false,
      soldByWeight: true,
      inventory: { currentStock: '8.065' },
    })
    expect(untracked.availableQuantity).toBeNull()
    expect(untracked.availableQuantityExact).toBeNull()
  })

  it('devuelve 0 por peso cuando no hay registro de inventario', () => {
    expect(computeInventoryAvailability({ trackInventory: true, inventoryMethod: 'QUANTITY', soldByWeight: true }).availableQuantity).toBe(
      0,
    )
  })
})

import { Decimal } from '@prisma/client/runtime/library'
import { Unit } from '@prisma/client'

/**
 * Recepción de compras con PRESENTACIÓN (CEDIS: "compro 50 cajas de huevo").
 *
 * La conversión ocurre en el BORDE: la cantidad y el costo se normalizan a la
 * unidad base ANTES de crear el lote FIFO, mover `currentStock` o escribir el
 * movimiento. Estos tests fijan la aritmética que gobierna ese borde — sobre
 * todo el COSTO, que es donde un factor mal aplicado se vuelve dinero mal
 * valuado en el inventario.
 *
 * Espeja `purchasedQuantityInBaseUnit` en purchaseOrder.service.ts.
 */

// Réplica exacta de la aritmética del helper (que es privado del servicio).
function purchasedInBase(
  orderItem: {
    unit: Unit
    unitPrice: Decimal
    presentationFactor: Decimal | null
    rawMaterial: { unit: Unit }
  },
  qty: number,
) {
  if (orderItem.presentationFactor) {
    const f = new Decimal(orderItem.presentationFactor)
    const baseQuantity = new Decimal(qty).mul(f)
    return { baseQuantity, batch: { quantity: baseQuantity, unit: orderItem.rawMaterial.unit, costPerUnit: orderItem.unitPrice.div(f) } }
  }
  return {
    baseQuantity: new Decimal(qty),
    batch: { quantity: new Decimal(qty), unit: orderItem.unit, costPerUnit: orderItem.unitPrice },
  }
}

describe('Recepción de compras — presentación de compra (huevo del CEDIS)', () => {
  // Huevo: base PIEZA, comprado en cajas de 360 a $360 la caja.
  const huevoEnCajas = {
    unit: Unit.PIECE,
    unitPrice: new Decimal(360),
    presentationFactor: new Decimal(360),
    rawMaterial: { unit: Unit.PIECE },
  }

  it('50 cajas entran como 18 000 piezas al stock', () => {
    expect(purchasedInBase(huevoEnCajas, 50).baseQuantity.toNumber()).toBe(18000)
  })

  it('💰 el costo se DIVIDE entre el factor: caja a $360 → $1 por pieza', () => {
    expect(purchasedInBase(huevoEnCajas, 50).batch.costPerUnit.toNumber()).toBe(1)
  })

  it('💰 el valor total del lote cuadra con lo pagado (50 × $360 = $18 000)', () => {
    const { batch } = purchasedInBase(huevoEnCajas, 50)
    expect(batch.quantity.mul(batch.costPerUnit).toNumber()).toBe(18000)
  })

  it('el lote se crea YA en unidad base (para que createStockBatch no reconvierta)', () => {
    expect(purchasedInBase(huevoEnCajas, 50).batch.unit).toBe(Unit.PIECE)
  })

  it('una recepción parcial (10 de 50 cajas) escala igual', () => {
    const { baseQuantity, batch } = purchasedInBase(huevoEnCajas, 10)
    expect(baseQuantity.toNumber()).toBe(3600)
    expect(batch.quantity.mul(batch.costPerUnit).toNumber()).toBe(3600)
  })

  it('un factor fraccionario (kilo = 18.18 piezas) no pierde precisión', () => {
    const porKilo = { ...huevoEnCajas, unitPrice: new Decimal(50), presentationFactor: new Decimal('18.18') }
    const { baseQuantity, batch } = purchasedInBase(porKilo, 3)
    expect(baseQuantity.toNumber()).toBeCloseTo(54.54, 2)
    // 3 kg × $50 = $150 pagados; el lote debe valer lo mismo.
    expect(batch.quantity.mul(batch.costPerUnit).toNumber()).toBeCloseTo(150, 6)
  })

  describe('REGRESIÓN — sin presentación, el comportamiento es el de siempre', () => {
    const legacyMismaUnidad = {
      unit: Unit.KILOGRAM,
      unitPrice: new Decimal(80),
      presentationFactor: null,
      rawMaterial: { unit: Unit.KILOGRAM },
    }

    it('cantidad y costo pasan intactos', () => {
      const { baseQuantity, batch } = purchasedInBase(legacyMismaUnidad, 5)
      expect(baseQuantity.toNumber()).toBe(5)
      expect(batch.costPerUnit.toNumber()).toBe(80)
    })

    it('el lote conserva la unidad DE LA ORDEN (createStockBatch normaliza él mismo)', () => {
      // Si le pasáramos la base ya convertida CON la unidad de la orden,
      // createStockBatch convertiría dos veces y el stock quedaría ×1000.
      const legacyDistintaUnidad = {
        unit: Unit.KILOGRAM,
        unitPrice: new Decimal(80),
        presentationFactor: null,
        rawMaterial: { unit: Unit.GRAM },
      }
      const { batch } = purchasedInBase(legacyDistintaUnidad, 2)
      expect(batch.unit).toBe(Unit.KILOGRAM)
      expect(batch.quantity.toNumber()).toBe(2)
    })
  })
})

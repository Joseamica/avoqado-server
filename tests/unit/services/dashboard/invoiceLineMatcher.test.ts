/**
 * Casar los renglones de un CFDI con los de una orden de compra.
 *
 * La factura NO dice qué compraste — la orden ya lo sabe. Esto sólo empareja para poder
 * comparar. Regla dura: **nunca adivina**. Un renglón que no case con certeza queda sin
 * casar y lo resuelve una persona; preferimos dejar trabajo a mano antes que colgarle a un
 * insumo un cobro que no era suyo.
 */
import { matchInvoiceLines } from '@/services/dashboard/invoiceLineMatcher'
import type { CfdiConcepto } from '@/services/fiscal/cfdiReceived.parser'

const concepto = (over: Partial<CfdiConcepto>): CfdiConcepto => ({
  supplierItemCode: null,
  descripcion: 'algo',
  claveProdServ: null,
  claveUnidad: null,
  cantidad: 1,
  valorUnitarioCents: 0,
  importeCents: 0,
  descuentoCents: 0,
  ...over,
})

const CAFE = concepto({ supplierItemCode: 'CAF-001', descripcion: 'Café', cantidad: 10, importeCents: 800_00 })
const AZUCAR = concepto({ supplierItemCode: 'AZU-500', descripcion: 'Azúcar', cantidad: 4, importeCents: 200_00 })

const orderItem = (id: string, totalCents: number, quantity = 1) => ({ id, totalCents, quantity })

describe('matchInvoiceLines', () => {
  it('casa por código del proveedor cuando ya se conoce ese código', () => {
    // Es el camino más fiable y el que alimenta la fase 2: en cuanto un código quedó
    // asociado una vez, las siguientes facturas del proveedor casan solas.
    const result = matchInvoiceLines([CAFE], [orderItem('item-cafe', 999_99), orderItem('item-otro', 1_00)], {
      knownCodes: { 'CAF-001': 'item-cafe' },
    })

    expect(result.lines[0].purchaseOrderItemId).toBe('item-cafe')
    expect(result.unmatchedConceptos).toBe(0)
  })

  it('el código conocido gana sobre el importe', () => {
    // Aunque el importe cuadre con OTRO renglón, el código es evidencia más fuerte.
    const result = matchInvoiceLines([CAFE], [orderItem('item-otro', 800_00), orderItem('item-cafe', 500_00)], {
      knownCodes: { 'CAF-001': 'item-cafe' },
    })

    expect(result.lines[0].purchaseOrderItemId).toBe('item-cafe')
  })

  it('sin código conocido, casa por importe exacto', () => {
    const result = matchInvoiceLines([CAFE, AZUCAR], [orderItem('item-a', 200_00), orderItem('item-b', 800_00)], {})

    expect(result.lines.map(l => l.purchaseOrderItemId)).toEqual(['item-b', 'item-a'])
    expect(result.unmatchedConceptos).toBe(0)
    expect(result.unmatchedOrderItemIds).toEqual([])
  })

  it('nunca casa dos conceptos con el mismo renglón', () => {
    // Dos renglones del mismo importe: cada concepto consume uno distinto.
    const otroCafe = concepto({ supplierItemCode: 'CAF-002', descripcion: 'Café B', importeCents: 800_00 })
    const result = matchInvoiceLines([CAFE, otroCafe], [orderItem('item-1', 800_00), orderItem('item-2', 800_00)], {})

    const ids = result.lines.map(l => l.purchaseOrderItemId)
    expect(new Set(ids).size).toBe(2)
    expect(ids).not.toContain(null)
  })

  it('deja sin casar lo que no coincide con nada, en vez de adivinar', () => {
    const flete = concepto({ descripcion: 'Flete', importeCents: 150_00 })
    const result = matchInvoiceLines([CAFE, flete], [orderItem('item-cafe', 800_00)], {})

    expect(result.lines[0].purchaseOrderItemId).toBe('item-cafe')
    expect(result.lines[1].purchaseOrderItemId).toBeNull()
    expect(result.unmatchedConceptos).toBe(1)
  })

  it('reporta los renglones de la orden que ninguna factura cubrió', () => {
    // Entrega parcial: pediste dos cosas y te facturaron una.
    const result = matchInvoiceLines([CAFE], [orderItem('item-cafe', 800_00), orderItem('item-azucar', 200_00)], {})

    expect(result.unmatchedOrderItemIds).toEqual(['item-azucar'])
  })

  it('un código conocido que apunta a un renglón que no está en ESTA orden no casa', () => {
    // El mapeo es del proveedor, no de la orden: puede apuntar a un renglón de otra.
    const result = matchInvoiceLines([CAFE], [orderItem('item-otro', 500_00)], {
      knownCodes: { 'CAF-001': 'item-de-otra-orden' },
    })

    expect(result.lines[0].purchaseOrderItemId).toBeNull()
    expect(result.unmatchedConceptos).toBe(1)
  })

  it('sin conceptos devuelve todo sin casar y no truena', () => {
    const result = matchInvoiceLines([], [orderItem('item-cafe', 800_00)], {})

    expect(result.lines).toEqual([])
    expect(result.unmatchedConceptos).toBe(0)
    expect(result.unmatchedOrderItemIds).toEqual(['item-cafe'])
  })
})

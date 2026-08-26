import type { CfdiConcepto } from '../fiscal/cfdiReceived.parser'

/**
 * Empareja los renglones de un CFDI con los de una orden de compra.
 *
 * La factura NO dice qué compraste — la orden ya lo sabe. Esto sólo empareja para poder
 * comparar lo cobrado contra lo pedido.
 *
 * 🔴 Nunca adivina. Sólo empareja con evidencia dura:
 *   1. el código del proveedor, si ya se supo antes a qué renglón corresponde;
 *   2. el importe exacto.
 * Cualquier otra cosa —parecido de texto, cantidades aproximadas— queda SIN casar y lo
 * resuelve una persona. Preferimos dejar trabajo a mano antes que colgarle a un insumo un
 * cobro que no era suyo: ese error se propaga al costo y a los reportes en silencio.
 *
 * Función pura a propósito: es la pieza con más casos borde de toda la conciliación, y así
 * se prueba sin base de datos.
 */

export interface OrderLineForMatch {
  id: string
  /** Total del renglón en centavos enteros. */
  totalCents: number
  quantity: number
}

export interface MatchedLine {
  concepto: CfdiConcepto
  purchaseOrderItemId: string | null
}

export interface MatchOptions {
  /** Código del proveedor → id del renglón de orden que se le asoció antes (fase 2). */
  knownCodes?: Record<string, string>
}

export interface MatchInvoiceLinesResult {
  lines: MatchedLine[]
  /** Cuántos renglones de la factura quedaron sin casar. */
  unmatchedConceptos: number
  /** Renglones de la orden que ninguna línea de esta factura cubrió (entrega parcial). */
  unmatchedOrderItemIds: string[]
}

export function matchInvoiceLines(
  conceptos: CfdiConcepto[],
  orderItems: OrderLineForMatch[],
  options: MatchOptions = {},
): MatchInvoiceLinesResult {
  const knownCodes = options.knownCodes ?? {}
  const available = new Map(orderItems.map(item => [item.id, item]))
  const lines: MatchedLine[] = []

  // Dos pasadas: primero los códigos conocidos, que son la evidencia más fuerte. Si se
  // hiciera en una sola, un concepto anterior podría llevarse por importe el renglón que
  // otro tenía asignado por código.
  const byCode = new Map<number, string>()
  conceptos.forEach((concepto, index) => {
    const code = concepto.supplierItemCode
    if (!code) return
    const targetId = knownCodes[code]
    // El mapeo pertenece al proveedor, no a esta orden: puede apuntar a un renglón que
    // aquí no existe. En ese caso no vale y se cae al importe.
    if (targetId && available.has(targetId)) {
      byCode.set(index, targetId)
      available.delete(targetId)
    }
  })

  conceptos.forEach((concepto, index) => {
    const fromCode = byCode.get(index)
    if (fromCode) {
      lines.push({ concepto, purchaseOrderItemId: fromCode })
      return
    }

    const match = [...available.values()].find(item => item.totalCents === concepto.importeCents)
    if (match) {
      available.delete(match.id)
      lines.push({ concepto, purchaseOrderItemId: match.id })
      return
    }

    lines.push({ concepto, purchaseOrderItemId: null })
  })

  return {
    lines,
    unmatchedConceptos: lines.filter(l => l.purchaseOrderItemId === null).length,
    unmatchedOrderItemIds: [...available.keys()],
  }
}

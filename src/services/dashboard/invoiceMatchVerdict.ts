import type { InvoiceMatchStatus } from '@prisma/client'

/**
 * Decide el veredicto de una factura contra su orden de compra.
 *
 * 🔴 Describe, no corrige. El costo de la mercancía se congeló al RECIBIR desde
 * `PurchaseOrderItem.unitPrice`; una diferencia con lo facturado se AVISA y nada más.
 * Revaluar el lote cambiaría el costo de ventas que ya ocurrieron con él.
 *
 * Función pura: el veredicto se decide en un solo lugar y se guarda, para que la pantalla
 * no vuelva a calcularlo con criterios ligeramente distintos — así nacen los descuadres.
 */

export interface MatchVerdictInput {
  /**
   * ¿El emisor del CFDI es el proveedor de la orden?
   *
   * `null` = NO SE PUDO comprobar, porque el proveedor no tiene RFC capturado. No es lo
   * mismo que "es otro proveedor": marcar mismatch ahí acusaría al proveedor de algo que
   * en realidad es un dato faltante nuestro. Se deja pasar y se anota.
   */
  supplierMatches: boolean | null
  invoiceTotalCents: number
  orderTotalCents: number
  unmatchedConceptos: number
  unmatchedOrderItemIds: string[]
}

export interface MatchVerdictNotes {
  invoiceTotalCents: number
  orderTotalCents: number
  /** Positivo = el proveedor cobró de MÁS. Negativo = de menos. */
  totalDifferenceCents: number
  unmatchedConceptos: number
  unmatchedOrderItemIds: string[]
  /** true cuando el proveedor no tiene RFC capturado y por eso no se verificó el emisor. */
  supplierUnverified?: boolean
}

export interface MatchVerdict {
  status: InvoiceMatchStatus
  notes: MatchVerdictNotes
}

export function decideMatchVerdict(input: MatchVerdictInput): MatchVerdict {
  const totalDifferenceCents = input.invoiceTotalCents - input.orderTotalCents

  const notes: MatchVerdictNotes = {
    invoiceTotalCents: input.invoiceTotalCents,
    orderTotalCents: input.orderTotalCents,
    totalDifferenceCents,
    unmatchedConceptos: input.unmatchedConceptos,
    unmatchedOrderItemIds: input.unmatchedOrderItemIds,
    ...(input.supplierMatches === null ? { supplierUnverified: true } : {}),
  }

  // El orden importa. Si la factura ni siquiera es de este proveedor, comparar importes no
  // significa nada; y entre dinero y renglones, lo que se le reclama al proveedor primero
  // es el dinero.
  if (input.supplierMatches === false) return { status: 'SUPPLIER_MISMATCH', notes }
  if (totalDifferenceCents !== 0) return { status: 'AMOUNT_MISMATCH', notes }
  if (input.unmatchedConceptos > 0 || input.unmatchedOrderItemIds.length > 0) {
    return { status: 'LINES_MISMATCH', notes }
  }

  return { status: 'MATCHED', notes }
}

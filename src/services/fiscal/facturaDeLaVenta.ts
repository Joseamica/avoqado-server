/**
 * ¿La venta ya tiene su factura? (28-oct-2026, «Nueva factura» en Facturas del dashboard y la tool `order_invoice_status` del MCP).
 *
 * Es la MISMA regla del candado de emisión (`issueCfdiForOrder`, cfdi.service.ts): sólo cuenta la factura individual (no la global) de
 * ingreso (no una nota de crédito) que está timbrada o en cancelación, y con una sustitución manda la que NO fue sustituida por otra ya
 * timbrada. El candado, antes de decidir, le pregunta al PAC por cada cancelación pedida; aquí no se puede, así que se separan dos casos:
 *   - `VIGENTE`: facturar otra vez termina en «ya facturada» pase lo que pase con el PAC.
 *   - `EN_CANCELACION`: depende de que el PAC ya haya aceptado una cancelación pedida → una pantalla NO la bloquea: deja intentarlo y el
 *     candado contesta.
 *
 * Módulo puro (sin consultas ni efectos; de Prisma sólo el tipo): lo importan el listado de ventas y el MCP.
 */
import type { Prisma } from '@prisma/client'

/** Las facturas de una venta que pueden decidir el resultado: el `where` de la relación `Order.cfdis`. */
export const FACTURAS_QUE_CUENTAN_DE_LA_VENTA: Prisma.CfdiWhereInput = {
  isGlobal: false,
  type: 'INGRESO',
  status: { in: ['STAMPED', 'CANCEL_REQUESTED'] },
}

/** Lo mínimo que la regla necesita de cada factura (el `select` de la relación lo debe traer). */
export const CAMPOS_DE_LA_REGLA = { id: true, replacesCfdiId: true, status: true, cancelStatus: true } as const

export type EstadoDeFacturaDeLaVenta = 'VIGENTE' | 'EN_CANCELACION'

interface FacturaQueCuenta {
  id: string
  replacesCfdiId?: string | null
  status: string
  cancelStatus?: string | null
}

const enCancelacion = (f: FacturaQueCuenta) => f.status === 'CANCEL_REQUESTED' || f.cancelStatus === 'REQUESTED'

/**
 * El estado y la factura que manda (la que el candado de emisión contestaría). `null` = la venta no tiene factura que cuente.
 *
 * Espejo de `issueCfdiForOrder`: `vigente` = la que no fue sustituida por otra timbrada. Si ésa está en cancelación y sustituyó a una
 * original que sigue en pie, la venta está facturada con la original (salvo que la original también esté en cancelación: entonces depende
 * del PAC).
 */
export function facturaDeLaVenta<F extends FacturaQueCuenta>(
  facturas: readonly F[] | null | undefined,
): { estado: EstadoDeFacturaDeLaVenta; factura: F } | null {
  const vigentes = (facturas ?? []).filter(f => f.status === 'STAMPED' || f.status === 'CANCEL_REQUESTED')
  if (vigentes.length === 0) return null
  const vigente = vigentes.find(f => !vigentes.some(s => s.replacesCfdiId === f.id && s.status === 'STAMPED')) ?? vigentes[0]
  if (!enCancelacion(vigente)) return { estado: 'VIGENTE', factura: vigente }
  const original = vigentes.find(f => f.id === vigente.replacesCfdiId)
  if (original) return { estado: enCancelacion(original) ? 'EN_CANCELACION' : 'VIGENTE', factura: original }
  return { estado: 'EN_CANCELACION', factura: vigente }
}

export function estadoDeFacturaDeLaVenta(facturas: readonly FacturaQueCuenta[] | null | undefined): EstadoDeFacturaDeLaVenta | null {
  return facturaDeLaVenta(facturas)?.estado ?? null
}

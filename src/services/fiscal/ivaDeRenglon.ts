/**
 * El IVA de UN renglón al facturar (plan 3 del IVA por producto). Regla única:
 *   sellado (OrderItem.ivaTratamiento) > tratamiento ACTUAL del producto > IVA_16 (sin producto).
 * Un renglón sellado ya pertenece a un documento y nunca vuelve a leer el producto.
 * La traducción al SAT sale de `trasladoSatDe` (plan 1), la misma regla que usa el trigger de la base.
 */
import { IvaTratamiento, trasladoSatDe } from './ivaTratamiento'

export function resolverTratamiento(r: {
  selladoIva: IvaTratamiento | null | undefined
  productoIva: IvaTratamiento | null | undefined
  tieneProducto: boolean
}): IvaTratamiento {
  if (r.selladoIva) return r.selladoIva
  if (r.tieneProducto && r.productoIva) return r.productoIva
  return 'IVA_16'
}

type ImpuestoSat = { type: 'IVA'; factor: 'Tasa' | 'Exento'; rate: number; withholding: false }

export function impuestosSatDe(
  t: IvaTratamiento,
): { objetoImp: '01' | '02'; taxes: ImpuestoSat[]; rate: number } | { bloqueado: true; motivo: string } {
  const sat = trasladoSatDe(t)
  if (!sat.timbrable) {
    return {
      bloqueado: true,
      motivo: `Hay un producto con objeto de impuesto ${sat.objetoImp}, que la facturación todavía no soporta; corrígelo en el producto antes de facturar.`,
    }
  }
  if (!sat.traslado) return { objetoImp: '01', taxes: [], rate: 0 }
  if (sat.traslado.tipoFactor === 'Exento') {
    return { objetoImp: '02', rate: 0, taxes: [{ type: 'IVA', factor: 'Exento', rate: 0, withholding: false }] }
  }
  const rate = Number(sat.traslado.tasaOCuota)
  return { objetoImp: '02', rate, taxes: [{ type: 'IVA', factor: 'Tasa', rate, withholding: false }] }
}

export function clasificarOrden(ts: IvaTratamiento[]): 'TODO_16' | 'MIXTA' {
  return ts.every(t => t === 'IVA_16') ? 'TODO_16' : 'MIXTA'
}

export function hayBloqueados(ts: IvaTratamiento[]): boolean {
  return ts.some(t => t === 'BLOQUEADO_03' || t === 'BLOQUEADO_04')
}

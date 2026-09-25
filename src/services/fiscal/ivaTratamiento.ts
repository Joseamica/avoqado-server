/**
 * Tratamiento de IVA de un producto: UN valor que decide el ObjetoImp y el traslado del CFDI.
 * La tupla vieja (`taxRate` + `objetoImp`) se conserva porque las apps publicadas la leen; este módulo
 * es la ÚNICA traducción entre los dos mundos, y el trigger de PostgreSQL (migración
 * `iva_tratamiento_columnas`) repite exactamente estas reglas. Si cambias una, cambia la otra.
 *
 * Regla fiscal (LIVA arts. 2-A, 9, 15; Guía de llenado del Anexo 20): tasa 0 y exento son los dos
 * ObjetoImp 02; tasa 0 lleva traslado Tasa 0.000000 e Importe 0, exento lleva factor Exento sin cuota.
 */

export type IvaTratamiento = 'IVA_16' | 'IVA_8' | 'IVA_0' | 'EXENTO' | 'NO_OBJETO' | 'BLOQUEADO_03' | 'BLOQUEADO_04'
export type ObjetoImp = '01' | '02' | '03' | '04'

export const TRATAMIENTOS_OFRECIDOS_V1: readonly IvaTratamiento[] = ['IVA_16', 'IVA_0', 'EXENTO'] as const

const aCentesimas = (tasa: number | string): number => Math.round(Number(tasa) * 10000) / 10000

/** `null` = combinación que el SAT no admite (se rechaza, nunca se adivina). EXENTO nunca sale de aquí. */
export function tratamientoDesdeTupla(taxRate: number | string, objetoImp: string): IvaTratamiento | null {
  switch (objetoImp) {
    case '01':
      return 'NO_OBJETO'
    case '03':
      return 'BLOQUEADO_03'
    case '04':
      return 'BLOQUEADO_04'
    case '02': {
      const tasa = aCentesimas(taxRate)
      if (tasa === 0.16) return 'IVA_16'
      if (tasa === 0.08) return 'IVA_8'
      if (tasa === 0) return 'IVA_0'
      return null
    }
    default:
      return null
  }
}

export function tuplaDesdeTratamiento(t: IvaTratamiento, tasaActual: number): { taxRate: number; objetoImp: ObjetoImp } {
  switch (t) {
    case 'IVA_16':
      return { taxRate: 0.16, objetoImp: '02' }
    case 'IVA_8':
      return { taxRate: 0.08, objetoImp: '02' }
    case 'IVA_0':
    case 'EXENTO':
      return { taxRate: 0, objetoImp: '02' }
    case 'NO_OBJETO':
      return { taxRate: 0, objetoImp: '01' }
    case 'BLOQUEADO_03':
      return { taxRate: aCentesimas(tasaActual), objetoImp: '03' }
    case 'BLOQUEADO_04':
      return { taxRate: aCentesimas(tasaActual), objetoImp: '04' }
  }
}

type TrasladoSat = { tipoFactor: 'Tasa'; tasaOCuota: '0.160000' | '0.080000' | '0.000000' } | { tipoFactor: 'Exento' }

export function trasladoSatDe(t: IvaTratamiento): { objetoImp: ObjetoImp; traslado: TrasladoSat | null; timbrable: boolean } {
  switch (t) {
    case 'IVA_16':
      return { objetoImp: '02', traslado: { tipoFactor: 'Tasa', tasaOCuota: '0.160000' }, timbrable: true }
    case 'IVA_8':
      return { objetoImp: '02', traslado: { tipoFactor: 'Tasa', tasaOCuota: '0.080000' }, timbrable: true }
    case 'IVA_0':
      return { objetoImp: '02', traslado: { tipoFactor: 'Tasa', tasaOCuota: '0.000000' }, timbrable: true }
    case 'EXENTO':
      return { objetoImp: '02', traslado: { tipoFactor: 'Exento' }, timbrable: true }
    case 'NO_OBJETO':
      return { objetoImp: '01', traslado: null, timbrable: true }
    case 'BLOQUEADO_03':
      return { objetoImp: '03', traslado: null, timbrable: false }
    case 'BLOQUEADO_04':
      return { objetoImp: '04', traslado: null, timbrable: false }
  }
}

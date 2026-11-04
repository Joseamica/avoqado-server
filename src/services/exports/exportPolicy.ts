// Política pura de los exportes en segundo plano. Sin I/O: se prueba sola.
// Números medidos el 2026-10-06 con SheetJS 0.18.5 (spec §3).

const envNum = (name: string, fallback: number): number => {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v > 0 ? v : fallback
}

export const EXPORT_LIMITS = {
  CELDAS_DIRECTO: 20_000, // PROVISIONAL: lo fija la medición de la frontera (Tarea 13); se baja si retiene > 200 ms
  BYTES_POR_CELDA_XLSX: 460,
  HOLGURA_XLSX: 1.25, // copia de las celdas al mandarlas al worker
  XLSX_MAX_MB: envNum('EXPORT_XLSX_MAX_MB', 400),
  MEMORIA_LIMITE_MB: envNum('EXPORT_MEMORY_LIMIT_MB', 1_200),
  FILAS_MAX_SEGUNDO_PLANO: 200_000,
  TAMANO_PAGINA: 500,
  RETENCION_DIAS: 7,
  VIVOS_POR_USUARIO: 3,
} as const

export type ExportFileFormat = 'csv' | 'xlsx'

export type DecisionCarril =
  | { carril: 'directo'; formato: ExportFileFormat }
  | { carril: 'segundoPlano'; formato: ExportFileFormat; cambioAFormato?: 'csv' }
  | { carril: 'rechazo'; motivo: 'demasiadasFilas'; filas: number; maximo: number }

export function memoriaEstimadaMb(i: { filas: number; columnas: number; formato: ExportFileFormat }): number {
  if (i.formato === 'csv') return (2 * EXPORT_LIMITS.TAMANO_PAGINA * i.columnas * EXPORT_LIMITS.BYTES_POR_CELDA_XLSX) / 1e6 + 1
  return (i.filas * i.columnas * EXPORT_LIMITS.BYTES_POR_CELDA_XLSX * EXPORT_LIMITS.HOLGURA_XLSX) / 1e6
}

export function decidirCarril(i: { filas: number; columnas: number; formato: ExportFileFormat }): DecisionCarril {
  if (i.filas > EXPORT_LIMITS.FILAS_MAX_SEGUNDO_PLANO) {
    return { carril: 'rechazo', motivo: 'demasiadasFilas', filas: i.filas, maximo: EXPORT_LIMITS.FILAS_MAX_SEGUNDO_PLANO }
  }
  if (i.filas * i.columnas < EXPORT_LIMITS.CELDAS_DIRECTO) return { carril: 'directo', formato: i.formato }
  if (i.formato === 'xlsx' && memoriaEstimadaMb(i) > EXPORT_LIMITS.XLSX_MAX_MB) {
    return { carril: 'segundoPlano', formato: 'csv', cambioAFormato: 'csv' }
  }
  return { carril: 'segundoPlano', formato: i.formato }
}

export function admitePorMemoria(i: { estimadoMb: number; rssMb: number; limiteMb?: number }): boolean {
  return i.rssMb + i.estimadoMb <= (i.limiteMb ?? EXPORT_LIMITS.MEMORIA_LIMITE_MB)
}

/** 413 de los GET viejos cuando el pedido ya no es del carril directo: la pantalla vieja lo muestra en su aviso de 413. */
export const MENSAJE_GET_VIEJO_GRANDE = 'Este archivo es grande: recarga la página para descargarlo en segundo plano'

/** Codex r1 #8: un READY vencido se contesta EXPIRED aunque la limpieza diaria no haya pasado. */
export function estadoVisible<S extends string>(run: { status: S; expiresAt: Date }, ahora: Date): S | 'EXPIRED' {
  return run.status === 'READY' && +run.expiresAt <= +ahora ? 'EXPIRED' : run.status
}

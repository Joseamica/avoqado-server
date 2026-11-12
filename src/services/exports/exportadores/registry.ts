import type { Exportador } from './types'
import { cobros } from './cobros.exportador'
import { historialInventario } from './historialInventario.exportador'
import { ordenes } from './ordenes.exportador'
import { ventasDetalladas } from './ventasDetalladas.exportador'

const EXPORTADORES: Record<string, Exportador<any, any>> = {
  [ventasDetalladas.kind]: ventasDetalladas,
  [cobros.kind]: cobros,
  [ordenes.kind]: ordenes,
  [historialInventario.kind]: historialInventario,
}

export const KINDS_EXPORTE = Object.keys(EXPORTADORES)
export function obtenerExportador(kind: string): Exportador<unknown, unknown> | null {
  return Object.prototype.hasOwnProperty.call(EXPORTADORES, kind) ? EXPORTADORES[kind] : null
}

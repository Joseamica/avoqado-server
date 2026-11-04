import type { ExportColumnDef } from '@/services/dashboard/export.helpers'

export interface Cursor {
  createdAt: string
  id: string
}
export interface ContextoExporte {
  venueId: string
  staffId: string
  esSuperadmin: boolean
}
/** 403 listo para mandar, con el MISMO cuerpo que el GET viejo de ese exporte. */
export interface Bloqueo {
  status: 403
  body: Record<string, unknown>
}
export interface Exportador<TFiltros, TFila> {
  kind: string
  titulo: string // hoja de Excel, campanita y correo
  nombreArchivo: string // stem del archivo, p. ej. 'ventas-detalladas'
  permiso: string // checkPermission de TODAS sus rutas
  /** Valida y normaliza filtros crudos (body o los guardados). Acepta su propia salida. Lanza BadRequestError. */
  parsearFiltros(raw: unknown): TFiltros
  /** El gating de hoy de ese exporte; null si puede. */
  autorizar(ctx: ContextoExporte, filtros: TFiltros): Promise<Bloqueo | null>
  columnas: ExportColumnDef<TFila>[]
  contar(venueId: string, filtros: TFiltros, corte: Date): Promise<number>
  pagina(venueId: string, filtros: TFiltros, corte: Date, despuesDe: Cursor | null, limite: number): Promise<TFila[]>
  cursorDe(fila: TFila): Cursor
}

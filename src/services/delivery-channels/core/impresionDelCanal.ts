/**
 * Dónde se imprime el delivery de cada canal (`DeliveryChannelLink.config.impresion`).
 * Default = lo de hoy: comanda como en el salón y empaque del negocio. Ante cualquier duda se imprime
 * como en el salón: nunca un pedido sin papel.
 */
import { Prisma, PrismaClient } from '@prisma/client'
import { ValidationError } from '../../../errors/AppError'

export type ImpresionDelCanal = {
  comanda: 'SALON' | 'UNA_ESTACION'
  estacionId?: string
  empaque: 'NEGOCIO' | 'NO' | 'ESTACION'
  empaqueEstacionId?: string
}

export type ImpresionReparto = {
  proveedor: string
  estacionUnicaId: string | null
  empaque: boolean
  empaqueEstacionId: string | null
}

export type EstacionElegible = { id: string; active: boolean; sendsComanda: boolean }

const DEFAULT: ImpresionDelCanal = { comanda: 'SALON', empaque: 'NEGOCIO' }
const COMANDAS = ['SALON', 'UNA_ESTACION']
const EMPAQUES = ['NEGOCIO', 'NO', 'ESTACION']
const esTexto = (v: unknown): v is string => typeof v === 'string' && v.length > 0

function mensajeDeForma(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return '`impresion` debe ser un objeto'
  const r = raw as Record<string, unknown>
  if (!COMANDAS.includes(r.comanda as string)) return 'La comanda del canal debe ser «SALON» o «UNA_ESTACION»'
  if (!EMPAQUES.includes(r.empaque as string)) return 'El empaque del canal debe ser «NEGOCIO», «NO» o «ESTACION»'
  if (r.comanda === 'UNA_ESTACION' && !esTexto(r.estacionId)) return 'Elige la estación donde sale la comanda'
  if (r.empaque === 'ESTACION' && !esTexto(r.empaqueEstacionId)) return 'Elige la estación donde sale el empaque'
  return null
}

/** Nunca lanza: falta o mal formado ⇒ el default (como en el salón). */
export function leerImpresion(config: unknown): ImpresionDelCanal {
  const raw = typeof config === 'object' && config !== null ? (config as Record<string, unknown>).impresion : undefined
  if (mensajeDeForma(raw)) return { ...DEFAULT }
  const r = raw as ImpresionDelCanal
  return {
    comanda: r.comanda,
    ...(r.comanda === 'UNA_ESTACION' && { estacionId: r.estacionId }),
    empaque: r.empaque,
    ...(r.empaque === 'ESTACION' && { empaqueEstacionId: r.empaqueEstacionId }),
  }
}

export function validarFormaImpresion(raw: unknown): void {
  const msg = mensajeDeForma(raw)
  if (msg) throw new ValidationError(msg)
}

export function idsDeEstaciones(impresion: ImpresionDelCanal): string[] {
  const ids: string[] = []
  if (impresion.comanda === 'UNA_ESTACION' && impresion.estacionId) ids.push(impresion.estacionId)
  if (impresion.empaque === 'ESTACION' && impresion.empaqueEstacionId) ids.push(impresion.empaqueEstacionId)
  return [...new Set(ids)]
}

export async function validarEstacionesDeImpresion(
  db: Prisma.TransactionClient | PrismaClient,
  venueId: string,
  impresion: ImpresionDelCanal,
): Promise<void> {
  const ids = idsDeEstaciones(impresion)
  if (ids.length === 0) return
  const filas = await db.printStation.findMany({
    where: { venueId, id: { in: ids } },
    select: { id: true, active: true, sendsComanda: true },
    take: ids.length,
  })
  const buenas = new Set(filas.filter(f => f.active && f.sendsComanda).map(f => f.id))
  if (ids.some(id => !buenas.has(id))) {
    throw new ValidationError('La estación elegida no existe en este negocio, está apagada o no lleva comanda')
  }
}

/** Estación borrada/apagada/sin comanda ⇒ `null` (sale como en el salón; el editor lo avisa). */
export function resolverImpresionReparto(
  proveedor: string,
  impresion: ImpresionDelCanal,
  estaciones: Map<string, EstacionElegible>,
): ImpresionReparto {
  const elegible = (id?: string): string | null => {
    const e = id ? estaciones.get(id) : undefined
    return e && e.active && e.sendsComanda ? e.id : null
  }
  return {
    proveedor,
    estacionUnicaId: impresion.comanda === 'UNA_ESTACION' ? elegible(impresion.estacionId) : null,
    empaque: impresion.empaque !== 'NO',
    empaqueEstacionId: impresion.empaque === 'ESTACION' ? elegible(impresion.empaqueEstacionId) : null,
  }
}

// src/services/dashboard/staffPay/lectura.ts — lo que una LECTURA de pago al personal (el recibo y el reporte) resuelve con el
// cliente global ANTES de su foto y lo que compara DENTRO (fase 3; sacado de `recibos.service.ts` en B14-fix para que el reporte lo
// use igual). B14-fix (Codex participación r1): F1, el alcance de la CONEXIÓN (MCP) se intersecta antes del permiso; F2, la
// pertenencia de cada sede a la organización se relee dentro de la foto; F3, el reporte abierto también lee en una foto.
import { Prisma } from '@prisma/client'
import prisma from '../../../utils/prismaClient'
import { sedesConServicePay, sedesLegiblesDe } from './acceso'
import { alcanceDelPeriodo, sedesConVentana } from './alcance'
import { periodoQueContieneFecha } from './periodosGuardados'

type Db = Prisma.TransactionClient | typeof prisma
const TZ_DEFAULT = 'America/Mexico_City'

/**
 * Todo lo que se consulta con el cliente GLOBAL —los MÓDULOS (`sedesConServicePay`), las sedes con ventana y los PERMISOS
 * (`sedesLegiblesDe`)—, resuelto ANTES de abrir la instantánea y pasado como datos (Codex R4-Nuevo 1): dentro, cada foto
 * retendría su conexión esperando OTRA del pool. El permiso se resuelve para TODAS las candidatas: las del periodo como está
 * ahora ∪ las que hoy tienen el módulo ∪ las que tienen alguna ventana (B11, r4.4: su historia las mete al alcance).
 */
export interface LecturaPreparada {
  organizationId: string
  activas: string[]
  /** Las sedes con alguna ventana (B11): dentro de la foto sólo se comparan. */
  conVentana: string[]
  /** Legibles por quien pregunta Y dentro del alcance de su conexión (`soloSedes`). */
  permitidas: Set<string>
}

/**
 * `soloSedes` (B14-fix F1): el alcance de una conexión MCP. Se intersecta ANTES del permiso, así que una sede fuera de la
 * conexión no se lee aunque el usuario pueda leerla en el dashboard: no aporta renglones, totales, personas ni pendientes, y
 * la respuesta dice `parcial`.
 */
export async function prepararLectura(input: {
  userId: string
  organizationId: string
  fecha: string
  soloSedes?: readonly string[]
}): Promise<LecturaPreparada> {
  const filaAhora = await periodoQueContieneFecha(prisma, input.organizationId, input.fecha)
  const activas = await sedesConServicePay(input.organizationId)
  const conVentana = await sedesConVentana(prisma, input.organizationId)
  const candidatas = [...new Set([...(filaAhora?.venueIds ?? []), ...activas, ...conVentana])]
  // Ronda 1 (R2): un Set; con SUPERADMIN la conexión trae TODAS las sedes de la plataforma (`includes` sería n·m).
  const conexion = input.soloSedes ? new Set(input.soloSedes) : null
  const enConexion = conexion ? candidatas.filter(v => conexion.has(v)) : candidatas
  const { venueIds: permitidas } = await sedesLegiblesDe(input.userId, enConexion)
  return { organizationId: input.organizationId, activas, conVentana, permitidas: new Set(permitidas) }
}

/**
 * El alcance LEGIBLE de un periodo (`alcanceDelPeriodo`, B11: cerrado = su alcance; abierto = guardadas ∪ activas y, desde el
 * inicio de pago al personal, ∪ las sedes con ventana; filtrado por permiso y por `sede`), con módulos, ventanas y permisos ya
 * resueltos: es pura y corre dentro de la instantánea. Una sede que entró al periodo entre la preparación y la instantánea no
 * tiene permiso resuelto: no se lee y la respuesta dice `parcial` (conservador; la siguiente lectura ya la incluye).
 */
export function alcanceEnLaFoto(
  p: LecturaPreparada,
  fila: { status: 'OPEN' | 'CLOSED'; venueIds: string[] } | null,
  periodo: { start: string; end: string },
  startDate: string | null,
  sede?: string,
) {
  const alcance = alcanceDelPeriodo({
    periodo: { ...periodo, estado: fila?.status ?? 'OPEN' },
    guardadas: fila?.venueIds ?? [],
    activas: p.activas,
    conVentana: p.conVentana,
    startDate,
  })
  const legibles = alcance.filter(v => p.permitidas.has(v)).sort()
  const venueIds = sede ? legibles.filter(id => id === sede) : legibles
  return { venueIds, parcial: legibles.length < alcance.length || (sede !== undefined && venueIds.length === 0) }
}

/**
 * B14-fix F2 (Codex participación r1 #2): DENTRO de la foto, la zona de cada sede que SIGUE siendo de la organización. Las
 * sedes se prepararon antes (permisos, módulos, ventanas); un traslado que confirmó entre la preparación y la foto sacó a la
 * sede de la organización y el dinero que hizo después es de OTRA: la que no sale aquí no se lee (ni clases ni ventas), nunca
 * se suma con la zona de fábrica.
 */
export async function zonasEnLaFoto(db: Db, organizationId: string, venueIds: string[]): Promise<Map<string, string>> {
  if (!venueIds.length) return new Map()
  const vs = await db.venue.findMany({
    where: { id: { in: venueIds }, organizationId },
    select: { id: true, timezone: true },
    take: venueIds.length,
  })
  return new Map(vs.map(v => [v.id, v.timezone || TZ_DEFAULT]))
}

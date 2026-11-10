/**
 * La lista de la organización (App de campo, bloque 1): cada promotor con el estado de su celular. El filtro por estado, la
 * búsqueda, el orden y la paginación son del servidor. Nunca devuelve el PIN (sólo si la sucursal ya tiene uno).
 */
import { Prisma } from '@prisma/client'
import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import { utcTs } from '@/utils/sqlDates'
import { personSearchWhere } from '@/mcp/personSearch'
import { filtroDePromotor, sucursalesConCampo } from './personasDeCampo'

/**
 * Tope de las consultas de ids (promotores, celulares y códigos vivos). Con 39 promotores hoy y 100× ≈ 4 000 caben.
 * ponytail: conjuntos de ids en memoria con tope; si una organización pasa de 10 000, mover conteos y filtro de estado a SQL.
 */
export const TOPE_DE_IDS = 10_000
export function conTope<T>(filas: T[], que: string, organizationId: string): T[] {
  if (filas.length >= TOPE_DE_IDS)
    logger.warn(`📱 [CAMPO] ${que}: se alcanzó el tope de ${TOPE_DE_IDS}; la lista puede quedar corta`, { organizationId })
  return filas
}

export type EstadoDelPromotor = 'SIN_CELULAR' | 'CODIGO_SIN_USAR' | 'ACTIVO'

export type FilaDePromotor = {
  staffId: string
  nombre: string
  telefono: string | null
  sucursales: { venueId: string; staffVenueId: string; nombre: string; tienePin: boolean }[]
  estado: EstadoDelPromotor
  codigo: { codigo: string; expiraAt: string } | null
  celular: {
    id: string
    marca: string | null
    modelo: string | null
    versionApp: string | null
    activadoAt: string
    vistoAt: string | null
    porSubir: number
  } | null
  ultimaChecada: { at: string; conUbicacion: boolean; venueId: string } | null
  porRevisar: number
}

export type FiltrosDeLaLista = { q?: string; venueId?: string; estado?: EstadoDelPromotor; page: number; pageSize: number }

const HORAS_DE_LA_ULTIMA_CHECADA = 48
const SIN_RESOLVER = ['PENDIENTE', 'APLICANDO']

/**
 * `venueIds`: el alcance de quien pregunta (el MCP, S3): nada de fuera sale. El panel no lo pasa (toda la organización, A7).
 */
export async function listarCelularesDeCampo(organizationId: string, f: FiltrosDeLaLista, venueIds?: string[]) {
  const vacio = { SIN_CELULAR: 0, CODIGO_SIN_USAR: 0, ACTIVO: 0 }
  const conCampo = await sucursalesConCampo(organizationId)
  if (conCampo.length === 0) return { disponible: false, items: [] as FilaDePromotor[], total: 0, conteos: vacio, porRevisar: 0 }

  // Sin `venueId`, toda la organización (o todo el alcance); una sucursal que no es de campo no tiene promotores.
  const alcance = conCampo.filter(v => (!f.venueId || v === f.venueId) && (!venueIds || venueIds.includes(v)))
  const deAlcance = { active: true, venues: { some: filtroDePromotor(alcance) } }
  // Lo por revisar se cuenta por SU sucursal, no por la persona (S5): el de alguien dado de baja también cuenta.
  const sucursalesDelConteo = venueIds ? venueIds.filter(v => !f.venueId || v === f.venueId) : f.venueId ? [f.venueId] : null
  const deLasSucursales = sucursalesDelConteo ? { venueId: { in: sucursalesDelConteo } } : {}
  const ahora = new Date()

  // Sólo ids (acotados a los promotores de la organización y con tope): de aquí salen los conteos y el filtro por estado.
  const [promotores, celularesVivos, codigosVivos, porRevisar] = await Promise.all([
    alcance.length
      ? prisma.staff.findMany({ where: deAlcance, select: { id: true }, orderBy: { id: 'asc' }, take: TOPE_DE_IDS })
      : Promise.resolve([] as { id: string }[]),
    prisma.celularDeCampo.findMany({
      where: { organizationId, staffIdVinculado: { not: null } },
      select: { staffId: true },
      orderBy: { id: 'asc' },
      take: TOPE_DE_IDS,
    }),
    prisma.codigoDeCelular.findMany({
      where: { organizationId, usadoAt: null, anuladoAt: null, expiraAt: { gt: ahora } },
      select: { staffId: true, codigo: true, expiraAt: true },
      orderBy: { id: 'asc' },
      take: TOPE_DE_IDS,
    }),
    prisma.envioRetenidoDeCampo.count({ where: { organizationId, estado: { in: SIN_RESOLVER }, ...deLasSucursales } }),
  ])
  conTope(promotores, 'promotores', organizationId)
  conTope(celularesVivos, 'celulares vinculados', organizationId)
  conTope(codigosVivos, 'códigos vivos', organizationId)
  const vinculados = new Set(celularesVivos.map(c => c.staffId))
  const conCodigo = new Map(codigosVivos.map(c => [c.staffId, c]))
  const estadoDe = (id: string): EstadoDelPromotor =>
    vinculados.has(id) ? 'ACTIVO' : conCodigo.has(id) ? 'CODIGO_SIN_USAR' : 'SIN_CELULAR'

  const conteos = { ...vacio }
  for (const p of promotores) conteos[estadoDe(p.id)]++
  const ids = promotores.map(p => p.id)

  // La columna de cada fila: los retenidos sin resolver de esos promotores (en las mismas sucursales que el total).
  const retenidos = ids.length
    ? await prisma.envioRetenidoDeCampo.groupBy({
        by: ['staffId'],
        where: { organizationId, staffId: { in: ids }, estado: { in: SIN_RESOLVER }, ...deLasSucursales },
        _count: { _all: true },
      })
    : []
  const porRevisarDe = new Map(retenidos.map(r => [r.staffId, r._count._all]))

  const dePagina = {
    ...deAlcance,
    ...(f.estado ? { id: { in: ids.filter(id => estadoDe(id) === f.estado) } } : {}),
    ...(f.q?.trim() ? { AND: [personSearchWhere(f.q)] } : {}),
  }
  const [total, personas] = alcance.length
    ? await Promise.all([
        prisma.staff.count({ where: dePagina }),
        prisma.staff.findMany({
          where: dePagina,
          select: {
            id: true,
            firstName: true,
            lastName: true,
            phone: true,
            venues: {
              where: filtroDePromotor(alcance),
              select: { id: true, venueId: true, pin: true, venue: { select: { name: true } } },
              orderBy: [{ startDate: 'asc' }, { id: 'asc' }],
            },
          },
          orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }, { id: 'asc' }],
          skip: (f.page - 1) * f.pageSize,
          take: f.pageSize,
        }),
      ])
    : [0, []]

  const paginaIds = personas.map(p => p.id)
  const [celulares, checadas] = paginaIds.length
    ? await Promise.all([
        prisma.celularDeCampo.findMany({
          where: { organizationId, staffIdVinculado: { in: paginaIds } },
          take: paginaIds.length, // uno vinculado por persona (activar desvincula los anteriores), y una página de personas
          select: {
            id: true,
            staffIdVinculado: true,
            marca: true,
            modelo: true,
            versionApp: true,
            createdAt: true,
            vistoAt: true,
            porSubir: true,
          },
        }),
        // Sólo las sucursales de la lista (S4), y sólo la ÚLTIMA de cada persona desde la base (T6): nunca todas sus checadas.
        prisma.$queryRaw<{ staffId: string; venueId: string; clockInTime: Date; clockInLatitude: number | null }[]>(Prisma.sql`
          SELECT DISTINCT ON ("staffId") "staffId", "venueId", "clockInTime", "clockInLatitude"
            FROM "time_entries"
           WHERE "staffId" = ANY(${paginaIds}::text[])
             AND "venueId" = ANY(${alcance}::text[])
             AND "clockInTime" >= ${utcTs(new Date(ahora.getTime() - HORAS_DE_LA_ULTIMA_CHECADA * 3600_000))}
           ORDER BY "staffId", "clockInTime" DESC`),
      ])
    : [[], []]
  const celularDe = new Map(celulares.map(c => [c.staffIdVinculado, c]))
  const checadaDe = new Map(checadas.map(t => [t.staffId, t]))

  const items: FilaDePromotor[] = personas.map(p => {
    const cel = celularDe.get(p.id)
    const cod = conCodigo.get(p.id)
    const chk = checadaDe.get(p.id)
    return {
      staffId: p.id,
      nombre: `${p.firstName} ${p.lastName}`.trim(),
      telefono: p.phone,
      sucursales: p.venues.map(v => ({ venueId: v.venueId, staffVenueId: v.id, nombre: v.venue.name, tienePin: !!v.pin })),
      estado: estadoDe(p.id),
      codigo: cod && !vinculados.has(p.id) ? { codigo: cod.codigo, expiraAt: cod.expiraAt.toISOString() } : null,
      celular: cel
        ? {
            id: cel.id,
            marca: cel.marca,
            modelo: cel.modelo,
            versionApp: cel.versionApp,
            activadoAt: cel.createdAt.toISOString(),
            vistoAt: cel.vistoAt?.toISOString() ?? null,
            porSubir: cel.porSubir,
          }
        : null,
      ultimaChecada: chk ? { at: chk.clockInTime.toISOString(), conUbicacion: chk.clockInLatitude != null, venueId: chk.venueId } : null,
      porRevisar: porRevisarDe.get(p.id) ?? 0,
    }
  })
  return { disponible: true, items, total, conteos, porRevisar }
}

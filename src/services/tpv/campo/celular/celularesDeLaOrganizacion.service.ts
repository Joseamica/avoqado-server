/**
 * La lista de la organización (App de campo, bloque 1): cada promotor con el estado de su celular. El filtro por estado, la
 * búsqueda, el orden y la paginación son del servidor. Nunca devuelve el PIN (sólo si la sucursal ya tiene uno).
 */
import prisma from '@/utils/prismaClient'
import { personSearchWhere } from '@/mcp/personSearch'
import { filtroDePromotor, sucursalesConCampo } from './personasDeCampo'

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

export async function listarCelularesDeCampo(organizationId: string, f: FiltrosDeLaLista) {
  const vacio = { SIN_CELULAR: 0, CODIGO_SIN_USAR: 0, ACTIVO: 0 }
  const conCampo = await sucursalesConCampo(organizationId)
  if (conCampo.length === 0) return { disponible: false, items: [] as FilaDePromotor[], total: 0, conteos: vacio, porRevisar: 0 }

  // Sin `venueId`, toda la organización; una sucursal que no es de campo no tiene promotores.
  const alcance = f.venueId ? conCampo.filter(v => v === f.venueId) : conCampo
  const deAlcance = { active: true, venues: { some: filtroDePromotor(alcance) } }
  const ahora = new Date()

  // Sólo ids (acotados a los promotores de la organización): de aquí salen los conteos y el filtro por estado exactos.
  // ponytail: ids de todos los promotores en memoria; con decenas de miles, pasar a conteos SQL.
  const [promotores, celularesVivos, codigosVivos] = await Promise.all([
    alcance.length ? prisma.staff.findMany({ where: deAlcance, select: { id: true } }) : Promise.resolve([] as { id: string }[]),
    prisma.celularDeCampo.findMany({ where: { organizationId, staffIdVinculado: { not: null } }, select: { staffId: true } }),
    prisma.codigoDeCelular.findMany({
      where: { organizationId, usadoAt: null, anuladoAt: null, expiraAt: { gt: ahora } },
      select: { staffId: true, codigo: true, expiraAt: true },
    }),
  ])
  const vinculados = new Set(celularesVivos.map(c => c.staffId))
  const conCodigo = new Map(codigosVivos.map(c => [c.staffId, c]))
  const estadoDe = (id: string): EstadoDelPromotor =>
    vinculados.has(id) ? 'ACTIVO' : conCodigo.has(id) ? 'CODIGO_SIN_USAR' : 'SIN_CELULAR'

  const conteos = { ...vacio }
  for (const p of promotores) conteos[estadoDe(p.id)]++
  const ids = promotores.map(p => p.id)

  // Retenidos sin resolver de esos promotores: una sola consulta alimenta el total y la columna de cada fila.
  const retenidos = ids.length
    ? await prisma.envioRetenidoDeCampo.groupBy({
        by: ['staffId'],
        where: { organizationId, staffId: { in: ids }, estado: { in: SIN_RESOLVER } },
        _count: { _all: true },
      })
    : []
  const porRevisarDe = new Map(retenidos.map(r => [r.staffId, r._count._all]))
  const porRevisar = retenidos.reduce((s, r) => s + r._count._all, 0)

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
        prisma.timeEntry.findMany({
          where: { staffId: { in: paginaIds }, clockInTime: { gte: new Date(ahora.getTime() - HORAS_DE_LA_ULTIMA_CHECADA * 3600_000) } },
          select: { staffId: true, venueId: true, clockInTime: true, clockInLatitude: true },
          orderBy: { clockInTime: 'desc' },
        }),
      ])
    : [[], []]
  const celularDe = new Map(celulares.map(c => [c.staffIdVinculado, c]))
  const checadaDe = new Map<string, (typeof checadas)[number]>()
  for (const t of checadas) if (!checadaDe.has(t.staffId)) checadaDe.set(t.staffId, t) // la más reciente va primero

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

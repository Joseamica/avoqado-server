import { StaffRole, PlanTier, VenueType, Prisma } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import { venueTypeToCategory } from '../../utils/venueTypeCategory'

export interface AudienceFilters {
  audienceRoles: StaffRole[]
  targetPlanTiers: PlanTier[]
  targetCategories: string[]
  targetVenueIds: string[]
}

export interface AudienceMember {
  staffId: string
  venueId: string
}

/**
 * Construye el filtro de audiencia de un anuncio de plataforma.
 *
 * Todos los ejes son AND; una lista vacía NO agrega su condición ("todos").
 *
 * 🔴 `active: true` en los DOS lados (el vínculo y la persona): sin eso se le reparte
 * a gente dada de baja, y además se le infla el conteo al superadmin antes de publicar.
 */
function buildWhere(f: AudienceFilters): Prisma.StaffVenueWhereInput {
  const venue: Prisma.VenueWhereInput = {}

  if (f.targetVenueIds.length > 0) venue.id = { in: f.targetVenueIds }
  if (f.targetPlanTiers.length > 0) venue.planTier = { in: f.targetPlanTiers }
  if (f.targetCategories.length > 0) {
    const tipos = (Object.keys(venueTypeToCategory) as VenueType[]).filter(t => f.targetCategories.includes(venueTypeToCategory[t]))
    venue.type = { in: tipos }
  }

  return {
    active: true,
    staff: { active: true },
    role: { in: f.audienceRoles },
    venue,
  }
}

/** Pares (persona, venue) a los que se reparte el anuncio. */
export async function resolveAudience(f: AudienceFilters): Promise<AudienceMember[]> {
  const filas = await prisma.staffVenue.findMany({
    where: buildWhere(f),
    select: { staffId: true, venueId: true },
  })
  return filas.map(r => ({ staffId: r.staffId, venueId: r.venueId }))
}

/**
 * Lo que ve el superadmin ANTES de publicar.
 *
 * Son DOS números distintos a propósito: una persona puede administrar varios
 * negocios, así que "37 negocios" y "37 personas" casi nunca coinciden.
 */
export async function countAudience(f: AudienceFilters): Promise<{ venues: number; people: number }> {
  const where = buildWhere(f)
  // 🔴 `groupBy`, NO `distinct`. El `distinct` de Prisma se resuelve EN MEMORIA del
  // cliente salvo que el generator active `nativeDistinct` — y este schema no lo activa,
  // así que habría traído todos los vínculos igual. `groupBy` sí baja a GROUP BY en SQL.
  // Esto corre en cada tecla del compositor: el cliente además debe debouncear.
  const [venues, people] = await Promise.all([
    prisma.staffVenue.groupBy({ by: ['venueId'], where }),
    prisma.staffVenue.groupBy({ by: ['staffId'], where }),
  ])
  return { venues: venues.length, people: people.length }
}

/**
 * ¿Esta persona pertenece de verdad a la audiencia de estos filtros?
 *
 * 🔴 Es la autoridad de lectura de un anuncio, y existe porque la fila de entrega SÍ es
 * fabricable: `POST /dashboard/notifications` (permiso `notifications:send`) acepta
 * `entityType` y `entityId` libres, así que alguien podría crearse una entrega falsa
 * apuntando a un anuncio ajeno. Pertenecer a la audiencia no se puede fabricar.
 */
export async function staffMatchesAudience(staffId: string, f: AudienceFilters): Promise<boolean> {
  const fila = await prisma.staffVenue.findFirst({
    where: { ...buildWhere(f), staffId },
    select: { id: true },
  })
  return Boolean(fila)
}

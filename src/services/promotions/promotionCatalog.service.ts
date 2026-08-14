import prisma from '@/utils/prismaClient'
import { DEFAULT_TIMEZONE, isWithinVenueSchedule } from '@/utils/datetime'

/** Cuánto se adelanta el panel mostrando lo que viene. Más allá, no se muestra. */
const UPCOMING_HORIZON_MS = 4 * 60 * 60 * 1000
/**
 * Paso del recorrido de la ventana. La vigencia se define en minutos ("HH:mm"),
 * así que 5 min no puede saltarse una apertura — y son 48 evaluaciones de una
 * función pura, no queries.
 */
const UPCOMING_SCAN_STEP_MS = 5 * 60 * 1000

export interface PromotionCard {
  id: string
  name: string
  description: string | null
  imageUrl: string | null
  type: string
  pricingMode: string
  priceCents: number
  /** Sólo en las próximas: a qué hora abre, para poder decirlo en la tarjeta. */
  startsAt?: string
  groups: Array<{ id: string; name: string; options: Array<{ id: string; productId: string; priceDeltaCents: number }> }>
}

/**
 * Qué promociones ve el POS: las vigentes ahora y las que abren pronto.
 *
 * Las próximas se muestran apagadas en vez de colapsar el panel. Colapsar
 * recuperaría el 25% de la pantalla pero movería el layout dos veces al día,
 * encogiendo la cuadrícula que el cajero ya tiene memorizada — y decir "a las
 * 6 son 2x1" es una herramienta de venta.
 *
 * 🔴 "Abre pronto" se decide recorriendo TODA la ventana de 4 horas, no
 * muestreando un solo instante (audit 2026-08-13): a las 15:00, una promo de
 * 17:00–18:00 ya volvió a estar cerrada a las 19:00 — el muestreo único la
 * escondía. La vigencia es fechas (validFrom/validUntil) ∧ horario.
 */
export async function listPromotionsForPos(
  venueId: string,
  now: Date = new Date(),
): Promise<{ active: PromotionCard[]; upcoming: PromotionCard[] }> {
  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
  const timezone = venue?.timezone || DEFAULT_TIMEZONE
  const horizonEnd = new Date(now.getTime() + UPCOMING_HORIZON_MS)

  const promotions = await prisma.promotion.findMany({
    where: {
      venueId,
      status: 'PUBLISHED',
      // validFrom hasta el FIN del horizonte: una promo que arranca por fecha
      // dentro de las próximas 4 horas también es "próxima".
      AND: [
        { OR: [{ validFrom: null }, { validFrom: { lte: horizonEnd } }] },
        { OR: [{ validUntil: null }, { validUntil: { gte: now } }] },
      ],
    },
    include: { groups: { include: { options: true }, orderBy: { displayOrder: 'asc' } } },
    orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
  })

  // El orden se garantiza también en memoria: el panel del cajero depende de
  // él y no debe quedar a merced de cómo llegue la lista.
  const ordered = [...promotions].sort((a, b) => a.displayOrder - b.displayOrder || a.name.localeCompare(b.name))

  const isLiveAt = (promotion: (typeof promotions)[number], at: Date): boolean => {
    const withinDates = (!promotion.validFrom || at >= promotion.validFrom) && (!promotion.validUntil || at <= promotion.validUntil)
    return withinDates && isWithinVenueSchedule(promotion, at, timezone)
  }

  const active: PromotionCard[] = []
  const upcoming: PromotionCard[] = []

  for (const promotion of ordered) {
    const card = toCard(promotion)
    if (isLiveAt(promotion, now)) {
      active.push(card)
      continue
    }
    // ¿Abre en algún punto DENTRO del horizonte? Se recorre la ventana con el
    // propio predicado, para no reimplementar la aritmética de horarios.
    for (let t = now.getTime() + UPCOMING_SCAN_STEP_MS; t <= horizonEnd.getTime(); t += UPCOMING_SCAN_STEP_MS) {
      if (isLiveAt(promotion, new Date(t))) {
        upcoming.push({ ...card, startsAt: promotion.timeFrom ?? localHHmm(promotion.validFrom, timezone) })
        break
      }
    }
  }

  return { active, upcoming }
}

/** "HH:mm" de un instante en la zona del venue, para la tarjeta de "próximas". */
function localHHmm(at: Date | null, timezone: string): string | undefined {
  if (!at) return undefined
  try {
    return at.toLocaleTimeString('en-GB', { timeZone: timezone, hour12: false, hour: '2-digit', minute: '2-digit' })
  } catch {
    return undefined
  }
}

function toCard(promotion: any): PromotionCard {
  return {
    id: promotion.id,
    name: promotion.name,
    description: promotion.description,
    imageUrl: promotion.imageUrl,
    type: promotion.type,
    pricingMode: promotion.pricingMode,
    priceCents: promotion.priceCents,
    groups: (promotion.groups ?? []).map((g: any) => ({
      id: g.id,
      name: g.name,
      options: (g.options ?? []).map((o: any) => ({ id: o.id, productId: o.productId, priceDeltaCents: o.priceDeltaCents })),
    })),
  }
}

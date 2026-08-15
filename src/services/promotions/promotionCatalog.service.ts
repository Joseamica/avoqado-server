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
  groups: Array<{
    id: string
    name: string
    options: Array<{
      id: string
      productId: string
      priceDeltaCents: number
      /** Unidades que ENTRAN al carrito (2 en un 2x1). El POS las necesita para el gancho y el preview. */
      quantity: number
      /** Unidades que se COBRAN (1 en un 2x1). */
      chargedQuantity: number
      /** Denormalizados para que la tarjeta se pinte sin cruzar el catálogo local. */
      productName: string
      /** Precio de lista en CENTAVOS. Sólo para el estimado que se muestra; el precio real lo calcula el server al aplicar. */
      productPriceCents: number
    }>
  }>
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
    include: {
      groups: {
        // `venueId` va en el select por la regla dura del repo: toda lectura se
        // verifica contra el tenant. Los FKs Promotion→Venue y
        // PromotionOption→Product son independientes, así que el schema NO
        // garantiza que el producto de una opción sea de este venue (la
        // escritura sí lo valida — esto es el cinturón del lado de lectura).
        include: { options: { include: { product: { select: { name: true, price: true, venueId: true } } } } },
        orderBy: { displayOrder: 'asc' },
      },
    },
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
    const card = toCard(promotion, venueId)
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

/**
 * `venueId` se pasa explícito para poder verificar el tenant del producto de
 * cada opción: es la regla dura del repo y aquí no llega por contexto.
 */
function toCard(promotion: any, venueId: string): PromotionCard {
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
      options: (g.options ?? []).map((o: any) => ({
        id: o.id,
        productId: o.productId,
        priceDeltaCents: o.priceDeltaCents,
        quantity: o.quantity,
        chargedQuantity: o.chargedQuantity,
        // Un producto borrado NO puede dejar al cajero sin panel — y uno de
        // OTRO venue se trata igual que borrado: no se pinta su nombre ni su
        // precio. Nunca se filtra dato de otro tenant por un panel de POS.
        productName: o.product?.venueId === venueId ? (o.product?.name ?? '') : '',
        productPriceCents:
          o.product?.venueId === venueId && o.product?.price != null
            ? // Product.price es Decimal en PESOS -> centavos del contrato POS.
              Math.round(Number(o.product.price) * 100)
            : 0,
      })),
    })),
  }
}

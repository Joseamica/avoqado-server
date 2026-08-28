import prisma from '../../utils/prismaClient'

/**
 * Lo minimo que la pagina publica de la tarjeta necesita ANTES de que el cliente se
 * identifique: como se llama el negocio, su marca, y si de verdad tiene sellos.
 *
 * 🔴 Existe por un defecto real (27-ago). El cartel del mostrador apuntaba al widget
 * de reservas, y ese endpoint tiene un candado deliberado: cuando el negocio apago
 * las reservaciones publicas, se cierra entero. El candado esta bien puesto —evita
 * enseñar un escaparate de citas que rebota al final— pero una tarjeta de sellos no
 * tiene nada que ver con reservar. Testarudo, un café que jamas va a aceptar citas,
 * respondia "Las reservaciones en linea estan deshabilitadas" al escanear su propio
 * cartel. Son 69 de 73 negocios activos los que ni siquiera tienen configuracion de
 * reservas.
 *
 * 🔴 Es publico y sin sesion: SOLO sale lo que ya va impreso en el cartel de la
 * entrada. Nada de clientes, nada de ventas, ningun id interno.
 */
export interface PublicCardInfo {
  venue: { name: string; slug: string; logo: string | null; primaryColor: string | null }
  stampsEnabled: boolean
  stampsRequired: number
  rewardLabel: string
}

export async function getPublicCardInfo(venueSlug: string): Promise<PublicCardInfo | null> {
  const venue = await prisma.venue.findFirst({
    where: { slug: venueSlug, active: true },
    select: { id: true, name: true, slug: true, logo: true, primaryColor: true },
  })
  if (!venue) return null

  const config = await prisma.loyaltyConfig.findUnique({
    where: { venueId: venue.id },
    select: { stampsEnabled: true, stampsRequired: true, stampRewardLabel: true },
  })

  return {
    // Se compone a mano en vez de esparcir `venue`: el `select` de arriba trae el id
    // porque hace falta para la segunda consulta, y esparcirlo lo publicaria.
    venue: { name: venue.name, slug: venue.slug, logo: venue.logo, primaryColor: venue.primaryColor },
    stampsEnabled: !!config?.stampsEnabled,
    stampsRequired: config?.stampsRequired ?? 0,
    rewardLabel: config?.stampRewardLabel ?? '',
  }
}

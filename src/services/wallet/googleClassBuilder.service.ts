import type { CardDesign } from './cardDesign.service'

/**
 * Arma la `loyaltyClass` de un negocio — la PLANTILLA de la que cuelgan las tarjetas
 * de todos sus clientes.
 *
 * 🔴 Lógica PURA a propósito, espejo de `applePassBuilder.service.ts`: no toca red ni
 * credenciales, así que el contenido de la tarjeta se puede probar entero sin una
 * cuenta de emisor.
 *
 * Una clase POR VENUE: cada negocio tiene su nombre, su logo, sus colores y su premio.
 * Referencia: https://developers.google.com/wallet/retail/loyalty-cards
 */

export interface BuildLoyaltyClassArgs {
  issuerId: string
  venueId: string
  venueName: string
  design: CardDesign
  rewardLabel: string
}

/**
 * 🔴 Google exige que el id empiece con el issuer y sólo tenga alfanuméricos, `.`, `_`
 * y `-`. Los `cuid` de Prisma cumplen. El prefijo `venue-` deja legible de qué es cada
 * clase cuando se ven listadas en la consola.
 */
export function googleClassId(issuerId: string, venueId: string): string {
  return `${issuerId}.venue-${venueId}`
}

export function buildLoyaltyClass(args: BuildLoyaltyClassArgs): Record<string, unknown> {
  const { issuerId, venueId, venueName, design, rewardLabel } = args

  return {
    id: googleClassId(issuerId, venueId),
    issuerId,

    // 🔴 Marca blanca: el cliente guarda la tarjeta de SU cafetería, no la de su
    // proveedor de punto de venta. Es la razón por la que este producto se vende.
    issuerName: venueName,
    programName: venueName,

    // 🔴 En modo demo Google acepta la clase con este estado. Al obtener el permiso de
    // publicación pasa a APPROVED sola; mandar APPROVED antes es un error de la API.
    reviewStatus: 'UNDER_REVIEW',

    // Google entiende #RRGGBB directo, a diferencia de Apple que sólo lee rgb(r,g,b).
    hexBackgroundColor: design.backgroundColor,

    // 🔴 Sólo si el negocio subió el suyo. Un `sourceUri.uri` nulo hace que Google
    // rechace la clase entera con un error que no dice cuál campo estaba mal.
    ...(design.logoUrl ? { programLogo: { sourceUri: { uri: design.logoUrl } } } : {}),

    // El reverso: donde el cliente resuelve sus dudas sin preguntarle a nadie. Mismo
    // texto que el `backFields` del pase de Apple, para que las dos tarjetas digan lo
    // mismo.
    textModulesData: [
      {
        header: 'Cómo funciona',
        // 🔴 El premio va TAL CUAL lo escribió el negocio, sin bajarle el caso: es
        // texto libre configurado por el venue (p.ej. "Un café gratis" con mayúscula
        // inicial a propósito), no una palabra gramatical nuestra que podamos doblar.
        body: `Junta tus sellos y obtén ${rewardLabel}. Muestra el código de esta tarjeta al pagar y el negocio te pone tu sello.`,
        id: 'howto',
      },
      {
        header: 'Tus datos',
        body: 'Esta tarjeta la emite Avoqado para el negocio. Puedes eliminarla cuando quieras desde tu cartera.',
        id: 'privacy',
      },
    ],
  }
}

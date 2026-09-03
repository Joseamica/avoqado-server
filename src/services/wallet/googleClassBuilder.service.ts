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
  /** El logo del NEGOCIO (`Venue.logo`), respaldo cuando el diseñador no tiene uno propio. */
  venueLogo: string | null
}

/**
 * 🔴 `programLogo` es REQUIRED en la referencia REST de `LoyaltyClass` de Google — a
 * diferencia de Apple, que acepta un pase sin logo. Mandar la clase sin este campo hace
 * que Google la rechace con un 400 y el cliente vea una página de error al tocar
 * «Guardar mi tarjeta». Este es el ÚLTIMO recorrido de la cadena de respaldo
 * (`design.logoUrl` → `Venue.logo` → este), para el negocio que no subió NINGÚN logo.
 *
 * 🔴 Apple resuelve el mismo problema embebiendo un PNG propio en el `.pkpass`
 * (`avoqadoLogoPng()`); Google en cambio exige una URL PÚBLICA en `sourceUri.uri` — no
 * hay forma de embeber el archivo. Verificado que resuelve (200, `image/png`, 512×512,
 * `access-control-allow-origin: *`) al momento de escribir esto.
 */
export const AVOQADO_FALLBACK_LOGO_URL = 'https://avoqado.io/web-app-manifest-512x512.png'

/**
 * 🔴 Google exige que el id empiece con el issuer y sólo tenga alfanuméricos, `.`, `_`
 * y `-`. Los `cuid` de Prisma cumplen. El prefijo `venue-` deja legible de qué es cada
 * clase cuando se ven listadas en la consola.
 */
export function googleClassId(issuerId: string, venueId: string): string {
  return `${issuerId}.venue-${venueId}`
}

export function buildLoyaltyClass(args: BuildLoyaltyClassArgs): Record<string, unknown> {
  const { issuerId, venueId, venueName, design, rewardLabel, venueLogo } = args

  // 🔴 Cadena de respaldo, de más específico a más general: el logo que el negocio
  // subió en el diseñador de Avoqado, luego el logo general del negocio (`Venue.logo`,
  // que casi todos sí tienen), y sólo si ninguno existe, el de Avoqado. `programLogo`
  // es obligatorio para Google (ver comentario en `AVOQADO_FALLBACK_LOGO_URL`), así que
  // esta cadena SIEMPRE resuelve en una URL — nunca se omite el campo.
  //
  // 🔴 `Venue.logo` puede venir en JPG, y por eso el pase de APPLE no lo usa (Apple sólo
  // acepta PNG en sus assets). Google sí acepta JPG y PNG en `sourceUri`, así que aquí
  // SÍ sirve tal cual — no "corregir" esto copiando el criterio de Apple.
  const logoUrl = design.logoUrl || venueLogo || AVOQADO_FALLBACK_LOGO_URL

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

    // 🔴 SIEMPRE presente: `programLogo` es REQUIRED para Google (a diferencia de Apple).
    // `logoUrl` ya resolvió arriba con la cadena de respaldo, así que nunca es null ni
    // vacío — un `sourceUri.uri` nulo hace que Google rechace la clase entera con un
    // error que no dice cuál campo estaba mal.
    programLogo: { sourceUri: { uri: logoUrl } },

    // El reverso: donde el cliente resuelve sus dudas sin preguntarle a nadie. Mismo
    // texto que el `backFields` del pase de Apple, para que las dos tarjetas digan lo
    // mismo.
    textModulesData: [
      {
        header: 'Cómo funciona',
        // 🔴 En minúscula a propósito, a media frase («…y obtén un café gratis»): es
        // EXACTAMENTE lo que hace `applePassBuilder.service.ts` (línea con
        // `rewardLabel.toLowerCase()`), cuya prueba lo exige igual. Si Google no lo
        // hiciera, el mismo premio se leería "obtén Un café gratis" — una mayúscula a
        // media oración que el cliente lee como falta de ortografía, y las dos
        // tarjetas dirían el premio distinto según el teléfono.
        body: `Junta tus sellos y obtén ${rewardLabel.toLowerCase()}. Muestra el código de esta tarjeta al pagar y el negocio te pone tu sello.`,
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

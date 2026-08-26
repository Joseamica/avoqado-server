/**
 * Arma el JSON de un pase `storeCard` de Apple Wallet — la tarjeta de lealtad del
 * cliente, con la marca del negocio.
 *
 * 🔴 Lógica PURA a propósito: no toca disco, no firma, no lee certificados. Eso vive
 * en `applePassSigner.service.ts`. La separación importa porque el contenido del
 * pase es donde se cometen los errores caros — filtrar un identificador de cliente
 * en un código de barras que cualquiera lee con la cámara, o mandar un color que
 * Apple ignora — y así se puede probar entero sin tener un certificado a la mano.
 *
 * Referencia del formato: https://developer.apple.com/documentation/walletpasses
 */

export interface PassBrand {
  name: string
  logo: string | null
  primaryColor: string | null
  secondaryColor: string | null
}

export interface PassContent {
  stampsEarned: number
  stampsRequired: number
  rewardLabel: string
}

export interface BuildStoreCardArgs {
  brand: PassBrand
  content: PassContent
  serialNumber: string
  authToken: string
  qrToken: string
  passTypeIdentifier: string
  teamIdentifier: string
}

/** Verde de marca de Avoqado, para negocios que no configuraron el suyo. */
const AVOQADO_VERDE = 'rgb(122,221,44)'
const NEGRO = 'rgb(17,17,17)'

/**
 * Apple sólo entiende `rgb(r,g,b)`.
 *
 * 🔴 Un `#hex` NO revienta: Apple lo ignora en silencio y pinta la tarjeta gris.
 * El fallo es invisible en el servidor y sólo aparece cuando alguien abre el pase
 * en un iPhone, que es el peor momento para descubrirlo.
 */
export function hexToRgbCss(hex: string | null, fallback: string): string {
  if (!hex) return fallback
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!match) return fallback
  const n = parseInt(match[1], 16)
  return `rgb(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255})`
}

export function buildStoreCardPass(args: BuildStoreCardArgs): Record<string, unknown> {
  const { brand, content } = args

  return {
    formatVersion: 1,
    passTypeIdentifier: args.passTypeIdentifier,
    teamIdentifier: args.teamIdentifier,

    // 🔴 El par (passTypeIdentifier, serialNumber) es lo que Apple usa para
    // REEMPLAZAR un pase por su versión nueva. Si cualquiera de los dos cambia
    // entre emisiones, el iPhone instala una segunda tarjeta en vez de actualizar
    // la que ya tenía, y el cliente termina con duplicados.
    serialNumber: args.serialNumber,
    authenticationToken: args.authToken,

    // Marca blanca: el cliente guarda la tarjeta de SU cafetería, no la de su
    // proveedor de punto de venta. Es la razón por la que este producto se vende.
    organizationName: brand.name,
    description: `Tarjeta de ${brand.name}`,

    backgroundColor: hexToRgbCss(brand.primaryColor, AVOQADO_VERDE),
    foregroundColor: NEGRO,
    labelColor: NEGRO,

    barcodes: [
      {
        // 🔴 Token opaco, jamás el customerId, el teléfono o el correo. El código
        // de barras de un pase lo puede leer cualquiera que vea la pantalla del
        // cliente — la mesa de al lado incluida.
        message: args.qrToken,
        format: 'PKBarcodeFormatQR',
        // iso-8859-1 es lo que Apple documenta para QR en pases. utf-8 produce
        // códigos que algunos lectores viejos no decodifican.
        messageEncoding: 'iso-8859-1',
      },
    ],

    // 🔴 SIN primaryFields a propósito. En un storeCard con banda, los campos
    // primarios se dibujan ENCIMA de ella — y taparían justo los sellos, que son
    // lo único que el cliente mira. El conteo se va al encabezado, que vive
    // arriba a la derecha, fuera de la banda.
    storeCard: {
      headerFields: [
        {
          key: 'stamps',
          label: 'SELLOS',
          value: `${content.stampsEarned}/${content.stampsRequired}`,
        },
      ],
      secondaryFields: [
        {
          key: 'reward',
          // 🔴 "PREMIO", no "Tu premio": con el placeholder por defecto la etiqueta
          // y el valor salían IDÉNTICOS en la tarjeta ("Tu premio / Tu premio"),
          // que en un iPhone se lee como un error. Sólo se ve renderizando.
          label: 'PREMIO',
          value: content.rewardLabel,
        },
      ],
      // El reverso: donde el cliente resuelve sus dudas sin preguntarle a nadie.
      backFields: [
        {
          key: 'howto',
          label: 'Cómo funciona',
          value:
            `Junta ${content.stampsRequired} sellos y obtén ${content.rewardLabel.toLowerCase()}. ` +
            'Muestra el código de esta tarjeta al pagar y el negocio te pone tu sello.',
        },
        {
          key: 'privacy',
          label: 'Tus datos',
          value: 'Esta tarjeta la emite Avoqado para el negocio. Puedes eliminarla cuando quieras desde tu cartera.',
        },
      ],
    },
  }
}

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

/**
 * Los tres colores que Apple entiende en un `storeCard`. Llegan como argumento y no
 * se leen de la base a proposito: este archivo es logica PURA y probarlo no puede
 * exigir una conexion. Los colores de los SELLOS no viven aqui — van dentro de la
 * imagen de la banda, que dibuja el firmador.
 */
export interface PassColors {
  /** Hex #RRGGBB. Si viene mal formado se cae al token del tema. */
  background: string
  text: string
  label: string
}

export interface BuildStoreCardArgs {
  brand: PassBrand
  /** Omitido = los tokens del tema oscuro de avoqado-android. */
  colors?: PassColors
  /**
   * Dónde puede preguntar el iPhone por los cambios de esta tarjeta.
   *
   * 🔴 Sin esto el aparato NUNCA se registra y la tarjeta se queda con el saldo del
   * momento en que se descargó. No falla ni avisa: sólo no cambia nunca, y eso se
   * descubre semanas después con un cliente reclamando su sello.
   *
   * Se OMITE a propósito cuando no hay una URL que Apple pueda alcanzar (desarrollo):
   * apuntar a algo que no responde deja al iPhone reintentando contra el vacío.
   * Omitirla entrega una tarjeta que simplemente no se auto-actualiza, que es el
   * comportamiento honesto.
   */
  webServiceURL?: string | null
  content: PassContent
  serialNumber: string
  authToken: string
  qrToken: string
  passTypeIdentifier: string
  teamIdentifier: string
}

/**
 * 🔴 Tokens del tema REAL de `avoqado-android` (`designsystem/theme/Color.kt`), no
 * una paleta inventada. Es un sistema estilo iOS: superficies neutras y el verde
 * de marca como ÚNICO acento.
 *
 * El fondo va neutro y no con el color del negocio a propósito: un fondo saturado
 * satura la tarjeta entera y pelea con el contenido. El negocio se ve reflejado en
 * el ACENTO (los sellos), que es donde la mirada cae.
 */
const SURFACE_DARK = 'rgb(28,28,30)' // SurfaceDark
const ON_SURFACE_DARK = 'rgb(255,255,255)' // OnSurfaceDark
const ON_SURFACE_VARIANT_DARK = 'rgb(152,152,157)' // OnSurfaceVariantDark

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

    // Sólo cuando hay una URL pública de verdad. Ver `webServiceURL` arriba.
    ...(args.webServiceURL ? { webServiceURL: args.webServiceURL } : {}),

    // Marca blanca: el cliente guarda la tarjeta de SU cafetería, no la de su
    // proveedor de punto de venta. Es la razón por la que este producto se vende.
    organizationName: brand.name,
    description: `Tarjeta de ${brand.name}`,

    // 🔴 El negocio elige sus colores; el token del tema es la RED DE SEGURIDAD.
    // `hexToRgbCss` devuelve el fallback ante cualquier valor que Apple no entienda,
    // asi que una fila con basura produce una tarjeta con la marca de Avoqado — fea
    // para el negocio, pero legible. Sin fallback produciria una tarjeta GRIS, que
    // es lo que Apple pinta cuando no entiende un color y no avisa de ello.
    backgroundColor: hexToRgbCss(args.colors?.background ?? null, SURFACE_DARK),
    foregroundColor: hexToRgbCss(args.colors?.text ?? null, ON_SURFACE_DARK),
    // Las etiquetas en gris secundario: el valor es lo que se lee, la etiqueta
    // sólo lo acompaña. Igualarlas hace que la tarjeta se vea plana y ruidosa.
    labelColor: hexToRgbCss(args.colors?.label ?? null, ON_SURFACE_VARIANT_DARK),

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

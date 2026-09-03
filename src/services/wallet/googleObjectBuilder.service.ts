import { googleClassId } from './googleClassBuilder.service'

/**
 * Arma el `loyaltyObject` de un cliente — SU tarjeta, colgada de la clase del negocio.
 *
 * 🔴 Lógica PURA, espejo de `applePassBuilder.service.ts`.
 *
 * 🔴 La decisión que sostiene el diseño: los sellos van dibujados en el `heroImage`, y
 * su URL lleva DENTRO la revisión del pase. Google no documenta si refresca una imagen
 * cuando el contenido cambia en la misma dirección; versionar la URL elimina la
 * dependencia en vez de apostarle. Cada sello sube `revision`, la dirección cambia, y
 * Google se ve obligado a redescargar.
 */

export interface BuildLoyaltyObjectArgs {
  issuerId: string
  venueId: string
  walletPassId: string
  /** El mismo `serialNumber` del `WalletPass`. No es secreto y no sirve para sellar. */
  serialNumber: string
  qrToken: string
  revision: number
  /** Raíz pública del API, p.ej. `https://api.avoqado.io`. */
  baseUrl: string
  content: { stampsEarned: number; stampsRequired: number; rewardLabel: string }
}

export function googleObjectId(issuerId: string, walletPassId: string): string {
  return `${issuerId}.pass-${walletPassId}`
}

/**
 * 🔴 Se usa `serialNumber` y NO `qrToken`: el qrToken es el secreto que identifica al
 * cliente para sellar, y esta URL la descargan los servidores de Google. El serial es
 * un uuid aleatorio que no sirve para sellar a nadie, y la imagen no lleva datos
 * personales — sólo sellos dibujados.
 */
export function stampStripUrl(baseUrl: string, serialNumber: string, revision: number): string {
  // 🔴 `\/+$` (no `\/$`): una base mal configurada con MÁS de una diagonal final
  // (`https://api.avoqado.io//`) no puede colarse hasta la URL que Google descarga.
  return `${baseUrl.replace(/\/+$/, '')}/api/v1/public/wallet/stamps/${serialNumber}/${revision}.png`
}

export function buildLoyaltyObject(args: BuildLoyaltyObjectArgs): Record<string, unknown> {
  const { issuerId, venueId, walletPassId, serialNumber, qrToken, revision, baseUrl, content } = args

  return {
    id: googleObjectId(issuerId, walletPassId),
    classId: googleClassId(issuerId, venueId),
    state: 'ACTIVE',

    // El avance, escrito igual que en el encabezado del pase de Apple.
    loyaltyPoints: {
      label: 'SELLOS',
      balance: { string: `${content.stampsEarned}/${content.stampsRequired}` },
    },

    barcode: {
      type: 'QR_CODE',
      // 🔴 Token opaco, jamás el customerId ni el teléfono: el código de barras lo
      // puede leer cualquiera que vea la pantalla del cliente.
      value: qrToken,
      alternateText: '',
    },

    // La franja con los sellos dibujados: lo que hace que la tarjeta de Android se vea
    // igual que la del iPhone.
    heroImage: { sourceUri: { uri: stampStripUrl(baseUrl, serialNumber, revision) } },

    textModulesData: [{ header: 'Tu premio', body: content.rewardLabel, id: 'reward' }],
  }
}

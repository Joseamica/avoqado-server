import { randomBytes, randomUUID } from 'crypto'
import { WalletPlatform } from '@prisma/client'
import prisma from '../../utils/prismaClient'

/**
 * Emisión y resolución de pases de cartera (Apple Wallet / Google Wallet).
 *
 * Los dos tokens que se generan aquí son secretos DISTINTOS y no intercambiables:
 *
 * - `qrToken` viaja dentro del código de barras y lo puede leer cualquiera que vea
 *   la pantalla del cliente. Sirve para identificarlo en la caja, y por eso es
 *   rotable: al canjear un premio se cambia.
 * - `authToken` viaja dentro del archivo del pase y es lo que Apple presenta al
 *   servidor para pedir actualizaciones (Plan C). Nunca se muestra en pantalla.
 *
 * Reusar el mismo valor para ambos entregaría la llave de actualización a quien le
 * tome una foto al código de barras.
 */

/** 24 bytes → 48 hex. Suficiente para que adivinarlo no sea una estrategia. */
function opaqueSecret(): string {
  return randomBytes(24).toString('hex')
}

/**
 * Emite (o recupera) el pase de Apple de un cliente en un negocio.
 *
 * 🔴 Idempotente por (venueId, customerId, APPLE) a propósito. El cliente va a tocar
 * "agregar a mi cartera" más de una vez — desde el recibo, desde un correo, por
 * curiosidad — y no puede terminar con tres tarjetas del mismo café. Es la queja
 * recurrente de los productos de este tipo.
 *
 * El filtro incluye `platform` y `active`: sin `platform` devolvería el pase de
 * Google como si fuera el de Apple; sin `active` reviviría uno revocado a propósito.
 */
export async function issueApplePass(venueId: string, customerId: string) {
  const existing = await prisma.walletPass.findFirst({
    where: { venueId, customerId, platform: WalletPlatform.APPLE, active: true },
  })
  if (existing) {
    return {
      id: existing.id,
      serialNumber: existing.serialNumber,
      qrToken: existing.qrToken,
      authToken: existing.authToken,
    }
  }

  const created = await prisma.walletPass.create({
    data: {
      venueId,
      customerId,
      platform: WalletPlatform.APPLE,
      // El serial identifica el pase ante Apple de por vida. Un uuid evita que dos
      // venues generen el mismo por coincidencia de contadores.
      serialNumber: `AVQ-${randomUUID()}`,
      authToken: opaqueSecret(),
      qrToken: opaqueSecret(),
    },
  })

  return {
    id: created.id,
    serialNumber: created.serialNumber,
    qrToken: created.qrToken,
    authToken: created.authToken,
  }
}

/**
 * Resuelve un pase desde el token que venía en el QR escaneado.
 *
 * 🔴 Filtra por `active`. Desactivar un pase tiene que dejarlo inservible para
 * sellar; si este filtro se cae, un pase revocado sigue funcionando en la caja.
 */
export async function findPassByQrToken(qrToken: string) {
  return prisma.walletPass.findFirst({ where: { qrToken, active: true } })
}

import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { getReceiptLayout } from './receiptLayout.service'

/**
 * Lo que del venue necesita el ENCABEZADO del ticket en los aparatos (spec § 7.3).
 *
 * 🔴 Un solo `select` y un solo constructor para mobile Y para la PAX. Si cada uno armara lo
 * suyo, las tablets y la terminal imprimirían distinto y los casos dorados NO lo cazarían:
 * los goldens prueban el intérprete, no el transporte.
 */
export const RECEIPT_VENUE_SELECT = {
  name: true,
  logo: true,
  phone: true,
  address: true,
  city: true,
  state: true,
  zipCode: true,
  // Columnas LEGACY: son la tercera fuente del RFC y lo que la PAX imprime hoy (spec § 5.6).
  rfc: true,
  legalName: true,
  fiscalEmisors: {
    orderBy: { createdAt: 'asc' as const },
    select: {
      id: true,
      legalName: true,
      rfc: true,
      lugarExpedicion: true,
      merchantConfigs: { select: { merchantAccountId: true } },
    },
  },
} as const

type VenueDelRecibo = {
  name: string
  logo: string | null
  phone: string | null
  address: string | null
  city: string | null
  state: string | null
  zipCode: string | null
  rfc: string | null
  legalName: string | null
  fiscalEmisors: Array<{
    id: string
    legalName: string
    rfc: string
    lugarExpedicion: string | null
    merchantConfigs: Array<{ merchantAccountId: string | null }>
  }>
}

/**
 * 🔴 ADITIVO: `legalName`, `rfc` y `lugarExpedicion` siguen siendo los del emisor PRINCIPAL,
 * byte a byte como antes — hay apps instaladas en la calle que los leen. Lo nuevo
 * (`fiscalEmisors`, `principalEmisorId`, `legacy`) se añade al lado para que la app pueda
 * elegir el emisor de la venta (spec § 5.6).
 */
export function buildReceiptInfo(venue: VenueDelRecibo) {
  // 🔴 Defensivo a propósito: este payload NO puede tirar. Un emisor sin `merchantConfigs`
  // (una consulta parcial, un dato viejo) reventaría el mapeo y el POS se quedaría sin
  // receiptInfo EN SILENCIO — y sin encabezado no hay ticket fiscal.
  const emisores = venue.fiscalEmisors ?? []
  const principal = emisores[0]
  return {
    name: venue.name ?? null,
    logoUrl: venue.logo ?? null,
    phone: venue.phone ?? null,
    address: venue.address ?? null,
    city: venue.city ?? null,
    state: venue.state ?? null,
    zipCode: venue.zipCode ?? null,
    // — los tres de siempre —
    legalName: principal?.legalName ?? null,
    rfc: principal?.rfc ?? null,
    lugarExpedicion: principal?.lugarExpedicion ?? null,
    // — lo nuevo, aditivo —
    fiscalEmisors: emisores.map(e => ({
      id: e.id ?? null,
      legalName: e.legalName,
      rfc: e.rfc,
      lugarExpedicion: e.lugarExpedicion ?? null,
      merchantAccountIds: (e.merchantConfigs ?? []).map(m => m.merchantAccountId).filter((id): id is string => Boolean(id)),
    })),
    principalEmisorId: principal?.id ?? null,
    legacy: { legalName: venue.legalName ?? null, rfc: venue.rfc ?? null },
  }
}

export type ReceiptInfoPayload = ReturnType<typeof buildReceiptInfo>

export interface DeviceReceiptPayload {
  receiptInfo?: ReceiptInfoPayload
  receiptLayout?: { schemaVersion: number; revision: number; blocks: unknown[] }
}

/**
 * Los dos bloques del ticket que viajan a los aparatos, en UNA llamada.
 *
 * 🔴 Tolerante a fallos por diseño: si algo no se puede resolver, el campo se OMITE y la
 * respuesta sale igual. Un POS sin sus settings no puede cobrar; sin diseño imprime su
 * canónica embebida. Nunca se cambia un fallo de ticket por un fallo de cobro.
 */
export async function getDeviceReceiptPayload(venueId: string): Promise<DeviceReceiptPayload> {
  const [venue, layout] = await Promise.all([
    prisma.venue.findUnique({ where: { id: venueId }, select: RECEIPT_VENUE_SELECT }).catch(error => {
      logger.error('No se pudo resolver el encabezado del ticket; la respuesta sale sin receiptInfo', { venueId, error })
      return null
    }),
    getReceiptLayout(venueId)
      .then(l => ({ schemaVersion: l.schemaVersion, revision: l.revision, blocks: l.blocks as unknown[] }))
      .catch(error => {
        logger.error('No se pudo resolver el diseño del ticket; la respuesta sale sin receiptLayout', { venueId, error })
        return null
      }),
  ])

  return {
    ...(venue ? { receiptInfo: buildReceiptInfo(venue as VenueDelRecibo) } : {}),
    ...(layout ? { receiptLayout: layout } : {}),
  }
}

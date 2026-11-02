// src/services/customer-display/venueSignatures.ts
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { RECEIPT_ASSOCIATION_COLUMNS, RECEIPT_EMISOR_COLUMNS } from '@/services/dashboard/receiptLayout/devicePayload.service'

/**
 * Las firmas del venue que alimentan la huella `settings` (spec §5.7.4), en UNA sola sentencia con subconsultas
 * escalares: Prisma no tiene `relationJoins`, así que un select anidado serían varias consultas por poll.
 *
 * Índices que usa (existen): `Venue` PK, `VenueSettings.venueId` único, `ReceiptLayout.venueId` único,
 * `FiscalEmisor(venueId)` y `MerchantFiscalConfig(fiscalEmisorId)`. El plan se mide en la Task 13.
 *
 * 🔴 Por qué un hash del CONTENIDO y no `count + max(updatedAt)` (hallazgo E3 de la 5ª ronda): `@updatedAt` lo pone el
 * reloj de la aplicación; una transacción que confirma tarde puede no mover el máximo, y una baja más un alta conservan el
 * conteo. El hash depende de lo que hay: detecta altas, bajas, ediciones, reasignaciones y borrados en cascada.
 */

export interface VenueSignatures {
  /** `Venue.updatedAt` (cubre nombre, logo, dirección, zona horaria, RFC legado). */
  venueAt: string
  /** `VenueSettings.updatedAt`. */
  settingsAt: string | null
  /** `"id:revision"` — el id importa: restablecer el ticket BORRA la fila y la nueva vuelve a la revisión 1. */
  receiptLayout: string | null
  /** md5 del contenido de los emisores que consume el recibo, en su orden total. */
  emisores: string
  /** md5 de las asociaciones comercio-emisor de ESOS emisores. */
  asociaciones: string
}

const IDENTIFICADOR = /^[A-Za-z][A-Za-z0-9]*$/

/** Columnas CONSTANTES del código, nunca del cliente; aun así se validan, porque van crudas al texto de la sentencia. */
function columnas(alias: 'e' | 'm', nombres: readonly string[]): Prisma.Sql {
  for (const nombre of nombres) if (!IDENTIFICADOR.test(nombre)) throw new Error(`venueSignatures: columna inválida «${nombre}»`)
  return Prisma.raw(nombres.map(nombre => `${alias}."${nombre}"`).join(', '))
}

/**
 * Cada emisor: lo que consume el recibo MÁS `createdAt`, que decide el orden y con él el emisor PRINCIPAL.
 * `json_build_array` distingue null de vacío y no depende de separadores.
 */
const COLUMNAS_DEL_EMISOR = columnas('e', ['id', 'createdAt', ...RECEIPT_EMISOR_COLUMNS.filter(c => c !== 'id')])
/** Cada asociación: su id, su emisor (una reasignación cambia la firma) y lo que consume el recibo. */
const COLUMNAS_DE_LA_ASOCIACION = columnas('m', ['id', 'fiscalEmisorId', ...RECEIPT_ASSOCIATION_COLUMNS])

/** 🔴 El orden TOTAL de los emisores — el mismo del recibo (`RECEIPT_VENUE_SELECT`, Task 2). */
export const ORDEN_DE_EMISORES = Prisma.sql`e."createdAt", e.id`

export function venueSignaturesSql(venueId: string): Prisma.Sql {
  return Prisma.sql`
    SELECT
      v."updatedAt" AS venue_at,
      (SELECT s."updatedAt" FROM "VenueSettings" s WHERE s."venueId" = v.id) AS settings_at,
      (SELECT r.id || ':' || r.revision FROM "ReceiptLayout" r WHERE r."venueId" = v.id) AS receipt_layout,
      (SELECT md5(coalesce(string_agg(json_build_array(${COLUMNAS_DEL_EMISOR})::text, ',' ORDER BY ${ORDEN_DE_EMISORES}), ''))
         FROM "FiscalEmisor" e WHERE e."venueId" = v.id) AS emisores,
      (SELECT md5(coalesce(string_agg(json_build_array(${COLUMNAS_DE_LA_ASOCIACION})::text, ','
                    ORDER BY m."fiscalEmisorId", m."merchantAccountId", m.id), ''))
         FROM "MerchantFiscalConfig" m JOIN "FiscalEmisor" e ON e.id = m."fiscalEmisorId"
        WHERE e."venueId" = v.id) AS asociaciones
    FROM "Venue" v
    WHERE v.id = ${venueId}
  `
}

interface FilaDeFirmas {
  venue_at: Date
  settings_at: Date | null
  receipt_layout: string | null
  emisores: string
  asociaciones: string
}

/**
 * ⚠️ `Venue.updatedAt` y `VenueSettings.updatedAt` son `@updatedAt` de Prisma: un `UPDATE` escrito a mano no los mueve
 * (declarado en el spec §5.7.4). Para UNA sola fila basta `updatedAt` porque se compara por igualdad, no por orden.
 *
 * @returns `null` si el venue no existe.
 */
export async function readVenueSignatures(venueId: string): Promise<VenueSignatures | null> {
  const [fila] = await prisma.$queryRaw<FilaDeFirmas[]>(venueSignaturesSql(venueId))
  if (!fila) return null
  return {
    venueAt: fila.venue_at.toISOString(),
    settingsAt: fila.settings_at ? fila.settings_at.toISOString() : null,
    receiptLayout: fila.receipt_layout,
    emisores: fila.emisores,
    asociaciones: fila.asociaciones,
  }
}

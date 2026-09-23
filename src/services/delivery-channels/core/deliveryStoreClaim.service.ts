/**
 * Reclamar la tienda ANTES del HTTP y finalizar por CAS — spec 2026-09-21 §4.2/§4.3.
 *
 * POR QUÉ EXISTE: activar una tienda de Uber le manda sus pedidos a UN negocio. Comprobar
 * «nadie más la tiene» con una lectura y luego escribir deja una ventana en la que dos
 * negocios llegan a `pos_data` con la misma tienda, y una revocación (`store.deprovisioned`)
 * que cae entre `pos_data` y la escritura local quedaba pisada: el consentimiento revocado
 * se volvía a otorgar en silencio. Ahora:
 *
 *   1. RECLAMAR (una transacción): el vínculo se crea o se toma con `activatingIntentId`
 *      condicionado ⇒ otro negocio da `OTHER_VENUE`, otro intent `CLAIMED_BY_OTHER`, sin HTTP.
 *      La `revocationVersion` reclamada se guarda EN EL INTENT la primera vez y se reutiliza
 *      en toda recuperación: nunca se relee del vínculo.
 *   2. `pos_data` (lo hace el controlador, fuera de toda transacción).
 *   3. FINALIZAR por CAS sobre intent + dueño + versión: una revocación intermedia gana.
 *
 * Cada efecto va en una transacción que PRIMERO bloquea el intent y comprueba que esta
 * ejecución sigue siendo la dueña del lease: una ejecución muerta no escribe nada.
 */
import crypto from 'crypto'
import { DeliveryChannelStatus, DeliveryConnectIntent, DeliveryProvider, Prisma } from '@prisma/client'

import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import { utcTs } from '@/utils/sqlDates'

import { casEstado, type EstadoIntent } from './deliveryConnectIntent.service'

const PROVIDER = DeliveryProvider.UBER_EATS
type Tx = Prisma.TransactionClient

/** Resultados finales que puede dar una tienda (sólo `LOCAL_WRITE_FAILED` se reintenta). */
export type OutcomeTienda =
  | 'ACTIVATED'
  | 'OTHER_VENUE'
  | 'CLAIMED_BY_OTHER'
  | 'EXCLUDED_BY_ENV'
  | 'POS_DATA_FAILED'
  | 'REVOKED_MEANWHILE'
  | 'LOCAL_WRITE_FAILED'

/**
 * Corre `fn` en una transacción que primero hace `SELECT … FOR UPDATE` del intent exigiendo
 * `ACTIVATING`, este dueño y lease vivo. Sin fila ⇒ `null` y no se escribió nada.
 */
async function bajoLease<T extends object>(intentId: string, owner: string, fn: (tx: Tx) => Promise<T>): Promise<T | null> {
  return prisma.$transaction(async tx => {
    const vivo = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "DeliveryConnectIntent"
       WHERE "id" = ${intentId} AND "state" = 'ACTIVATING'
         AND "activationOwner" = ${owner} AND "activationLeaseUntil" > ${utcTs(new Date())}
       FOR UPDATE`
    return vivo.length === 1 ? fn(tx) : null
  })
}

/** Merge ANIDADO en `resultsJson[storeId]`: lo anotado antes (la versión reclamada) sobrevive. */
export function anotarSql(intentId: string, storeId: string, parcial: Record<string, unknown>): Prisma.Sql {
  return Prisma.sql`
    UPDATE "DeliveryConnectIntent"
       SET "resultsJson" = COALESCE("resultsJson", '{}'::jsonb) || jsonb_build_object(
             ${storeId}::text, COALESCE("resultsJson" -> ${storeId}::text, '{}'::jsonb) || ${JSON.stringify(parcial)}::jsonb),
           "updatedAt" = ${utcTs(new Date())}
     WHERE "id" = ${intentId}`
}

const conResultado = (tx: Tx, intentId: string, storeId: string, outcome: OutcomeTienda) =>
  tx.$executeRaw(anotarSql(intentId, storeId, { outcome, at: new Date().toISOString() }))

/** Suelta la reclamación de ESTE intent y ESTE dueño, sin tocar `status` ni consentimiento. */
const soltar = (tx: Tx, intentId: string, owner: string, storeId: string) =>
  tx.deliveryChannelLink.updateMany({
    where: { provider: PROVIDER, externalLocationId: storeId, activatingIntentId: intentId, activationOwner: owner },
    data: { activatingIntentId: null, activationOwner: null },
  })

type Intent = Pick<DeliveryConnectIntent, 'id' | 'venueId' | 'orderAcceptanceMode' | 'environment' | 'clientId'>

export type Reclamo =
  | { tipo: 'MUERTA' } // esta ejecución perdió el lease: ni HTTP ni escrituras
  | { tipo: 'FINAL'; outcome: 'OTHER_VENUE' | 'CLAIMED_BY_OTHER' | 'REVOKED_MEANWHILE' }
  | { tipo: 'RECLAMADA'; version: number; linkId: string }

/** Paso 1 (§4.3): reclamación atómica. Sólo `RECLAMADA` autoriza a llamar a `pos_data`. */
export async function reclamarTienda(intent: Intent, owner: string, storeId: string, nombre: string | null): Promise<Reclamo> {
  const r = await bajoLease<Reclamo>(intent.id, owner, async tx => {
    // INSERT … ON CONFLICT DO NOTHING: si otra transacción la está insertando, ésta ESPERA a
    // que confirme y no hace nada (el `upsert` de Prisma no es atómico entre transacciones).
    await tx.deliveryChannelLink.createMany({
      data: [
        {
          venueId: intent.venueId,
          provider: PROVIDER,
          externalLocationId: storeId,
          externalAccountId: nombre,
          webhookSecret: crypto.randomBytes(32).toString('hex'),
          orderAcceptanceMode: intent.orderAcceptanceMode,
          status: DeliveryChannelStatus.PENDING,
        },
      ],
      skipDuplicates: true,
    })
    // 🔴 La reclamación: mismo negocio Y (libre o ya de este intent). Una recuperación del
    // mismo intent la re-reclama con SU dueño; el CAS de la ejecución anterior deja de pasar.
    const { count } = await tx.deliveryChannelLink.updateMany({
      where: {
        provider: PROVIDER,
        externalLocationId: storeId,
        venueId: intent.venueId,
        OR: [{ activatingIntentId: null }, { activatingIntentId: intent.id }],
      },
      data: { activatingIntentId: intent.id, activationOwner: owner },
    })
    // Con la fila ya bloqueada por el UPDATE, esta lectura es la que cuenta.
    const link = await tx.deliveryChannelLink.findUniqueOrThrow({
      where: { provider_externalLocationId: { provider: PROVIDER, externalLocationId: storeId } },
      select: { id: true, venueId: true, revocationVersion: true },
    })
    if (count === 0) {
      const outcome = link.venueId !== intent.venueId ? 'OTHER_VENUE' : 'CLAIMED_BY_OTHER'
      await conResultado(tx, intent.id, storeId, outcome)
      return { tipo: 'FINAL', outcome }
    }

    const [fila] = await tx.$queryRaw<{ v: number | null }[]>`
      SELECT ("resultsJson" -> ${storeId}::text ->> 'claimedRevocationVersion')::int AS v
        FROM "DeliveryConnectIntent" WHERE "id" = ${intent.id}`
    if (fila?.v == null) {
      await tx.$executeRaw(anotarSql(intent.id, storeId, { claimedRevocationVersion: link.revocationVersion }))
      return { tipo: 'RECLAMADA', version: link.revocationVersion, linkId: link.id }
    }
    // Recuperación: la versión es la que el dueño consintió, no la de ahora. Si cambió, hubo una
    // revocación de por medio y reconectar exige un consentimiento NUEVO — sin HTTP.
    if (fila.v !== link.revocationVersion) {
      await soltar(tx, intent.id, owner, storeId)
      await conResultado(tx, intent.id, storeId, 'REVOKED_MEANWHILE')
      return { tipo: 'FINAL', outcome: 'REVOKED_MEANWHILE' }
    }
    return { tipo: 'RECLAMADA', version: fila.v, linkId: link.id }
  })
  return r ?? { tipo: 'MUERTA' }
}

/**
 * Paso 3 (§4.3): finalización por CAS. `null` ⇒ la ejecución perdió el lease (la recuperación
 * repetirá 2–3). count 0 ⇒ una revocación o una reclamación ajena se cruzó: `REVOKED_MEANWHILE`,
 * sin consentimiento.
 */
export async function finalizarTienda(
  intent: Intent,
  owner: string,
  storeId: string,
  version: number,
): Promise<'ACTIVATED' | 'REVOKED_MEANWHILE' | null> {
  const r = await bajoLease(intent.id, owner, async tx => {
    const { count } = await tx.deliveryChannelLink.updateMany({
      where: {
        provider: PROVIDER,
        externalLocationId: storeId,
        venueId: intent.venueId,
        activatingIntentId: intent.id,
        activationOwner: owner,
        revocationVersion: version,
        status: { in: [DeliveryChannelStatus.PENDING, DeliveryChannelStatus.ACTIVE, DeliveryChannelStatus.DISABLED] },
      },
      data: {
        status: DeliveryChannelStatus.ACTIVE,
        ownerAuthorizedAt: new Date(),
        ownerAuthorizedEnvironment: intent.environment,
        ownerAuthorizedStoreId: storeId,
        ownerAuthorizedClientId: intent.clientId,
        ownerAuthorizedByIntentId: intent.id,
        orderAcceptanceMode: intent.orderAcceptanceMode,
        activatingIntentId: null,
        activationOwner: null,
      },
    })
    const outcome: 'ACTIVATED' | 'REVOKED_MEANWHILE' = count === 1 ? 'ACTIVATED' : 'REVOKED_MEANWHILE'
    if (count === 0) await soltar(tx, intent.id, owner, storeId)
    await conResultado(tx, intent.id, storeId, outcome)
    return { outcome }
  })
  return r?.outcome ?? null
}

/** `pos_data` falló: resultado final y la tienda queda libre para un intent nuevo. `false` ⇒ lease perdido. */
export async function liberarReclamo(intentId: string, owner: string, storeId: string, outcome: OutcomeTienda): Promise<boolean> {
  const r = await bajoLease(intentId, owner, async tx => {
    await soltar(tx, intentId, owner, storeId)
    await conResultado(tx, intentId, storeId, outcome)
    return {}
  })
  return r !== null
}

// ─── Job diario (§4.1 final) ────────────────────────────────────────────────────────────

const LOTE = 100
const RONDAS = 20
const PURGA_MS = 7 * 24 * 3_600_000
const VIVOS: EstadoIntent[] = ['CREATED', 'EXCHANGED', 'ACTIVATING']

/**
 * 1) Vencidos ⇒ `EXPIRED` por `casEstado` (borra el token), salvo un lease VIVO: esa corrida
 *    termina y el vencido se toma mañana. 2) Reclamaciones de intents que ya no pueden tener
 *    lease (terminales o purgados) ⇒ liberadas. 3) Terminales de más de 7 días ⇒ borrados.
 * Todo por lotes; el orden importa: se libera ANTES de purgar.
 */
export async function limpiarIntents(ahora = new Date()): Promise<{ vencidos: number; liberadas: number; purgados: number }> {
  let vencidos = 0
  for (let ronda = 0; ronda < RONDAS; ronda++) {
    const lote = await prisma.deliveryConnectIntent.findMany({
      where: {
        state: { in: VIVOS },
        expiresAt: { lt: ahora },
        OR: [{ activationLeaseUntil: null }, { activationLeaseUntil: { lt: ahora } }],
      },
      select: { id: true },
      take: LOTE,
    })
    for (const { id } of lote) {
      const leaseMuerto = { OR: [{ activationLeaseUntil: null }, { activationLeaseUntil: { lt: ahora } }] }
      if (await casEstado(id, VIVOS, 'EXPIRED', { failureReason: 'EXPIRED' }, { expiresAt: { lt: ahora }, ...leaseMuerto })) vencidos++
    }
    if (lote.length < LOTE) break
  }

  // ponytail: sin índice en `activatingIntentId` — una fila por tienda conectada y casi todas en
  // NULL; si la tabla pasa de ~10^5, índice parcial `WHERE "activatingIntentId" IS NOT NULL`.
  const liberadas = await prisma.$executeRaw`
    UPDATE "DeliveryChannelLink" l
       SET "activatingIntentId" = NULL, "activationOwner" = NULL, "updatedAt" = ${utcTs(ahora)}
     WHERE l."id" IN (
       SELECT l2."id" FROM "DeliveryChannelLink" l2
        WHERE l2."activatingIntentId" IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM "DeliveryConnectIntent" i
                           WHERE i."id" = l2."activatingIntentId" AND i."state" IN ('CREATED','EXCHANGED','ACTIVATING'))
        LIMIT 500)`

  let purgados = 0
  for (let ronda = 0; ronda < RONDAS; ronda++) {
    const lote = await prisma.deliveryConnectIntent.findMany({
      where: { state: { in: ['CONSUMED', 'FAILED', 'EXPIRED'] }, expiresAt: { lt: new Date(ahora.getTime() - PURGA_MS) } },
      select: { id: true },
      take: LOTE,
    })
    if (lote.length) purgados += (await prisma.deliveryConnectIntent.deleteMany({ where: { id: { in: lote.map(x => x.id) } } })).count
    if (lote.length < LOTE) break
  }

  if (vencidos || liberadas || purgados) logger.info('🛵 [UberConnect] limpieza diaria de intents', { vencidos, liberadas, purgados })
  return { vencidos, liberadas, purgados }
}

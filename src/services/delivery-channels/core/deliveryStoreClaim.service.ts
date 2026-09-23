/**
 * Reclamar la tienda ANTES del HTTP y finalizar por CAS — spec 2026-09-21 §4.2/§4.3.
 *
 * POR QUÉ EXISTE: activar una tienda de Uber le manda sus pedidos a UN negocio. Comprobar
 * «nadie más la tiene» con una lectura y luego escribir deja una ventana en la que dos
 * negocios llegan a `pos_data` con la misma tienda, y una revocación (`store.deprovisioned`)
 * que cae entre `pos_data` y la escritura local quedaba pisada: el consentimiento revocado
 * se volvía a otorgar en silencio. Ahora:
 *
 *   0. AL CONSENTIR (la selección del dueño): se congela la `revocationVersion` de cada tienda
 *      elegida. Ésa es la versión consentida, no la que haya cuando le toque su turno.
 *   1. RECLAMAR (una transacción): el vínculo se crea o se toma con `activatingIntentId`
 *      condicionado ⇒ otro negocio da `OTHER_VENUE`, otro intent VIVO `CLAIMED_BY_OTHER`, sin
 *      HTTP. Si la versión actual ya no es la consentida ⇒ `REVOKED_MEANWHILE`, sin HTTP.
 *   2. `pos_data` (lo hace el controlador, fuera de toda transacción); su éxito se anota
 *      (`posDataOk`) y una recuperación con la misma versión no lo repite.
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

import { casEstado, ESTADOS_VIVOS, mezclaResultadoSql } from './deliveryConnectIntent.service'

const PROVIDER = DeliveryProvider.UBER_EATS
type Tx = Prisma.TransactionClient
/** El SQL de «intent que todavía puede tener lease», armado de la MISMA lista que el TS. */
const vivosSql = Prisma.join([...ESTADOS_VIVOS])

/** Resultados que puede dar una tienda (sólo `LOCAL_WRITE_FAILED` se reintenta). */
export type OutcomeTienda =
  | 'ACTIVATED'
  | 'OTHER_VENUE'
  | 'CLAIMED_BY_OTHER'
  | 'EXCLUDED_BY_ENV'
  | 'POS_DATA_FAILED'
  | 'REVOKED_MEANWHILE'
  | 'LOCAL_WRITE_FAILED'
export type ResultadoFinal = { outcome: OutcomeTienda } & Record<string, unknown>

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

const anotar = (tx: Tx, intentId: string, storeId: string, parcial: Record<string, unknown>) =>
  tx.$executeRaw`UPDATE "DeliveryConnectIntent" SET "resultsJson" = ${mezclaResultadoSql(storeId, parcial)},
    "updatedAt" = ${utcTs(new Date())} WHERE "id" = ${intentId}`

const conResultado = (tx: Tx, intentId: string, storeId: string, r: ResultadoFinal) =>
  anotar(tx, intentId, storeId, { ...r, at: new Date().toISOString() })

/** Lo que el intent ya sabe de ESA tienda: versión consentida, si `pos_data` pasó, si esta reclamación creó el vínculo. */
async function leerTienda(tx: Tx, intentId: string, storeId: string) {
  const [f] = await tx.$queryRaw<{ v: number | null; ok: boolean | null; creo: boolean | null }[]>`
    SELECT ("resultsJson" -> ${storeId}::text ->> 'claimedRevocationVersion')::int AS v,
           ("resultsJson" -> ${storeId}::text ->> 'posDataOk')::boolean AS ok,
           ("resultsJson" -> ${storeId}::text ->> 'creoVinculo')::boolean AS creo
      FROM "DeliveryConnectIntent" WHERE "id" = ${intentId}`
  return { version: f?.v ?? null, posDataOk: f?.ok === true, creoVinculo: f?.creo === true }
}

type Intent = Pick<DeliveryConnectIntent, 'id' | 'venueId' | 'orderAcceptanceMode' | 'environment' | 'clientId'>

/**
 * Suelta la reclamación de ESTE intent y ESTE dueño, sin tocar `status` ni consentimiento. Si
 * esta misma reclamación CREÓ la fila y sigue PENDING sin consentimiento, la borra: un intento
 * fallido no deja la tienda atada a este negocio (otro negocio la podría conectar después).
 */
async function soltar(tx: Tx, intent: Pick<Intent, 'id' | 'venueId'>, owner: string, storeId: string): Promise<void> {
  const mia = { provider: PROVIDER, externalLocationId: storeId, activatingIntentId: intent.id, activationOwner: owner }
  if ((await leerTienda(tx, intent.id, storeId)).creoVinculo) {
    const { count } = await tx.deliveryChannelLink.deleteMany({
      where: { ...mia, venueId: intent.venueId, status: DeliveryChannelStatus.PENDING, ownerAuthorizedAt: null },
    })
    if (count === 1) return
  }
  await tx.deliveryChannelLink.updateMany({ where: mia, data: { activatingIntentId: null, activationOwner: null } })
}

// ─── 0. Al consentir ────────────────────────────────────────────────────────────────────

/**
 * La selección del dueño: CAS `EXCHANGED → ACTIVATING` guardando la selección Y la
 * `revocationVersion` de cada tienda en ese instante (spec §4.3, M7 de la revisión). Una
 * revocación entre este clic y el turno de la tienda N se detecta: la reclamación compara contra
 * esto, no contra lo que haya después. Tienda sin vínculo todavía ⇒ 0 (la fila nacerá en 0).
 */
export async function seleccionarTiendas(intentId: string, storeIds: string[]): Promise<boolean> {
  const links = await prisma.deliveryChannelLink.findMany({
    where: { provider: PROVIDER, externalLocationId: { in: storeIds } },
    select: { externalLocationId: true, revocationVersion: true },
    take: storeIds.length,
  })
  const version = new Map(links.map(l => [l.externalLocationId, l.revocationVersion]))
  const consentidas = Object.fromEntries(storeIds.map(s => [s, { claimedRevocationVersion: version.get(s) ?? 0 }]))
  return casEstado(intentId, 'EXCHANGED', 'ACTIVATING', { selectionJson: storeIds, resultsJson: consentidas })
}

// ─── 1. Reclamar ────────────────────────────────────────────────────────────────────────

export type Reclamo =
  | { tipo: 'MUERTA' } // esta ejecución perdió el lease: ni HTTP ni escrituras
  | { tipo: 'FINAL'; outcome: 'OTHER_VENUE' | 'CLAIMED_BY_OTHER' | 'REVOKED_MEANWHILE' }
  | { tipo: 'RECLAMADA'; version: number; linkId: string; posDataOk: boolean }

/**
 * Si la tienda la tiene otro intent que ya pasó su vencimiento con el lease muerto, se vence
 * AQUÍ con el mismo `casEstado` del job (borra su token). Sin esto, un enlace abandonado dejaba
 * la tienda en `CLAIMED_BY_OTHER` hasta el job de las 04:17 — incluso para el mismo negocio.
 * Un dueño que se acaba de recuperar tiene lease vivo: el CAS no lo toca.
 */
async function vencerDuenoAbandonado(intentId: string, storeId: string): Promise<void> {
  const link = await prisma.deliveryChannelLink.findUnique({
    where: { provider_externalLocationId: { provider: PROVIDER, externalLocationId: storeId } },
    select: { activatingIntentId: true },
  })
  const dueno = link?.activatingIntentId
  if (!dueno || dueno === intentId) return
  const ahora = new Date()
  const vencido = await casEstado(
    dueno,
    [...ESTADOS_VIVOS],
    'EXPIRED',
    { failureReason: 'EXPIRED' },
    {
      expiresAt: { lt: ahora },
      OR: [{ activationLeaseUntil: null }, { activationLeaseUntil: { lt: ahora } }],
    },
  )
  if (vencido) logger.info('🛵 [UberConnect] intent abandonado vencido al reclamar su tienda', { intentId: dueno, storeId, por: intentId })
}

/** Paso 1 (§4.3): reclamación atómica. Sólo `RECLAMADA` autoriza a llamar a `pos_data`. */
export async function reclamarTienda(intent: Intent, owner: string, storeId: string, nombre: string | null): Promise<Reclamo> {
  await vencerDuenoAbandonado(intent.id, storeId)
  const r = await bajoLease<Reclamo>(intent.id, owner, async tx => {
    // INSERT … ON CONFLICT DO NOTHING: si otra transacción la está insertando, ésta ESPERA a
    // que confirme y no hace nada (el `upsert` de Prisma no es atómico entre transacciones).
    const { count: creada } = await tx.deliveryChannelLink.createMany({
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
    // 🔴 La reclamación: mismo negocio Y (libre, ya de este intent, o de un intent que ya no
    // puede tener lease). Una recuperación del mismo intent la re-reclama con SU dueño; el CAS de
    // la ejecución anterior deja de pasar. Un dueño VIVO la conserva ⇒ `CLAIMED_BY_OTHER`.
    const tomada = await tx.$executeRaw`
      UPDATE "DeliveryChannelLink" l
         SET "activatingIntentId" = ${intent.id}, "activationOwner" = ${owner}, "updatedAt" = ${utcTs(new Date())}
       WHERE l."provider" = 'UBER_EATS' AND l."externalLocationId" = ${storeId} AND l."venueId" = ${intent.venueId}
         AND (l."activatingIntentId" IS NULL OR l."activatingIntentId" = ${intent.id}
              OR NOT EXISTS (SELECT 1 FROM "DeliveryConnectIntent" i
                              WHERE i."id" = l."activatingIntentId" AND i."state" IN (${vivosSql})))`
    // Con la fila ya bloqueada por el UPDATE, esta lectura es la que cuenta.
    const link = await tx.deliveryChannelLink.findUniqueOrThrow({
      where: { provider_externalLocationId: { provider: PROVIDER, externalLocationId: storeId } },
      select: { id: true, venueId: true, revocationVersion: true },
    })
    if (tomada === 0) {
      const outcome = link.venueId !== intent.venueId ? 'OTHER_VENUE' : 'CLAIMED_BY_OTHER'
      await conResultado(tx, intent.id, storeId, { outcome })
      return { tipo: 'FINAL', outcome }
    }
    if (creada === 1) await anotar(tx, intent.id, storeId, { creoVinculo: true })

    const previo = await leerTienda(tx, intent.id, storeId)
    // Intent de antes de congelar la versión al consentir: la de ahora (compatibilidad).
    if (previo.version === null) {
      await anotar(tx, intent.id, storeId, { claimedRevocationVersion: link.revocationVersion })
      return { tipo: 'RECLAMADA', version: link.revocationVersion, linkId: link.id, posDataOk: false }
    }
    // La versión es la que el dueño consintió, no la de ahora. Si cambió, hubo una revocación
    // de por medio y reconectar exige un consentimiento NUEVO — sin HTTP.
    if (previo.version !== link.revocationVersion) {
      await soltar(tx, intent, owner, storeId)
      await conResultado(tx, intent.id, storeId, { outcome: 'REVOKED_MEANWHILE' })
      return { tipo: 'FINAL', outcome: 'REVOKED_MEANWHILE' }
    }
    return { tipo: 'RECLAMADA', version: previo.version, linkId: link.id, posDataOk: previo.posDataOk }
  })
  return r ?? { tipo: 'MUERTA' }
}

// ─── 2. `pos_data` ──────────────────────────────────────────────────────────────────────

/** `pos_data` pasó: se anota bajo el lease para que una recuperación con la misma versión no lo repita. */
export async function anotarPosDataOk(intentId: string, owner: string, storeId: string): Promise<boolean> {
  return (await bajoLease(intentId, owner, async tx => (await anotar(tx, intentId, storeId, { posDataOk: true }), {}))) !== null
}

/** `pos_data` falló: resultado final y la tienda queda libre para un enlace nuevo. `false` ⇒ lease perdido. */
export async function liberarReclamo(
  intent: Pick<Intent, 'id' | 'venueId'>,
  owner: string,
  storeId: string,
  r: ResultadoFinal,
): Promise<boolean> {
  const hecho = await bajoLease(intent.id, owner, async tx => {
    await soltar(tx, intent, owner, storeId)
    await conResultado(tx, intent.id, storeId, r)
    return {}
  })
  return hecho !== null
}

// ─── 3. Finalizar ───────────────────────────────────────────────────────────────────────

/**
 * Paso 3 (§4.3): finalización por CAS. `null` ⇒ la ejecución perdió el lease (la recuperación
 * repite). count 0 ⇒ una revocación o una reclamación ajena se cruzó: `REVOKED_MEANWHILE`, sin
 * consentimiento.
 *
 * ⚠️ Desviación deliberada del spec (M2 de la revisión, decisión del coordinador): un vínculo
 * PAUSED del mismo negocio que se reconecta recibe el consentimiento y SIGUE en pausa
 * (`sigueEnPausa`). El spec lo excluía de la finalización y el dueño veía «Uber retiró el permiso»
 * sobre una tienda que sólo estaba pausada.
 */
export async function finalizarTienda(
  intent: Intent,
  owner: string,
  storeId: string,
  version: number,
): Promise<{ outcome: 'ACTIVATED' | 'REVOKED_MEANWHILE'; sigueEnPausa?: true } | null> {
  return bajoLease(intent.id, owner, async tx => {
    const donde = {
      provider: PROVIDER,
      externalLocationId: storeId,
      venueId: intent.venueId,
      activatingIntentId: intent.id,
      activationOwner: owner,
      revocationVersion: version,
    }
    const consentimiento = {
      ownerAuthorizedAt: new Date(),
      ownerAuthorizedEnvironment: intent.environment,
      ownerAuthorizedStoreId: storeId,
      ownerAuthorizedClientId: intent.clientId,
      ownerAuthorizedByIntentId: intent.id,
      orderAcceptanceMode: intent.orderAcceptanceMode,
      activatingIntentId: null,
      activationOwner: null,
    }
    const activos = [DeliveryChannelStatus.PENDING, DeliveryChannelStatus.ACTIVE, DeliveryChannelStatus.DISABLED]
    let r: { outcome: 'ACTIVATED' | 'REVOKED_MEANWHILE'; sigueEnPausa?: true } = { outcome: 'ACTIVATED' }
    if (
      (
        await tx.deliveryChannelLink.updateMany({
          where: { ...donde, status: { in: activos } },
          data: { ...consentimiento, status: 'ACTIVE' },
        })
      ).count === 0
    ) {
      const pausada = await tx.deliveryChannelLink.updateMany({
        where: { ...donde, status: DeliveryChannelStatus.PAUSED },
        data: consentimiento,
      })
      r = pausada.count === 1 ? { outcome: 'ACTIVATED', sigueEnPausa: true } : { outcome: 'REVOKED_MEANWHILE' }
    }
    if (r.outcome === 'REVOKED_MEANWHILE') await soltar(tx, intent, owner, storeId)
    await conResultado(tx, intent.id, storeId, r)
    return r
  })
}

// ─── Job diario (§4.1 final) ────────────────────────────────────────────────────────────

const LOTE = 100
const RONDAS = 20
const PURGA_MS = 7 * 24 * 3_600_000

/**
 * 1) Vencidos ⇒ `EXPIRED` por `casEstado` (borra el token), salvo un lease VIVO: esa corrida
 *    termina y el vencido se toma mañana. 2) Reclamaciones de intents que ya no pueden tener
 *    lease (terminales o purgados) ⇒ liberadas. 3) Terminales de más de 7 días ⇒ borrados.
 * Todo por lotes; el orden importa: se libera ANTES de purgar.
 */
export async function limpiarIntents(ahora = new Date()): Promise<{ vencidos: number; liberadas: number; purgados: number }> {
  const leaseMuerto = { OR: [{ activationLeaseUntil: null }, { activationLeaseUntil: { lt: ahora } }] }
  let vencidos = 0
  for (let ronda = 0; ronda < RONDAS; ronda++) {
    const lote = await prisma.deliveryConnectIntent.findMany({
      where: { state: { in: [...ESTADOS_VIVOS] }, expiresAt: { lt: ahora }, ...leaseMuerto },
      select: { id: true },
      take: LOTE,
    })
    for (const { id } of lote) {
      if (await casEstado(id, [...ESTADOS_VIVOS], 'EXPIRED', { failureReason: 'EXPIRED' }, { expiresAt: { lt: ahora }, ...leaseMuerto }))
        vencidos++
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
                           WHERE i."id" = l2."activatingIntentId" AND i."state" IN (${vivosSql}))
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

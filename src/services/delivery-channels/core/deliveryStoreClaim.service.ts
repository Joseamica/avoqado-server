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
 *
 * 🔴 La revocación se cuenta DOS veces a propósito (P1-3 de la auditoría final): en el vínculo
 * (`revocationVersion`) y POR TIENDA (`DeliveryStoreRevocation`), porque un `deprovisioned` puede llegar
 * cuando la tienda todavía no tiene vínculo. Se congelan las dos al consentir y se comparan las dos al
 * reclamar y al finalizar. Orden de candados en TODOS los caminos: revocación de la tienda → vínculo.
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

/** La versión POR TIENDA que el dueño consintió (null = intent anterior a P1-3). */
async function tiendaConsentida(tx: Tx, intentId: string, storeId: string): Promise<number | null> {
  const [f] = await tx.$queryRaw<{ v: number | null }[]>`
    SELECT ("resultsJson" -> ${storeId}::text ->> 'claimedStoreRevocation')::int AS v
      FROM "DeliveryConnectIntent" WHERE "id" = ${intentId}`
  return f?.v ?? null
}

/** Clave del registro por tienda: sin espacios ni mayúsculas (el webhook y `/stores` podrían no coincidir en caso). */
const claveTienda = (storeId: string) => storeId.trim().toLowerCase()

/**
 * Revocaciones registradas de la tienda AHORA. Crea la fila en 0 si no existe y la lee `FOR SHARE`: así
 * se serializa con `revocarTienda` (que la sube ANTES de buscar el vínculo) aunque la tienda no tenga
 * vínculo todavía. Va antes de tocar el vínculo, en el mismo orden que `revocarTienda`: sin ciclos.
 */
async function revocacionesDeLaTienda(tx: Tx, storeId: string): Promise<number> {
  const clave = claveTienda(storeId)
  await tx.$executeRaw`
    INSERT INTO "DeliveryStoreRevocation" ("provider", "externalLocationId") VALUES ('UBER_EATS', ${clave})
    ON CONFLICT DO NOTHING`
  const [f] = await tx.$queryRaw<{ version: number }[]>`
    SELECT "version" FROM "DeliveryStoreRevocation"
     WHERE "provider" = 'UBER_EATS' AND "externalLocationId" = ${clave} FOR SHARE`
  return f.version
}

/**
 * `store.deprovisioned` (spec §4.2, P1-3): la revocación se registra POR TIENDA exista o no el vínculo, y
 * en la MISMA transacción se deshabilita el vínculo que haya (DISABLED, sin los cinco campos de
 * consentimiento, `revocationVersion + 1`). Antes, sin vínculo el evento se tiraba y la tienda se
 * re-otorgaba al nacer. Devuelve los vínculos deshabilitados.
 *
 * ponytail: `lower(btrim(...))` sin índice — una fila por tienda conectada y el evento es raro.
 */
export async function revocarTienda(storeId: string): Promise<Array<{ id: string; venueId: string }>> {
  const clave = claveTienda(storeId)
  const ahora = new Date()
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`
      INSERT INTO "DeliveryStoreRevocation" ("provider", "externalLocationId", "version", "revokedAt")
      VALUES ('UBER_EATS', ${clave}, 1, ${utcTs(ahora)})
      ON CONFLICT ("provider", "externalLocationId")
      DO UPDATE SET "version" = "DeliveryStoreRevocation"."version" + 1, "revokedAt" = EXCLUDED."revokedAt"`
    return tx.$queryRaw<Array<{ id: string; venueId: string }>>`
      UPDATE "DeliveryChannelLink"
         SET "status" = 'DISABLED', "ownerAuthorizedAt" = NULL, "ownerAuthorizedEnvironment" = NULL,
             "ownerAuthorizedStoreId" = NULL, "ownerAuthorizedClientId" = NULL, "ownerAuthorizedByIntentId" = NULL,
             "revocationVersion" = "revocationVersion" + 1, "updatedAt" = ${utcTs(ahora)}
       WHERE "provider" = 'UBER_EATS' AND lower(btrim("externalLocationId")) = ${clave}
       RETURNING "id", "venueId"`
  })
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
  const [links, porTienda] = await Promise.all([
    prisma.deliveryChannelLink.findMany({
      where: { provider: PROVIDER, externalLocationId: { in: storeIds } },
      select: { externalLocationId: true, revocationVersion: true },
      take: storeIds.length,
    }),
    prisma.deliveryStoreRevocation.findMany({
      where: { provider: PROVIDER, externalLocationId: { in: storeIds.map(claveTienda) } },
      select: { externalLocationId: true, version: true },
      take: storeIds.length,
    }),
  ])
  const version = new Map(links.map(l => [l.externalLocationId, l.revocationVersion]))
  const deTienda = new Map(porTienda.map(r => [r.externalLocationId, r.version]))
  const consentidas = Object.fromEntries(
    storeIds.map(s => [s, { claimedRevocationVersion: version.get(s) ?? 0, claimedStoreRevocation: deTienda.get(claveTienda(s)) ?? 0 }]),
  )
  return casEstado(intentId, 'EXCHANGED', 'ACTIVATING', { selectionJson: storeIds, resultsJson: consentidas })
}

/**
 * M-3: el vínculo que CREÓ un intent muerto (ya no vivo), del mismo negocio, que sigue PENDING y nunca
 * se consintió se BORRA — la misma regla que `soltar`. Liberarlo nada más dejaba la tienda atada a ese
 * negocio y el dueño de verdad recibía OTHER_VENUE («contacta a Avoqado»). Las condiciones van sobre la
 * FILA (EXISTS correlacionado): si otra reclamación la tomó mientras tanto, Postgres re-evalúa con la
 * fila nueva y no la borra.
 */
async function borrarVinculosDeMuertos(soloIntent?: string): Promise<number> {
  const deUno = soloIntent ? Prisma.sql`AND i."id" = ${soloIntent}` : Prisma.empty
  return prisma.$executeRaw`
    DELETE FROM "DeliveryChannelLink" l
     WHERE l."status" = 'PENDING' AND l."ownerAuthorizedAt" IS NULL
       AND EXISTS (SELECT 1 FROM "DeliveryConnectIntent" i
                    WHERE i."id" = l."activatingIntentId" AND i."venueId" = l."venueId"
                      AND i."state" NOT IN (${vivosSql}) ${deUno}
                      AND (i."resultsJson" -> l."externalLocationId" ->> 'creoVinculo')::boolean IS TRUE)`
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
  // Dueño muerto (recién vencido, FAILED o EXPIRED) que creó la fila sin consentirla: se borra ya, sin
  // esperar al job — si no, OTRO negocio recibiría OTHER_VENUE por una fila huérfana (M-3).
  if (await borrarVinculosDeMuertos(dueno)) logger.info('🛵 [UberConnect] vínculo huérfano de un intent muerto borrado', { intentId: dueno, storeId })
}

/** Paso 1 (§4.3): reclamación atómica. Sólo `RECLAMADA` autoriza a llamar a `pos_data`. */
export async function reclamarTienda(intent: Intent, owner: string, storeId: string, nombre: string | null): Promise<Reclamo> {
  await vencerDuenoAbandonado(intent.id, storeId)
  const r = await bajoLease<Reclamo>(intent.id, owner, async tx => {
    const tiendaAhora = await revocacionesDeLaTienda(tx, storeId) // ANTES del vínculo (orden de candados)
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
      await anotar(tx, intent.id, storeId, { claimedRevocationVersion: link.revocationVersion, claimedStoreRevocation: tiendaAhora })
      return { tipo: 'RECLAMADA', version: link.revocationVersion, linkId: link.id, posDataOk: false }
    }
    const deTienda = await tiendaConsentida(tx, intent.id, storeId)
    if (deTienda === null) await anotar(tx, intent.id, storeId, { claimedStoreRevocation: tiendaAhora }) // intent anterior a P1-3
    // Las versiones son las que el dueño consintió, no las de ahora. Si cualquiera cambió, hubo una
    // revocación de por medio (con o sin vínculo) y reconectar exige un consentimiento NUEVO — sin HTTP.
    if (previo.version !== link.revocationVersion || (deTienda !== null && deTienda !== tiendaAhora)) {
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
    // Una revocación registrada sólo POR TIENDA (el webhook buscó el vínculo antes de que existiera)
    // también gana; se lee antes de tocar el vínculo (orden de candados).
    const tiendaAhora = await revocacionesDeLaTienda(tx, storeId)
    const deTienda = await tiendaConsentida(tx, intent.id, storeId)
    const revocadaPorTienda = deTienda !== null && deTienda !== tiendaAhora
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
    if (revocadaPorTienda) r = { outcome: 'REVOKED_MEANWHILE' }
    else if (
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
 *    lease (terminales o purgados) ⇒ la fila que ese intent CREÓ sin consentir se borra (M-3), las
 *    demás se liberan. 3) Terminales de más de 7 días ⇒ borrados.
 * Todo por lotes; el orden importa: se libera ANTES de purgar.
 */
export async function limpiarIntents(
  ahora = new Date(),
): Promise<{ vencidos: number; borradas: number; liberadas: number; purgados: number }> {
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
  // Primero se borran las filas que un intent muerto CREÓ sin consentir (M-3); después se liberan las demás.
  const borradas = await borrarVinculosDeMuertos()
  const liberadas = await prisma.$executeRaw`
    UPDATE "DeliveryChannelLink" l
       SET "activatingIntentId" = NULL, "activationOwner" = NULL, "updatedAt" = ${utcTs(ahora)}
     WHERE l."id" IN (
       SELECT l2."id" FROM "DeliveryChannelLink" l2
        WHERE l2."activatingIntentId" IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM "DeliveryConnectIntent" i
                           WHERE i."id" = l2."activatingIntentId" AND i."state" IN (${vivosSql}))
        LIMIT 500)
       -- sobre la FILA también: si una reclamación viva la tomó mientras tanto, no se le quita
       AND NOT EXISTS (SELECT 1 FROM "DeliveryConnectIntent" i
                        WHERE i."id" = l."activatingIntentId" AND i."state" IN (${vivosSql}))`

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

  if (vencidos || borradas || liberadas || purgados)
    logger.info('🛵 [UberConnect] limpieza diaria de intents', { vencidos, borradas, liberadas, purgados })
  return { vencidos, borradas, liberadas, purgados }
}

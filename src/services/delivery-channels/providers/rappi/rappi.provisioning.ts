/**
 * Aprovisionar tiendas de Rappi y confirmar el resultado — el corazón del self-onboarding.
 *
 * 🔴 Cuatro reglas que no se negocian:
 *  1. El vínculo se RECLAMA (PENDING, bajo `FOR UPDATE`) antes del HTTP: una tienda de otro negocio,
 *     o reclamada por otra intención viva, se resuelve sin llamar a Rappi (el dueño con dos negocios).
 *  2. La reclamación vive en `config.rappiProvisioning` (R3), NUNCA en `activatingIntentId`: el job de
 *     limpieza compartido con Uber sólo toca vínculos con `activatingIntentId`, y aquí la confirmación
 *     es ASÍNCRONA — un vínculo esperando a Rappi no puede desaparecer. Se MEZCLA en `config` (ahí
 *     también vive `rappiPendingMenuHash`), jamás lo reemplaza.
 *  3. Una confirmación sólo PROMUEVE un vínculo que nosotros reclamamos, y tiene que PROBARLO (R7): el
 *     mismo lote, o la misma intención + el mismo `integrationId`. Jamás crea uno.
 *  4. Un resultado final no se degrada (R5): la escritura lo exige en su propio `WHERE`, porque el
 *     webhook y el re-chequeo de la pantalla de resultado corren a la vez y el que falla tarde no puede
 *     deshacer al que ganó.
 *
 * El webhook y el re-chequeo llaman a la MISMA `confirmarTienda`: idempotente, porque llegan los dos.
 */
import crypto from 'crypto'
import { DeliveryChannelStatus, DeliveryConnectIntent, Prisma } from '@prisma/client'

import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import { utcTs } from '@/utils/sqlDates'

import { casEstado, ESTADOS_VIVOS, mezclaResultadoSql } from '../../core/deliveryConnectIntent.service'
import { TTL_ACTIVANDO_MS } from './rappi.connect'
import { assertTiendaEscribible, RappiEscrituraBloqueadaError } from './rappi.http'
import { enLotes, type RespuestaAprovisionamiento, type ResultadoRappiTienda, type TiendaRappi } from './rappi.selfOnboarding'

export interface ProvisioningDeps {
  aprovisionar(idToken: string, tiendas: Array<{ storeId: string; name: string }>): Promise<RespuestaAprovisionamiento>
  suscribir(storeId: string): Promise<{ ok: boolean; fallidos: string[] }>
  tiendasEscribibles: readonly string[]
}
/** Lo que ya no cambia. Los otros tres (PROVISIONING, UNCERTAIN, SUBSCRIBE_FAILED) todavía esperan a Rappi. */
const FINALES = [
  'ACTIVATED',
  'OTHER_VENUE',
  'ALREADY_CONNECTED',
  'CLAIMED_BY_OTHER',
  'NOT_ENABLED_FOR_PILOT',
  'REJECTED',
  'FAILED',
] as const
export type OutcomeRappi = 'PROVISIONING' | 'UNCERTAIN' | 'SUBSCRIBE_FAILED' | (typeof FINALES)[number]
export type ResultadoRappi = { outcome: OutcomeRappi; detalle?: string }
export type Confirmacion = 'PROMOTED' | 'REMOVED' | 'DISABLED' | 'IGNORED' | 'SUBSCRIBE_FAILED'
/** ÚNICA definición de «final»: la usan el cierre del intent y la página de resultado. */
export const esFinal = (o: unknown): boolean => (FINALES as readonly unknown[]).includes(o)

/**
 * La reclamación, dentro de `config`. `creado` = la fila la insertó una reclamación de Rappi (se puede
 * borrar al deshacerla); si no, `statusPrevio` dice a qué estado vuelve — un vínculo DISABLED que se
 * reconecta trae historial de pedidos y config, y un rechazo de Rappi no puede llevárselos.
 * `confirmedAt` = ya confirmada (una confirmación repetida se reconoce y no alarma).
 */
type Aprov = {
  intentId: string
  since: string
  batchId?: string
  integrationId?: string
  creado?: true
  statusPrevio?: DeliveryChannelStatus
  confirmedAt?: string
}
type Fila = { id: string; venueId: string; status: DeliveryChannelStatus; config: Prisma.JsonValue }
type Tx = Prisma.TransactionClient

const objeto = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
function aprov(config: unknown): Aprov | null {
  const a = objeto(config).rappiProvisioning as Aprov | undefined
  return a && typeof a.intentId === 'string' && a.intentId ? a : null
}
/** Reemplaza SÓLO `rappiProvisioning` (o lo quita con `null`); el resto de `config` queda intacto. */
function conAprov(config: unknown, a: Aprov | null): Prisma.InputJsonValue {
  const { rappiProvisioning: _viejo, ...resto } = objeto(config)
  return (a ? { ...resto, rappiProvisioning: a } : resto) as Prisma.InputJsonValue
}

/** El candado de fila: toda decisión sobre un vínculo de Rappi se toma con la fila bloqueada. */
async function leerVinculo(tx: Tx, storeId: string): Promise<Fila | null> {
  const [fila] = await tx.$queryRaw<Fila[]>`
    SELECT "id", "venueId", "status", "config" FROM "DeliveryChannelLink"
     WHERE "provider" = 'RAPPI' AND "externalLocationId" = ${storeId} FOR UPDATE`
  return fila ?? null
}

/** Merge atómico en `resultsJson[storeId]` que NO pisa un resultado final (el `WHERE` lo exige). Sin `creoVinculo`, nunca. */
async function anotar(tx: Tx, intentId: string, storeId: string, r: ResultadoRappi): Promise<boolean> {
  const n = await tx.$executeRaw`
    UPDATE "DeliveryConnectIntent"
       SET "resultsJson" = ${mezclaResultadoSql(storeId, r)}, "updatedAt" = ${utcTs(new Date())}
     WHERE "id" = ${intentId}
       AND COALESCE("resultsJson" -> ${storeId}::text ->> 'outcome', '') NOT IN (${Prisma.join([...FINALES])})`
  return n === 1
}

function escribible(storeId: string, autorizadas: readonly string[]): boolean {
  try {
    assertTiendaEscribible(storeId, autorizadas) // el MISMO criterio que la capa baja: un lote nunca lo rechaza entero
    return true
  } catch {
    return false
  }
}

// ─── Reclamar y enviar ──────────────────────────────────────────────────────────────────

async function intentVivo(tx: Tx, id: string): Promise<boolean> {
  const i = await tx.deliveryConnectIntent.findUnique({ where: { id }, select: { state: true, expiresAt: true } })
  return !!i && (ESTADOS_VIVOS as readonly string[]).includes(i.state) && i.expiresAt.getTime() > Date.now()
}

/** R4: INSERT … ON CONFLICT DO NOTHING, luego la fila BLOQUEADA decide. El resultado se anota en la misma transacción. */
async function reclamar(intent: DeliveryConnectIntent, t: TiendaRappi): Promise<ResultadoRappi> {
  return prisma.$transaction(async tx => {
    const { count: creada } = await tx.deliveryChannelLink.createMany({
      data: [
        {
          venueId: intent.venueId,
          provider: 'RAPPI',
          externalLocationId: t.storeId,
          externalAccountId: t.name,
          webhookSecret: crypto.randomBytes(32).toString('hex'),
          orderAcceptanceMode: intent.orderAcceptanceMode,
          status: DeliveryChannelStatus.PENDING,
          ownerAuthorizedAt: new Date(),
          activatingIntentId: null,
        },
      ],
      skipDuplicates: true,
    })
    const fila = await leerVinculo(tx, t.storeId)
    if (!fila) throw new Error('RAPPI_RECLAMO_SIN_FILA') // tras el INSERT no puede faltar: fallo local, sin HTTP

    const previo = aprov(fila.config)
    let r: ResultadoRappi
    if (fila.venueId !== intent.venueId) r = { outcome: 'OTHER_VENUE' }
    // PAUSED también está conectada (la pausó el negocio): reaprovisionar la dejaría PENDING.
    else if (fila.status === DeliveryChannelStatus.ACTIVE || fila.status === DeliveryChannelStatus.PAUSED)
      r = { outcome: 'ALREADY_CONNECTED' }
    else if (previo && previo.intentId !== intent.id && !previo.confirmedAt && (await intentVivo(tx, previo.intentId)))
      r = { outcome: 'CLAIMED_BY_OTHER' }
    else {
      // Libre, de este intent, de uno muerto, o DISABLED. La reclamación NUEVA reemplaza entera a la vieja:
      // un `batchId` de antes no puede confirmar esta.
      const creado = creada === 1 || (fila.status === DeliveryChannelStatus.PENDING && previo?.creado === true)
      await tx.deliveryChannelLink.update({
        where: { id: fila.id },
        data: {
          status: DeliveryChannelStatus.PENDING,
          config: conAprov(fila.config, {
            intentId: intent.id,
            since: new Date().toISOString(),
            ...(creado ? { creado: true as const } : { statusPrevio: fila.status }),
          }),
        },
      })
      r = { outcome: 'PROVISIONING' }
    }
    await anotar(tx, intent.id, t.storeId, r) // R5: todo lo elegido queda escrito ANTES del HTTP
    return r
  })
}

/** Deshacer una reclamación: borra la fila que creamos, o devuelve la ajena a su estado. */
async function soltar(tx: Tx, fila: Fila, a: Aprov): Promise<void> {
  if (a.creado) await tx.deliveryChannelLink.delete({ where: { id: fila.id } })
  else
    await tx.deliveryChannelLink.update({
      where: { id: fila.id },
      data: { status: a.statusPrevio ?? DeliveryChannelStatus.DISABLED, config: conAprov(fila.config, null) },
    })
}

/** Bajo el candado: `tocar` sólo si la fila sigue PENDING y reclamada por ESTE intent; el resultado se anota igual. */
async function bajoReclamo(
  intentId: string,
  storeId: string,
  tocar: ((tx: Tx, fila: Fila, a: Aprov) => Promise<unknown>) | null,
  r?: ResultadoRappi,
): Promise<void> {
  await prisma.$transaction(async tx => {
    const fila = await leerVinculo(tx, storeId)
    const a = aprov(fila?.config)
    if (tocar && fila?.status === DeliveryChannelStatus.PENDING && a?.intentId === intentId) await tocar(tx, fila, a)
    if (r) await anotar(tx, intentId, storeId, r)
  })
}

/** Guarda la prueba de correlación (R7) para el webhook y el re-chequeo. Un valor vacío no se guarda. */
const correlacionar = (batchId?: string, integrationId?: string) => (tx: Tx, fila: Fila, a: Aprov) =>
  tx.deliveryChannelLink.update({
    where: { id: fila.id },
    data: { config: conAprov(fila.config, { ...a, ...(batchId ? { batchId } : {}), ...(integrationId ? { integrationId } : {}) }) },
  })

async function enviarLote(
  intentId: string,
  idToken: string,
  lote: TiendaRappi[],
  deps: ProvisioningDeps,
  out: Record<string, ResultadoRappi>,
) {
  const ids = lote.map(t => t.storeId)
  let resp: RespuestaAprovisionamiento | null = null
  let bloqueada = false
  try {
    resp = await deps.aprovisionar(
      idToken,
      lote.map(t => ({ storeId: t.storeId, name: t.name })),
    )
  } catch (e) {
    // Candado de la capa baja ⇒ no salió nada (definitivo). Red, login, timeout ⇒ no sabemos si Rappi
    // empezó: incierta, y el vínculo se queda para que la confirme el webhook o el re-chequeo.
    bloqueada = e instanceof RappiEscrituraBloqueadaError
    logger.error('🚨 [Rappi] el aprovisionamiento lanzó', { intentId, storeIds: ids, error: (e as Error).message })
  }
  const aceptadas = new Map((resp?.aceptadas ?? []).map(a => [a.storeId, a.integrationId]))
  const rechazadas = new Map((resp?.rechazadas ?? []).map(x => [x.storeId, x.motivo]))

  for (const storeId of ids) {
    try {
      if (bloqueada) {
        out[storeId] = { outcome: 'NOT_ENABLED_FOR_PILOT' }
        await bajoReclamo(intentId, storeId, soltar, out[storeId])
      } else if (aceptadas.has(storeId)) {
        // Se queda PROVISIONING (ya escrito): re-escribirlo aquí degradaría un ACTIVATED del webhook.
        out[storeId] = { outcome: 'PROVISIONING' }
        await bajoReclamo(intentId, storeId, correlacionar(resp?.batchId, aceptadas.get(storeId)))
      } else if (rechazadas.has(storeId)) {
        out[storeId] = { outcome: 'REJECTED', detalle: rechazadas.get(storeId) }
        await bajoReclamo(intentId, storeId, soltar, out[storeId])
      } else {
        // Incierta (R6): conserva el vínculo. Con `batchId` el webhook todavía la puede reconocer.
        out[storeId] = { outcome: 'UNCERTAIN' }
        await bajoReclamo(intentId, storeId, resp?.batchId ? correlacionar(resp.batchId) : null, out[storeId])
      }
    } catch (e) {
      logger.error('🚨 [Rappi] no se pudo anotar el aprovisionamiento de una tienda', { intentId, storeId, error: (e as Error).message })
    }
  }
}

/**
 * Aprovisiona lo que el dueño eligió. El intent YA está `ACTIVATING` (el controller hizo el CAS
 * `EXCHANGED → ACTIVATING` con `selectionJson` = ids). Devuelve lo que ESTA llamada decidió por tienda;
 * la verdad persistida está en `resultsJson` (un webhook pudo haberla avanzado mientras tanto).
 */
export async function activarSeleccion(
  intent: DeliveryConnectIntent,
  idToken: string,
  elegidas: TiendaRappi[],
  deps: ProvisioningDeps,
): Promise<Record<string, ResultadoRappi>> {
  // PRIMERA escritura, y también la guarda: sin alargarlo, el re-chequeo de /result lo vería EXPIRED a los
  // 10 min y `fallar` borraría el id_token. Si ya no está ACTIVATING, no se toca nada.
  if (!(await casEstado(intent.id, 'ACTIVATING', 'ACTIVATING', { expiresAt: new Date(Date.now() + TTL_ACTIVANDO_MS) }))) return {}

  const out: Record<string, ResultadoRappi> = {}
  const reclamadas: TiendaRappi[] = []
  for (const t of new Map(elegidas.map(x => [x.storeId, x])).values()) {
    if (!escribible(t.storeId, deps.tiendasEscribibles)) {
      out[t.storeId] = { outcome: 'NOT_ENABLED_FOR_PILOT' } // ni vínculo ni HTTP
      await prisma.$transaction(tx => anotar(tx, intent.id, t.storeId, out[t.storeId]))
      continue
    }
    try {
      out[t.storeId] = await reclamar(intent, t)
    } catch (e) {
      logger.error('🚨 [Rappi] no se pudo reclamar la tienda', { intentId: intent.id, storeId: t.storeId, error: (e as Error).message })
      out[t.storeId] = { outcome: 'FAILED', detalle: 'LOCAL_ERROR' }
      await prisma.$transaction(tx => anotar(tx, intent.id, t.storeId, out[t.storeId]))
    }
    if (out[t.storeId].outcome === 'PROVISIONING') reclamadas.push(t)
  }

  for (const lote of enLotes(reclamadas)) await enviarLote(intent.id, idToken, lote, deps, out)
  await cerrarSiTodoFinal(intent.id)
  return out
}

// ─── Confirmar (webhook y re-chequeo) ───────────────────────────────────────────────────

/** R7: el mismo lote, o (re-chequeo) la misma intención + el mismo `integrationId`. Un valor vacío nunca coincide. */
function coincide(a: Aprov | null, r: ResultadoRappiTienda & { batchId?: string }, esperado?: { intentId: string }): boolean {
  if (!a) return false
  if (r.integrationId && a.integrationId && r.integrationId !== a.integrationId) return false
  const porLote = !!r.batchId && !!a.batchId && r.batchId === a.batchId
  const porRelectura = !!esperado && esperado.intentId === a.intentId && !!r.integrationId && r.integrationId === a.integrationId
  return porLote || porRelectura
}
const pendienteNuestro = (fila: Fila | null, r: ResultadoRappiTienda & { batchId?: string }, esperado?: { intentId: string }) =>
  fila?.status === DeliveryChannelStatus.PENDING && coincide(aprov(fila.config), r, esperado)

function ignorar(fila: Fila | null, r: ResultadoRappiTienda & { batchId?: string }, esperado?: { intentId: string }): 'IGNORED' {
  const a = aprov(fila?.config)
  const ctx = { storeId: r.storeId, status: r.status, batchId: r.batchId }
  if (fila?.status === DeliveryChannelStatus.ACTIVE && a?.confirmedAt && coincide(a, r, esperado))
    logger.info('🛵 [Rappi] confirmación repetida de una tienda ya activa', ctx)
  else logger.error('🚨 [Rappi] confirmación de una tienda sin vínculo pendiente nuestro', ctx)
  return 'IGNORED'
}

/**
 * Aplica UNA confirmación de Rappi (`ACTIVE` / `FAILED` / `INACTIVE`) a nuestro vínculo PENDING.
 * El webhook pasa su `batchId`; el re-chequeo de /result pasa `integrationId` + `esperado.intentId`.
 * Actúa sólo sobre un PENDING que pruebe ser nuestro; si no, `IGNORED` (nunca crea un vínculo).
 * Un DEPROVISION de una tienda ya activa también se ignora: ese flujo no existe todavía.
 */
export async function confirmarTienda(
  r: ResultadoRappiTienda & { batchId?: string },
  deps: Pick<ProvisioningDeps, 'suscribir'>,
  esperado?: { intentId: string },
): Promise<Confirmacion> {
  if (r.status === 'ACTIVE') {
    // 🔴 Suscribir a los eventos ANTES de promover: una tienda ACTIVE sin suscripción no recibe pedidos.
    // Es HTTP, así que va FUERA de la transacción (no se sostiene un candado mientras Rappi contesta).
    const antes = await prisma.$transaction(tx => leerVinculo(tx, r.storeId))
    if (!pendienteNuestro(antes, r, esperado)) return ignorar(antes, r, esperado)
    const intentId = (aprov(antes?.config) as Aprov).intentId
    let s: { ok: boolean; fallidos: string[] }
    try {
      s = await deps.suscribir(r.storeId)
    } catch (e) {
      s = { ok: false, fallidos: [(e as Error).message] }
    }
    if (!s.ok) {
      logger.warn('🛵 [Rappi] tienda confirmada pero sin suscribir a sus eventos: sigue PENDING', {
        intentId,
        storeId: r.storeId,
        fallidos: s.fallidos,
      })
      await prisma.$transaction(tx => anotar(tx, intentId, r.storeId, { outcome: 'SUBSCRIBE_FAILED', detalle: s.fallidos.join(',') }))
      return 'SUBSCRIBE_FAILED'
    }
  }

  // Vínculo Y resultado del intent, en la MISMA transacción (R5), con la fila re-validada bajo candado.
  const hecho = await prisma.$transaction(async tx => {
    const fila = await leerVinculo(tx, r.storeId)
    if (!fila || !pendienteNuestro(fila, r, esperado)) return { fila, confirmacion: null }
    const a = aprov(fila.config) as Aprov
    let confirmacion: Confirmacion
    let res: ResultadoRappi
    if (r.status === 'ACTIVE') {
      // `activatingIntentId` y `ownerAuthorizedAt` no se tocan: la reclamación de Rappi nunca los usó.
      await tx.deliveryChannelLink.update({
        where: { id: fila.id },
        data: { status: DeliveryChannelStatus.ACTIVE, config: conAprov(fila.config, { ...a, confirmedAt: new Date().toISOString() }) },
      })
      confirmacion = 'PROMOTED'
      res = { outcome: 'ACTIVATED' }
    } else if (r.status === 'FAILED') {
      await soltar(tx, fila, a)
      confirmacion = 'REMOVED'
      res = { outcome: 'FAILED', detalle: r.errorMessage ?? 'RAPPI_FAILED' }
    } else {
      await tx.deliveryChannelLink.update({
        where: { id: fila.id },
        data: { status: DeliveryChannelStatus.DISABLED, config: conAprov(fila.config, null) },
      })
      confirmacion = 'DISABLED'
      res = { outcome: 'FAILED', detalle: 'RAPPI_INACTIVE' }
    }
    await anotar(tx, a.intentId, r.storeId, res)
    return { fila, confirmacion, intentId: a.intentId }
  })
  if (!hecho.confirmacion) return ignorar(hecho.fila, r, esperado) // cambió mientras suscribíamos
  await cerrarSiTodoFinal(hecho.intentId as string)
  return hecho.confirmacion
}

/**
 * `ACTIVATING → CONSUMED` (borra el id_token) sólo cuando CADA tienda de `selectionJson` (ids) tiene un
 * resultado final. Una selección vacía, o un `resultsJson` parcial, no es final.
 */
export async function cerrarSiTodoFinal(intentId: string): Promise<boolean> {
  const i = await prisma.deliveryConnectIntent.findUnique({
    where: { id: intentId },
    select: { state: true, selectionJson: true, resultsJson: true },
  })
  if (i?.state !== 'ACTIVATING') return false
  const seleccion = Array.isArray(i.selectionJson) ? i.selectionJson : []
  const res = objeto(i.resultsJson)
  if (!seleccion.length || !seleccion.every(s => typeof s === 'string' && esFinal(objeto(res[s]).outcome))) return false
  return casEstado(intentId, 'ACTIVATING', 'CONSUMED')
}

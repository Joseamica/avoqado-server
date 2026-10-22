/**
 * Aprovisionar tiendas de Rappi y confirmar el resultado — el corazón del self-onboarding.
 *
 * 🔴 Cuatro reglas que no se negocian:
 *  1. El vínculo se RECLAMA (PENDING, bajo `FOR UPDATE`) antes del HTTP: una tienda de otro negocio,
 *     o reclamada por otra intención viva, se resuelve sin llamar a Rappi (el dueño con dos negocios).
 *  2. La reclamación vive en `config.rappiProvisioning` (R3), NUNCA en `activatingIntentId`: el job de
 *     limpieza compartido con Uber sólo toca vínculos con `activatingIntentId`, y aquí la confirmación
 *     es ASÍNCRONA — un vínculo esperando a Rappi no puede desaparecer. Se MEZCLA en `config` (ahí
 *     también viven el menú en revisión y las demás llaves del sistema), jamás lo reemplaza.
 *  3. Una confirmación sólo PROMUEVE un vínculo que nosotros reclamamos, y tiene que PROBARLO (R7): el
 *     mismo lote, o la misma intención + el mismo `integrationId`. Jamás crea uno.
 *  4. Un resultado final no se degrada (R5): la escritura lo exige en su propio `WHERE`, porque el
 *     webhook y el re-chequeo de la pantalla de resultado corren a la vez y el que falla tarde no puede
 *     deshacer al que ganó.
 *
 * El webhook y el re-chequeo llaman a la MISMA `confirmarTienda`: idempotente, porque llegan los dos.
 */
import crypto from 'crypto'
import { DeliveryChannelStatus, DeliveryConnectIntent, OrderAcceptanceMode, Prisma } from '@prisma/client'

import logger from '@/config/logger'
import { logAction } from '@/services/dashboard/activity-log.service'
import prisma from '@/utils/prismaClient'
import { utcTs } from '@/utils/sqlDates'

import { casEstado, ESTADOS_VIVOS, mezclaResultadoSql } from '../../core/deliveryConnectIntent.service'
import { DeliveryWriteNotSentError, type ActionResult } from '../../core/types'
import { TTL_ACTIVANDO_MS } from './rappi.connect'
import { assertTiendaEscribible, RappiEscrituraBloqueadaError } from './rappi.http'
import { enLotes, type RespuestaAprovisionamiento, type ResultadoRappiTienda, type TiendaRappi } from './rappi.selfOnboarding'

export interface ProvisioningDeps {
  aprovisionar(idToken: string, tiendas: Array<{ storeId: string; name: string }>): Promise<RespuestaAprovisionamiento>
  suscribir(storeId: string): Promise<{ ok: boolean; fallidos: string[] }>
  tiendasEscribibles: readonly string[]
  /**
   * «Integrada sí/no» (Tarea 18). 🔴 Quien llama a `confirmarTienda` DEBE cablearla (el webhook y el re-chequeo lo hacen, con
   * `rappiAdapter.notifyIntegrationStatus`): sin ella la tienda se promueve igual pero Rappi nunca se entera de que ya está
   * integrada, y `confirmarTienda` lo deja a la vista en el log. Sólo la usa `confirmarTienda`, no `activarSeleccion`.
   */
  avisarIntegrada?(storeId: string, integrada: boolean): Promise<ActionResult>
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
/** `DEFERRED`: puede ser nuestra pero aún no hay con qué probarlo — el que llama la reintenta (ver `sinConfirmar`). */
export type Confirmacion = 'PROMOTED' | 'REMOVED' | 'DISABLED' | 'IGNORED' | 'DEFERRED' | 'SUBSCRIBE_FAILED'
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
/** Lo que decidió la transacción de `confirmarTienda` (el `intent` sólo si la reclamación probó ser nuestra). */
type Hecho = { fila: Fila | null; confirmacion: Confirmacion | null; intentId?: string; intent?: { staffId: string; environment: string } }

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
          // 🔴 SIEMPRE AUTO, aunque el intent diga otra cosa: Rappi no admite modo manual (cancela solo el
          // pedido que no se acepta en 4–6 min). El intent se comparte con otros proveedores y puede traer MANUAL.
          orderAcceptanceMode: OrderAcceptanceMode.AUTO,
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
      // un `batchId` de antes no puede confirmar esta. Pero si la fila está PENDING por esa reclamación
      // vieja, se hereda A QUÉ volvía (la creó ella, o su `statusPrevio`): guardar PENDING dejaba el canal
      // pendiente para siempre tras un rechazo.
      const origen = fila.status === DeliveryChannelStatus.PENDING ? previo : null
      const creado = creada === 1 || origen?.creado === true
      await tx.deliveryChannelLink.update({
        where: { id: fila.id },
        data: {
          status: DeliveryChannelStatus.PENDING,
          config: conAprov(fila.config, {
            intentId: intent.id,
            since: new Date().toISOString(),
            ...(creado ? { creado: true as const } : { statusPrevio: origen?.statusPrevio ?? fila.status }),
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

/**
 * 🔴 La reclamación vive en `config`, así que antes de actuar se comprueba contra la BASE: su intención es
 * de Rappi, del MISMO negocio que el vínculo, y ELIGIÓ esa tienda. Si no, ni HTTP ni escritura en esa
 * intención (H1, N3).
 */
async function intentDeLaReclamacion(tx: Tx, fila: Fila, a: Aprov, storeId: string) {
  const i = await tx.deliveryConnectIntent.findUnique({
    where: { id: a.intentId },
    select: { provider: true, venueId: true, staffId: true, environment: true, selectionJson: true },
  })
  const eligio = Array.isArray(i?.selectionJson) && i.selectionJson.includes(storeId)
  if (i?.provider === 'RAPPI' && i.venueId === fila.venueId && eligio) return i
  logger.error('🚨 [Rappi] la reclamación del vínculo apunta a una intención ajena (o que no eligió esta tienda): se ignora', {
    linkId: fila.id,
    intentId: a.intentId,
    storeId,
  })
  return null
}

/**
 * Por qué una confirmación no se aplica. 🔴 `DEFERRED` ≠ `IGNORED`: un webhook CON lote que llega a una
 * reclamación nuestra que todavía no guarda su `batchId` (el 202 sigue en vuelo, o `correlacionar` aún no
 * escribe) no se puede probar AHORA, pero puede ser justo la confirmación. Rappi no documenta reintentos:
 * darlo por procesado la perdería. Diferido, el evento queda FAILED y la reconciliación lo reintenta; uno
 * ajeno de verdad lo acota su tope de intentos (POISON).
 */
function sinConfirmar(
  fila: Fila | null,
  r: ResultadoRappiTienda & { batchId?: string },
  esperado?: { intentId: string },
): 'IGNORED' | 'DEFERRED' {
  const a = aprov(fila?.config)
  const ctx = { storeId: r.storeId, status: r.status, batchId: r.batchId }
  if (fila?.status === DeliveryChannelStatus.PENDING && a && !a.batchId && !a.confirmedAt && r.batchId) {
    logger.warn('🛵 [Rappi] confirmación de una reclamación que aún no guarda su lote: se reintenta', { ...ctx, intentId: a.intentId })
    return 'DEFERRED'
  }
  if (fila?.status === DeliveryChannelStatus.ACTIVE && a?.confirmedAt && coincide(a, r, esperado))
    logger.info('🛵 [Rappi] confirmación repetida de una tienda ya activa', ctx)
  // Nuestra (misma intención) pero sin prueba todavía: el re-chequeo vuelve a pasar, no es una alarma.
  else if (a && esperado?.intentId === a.intentId) logger.warn('🛵 [Rappi] tienda nuestra sin prueba de correlación todavía', ctx)
  else logger.error('🚨 [Rappi] confirmación de una tienda sin vínculo pendiente nuestro', ctx)
  return 'IGNORED'
}

/**
 * La baja que pide RAPPI (esta rama nunca da de baja una tienda): `DEPROVISION` + `INACTIVE` de una tienda
 * conectada (ACTIVE o PAUSED) la deja DISABLED — si no, seguiría figurando conectada sin recibir nada. No hay
 * lote nuestro que probar: basta la tienda (el webhook viene firmado). El `integrationId` sólo la descarta si
 * conocemos LOS DOS y difieren: un vínculo confirmado sólo por lote, o manual, no lo guarda.
 * `null` = no aplica, y la confirmación sigue su camino de siempre (un PENDING, igual).
 */
async function bajaDeRappi(r: ResultadoRappiTienda & { batchId?: string }): Promise<'DISABLED' | null> {
  const fila = await prisma.$transaction(async tx => {
    const f = await leerVinculo(tx, r.storeId)
    if (f?.status !== DeliveryChannelStatus.ACTIVE && f?.status !== DeliveryChannelStatus.PAUSED) return null
    const nuestro = aprov(f.config)?.integrationId
    if (r.integrationId && nuestro && r.integrationId !== nuestro) return null
    await tx.deliveryChannelLink.update({ where: { id: f.id }, data: { status: DeliveryChannelStatus.DISABLED } })
    return f
  })
  if (!fila) return null
  const datos = { storeId: r.storeId, linkId: fila.id, venueId: fila.venueId, statusPrevio: fila.status, batchId: r.batchId }
  logger.error('🚨 [Rappi] Rappi dio de BAJA la tienda — canal deshabilitado', datos)
  // Después del commit y sólo si se apagó: el dueño ve su canal DISABLED y la bitácora dice cuándo y por qué.
  void logAction({
    staffId: null, // nadie de Avoqado: lo pidió Rappi
    venueId: fila.venueId,
    action: 'DELIVERY_CHANNEL_DISCONNECTED',
    entity: 'DeliveryChannelLink',
    entityId: fila.id,
    data: { provider: 'RAPPI', externalLocationId: r.storeId, origen: 'RAPPI_DEPROVISION', statusPrevio: fila.status, batchId: r.batchId },
  })
  return 'DISABLED'
}

/**
 * Aplica UNA confirmación de Rappi (`ACTIVE` / `FAILED` / `INACTIVE`) a nuestro vínculo PENDING.
 * El webhook pasa su `batchId`; el re-chequeo de /result pasa `integrationId` + `esperado.intentId`.
 * Actúa sólo sobre un PENDING que pruebe ser nuestro; si no, `IGNORED` (nunca crea un vínculo), o `DEFERRED`
 * si todavía no se puede probar (ver `sinConfirmar`). La excepción es la baja de Rappi (`bajaDeRappi`).
 */
export async function confirmarTienda(
  r: ResultadoRappiTienda & { batchId?: string; operation?: 'PROVISION' | 'DEPROVISION' },
  deps: Pick<ProvisioningDeps, 'suscribir' | 'avisarIntegrada'>,
  esperado?: { intentId: string },
): Promise<Confirmacion> {
  if (r.operation === 'DEPROVISION' && r.status === 'INACTIVE') {
    const baja = await bajaDeRappi(r)
    if (baja) return baja
  }
  if (r.status === 'ACTIVE') {
    // 🔴 Suscribir a los eventos ANTES de promover: una tienda ACTIVE sin suscripción no recibe pedidos.
    // Es HTTP, así que va FUERA de la transacción (no se sostiene un candado mientras Rappi contesta).
    const antes = await prisma.$transaction(tx => leerVinculo(tx, r.storeId))
    if (!pendienteNuestro(antes, r, esperado)) return sinConfirmar(antes, r, esperado)
    const reclamo = aprov(antes?.config) as Aprov
    if (!(await prisma.$transaction(tx => intentDeLaReclamacion(tx, antes as Fila, reclamo, r.storeId)))) return 'IGNORED'
    const intentId = reclamo.intentId
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
  const hecho = await prisma.$transaction(async (tx): Promise<Hecho> => {
    const fila = await leerVinculo(tx, r.storeId)
    if (!fila || !pendienteNuestro(fila, r, esperado)) return { fila, confirmacion: null }
    const a = aprov(fila.config) as Aprov
    const intent = await intentDeLaReclamacion(tx, fila, a, r.storeId)
    if (!intent) return { fila, confirmacion: 'IGNORED' }
    let confirmacion: Confirmacion
    let res: ResultadoRappi
    if (r.status === 'ACTIVE') {
      // `activatingIntentId` y `ownerAuthorizedAt` no se tocan: la reclamación de Rappi nunca los usó. El
      // `integrationId` del aviso se guarda si el 202 no lo trajo (`coincide` ya exigió que no difiera): con él
      // se reconoce después una baja de Rappi.
      const confirmada: Aprov = { ...a, integrationId: a.integrationId ?? r.integrationId, confirmedAt: new Date().toISOString() }
      await tx.deliveryChannelLink.update({
        where: { id: fila.id },
        data: { status: DeliveryChannelStatus.ACTIVE, config: conAprov(fila.config, confirmada) },
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
    return { fila, confirmacion, intentId: a.intentId, intent }
  })
  if (!hecho.confirmacion) return sinConfirmar(hecho.fila, r, esperado) // cambió mientras suscribíamos
  if (hecho.confirmacion === 'IGNORED') return 'IGNORED'
  if (hecho.confirmacion === 'PROMOTED' && hecho.fila && hecho.intent) {
    // Como Uber: sólo el ganador, DESPUÉS del commit, y sin poder deshacerla (logAction nunca lanza).
    // Es lo que queda de quién conectó la tienda cuando la intención ya se purgó.
    void logAction({
      staffId: hecho.intent.staffId,
      venueId: hecho.fila.venueId,
      action: 'DELIVERY_CHANNEL_CONNECTED',
      entity: 'DeliveryChannelLink',
      entityId: hecho.fila.id,
      data: { provider: 'RAPPI', externalLocationId: r.storeId, intentId: hecho.intentId as string, environment: hecho.intent.environment },
    })
    // Tarea 18: promovimos NOSOTROS (la baja de Rappi, `bajaDeRappi`, nunca llega aquí). Sin esperarlo: ver `avisarIntegrada`.
    void avisarIntegrada(deps, hecho.fila, r.storeId, hecho.intentId as string)
  }
  await cerrarSiTodoFinal(hecho.intentId as string)
  return hecho.confirmacion
}

/**
 * «Integrada sí/no» (Tarea 18): con el vínculo ya ACTIVE y la transacción CERRADA, le dice a Rappi `integrated=true` para que los
 * pedidos de la tienda lleguen por la integración y no por su portal de aliados.
 *
 * 🔴 Best-effort, y SIN esperar (quien llama lo invoca con `void`): el re-chequeo corre dentro de la petición de la página de
 * resultado y el webhook dentro del procesador de eventos, y la llamada puede tardar hasta el techo de `TIMEOUT_RAPPI_MS`. En el
 * sandbox siempre falla (500, medición M9), así que NUNCA puede frenar ni romper la confirmación. Un fallo —respuesta no 2xx, un
 * throw o el candado de escritura, que es un «no salió»— queda en el log y en ActivityLog (`DELIVERY_INTEGRATION_STATUS_FAILED`),
 * jamás revierte la promoción ni lanza: todo el cuerpo está dentro de un `try`, para no dejar un rechazo sin atender.
 */
async function avisarIntegrada(
  deps: Pick<ProvisioningDeps, 'avisarIntegrada'>,
  fila: Fila,
  storeId: string,
  intentId: string,
): Promise<void> {
  const ctx = { storeId, linkId: fila.id, venueId: fila.venueId, intentId }
  try {
    if (!deps.avisarIntegrada) {
      logger.warn(
        '🛵 [Rappi] tienda promovida sin avisarIntegrada cableado: Rappi no se enteró de que ya está integrada (quien llamó a confirmarTienda debe pasarlo)',
        ctx,
      )
      return
    }
    let falla: Record<string, string | number | true> | null = null
    try {
      const r = await deps.avisarIntegrada(storeId, true)
      if (!r.ok) falla = { status: r.status, error: `HTTP_${r.status}`, cuerpo: String(r.raw ?? '').slice(0, 300) }
    } catch (e) {
      falla = {
        error: (e instanceof Error ? e.message : String(e)).slice(0, 300),
        // El candado de escritura o un token que no se pudo pedir: se SABE que Rappi no recibió nada.
        ...(e instanceof DeliveryWriteNotSentError ? { noSalio: true as const } : {}),
      }
    }
    if (!falla) return
    logger.error('🚨 [Rappi] no se pudo avisar «integrada» de una tienda ya ACTIVE: queda conectada y se sigue (revisar en la bitácora)', {
      ...ctx,
      ...falla,
    })
    void logAction({
      staffId: null, // nadie de Avoqado lo pidió: es el efecto automático de la conexión
      venueId: fila.venueId,
      action: 'DELIVERY_INTEGRATION_STATUS_FAILED',
      entity: 'DeliveryChannelLink',
      entityId: fila.id,
      data: { provider: 'RAPPI', externalLocationId: storeId, integrada: true, intentId, ...falla },
    })
  } catch (e) {
    logger.error('🚨 [Rappi] el aviso «integrada» falló al registrarse', { ...ctx, error: e instanceof Error ? e.message : String(e) })
  }
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

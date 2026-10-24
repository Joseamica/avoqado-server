// jobs/delivery-webhook-reconciliation.job.ts

import { CronJob } from 'cron'
import { DeliveryOrderEventStatus, DeliveryProvider, Prisma } from '@prisma/client'
import prisma from '../utils/prismaClient'
import logger from '../config/logger'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { parseDeliverectOrder } from '../services/delivery-channels/providers/deliverect/deliverect.mapper'
import { ingestDeliveryOrder } from '../services/delivery-channels/core/deliveryOrderIngestion.service'
import { markEventResult } from '../services/delivery-channels/core/deliveryWebhookEvent.service'
import { CAMBIO_SIN_CONFIRMAR, processUberEvent } from '../services/delivery-channels/providers/uber-eats/uber.eventProcessor'
import { processRappiEvent } from '../services/delivery-channels/providers/rappi/rappi.eventProcessor'
import { scheduleJob } from '../observability/jobContext'

/**
 * Delivery order webhook reconciliation job.
 *
 * Sweeps `DeliveryOrderEvent` rows that never reached a terminal state:
 *
 *   • FAILED — ingestion threw AFTER the event was persisted. The controller
 *     already ACKed 200 to the provider (`deliverect.webhook.controller.ts`),
 *     so the provider will NOT re-post; this job is the only thing that
 *     retries it.
 *   • RECEIVED older than 10 minutes — the Task 5 Critical: `ingestDeliveryOrder`
 *     can succeed while the FOLLOW-UP bookkeeping write (`markEventResult`)
 *     itself fails, leaving the row stuck in RECEIVED forever. The provider
 *     won't retry (dedup already has the event via the unique index), so
 *     without this sweep the event is invisible to any retry path.
 *
 * Re-processing is safe because `ingestDeliveryOrder` upserts the Order by
 * `venueId_externalId` and gates Payment creation behind a count===0 guard —
 * replaying an event whose order already exists just re-confirms it and lands
 * on `markEventResult(PROCESSED, orderId)`, exactly the write the original
 * request couldn't make.
 *
 * A RECEIVED event younger than 10 minutes is left untouched — it may still
 * be mid-flight inside the live request that created it.
 *
 * Events older than 24h (FAILED or RECEIVED) are swept to `error: 'ORPHANED'`
 * (status stays FAILED — this model has no ERROR status) and are excluded
 * from every future pass via `error: { not: 'ORPHANED' }`, so a permanently
 * broken payload (or a channel link that was deleted) doesn't get retried
 * forever.
 *
 * Structure mirrors `blumon-webhook-reconciliation.job.ts`: singleton class,
 * CronJob, `America/Mexico_City`, start()/stop() registered in `src/server.ts`.
 *
 * 🔴 Rappi tiene ADEMÁS su propio carril cada 30 s (`reprocesarCarrilRappi`): su reloj de aceptación es de
 * 4–6 min, y esperar los 10 min de arriba lo dejaba vencer. Toma lo que quedó RECEIVED a medias (el proceso
 * murió o se colgó) con más de 45 s; la pasada general sigue igual. Nadie trabaja dos veces el mismo evento
 * porque el procesador de Rappi lo RECLAMA en la fila (`reclamarEvento`): el que llega segundo recibe
 * `IN_FLIGHT` y no lo toca.
 */
export class DeliveryWebhookReconciliationJob {
  private job: CronJob | null = null

  /** Every 2 minutes at :45s — NEVER :00, anti-stampede rule (.claude/rules/cron-jobs.md). */
  private readonly CRON_PATTERN = '45 */2 * * * *'

  /** Cap per pass to avoid long transactions if a backlog builds up. */
  private readonly BATCH_SIZE = 50

  /** A RECEIVED event younger than this may still be mid-flight in the live request that created it. */
  private readonly RECEIVED_MIN_AGE_MS = 10 * 60_000

  /** Events older than this (FAILED or RECEIVED) are swept to ORPHANED and never retried again. */
  private readonly ORPHAN_TTL_MS = 24 * 3600_000

  /** Sentinel written to `error` by the ORPHANED sweep — used to exclude already-orphaned rows from every future pass. */
  private static readonly ORPHANED_MARKER = 'ORPHANED'

  /**
   * Proveedores que este job sabe reconciliar. Cada uno se enruta a SU camino en
   * `reprocesarSegunProveedor` — pasarle a uno el traductor de otro revienta el payload y
   * mata un pedido real. Al integrar Rappi/DiDi se amplía aquí Y allá, nunca sólo aquí.
   */
  private static readonly RECONCILABLE_PROVIDERS = [DeliveryProvider.DELIVERECT, DeliveryProvider.UBER_EATS, DeliveryProvider.RAPPI]

  /**
   * Errores TERMINALES: reintentarlos no puede cambiar el resultado, así que la fila se
   * excluye de toda pasada futura en vez de ocupar un lugar del lote cada 2 minutos.
   *
   * `PEDIDO_YA_NO_ACTIVO` — [medido 2026-08-20] pasado el plazo de ~11.5 min, Uber responde
   * `400 "The order is no longer active"` y deja el pedido en DENIED. Ese dinero no va a
   * llegar nunca: reintentar no lo resucita, y crear la venta sería inventarla.
   *
   * `CHANNEL_DISABLED` — un pedido de Rappi que llegó a un canal deshabilitado: no se aceptó y Rappi
   * lo cancela al vencer su reloj (4–6 min). Si el canal se reactiva, reintentarlo registraría un
   * pedido que ya no existe.
   *
   * `ACEPTACION_INCIERTA` — Rappi contestó 400 al aceptar y su historial SE LEYÓ pero no dijo si el pedido quedó aceptado
   * (vacío, o sólo eventos del repartidor). 🚨 Lo resuelve una persona con Rappi: reintentarlo solo terminaría registrando la
   * venta a ciegas. Un historial que NO se pudo leer (red, un no-2xx, un cuerpo ilegible) ya no es esto: es `HISTORIAL_NO_LEIDO`,
   * que NO es terminal y se reintenta.
   *
   * `CANCELADO_ANTES_DE_REGISTRAR` — el NEW_ORDER de Rappi encontró su aviso de cancelación ya guardado: ni se aceptó ni se
   * registró. Reintentarlo no cambia nada (la cancelación sigue ahí). OJO: `CANCELACION_EN_ESPERA` NO va aquí — es la
   * cancelación esperando a que su NEW_ORDER termine, y se reintenta con la espera normal. Tampoco `COMANDA_NO_CREADA`
   * (Tarea 11): el pedido de Rappi se aceptó y se registró pero su comanda no nació; el reintento la repone sin aceptar otra vez.
   *
   * `VARIANTE_BLOQUE_2B` / `VARIANTE_SIN_CALIBRAR` (Tarea 12) — un pedido de Rappi cuyo dinero esta fase no registra: con
   * repartidor propio o para recoger y cobrado por el negocio (el bloque 2b), o de una variante sin calibrar con un pedido
   * real. No se acepta ni se registra; reintentarlo no cambia nada. 🚨 Queda FAILED visible para una persona.
   *
   * 🔴 `ERRORES_TERMINALES` de `rappi.eventProcessor.ts` es una copia de esta lista (una prueba las compara): si se agrega
   * un código aquí, va también allá.
   */
  private static readonly TERMINAL_ERRORS = [
    'ORPHANED',
    'PEDIDO_YA_NO_ACTIVO',
    'CHANNEL_DISABLED',
    'ACEPTACION_INCIERTA',
    'CANCELADO_ANTES_DE_REGISTRAR',
    'VARIANTE_BLOQUE_2B',
    'VARIANTE_SIN_CALIBRAR',
  ]

  /**
   * Fix B2 (audit §10.2): without an attempt cap, a handful of permanently-broken
   * ("poison") events — malformed payload, deleted dependency, whatever keeps
   * throwing — would occupy a BATCH_SIZE slot on EVERY pass (~720 times/24h),
   * starving younger events out of the batch. Once a row's attemptCount reaches
   * this, the scan query excludes it forever: it stays FAILED, gets logged once
   * (the pass that pushed it over the cap), and is never selected again.
   * attemptCount/nextAttemptAt track ONLY this job's own retry attempts — the
   * original webhook ingestion failure that first set status=FAILED does not
   * count towards it.
   */
  private readonly MAX_ATTEMPTS = 10

  /** Backoff cap in minutes for `nextAttemptAt` scheduling (exponential: 2^attemptCount, capped here). */
  private readonly BACKOFF_CAP_MINUTES = 60

  /**
   * N-5: eventos de SEGUIMIENTO — sin plazo de aceptación. Hoy sólo el aviso de cambio de Uber
   * (`FULFILLMENT_CHANGED`), que se relee hasta 3 h mientras el pedido no cierra. Van en su propio
   * carril, DESPUÉS de todo lo demás: un pedido nuevo tiene ~11.5 min antes de que Uber lo cancele.
   */
  private static readonly EVENTOS_DE_SEGUIMIENTO = ['order.fulfillment_issues.resolved']

  /**
   * El resultado del aprovisionamiento de Rappi. Su reintento suscribe cada tienda a sus webhooks (hasta
   * 20 tiendas × 10 PUT: minutos), así que NO va en la pasada de pedidos: corre aparte
   * (`reprocesarAprovisionamientos`), con su propio candado. Dentro de la pasada, `enCurso` saltaba los
   * ticks siguientes y un pedido que falló detrás podía vencer (4–6 min en Rappi, ~11.5 en Uber).
   */
  private static readonly EVENTOS_DE_APROVISIONAMIENTO = ['STORE_PROVISIONING_STATUS']

  /**
   * Tope de relecturas de seguimiento por pasada. ponytail: con la lectura acotada a 8 s son ≤ 80 s,
   * así la pasada termina antes del siguiente tick (2 min) y un pedido nuevo nunca espera una pasada
   * entera de relecturas; si los avisos abiertos crecen, subirlo o dar al seguimiento su propio job.
   * El carril de aprovisionamiento usa el mismo tope por vuelta.
   */
  private readonly SEGUIMIENTO_POR_PASADA = 10

  /** N-8: mínimo de relecturas de seguimiento por pasada, aunque el carril urgente llene el lote. */
  private readonly SEGUIMIENTO_GARANTIZADO = 5

  /**
   * El carril propio de Rappi: cada 30 s, en :15 y :45 (nunca en :00, regla anti-estampida). Peor caso si el proceso
   * muere a medias: su reclamo (45 s) vence y la siguiente vuelta lo toma — ≤ 45 s + 30 s = 75 s, dentro de los 90 s.
   */
  private readonly RAPPI_CRON = '15,45 * * * * *'

  /** Un RECEIVED más joven puede seguir en su petición viva (que ya lo reclamó): el carril no lo mira antes. */
  private readonly RAPPI_RECEIVED_MIN_AGE_MS = 45_000

  /** Tope de eventos por vuelta del carril de Rappi. */
  private readonly RAPPI_POR_VUELTA = 10

  /**
   * Cuántos procesa a la vez: es lo que aguanta el pool de conexiones a la base. Cada uno que termina deja entrar al
   * siguiente; no se espera a que acabe un grupo (Codex plan r3 #3): el sexto de una ráfaga entra en segundos.
   */
  private readonly RAPPI_EN_PARALELO = 5

  /** Candado en memoria: una sola pasada a la vez (ver `runOnce`). */
  private enCurso = false

  /**
   * El del carril de aprovisionamiento: independiente de `enCurso`, así un aviso lento nunca frena pedidos.
   * ponytail: en memoria, como `enCurso` — una sola instancia (`.claude/rules/una-sola-instancia.md`, #5).
   */
  private aprovisionandoEnCurso = false

  /** El del carril de Rappi: independiente de los otros dos. ponytail: en memoria — una sola instancia (#5). */
  private rappiEnCurso = false

  /** El cron del carril de Rappi, aparte del de la pasada general (`DEMO_MODE` no llama `start()`: no corre ninguno). */
  private jobRappi: CronJob | null = null

  start(): void {
    if (this.job) return
    this.job = scheduleJob('delivery-webhook-reconciliation', this.CRON_PATTERN, () => this.tick(), null, false, 'America/Mexico_City')
    this.job.start()
    this.jobRappi = scheduleJob(
      'delivery-webhook-reconciliation-rappi',
      this.RAPPI_CRON,
      () => this.tickRappi(),
      null,
      false,
      'America/Mexico_City',
    )
    this.jobRappi.start()
    logger.info(`🛵 Delivery webhook reconciliation job started — every 2min, batch ${this.BATCH_SIZE}; Rappi lane every 30s`)
  }

  /**
   * Un tick del cron: la pasada de pedidos y, APARTE y sin esperarse entre sí, el carril de aprovisionamiento.
   * Se devuelve la promesa de los dos para que el registro de jobs en vuelo (`scheduleJob`) los vea hasta que
   * terminen; `cron` no espera el tick, así que no frena el siguiente (cada carril tiene su propio candado).
   */
  private async tick(): Promise<void> {
    await this.correrCarriles([
      ['pedidos', () => this.runOnce()],
      ['aprovisionamiento', () => this.reprocesarAprovisionamientos()],
    ])
  }

  /** El tick del carril de Rappi (cada 30 s), con el mismo registro de rechazos que `tick()`. */
  private async tickRappi(): Promise<void> {
    await this.correrCarriles([['rappi', () => this.reprocesarCarrilRappi()]])
  }

  /**
   * Corre los carriles a la vez y espera a todos. Cada carril atrapa lo suyo y no debería lanzar; si alguno lo hace,
   * se registra con su nombre: `allSettled` sólo se tragaba el rechazo, sin dejar rastro.
   */
  private async correrCarriles(carriles: Array<[nombre: string, correr: () => Promise<unknown>]>): Promise<void> {
    const resultados = await Promise.allSettled(carriles.map(async ([, correr]) => correr()))
    resultados.forEach((r, i) => {
      if (r.status === 'rejected') {
        logger.error('❌ [Delivery recon] un carril del tick lanzó (cada carril debería atrapar lo suyo)', {
          carril: carriles[i][0],
          error: r.reason instanceof Error ? r.reason.message : r.reason,
          stack: r.reason instanceof Error ? r.reason.stack : undefined,
        })
      }
    })
  }

  stop(): void {
    if (!this.job) return
    this.job.stop()
    this.job = null
    this.jobRappi?.stop()
    this.jobRappi = null
    logger.info('🛵 Delivery webhook reconciliation job stopped')
  }

  /**
   * One pass. Returns counters (never throws — a failed pass just retries on
   * the next tick, same as `blumon-webhook-reconciliation.job.ts`).
   */
  async runOnce(): Promise<{ reprocessed: number; orphaned: number }> {
    // 🔴 UNA pasada a la vez. El cron dispara `tick()` cada 2 minutos (`tick()` lanza esta pasada y, aparte,
    // el carril de aprovisionamiento, y espera a las dos con `Promise.allSettled`) y NO espera a que el
    // tick anterior termine: una pasada lenta (lote grande, Uber respondiendo despacio) se encima con la
    // siguiente, las dos seleccionan el MISMO evento FAILED y las dos lo reprocesan. Eso puede crear DOS
    // comandas del mismo pedido —`KdsOrder.orderId` no es único— y la cocina prepara la comida dos veces
    // (hallazgo de Codex, 2ª pasada; medido: el webhook NO participa de esta carrera porque su índice
    // único descarta el duplicado en el ingreso, y los eventos RECEIVED sólo entran al job tras 10 minutos).
    if (this.enCurso) {
      logger.warn('🛵 [Delivery recon] La pasada anterior sigue corriendo — se salta este tick')
      return { reprocessed: 0, orphaned: 0 }
    }
    this.enCurso = true
    const startedAt = Date.now()
    try {
      const { reprocessed, orphanedImmediate } = await this.reprocessStuckEvents()
      const orphanedSwept = await this.markOrphaned()
      const orphaned = orphanedImmediate + orphanedSwept
      if (reprocessed > 0 || orphaned > 0) {
        logger.info('🛵 [Delivery recon] Pass complete', { reprocessed, orphaned, elapsedMs: Date.now() - startedAt })
      }
      return { reprocessed, orphaned }
    } catch (err) {
      logger.error('❌ [Delivery recon] Job pass failed', {
        error: err instanceof Error ? err.message : err,
        stack: err instanceof Error ? err.stack : undefined,
      })
      return { reprocessed: 0, orphaned: 0 }
    } finally {
      // En `finally`: si la pasada revienta, el flag DEBE soltarse o el job queda muerto
      // para siempre y nadie rescata un solo pedido.
      this.enCurso = false
    }
  }

  /** Una vuelta del carril de aprovisionamiento (una a la vez; nunca lanza). Devuelve cuántos quedaron resueltos. */
  async reprocesarAprovisionamientos(): Promise<number> {
    if (this.aprovisionandoEnCurso) return 0
    this.aprovisionandoEnCurso = true
    try {
      const { reprocessed } = await this.reprocessStuckEvents('aprovisionamiento')
      // Su barrido de 24 h va AQUÍ, bajo este mismo candado (R1): el de la pasada de pedidos podía tomar un
      // aviso que este carril seguía procesando y devolver a FAILED uno que acababa de quedar PROCESSED.
      await this.markOrphaned('aprovisionamiento')
      return reprocessed
    } catch (err) {
      logger.error('❌ [Delivery recon] falló la vuelta del carril de aprovisionamiento', {
        error: err instanceof Error ? err.message : err,
      })
      return 0
    } finally {
      this.aprovisionandoEnCurso = false
    }
  }

  /**
   * Una vuelta del carril de Rappi (una a la vez; nunca lanza). Devuelve cuántos quedaron resueltos.
   *
   * Toma hasta `RAPPI_POR_VUELTA` eventos de Rappi en RECEIVED con más de 45 s y menos de 24 h, sin los avisos de
   * aprovisionamiento (siguen en su carril lento: Codex plan r2 #3), con los mismos filtros de la pasada general
   * (terminales, poison, espera de backoff). Cada uno va por el procesador, que lo RECLAMA: si lo tiene otro (la
   * petición viva, la pasada general) devuelve `IN_FLIGHT` y no cuenta como intento. Hasta `RAPPI_EN_PARALELO` a la vez.
   */
  async reprocesarCarrilRappi(): Promise<number> {
    if (this.rappiEnCurso) return 0
    this.rappiEnCurso = true
    try {
      const now = Date.now()
      const eventos = await retry(
        () =>
          prisma.deliveryOrderEvent.findMany({
            where: {
              AND: [
                ...this.filtrosBase(now),
                {
                  provider: DeliveryProvider.RAPPI,
                  status: DeliveryOrderEventStatus.RECEIVED,
                  eventType: { notIn: DeliveryWebhookReconciliationJob.EVENTOS_DE_APROVISIONAMIENTO },
                  receivedAt: { gte: new Date(now - this.ORPHAN_TTL_MS), lt: new Date(now - this.RAPPI_RECEIVED_MIN_AGE_MS) },
                },
              ],
            },
            // Servida por el índice `[status, receivedAt]`; el id desempata para que el orden sea estable.
            orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
            take: this.RAPPI_POR_VUELTA,
            // Sólo lo que piden el procesador (el id) y el registro de un fallo: el payload no viaja.
            select: { id: true, provider: true, externalEventId: true, venueId: true, status: true, attemptCount: true },
          }),
        { shouldRetry: shouldRetryDbConnectionError, context: 'deliveryWebhookReconciliation.rappi' },
      )

      // Un tope de N a la vez: N trabajadores toman de la misma cola, y cada uno que termina toma el siguiente.
      let resueltos = 0
      const cola = [...eventos]
      const trabajador = async () => {
        for (let event = cola.shift(); event; event = cola.shift()) {
          try {
            if (await this.reprocesarRappi(event.id)) resueltos++
          } catch (err) {
            await this.anotarFallo(event, err)
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(this.RAPPI_EN_PARALELO, cola.length) }, trabajador))
      return resueltos
    } catch (err) {
      logger.error('❌ [Delivery recon] falló la vuelta del carril de Rappi', {
        error: err instanceof Error ? err.message : err,
      })
      return 0
    } finally {
      this.rappiEnCurso = false
    }
  }

  /**
   * Los filtros que comparten la pasada general y el carril de Rappi: proveedores con camino propio, sin terminales,
   * sin poison y respetando la espera de backoff.
   */
  private filtrosBase(now: number): Prisma.DeliveryOrderEventWhereInput[] {
    return [
      // 🔴 Cada proveedor se reprocesa por SU camino (`reprocesarSegunProveedor`).
      // Antes esto decía sólo DELIVERECT porque abajo se llamaba `parseDeliverectOrder`
      // sobre CUALQUIER fila: un evento de Uber reventaba con "payload sin
      // channelOrderId/items" y se perdía un pedido real (observado el 2026-08-20).
      // La solución no era excluir a Uber —eso lo dejaba SIN NINGÚN reintento, que es
      // peor: su webhook contesta 200 y procesa en segundo plano, así que este job es
      // lo único que lo puede rescatar— sino enrutar por proveedor.
      { provider: { in: DeliveryWebhookReconciliationJob.RECONCILABLE_PROVIDERS } },
      // Never re-pick a row the ORPHANED sweep already gave up on. Written as an
      // explicit null-tolerant OR (rather than a bare `error: { not: 'ORPHANED' }`)
      // so rows with error=null (never failed before) are NOT accidentally excluded —
      // same pattern as blumon-webhook-reconciliation.job.ts's REVERSAL_OPERATION_TYPES guard.
      { OR: [{ error: null }, { error: { notIn: DeliveryWebhookReconciliationJob.TERMINAL_ERRORS } }] },
      // Fix B2: never re-select a poison event (maxed out its retry budget) —
      // it stays FAILED forever, excluded here rather than re-touched every pass.
      { attemptCount: { lt: this.MAX_ATTEMPTS } },
      // Fix B2: respect the backoff window — a row that just failed schedules
      // nextAttemptAt in the future and must not be re-picked before then.
      // Null-tolerant (never-yet-retried rows have nextAttemptAt=null by default).
      { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date(now) } }] },
    ]
  }

  /**
   * Pull FAILED (<24h) + stuck RECEIVED (10min–24h) events and retry each once.
   * `channelLinkId === null` (channel link deleted) is an immediate ORPHANED —
   * there is nothing to re-parse against, so waiting out the 24h TTL would
   * just waste passes.
   */
  private async reprocessStuckEvents(
    carril: 'pedidos' | 'aprovisionamiento' = 'pedidos',
  ): Promise<{ reprocessed: number; orphanedImmediate: number }> {
    const now = Date.now()
    const orphanCutoff = new Date(now - this.ORPHAN_TTL_MS)
    const receivedCutoff = new Date(now - this.RECEIVED_MIN_AGE_MS)

    const base = this.filtrosBase(now)
    // Acotadas (take) y servidas por los índices `[status, receivedAt]` / `[status, nextAttemptAt]`.
    const leer = (carril: Prisma.DeliveryOrderEventWhereInput, take: number) =>
      retry(
        () =>
          prisma.deliveryOrderEvent.findMany({
            where: { AND: [...base, carril] },
            orderBy: { receivedAt: 'asc' },
            take,
            include: { channelLink: true },
          }),
        { shouldRetry: shouldRetryDbConnectionError, context: 'deliveryWebhookReconciliation.scan' },
      )

    let reprocessed = 0
    let orphanedImmediate = 0

    const procesar = async (events: Awaited<ReturnType<typeof leer>>) => {
      for (const event of events) {
        const { channelLink } = event
        // P1-3: una revocación de tienda se registra POR TIENDA aunque aún no exista su vínculo
        // (`DeliveryStoreRevocation`, lo hace el procesador). Tirarla aquí como ORPHANED la perdía y una
        // conexión en curso podía re-otorgar la tienda.
        const revocacionSinVinculo =
          !channelLink && event.provider === DeliveryProvider.UBER_EATS && event.eventType === 'store.deprovisioned'
        // Lo mismo con el resultado del aprovisionamiento de Rappi: su cuerpo no trae tienda de primer
        // nivel, así que NUNCA tiene vínculo; cada tienda la confirma su procesador.
        const aprovisionamientoRappi =
          !channelLink && event.provider === DeliveryProvider.RAPPI && event.eventType === 'STORE_PROVISIONING_STATUS'
        try {
          if (!channelLink && !revocacionSinVinculo && !aprovisionamientoRappi) {
            // 🔴 Condicionado, como el barrido de 24 h (R1): sólo si sigue FAILED/RECEIVED, sin un error terminal y SIN un
            // reclamo vigente. Un `update` por id a ciegas regresaba a FAILED/ORPHANED un evento que otro proceso acababa de
            // dejar PROCESSED, o lo dejaba PROCESSED con `error = 'ORPHANED'` y un 🚨 falso (pendiente de la Tarea 8).
            const ahora = new Date(Date.now())
            const { count } = await prisma.deliveryOrderEvent.updateMany({
              where: {
                id: event.id,
                status: { in: [DeliveryOrderEventStatus.FAILED, DeliveryOrderEventStatus.RECEIVED] },
                AND: [
                  { OR: [{ lockedUntil: null }, { lockedUntil: { lt: ahora } }] },
                  { OR: [{ error: null }, { error: { notIn: DeliveryWebhookReconciliationJob.TERMINAL_ERRORS } }] },
                ],
              },
              data: {
                status: DeliveryOrderEventStatus.FAILED,
                error: DeliveryWebhookReconciliationJob.ORPHANED_MARKER,
                processedAt: ahora,
              },
            })
            if (count === 0) {
              logger.info('🛵 [Delivery recon] evento sin vínculo que otro proceso ya cerró o tiene reclamado: no se toca', {
                eventId: event.id,
                provider: event.provider,
              })
              continue
            }
            // Same per-event alert shape/prefix as the 24h sweep below — BetterStack
            // alerts on the '🚨 [Delivery recon] ORPHANED' pattern. Without this, a
            // deleted DeliveryChannelLink (venue turning off its integration) would
            // orphan events silently, with only an aggregate info-level count.
            logger.error('🚨 [Delivery recon] ORPHANED delivery event — channel link deleted, nothing to re-parse against', {
              eventId: event.id,
              provider: event.provider,
              externalEventId: event.externalEventId,
              venueId: event.venueId,
              reason: 'CHANNEL_LINK_DELETED',
              ageHours: Math.round((Date.now() - new Date(event.receivedAt).getTime()) / 3_600_000),
            })
            orphanedImmediate++
            continue
          }

          if (await this.reprocesarSegunProveedor(event, channelLink)) reprocessed++
        } catch (err) {
          await this.anotarFallo(event, err)
        }
      }
    }
    // Sin el piso de 24 h, como el seguimiento: un aviso que el job nunca intentó no caduca por edad.
    if (carril === 'aprovisionamiento') {
      await procesar(
        await leer(
          {
            eventType: { in: DeliveryWebhookReconciliationJob.EVENTOS_DE_APROVISIONAMIENTO },
            OR: [
              { status: DeliveryOrderEventStatus.FAILED },
              { status: DeliveryOrderEventStatus.RECEIVED, receivedAt: { lt: receivedCutoff } },
            ],
          },
          this.SEGUIMIENTO_POR_PASADA,
        ),
      )
      return { reprocessed, orphanedImmediate }
    }

    // N-5: carril URGENTE primero, con el lote completo reservado (pedidos nuevos, programados,
    // cancelaciones, tiendas…); las relecturas de SEGUIMIENTO sólo usan el sobrante, con tope, y
    // se leen DESPUÉS de procesar las urgentes. Un solo carril por antigüedad dejaba un pedido nuevo
    // detrás de 50 avisos viejos hasta el minuto 12 (Codex, 4.ª pasada) y Uber lo cancelaba.
    const urgentes = await leer(
      {
        eventType: {
          notIn: [
            ...DeliveryWebhookReconciliationJob.EVENTOS_DE_SEGUIMIENTO,
            ...DeliveryWebhookReconciliationJob.EVENTOS_DE_APROVISIONAMIENTO,
          ],
        },
        OR: [
          { status: DeliveryOrderEventStatus.FAILED, receivedAt: { gte: orphanCutoff } },
          { status: DeliveryOrderEventStatus.RECEIVED, receivedAt: { gte: orphanCutoff, lt: receivedCutoff } },
        ],
      },
      this.BATCH_SIZE,
    )
    await procesar(urgentes)
    // N-8: aunque el carril urgente llene el lote, el seguimiento tiene un mínimo garantizado por
    // pasada (va DESPUÉS de las urgentes); si no, un aviso nunca tenía turno y caducaba sin lectura.
    const cupo = Math.max(this.SEGUIMIENTO_GARANTIZADO, Math.min(this.BATCH_SIZE - urgentes.length, this.SEGUIMIENTO_POR_PASADA))
    // Sin el piso de 24 h: un seguimiento se cierra solo (incidencia a las 3 h, en su primera lectura
    // pasada esa vida), así que uno que nunca tuvo turno se lee aunque sea viejo — no caduca por edad.
    const seguimiento = await leer(
      {
        eventType: { in: DeliveryWebhookReconciliationJob.EVENTOS_DE_SEGUIMIENTO },
        OR: [
          { status: DeliveryOrderEventStatus.FAILED },
          { status: DeliveryOrderEventStatus.RECEIVED, receivedAt: { lt: receivedCutoff } },
        ],
      },
      cupo,
    )
    await procesar(seguimiento)

    return { reprocessed, orphanedImmediate }
  }

  /**
   * Enruta el reproceso al camino del proveedor. Devuelve `true` si el evento quedó resuelto.
   *
   * Lanza ante un fallo TRANSITORIO — eso es lo que dispara el bookkeeping de backoff del
   * llamador. Un fallo TERMINAL no lanza: devuelve `false` y la fila queda excluida de toda
   * pasada futura por `TERMINAL_ERRORS`.
   *
   * (Cuando aterrice el registro de adaptadores, este `switch` se resuelve por ahí; hoy es el
   * único punto del job que conoce proveedores, y está aislado a propósito.)
   */
  private async reprocesarSegunProveedor(
    event: { id: string; provider: DeliveryProvider; payload: unknown; externalEventId: string; venueId: string | null },
    channelLink: Parameters<typeof ingestDeliveryOrder>[1] | null,
  ): Promise<boolean> {
    if (event.provider === DeliveryProvider.RAPPI) return this.reprocesarRappi(event.id)

    if (event.provider === DeliveryProvider.UBER_EATS) {
      // El procesador de Uber hace el camino completo (traer, aceptar, ingerir, marcar) y
      // NO lanza: reporta el desenlace. Traducirlo es lo que decide reintento vs. rendición.
      const r = await processUberEvent(event.id)

      if (
        r.outcome === 'PROCESSED' ||
        r.outcome === 'ALREADY_DONE' ||
        r.outcome === 'NOT_AN_ORDER' ||
        r.outcome === 'RECONCILED' ||
        r.outcome === 'STORE_STATE'
      )
        return true

      // Sin vínculo no hay a quién ingerirle: el procesador ya lo dejó visible y no hay
      // nada que reintentar. (En la práctica el guard de `channelLink` del llamador lo
      // atrapa antes; se contempla aquí para que este método sea correcto por sí solo.)
      if (r.outcome === 'ORPHANED') return false

      if (r.error && DeliveryWebhookReconciliationJob.TERMINAL_ERRORS.includes(r.error)) {
        logger.error('🚨 [Delivery recon] pedido de Uber TERMINAL — no se reintenta más', {
          eventId: event.id,
          externalEventId: event.externalEventId,
          venueId: event.venueId,
          motivo: r.error,
        })
        return false
      }

      // Transitorio (red, 5xx, un fallo de ingesta): que el llamador agende el backoff.
      throw new Error(r.error ?? 'Uber: fallo desconocido al reprocesar')
    }

    if (!channelLink) return false // sólo Uber y Rappi llegan aquí sin vínculo, y ya salieron arriba
    const normalized = parseDeliverectOrder(Buffer.from(JSON.stringify(event.payload)), channelLink)
    const { order } = await ingestDeliveryOrder(normalized, channelLink)
    await markEventResult(event.id, DeliveryOrderEventStatus.PROCESSED, order.id)
    return true
  }

  /**
   * El camino de Rappi (lo usan la pasada general y su carril propio). `true` = resuelto; `false` = no hay nada que
   * reintentar ahora; lanza ante un fallo para que el llamador agende el backoff.
   */
  private async reprocesarRappi(eventId: string): Promise<boolean> {
    const r = await processRappiEvent(eventId)
    if (
      r.outcome === 'PROCESSED' ||
      r.outcome === 'ALREADY_DONE' ||
      r.outcome === 'NOT_AN_ORDER' ||
      r.outcome === 'CANCELLED' ||
      r.outcome === 'SCHEDULED_NOTED' ||
      r.outcome === 'MENU_VERDICT' ||
      r.outcome === 'STORE_STATE'
    ) {
      return true
    }
    if (r.outcome === 'ORPHANED') return false
    // 🔴 Otro proceso lo tiene reclamado (la petición viva, el otro carril) y lo está terminando: no es un intento
    // fallido. Ni cuenta ni programa espera — lanzar aquí le pondría backoff a un pedido que sigue vivo.
    if (r.outcome === 'IN_FLIGHT') return false
    throw new Error(r.error ?? 'Rappi: fallo desconocido al reprocesar')
  }

  /**
   * Fix B2: un reproceso que lanzó. Lleva la cuenta de intentos del job y agenda la espera exponencial para que un
   * evento envenenado no ocupe cada pasada; la fila se queda FAILED/RECEIVED — sólo cambian `attemptCount`/`nextAttemptAt`.
   * Nunca lanza (lo usan el lote de la pasada general y los trabajadores del carril de Rappi).
   */
  private async anotarFallo(
    event: {
      id: string
      provider: DeliveryProvider
      externalEventId: string
      venueId: string | null
      status: DeliveryOrderEventStatus
      attemptCount: number | null
    },
    err: unknown,
  ): Promise<void> {
    // Fix B2: track this job's own retry attempts + schedule exponential
    // backoff so a poison event doesn't occupy every 2-minute pass forever.
    // The row itself is left FAILED/RECEIVED either way — only the
    // attemptCount/nextAttemptAt bookkeeping changes here.
    const attemptCount = (event.attemptCount ?? 0) + 1
    const isPoison = attemptCount >= this.MAX_ATTEMPTS
    // N-5: la espera cuenta desde que ESTE evento terminó, no desde el inicio del lote.
    const nextAttemptAt = isPoison ? null : new Date(Date.now() + this.backoffMs(attemptCount))

    try {
      await prisma.deliveryOrderEvent.update({
        where: { id: event.id },
        data: { attemptCount, nextAttemptAt },
      })
    } catch (bookErr) {
      // Best-effort — same per-event isolation guarantee as the rest of this
      // loop: a failed bookkeeping write must NEVER abort the batch. Worst
      // case the row keeps its old attemptCount/nextAttemptAt and gets
      // reselected next pass with no backoff applied yet (never worse than
      // pre-fix behavior).
      logger.error('❌ [Delivery recon] Failed to persist attemptCount/nextAttemptAt backoff bookkeeping (event stays for next pass)', {
        eventId: event.id,
        error: bookErr instanceof Error ? bookErr.message : bookErr,
      })
    }

    if (isPoison) {
      // Logged exactly ONCE: the pass that pushes attemptCount to MAX_ATTEMPTS
      // is the last one that will ever select this row again (excluded by the
      // scan's attemptCount filter from here on) — no repeat alerts.
      logger.error('🚨 [Delivery recon] POISON delivery event — reached MAX_ATTEMPTS, giving up (stays FAILED, never retried again)', {
        eventId: event.id,
        provider: event.provider,
        externalEventId: event.externalEventId,
        venueId: event.venueId,
        attemptCount,
      })
    } else if (err instanceof Error && err.message === CAMBIO_SIN_CONFIRMAR) {
      // Espera acotada, no falla: el procesador lo cierra cuando el pedido cierra en Uber o al
      // agotarse su vida, con incidencia (P1-2).
      logger.warn('[Delivery recon] cambio de pedido aún sin reflejar en el proveedor: se relee con backoff', {
        motivo: err.message,
        eventId: event.id,
        attemptCount,
        nextAttemptAt,
      })
    } else if (err instanceof Error && err.message === 'CANCELACION_EN_ESPERA') {
      // Tampoco es una falla: la cancelación de Rappi espera a que su NEW_ORDER termine de registrarse (Tarea 10). Se
      // reintenta con la misma espera; si el presupuesto se agota, termina POISON como cualquier otro (arriba).
      logger.warn('[Delivery recon] la cancelación espera a que su pedido termine de registrarse: se reintenta con backoff', {
        motivo: err.message,
        eventId: event.id,
        attemptCount,
        nextAttemptAt,
      })
    } else {
      logger.error('❌ [Delivery recon] Failed to reprocess event (stays for next pass, unless >24h old)', {
        eventId: event.id,
        status: event.status,
        attemptCount,
        nextAttemptAt,
        error: err instanceof Error ? err.message : err,
      })
    }
  }

  /** Fix B2: exponential backoff in ms — `2^attemptCount` minutes, capped at `BACKOFF_CAP_MINUTES`. */
  private backoffMs(attemptCount: number): number {
    return Math.min(2 ** attemptCount, this.BACKOFF_CAP_MINUTES) * 60_000
  }

  /**
   * Sweep FAILED/RECEIVED events older than 24h to `error: 'ORPHANED'`.
   * Bulk `updateMany` is fine — these are not eligible for further retries.
   */
  private async markOrphaned(carril: 'pedidos' | 'aprovisionamiento' = 'pedidos'): Promise<number> {
    const cutoff = new Date(Date.now() - this.ORPHAN_TTL_MS)
    const orphanWhere = {
      // Los MISMOS proveedores que el scan, y eso es lo que hace honesto al barrido: caducar
      // a las 24 h algo que nadie intentó procesar es tirar una venta en silencio (era el caso
      // de Uber hasta el 2026-08-20). Caduca sólo lo que de verdad se reintentó y no salió.
      provider: { in: DeliveryWebhookReconciliationJob.RECONCILABLE_PROVIDERS },
      status: { in: [DeliveryOrderEventStatus.FAILED, DeliveryOrderEventStatus.RECEIVED] },
      receivedAt: { lt: cutoff },
      // Idempotent — never re-log/re-touch a row already marked ORPHANED. Null-tolerant
      // OR (not a bare `not: 'ORPHANED'`) so error=null rows (first time aging out) still match.
      OR: [{ error: null }, { error: { notIn: DeliveryWebhookReconciliationJob.TERMINAL_ERRORS } }],
      // R1: cada carril barre lo SUYO — los avisos de aprovisionamiento, sólo su carril, bajo su candado.
      eventType:
        carril === 'aprovisionamiento'
          ? { in: DeliveryWebhookReconciliationJob.EVENTOS_DE_APROVISIONAMIENTO }
          : { notIn: DeliveryWebhookReconciliationJob.EVENTOS_DE_APROVISIONAMIENTO },
      // N-8: un seguimiento que este job nunca intentó no caduca por edad: su carril lo lee sin piso
      // de 24 h y el procesador lo cierra (con incidencia si pasó su vida).
      NOT: {
        eventType: {
          in: [
            ...DeliveryWebhookReconciliationJob.EVENTOS_DE_SEGUIMIENTO,
            ...DeliveryWebhookReconciliationJob.EVENTOS_DE_APROVISIONAMIENTO,
          ],
        },
        attemptCount: 0,
      },
    } satisfies Prisma.DeliveryOrderEventWhereInput

    // Fetch rows BEFORE flipping them so we can emit a per-event alert with enough detail
    // for manual reconciliation (pattern: blumon recon job). Capped at BATCH_SIZE — same cap
    // as the rest of the job — so a large orphan backlog can't be loaded into memory (and
    // logged, one line per row) in a single unbounded pass; it finishes across subsequent
    // 2-minute passes instead.
    const toOrphan = await prisma.deliveryOrderEvent.findMany({
      where: orphanWhere,
      select: { id: true, provider: true, externalEventId: true, status: true, venueId: true, receivedAt: true },
      take: this.BATCH_SIZE,
    })

    if (toOrphan.length === 0) return 0

    for (const row of toOrphan) {
      logger.error('🚨 [Delivery recon] ORPHANED delivery event — never reached a terminal state within 24h', {
        eventId: row.id,
        provider: row.provider,
        externalEventId: row.externalEventId,
        previousStatus: row.status,
        venueId: row.venueId,
        ageHours: Math.round((Date.now() - new Date(row.receivedAt).getTime()) / 3_600_000),
      })
    }

    // Scope the bulk flip to EXACTLY the rows just fetched/logged above — `updateMany` has no
    // `take`, so re-using the broader `orphanWhere` here would flip every matching row
    // regardless of the fetch cap, silently marking rows ORPHANED (and excluding them from all
    // future passes) WITHOUT ever emitting their per-event alert. Scoping by id keeps the
    // alert and the state change in lockstep and keeps this pass genuinely bounded.
    // R1: and the eligibility predicates stay in the UPDATE — a row another path resolved between the SELECT and
    // here (PROCESSED) is left alone instead of being flipped back to FAILED/ORPHANED. `count` is what really flipped.
    const result = await prisma.deliveryOrderEvent.updateMany({
      where: { ...orphanWhere, id: { in: toOrphan.map(row => row.id) } },
      data: {
        status: DeliveryOrderEventStatus.FAILED,
        error: DeliveryWebhookReconciliationJob.ORPHANED_MARKER,
        processedAt: new Date(),
      },
    })

    logger.warn('🚨 [Delivery recon] Marked orphaned delivery events (no terminal state within 24h)', { count: result.count })

    return result.count
  }
}

export const deliveryWebhookReconciliationJob = new DeliveryWebhookReconciliationJob()

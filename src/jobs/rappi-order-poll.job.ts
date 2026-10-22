// jobs/rappi-order-poll.job.ts

import { CronJob } from 'cron'
import { DeliveryProvider, Prisma } from '@prisma/client'

import { env } from '../config/env'
import logger from '../config/logger'
import { scheduleJob } from '../observability/jobContext'
import prisma from '../utils/prismaClient'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { rappiAdapter } from '../services/delivery-channels/providers/rappi/rappi.adapter'
import {
  credencialesPresentes,
  pedidosEnviadosRappi,
  sondearPedidosRappi,
  tiendasEscribiblesRappi,
} from '../services/delivery-channels/providers/rappi/rappi.client'
import { processRappiEvent } from '../services/delivery-channels/providers/rappi/rappi.eventProcessor'
import { INTERVALO_SONDEO_MS, type RappiRespuesta } from '../services/delivery-channels/providers/rappi/rappi.http'
import { ESTADOS_VIVOS_RAPPI, guardarPedidoSondeadoRappi } from '../services/delivery-channels/providers/rappi/rappi.webhookIngress'

/**
 * Sondeo de pedidos de Rappi POR TIENDA (Tarea 20): la red por si se pierde el aviso NEW_ORDER. APAGADO por default
 * (`RAPPI_ORDER_POLL_ENABLED`).
 *
 * Lo medido en el sandbox (M13, 22-oct): con el servidor apagado, Rappi intentó el aviso 3 veces (cada 5 s) y se rindió; Rappi
 * no documenta más reintentos. El `GET …/stores/{storeId}/orders` (host nuevo) devolvió el pedido UNA vez, y el segundo GET vino
 * vacío: 🔴 ese GET NO es una lectura, pasa los pedidos de READY a SENT y quien lee primero se los lleva.
 *
 * Una pasada, en este orden:
 *   1. Las tiendas: vínculos RAPPI vivos (`ESTADOS_VIVOS_RAPPI`, la misma regla del PING) que además estén en
 *      `tiendasEscribiblesRappi()`. UNA consulta acotada. 🔴 Sólo ésas reciben el GET: a cualquier otra le robaría sus pedidos.
 *   2. Por cada tienda: GET → cada pedido se GUARDA como evento con la MISMA llave que su webhook (P2002 = ya estaba), sin
 *      ninguna otra llamada de red en medio. Si el proceso muere aquí, el pedido ya no vuelve por el GET: lo recupera el paso 3.
 *   3. `GET …/orders/status/sent` (lectura, global, ~10 min): los de NUESTRAS tiendas se guardan igual; los de otras se ignoran.
 *   4. Lo que se guardó se procesa (`processRappiEvent`, que reclama la fila: nadie lo trabaja dos veces).
 * Un pedido que llega por el sondeo Y por el webhook, en cualquier orden, choca en el índice único `dedupKey` y se registra UNA
 * vez (`guardarPedidoSondeadoRappi`).
 *
 * Ritmo: el cron toca cada 15 s (segundos 7, 22, 37 y 52: nunca :00, `.claude/rules/cron-jobs.md`) y una pasada sale sólo si
 * pasaron 45 s desde que empezó la anterior (`INTERVALO_SONDEO_MS`, lo que Rappi pide para descargar pedidos). Ningún patrón de
 * cron da 45 s parejos; éste no los acorta nunca, ni después de una pasada lenta.
 *
 * 🔴 UNA SOLA INSTANCIA: el candado de «una pasada a la vez» es en memoria, y dos servidores con el interruptor prendido se
 * robarían los pedidos entre sí (`.claude/rules/una-sola-instancia.md`).
 */
export class RappiOrderPollJob {
  private job: CronJob | null = null

  /** Cada 15 s, en los segundos 7, 22, 37 y 52 — NUNCA :00 (regla anti-estampida). La pasada sale cada 45 s (ver `tick`). */
  private readonly CRON_PATTERN = '7,22,37,52 * * * * *'

  /** El cron no es exacto al milisegundo: sin esta holgura, un tick que llega 2 ms antes de los 45 s se brincaría hasta los 60. */
  private readonly HOLGURA_MS = 1_000

  /** Cuántas tiendas se sondean a la vez: cada GET trae su techo de 10 s y una tienda colgada no detiene a las demás. */
  private readonly TIENDAS_EN_PARALELO = 5

  /** Cuántos pedidos se procesan a la vez (lo que aguanta el pool de la base, como el carril de Rappi). */
  private readonly PROCESOS_EN_PARALELO = 5

  /** Candado en memoria: una sola pasada a la vez. ponytail: en memoria — una sola instancia (`una-sola-instancia.md`). */
  private sondeoEnCurso = false

  /** Cuándo empezó la última pasada (para el ritmo de 45 s). */
  private ultimaPasadaMs: number | null = null

  /** Sin llaves de la integración no sale nada; se avisa UNA vez por proceso, no en cada pasada. */
  private avisoSinLlaves = false

  start(): void {
    if (this.job) return
    if (!env.RAPPI_ORDER_POLL_ENABLED) {
      logger.info('⏭️  [Rappi sondeo] apagado (RAPPI_ORDER_POLL_ENABLED no es "true"): no se programa')
      return
    }
    this.job = scheduleJob('rappi-order-poll', this.CRON_PATTERN, () => this.tick(), null, false, 'America/Mexico_City')
    this.job.start()
    logger.info('🛵 Rappi order poll started — una pasada cada 45 s', { tiendasAutorizadas: tiendasEscribiblesRappi().length })
  }

  stop(): void {
    if (!this.job) return
    this.job.stop()
    this.job = null
    logger.info('🛵 Rappi order poll stopped')
  }

  /** Un tick del cron (cada 15 s): sólo corre si ya pasaron 45 s desde que empezó la pasada anterior y ésta ya terminó. */
  private async tick(): Promise<void> {
    const ahora = Date.now()
    if (this.ultimaPasadaMs !== null && ahora - this.ultimaPasadaMs < INTERVALO_SONDEO_MS - this.HOLGURA_MS) return
    if (this.sondeoEnCurso) {
      logger.warn('🛵 [Rappi sondeo] la pasada anterior sigue corriendo: se espera al siguiente tick')
      return
    }
    this.ultimaPasadaMs = ahora
    await this.runOnce()
  }

  /** Una pasada (una a la vez; nunca lanza). */
  async runOnce(): Promise<ResumenDelSondeo> {
    const resumen = resumenVacio()
    if (!env.RAPPI_ORDER_POLL_ENABLED) return { ...resumen, saltada: 'APAGADO' }
    if (this.sondeoEnCurso) {
      logger.warn('🛵 [Rappi sondeo] la pasada anterior sigue corriendo: se salta esta')
      return { ...resumen, saltada: 'EN_CURSO' }
    }
    this.sondeoEnCurso = true
    const empezo = Date.now()
    try {
      await this.pasada(resumen)
      // Sólo cuando el sondeo SÍ rescató algo: una pasada vacía cada 45 s ahogaría el log (y cada falla ya trae su warn).
      if (resumen.guardados > 0) logger.info('🛵 [Rappi sondeo] pasada terminada', { ...resumen, ms: Date.now() - empezo })
      return resumen
    } catch (err) {
      logger.error('❌ [Rappi sondeo] la pasada falló entera (la siguiente lo vuelve a intentar)', {
        error: err instanceof Error ? err.message : String(err),
      })
      return { ...resumen, saltada: 'FALLO' }
    } finally {
      // En `finally`: si la pasada revienta, el candado DEBE soltarse o el sondeo queda muerto para siempre.
      this.sondeoEnCurso = false
    }
  }

  private async pasada(resumen: ResumenDelSondeo): Promise<void> {
    const autorizadas = tiendasEscribiblesRappi()
    if (autorizadas.length === 0) {
      resumen.saltada = 'SIN_TIENDAS'
      return
    }
    if (!credencialesPresentes()) {
      if (!this.avisoSinLlaves) {
        logger.warn('🛵 [Rappi sondeo] faltan las llaves de la integración: no se sondea hasta que estén')
        this.avisoSinLlaves = true
      }
      resumen.saltada = 'SIN_CREDENCIALES'
      return
    }

    // UNA consulta, acotada por la propia lista (`provider + externalLocationId` es único) y con la única columna que se usa.
    const vinculos = await retry(
      () =>
        prisma.deliveryChannelLink.findMany({
          where: {
            provider: DeliveryProvider.RAPPI,
            status: { in: [...ESTADOS_VIVOS_RAPPI] },
            externalLocationId: { in: autorizadas },
          },
          select: { externalLocationId: true },
          orderBy: { externalLocationId: 'asc' },
          take: autorizadas.length,
        }),
      { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'rappiOrderPoll.vinculos' },
    )
    // El filtro en memoria repite el de la base a propósito: un GET a una tienda ajena le roba sus pedidos.
    const permitidas = new Set(autorizadas)
    const tiendas = vinculos.map(v => v.externalLocationId).filter(id => permitidas.has(id))
    resumen.tiendas = tiendas.length
    if (tiendas.length === 0) {
      resumen.saltada = 'SIN_TIENDAS'
      return
    }

    const porProcesar: string[] = []

    // 2. Por tienda: GET y, sin otra llamada de red en medio, guardar TODO lo que trajo.
    await enParalelo(tiendas, this.TIENDAS_EN_PARALELO, async storeId => {
      const pedidos = await leerLista(() => sondearPedidosRappi(storeId), { storeId })
      if (!pedidos) {
        resumen.fallidas++
        return
      }
      for (const p of pedidos) await this.guardar(p, 'TIENDA', storeId, resumen, porProcesar)
    })

    // 3. La recuperación: lo que está en SENT. Lectura global: sólo cuenta lo de nuestras tiendas.
    const elegibles = new Set(tiendas)
    const enviados = await leerLista(() => pedidosEnviadosRappi(), { lista: 'status/sent' })
    if (!enviados) resumen.fallidas++
    else {
      for (const p of enviados) {
        const storeId = rappiAdapter.extractIdentity(p).storeId
        if (!storeId || !elegibles.has(storeId)) {
          resumen.ignorados++ // de otra tienda de la integración: no es nuestro, y no se dice nada
          continue
        }
        await this.guardar(p, 'ENVIADOS', storeId, resumen, porProcesar)
      }
    }

    // 4. Procesar lo guardado. El procesador reclama la fila, así que el webhook o el carril de Rappi no lo repiten.
    await enParalelo(porProcesar, this.PROCESOS_EN_PARALELO, async eventRowId => {
      try {
        await processRappiEvent(eventRowId)
        resumen.procesados++
      } catch (err) {
        logger.error('❌ [Rappi sondeo] el procesamiento lanzó; el evento quedó guardado y lo retoma el carril de Rappi', {
          eventRowId,
          error: nombreDelError(err),
        })
      }
    })
  }

  /**
   * Guarda UN pedido del sondeo. 🔴 Sin reintento a propósito: un fallo de la base se recupera por `status/sent` en la siguiente
   * pasada, y el mensaje de un error de Prisma puede traer el cuerpo del pedido (datos del cliente): sólo se loguea su código.
   */
  private async guardar(
    pedido: unknown,
    origen: OrigenDelSondeo,
    storeId: string,
    resumen: ResumenDelSondeo,
    porProcesar: string[],
  ): Promise<void> {
    const orderId = rappiAdapter.extractIdentity(pedido).orderId
    let r: Awaited<ReturnType<typeof guardarPedidoSondeadoRappi>>
    try {
      r = await guardarPedidoSondeadoRappi(pedido)
    } catch (err) {
      resumen.noGuardados++
      logger.error('❌ [Rappi sondeo] no se pudo guardar un pedido del sondeo: lo recupera status/sent en la siguiente pasada', {
        storeId,
        orderId,
        origen,
        error: nombreDelError(err),
      })
      return
    }
    if (r.outcome === 'MALFORMED') {
      resumen.descartados++
      logger.warn('🛵 [Rappi sondeo] un elemento sin id de pedido o sin tienda: no se guarda', { storeId, origen })
      return
    }
    if (r.outcome === 'DUPLICATE') {
      resumen.duplicados++ // ya estaba (llegó su webhook, o el GET de esta misma pasada): se registra una vez
      return
    }
    resumen.guardados++
    if (r.eventRowId) porProcesar.push(r.eventRowId)
    // El origen queda en el log: `DeliveryOrderEvent` no tiene columna de origen y esta fase no lleva migración de esquema.
    logger.info('🛵 [Rappi sondeo] pedido guardado por el sondeo (su aviso no había llegado)', {
      storeId,
      orderId,
      origen,
      evento: r.evento,
      eventRowId: r.eventRowId,
    })
  }
}

type OrigenDelSondeo = 'TIENDA' | 'ENVIADOS'

export interface ResumenDelSondeo {
  /** Por qué no hubo pasada (o se cortó); sin valor = corrió. */
  saltada?: 'APAGADO' | 'EN_CURSO' | 'SIN_TIENDAS' | 'SIN_CREDENCIALES' | 'FALLO'
  tiendas: number
  guardados: number
  duplicados: number
  /** Elementos sin id de pedido o sin tienda. */
  descartados: number
  /** De `status/sent`, de tiendas que no son nuestras. */
  ignorados: number
  /** Lecturas que no se pudieron hacer o leer (un GET por tienda o `status/sent`). */
  fallidas: number
  /** Pedidos que la base no dejó guardar (los recupera `status/sent`). */
  noGuardados: number
  procesados: number
}

function resumenVacio(): ResumenDelSondeo {
  return { tiendas: 0, guardados: 0, duplicados: 0, descartados: 0, ignorados: 0, fallidas: 0, noGuardados: 0, procesados: 0 }
}

/**
 * Lee la lista de una respuesta. `null` = no se pudo (red, un no-2xx, un 2xx que no es lista), con un `warn` que lleva la tienda
 * y el status, NUNCA el cuerpo (trae datos del cliente) ni un 🚨: con una tienda caída serían ~1,900 avisos al día. Un cuerpo
 * vacío es una lista vacía (no hay pedidos que perder).
 */
async function leerLista(llamar: () => Promise<RappiRespuesta>, datos: Record<string, string>): Promise<unknown[] | null> {
  let r: RappiRespuesta
  try {
    r = await llamar()
  } catch (err) {
    logger.warn('🛵 [Rappi sondeo] no se pudo leer la lista de pedidos', {
      ...datos,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    })
    return null
  }
  if (!r.ok) {
    logger.warn('🛵 [Rappi sondeo] Rappi contestó un error a la lista de pedidos', { ...datos, status: r.status })
    return null
  }
  if (!r.raw.trim()) return []
  try {
    const lista: unknown = JSON.parse(r.raw)
    if (Array.isArray(lista)) return lista
  } catch {
    // cae abajo: el aviso es el mismo para «no es JSON» y «no es una lista»
  }
  logger.warn('🛵 [Rappi sondeo] la lista de pedidos no se entiende (no es una lista): lo que traía lo recupera status/sent', {
    ...datos,
    status: r.status,
    bytes: r.raw.length,
  })
  return null
}

/** Hasta `tope` trabajos a la vez; cada uno que termina toma el siguiente. Un trabajo que lanza no detiene a los demás. */
async function enParalelo<T>(items: readonly T[], tope: number, trabajo: (item: T) => Promise<void>): Promise<void> {
  const cola = [...items]
  const trabajador = async () => {
    for (let item = cola.shift(); item !== undefined; item = cola.shift()) {
      try {
        await trabajo(item)
      } catch (err) {
        logger.error('❌ [Rappi sondeo] un trabajo de la pasada lanzó (cada uno debería atrapar lo suyo)', { error: nombreDelError(err) })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(tope, cola.length) }, trabajador))
}

/** El código o el nombre del error, nunca su mensaje: el de Prisma puede traer el cuerpo del pedido. */
function nombreDelError(err: unknown): string {
  if (err instanceof Prisma.PrismaClientKnownRequestError) return err.code
  return err instanceof Error ? err.name : 'desconocido'
}

export const rappiOrderPollJob = new RappiOrderPollJob()

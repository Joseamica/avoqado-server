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
import { DeliveryWriteNotSentError } from '../services/delivery-channels/core/types'
import { processRappiEvent, type RappiProcessOutcome } from '../services/delivery-channels/providers/rappi/rappi.eventProcessor'
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
 * Si los GET por tienda fallan porque Rappi no nos dio token (login rechazado o caído), esa pasada NO pide `status/sent` y el
 * sondeo se PAUSA 5 min, con un solo warn por racha: sin la pausa machacaba el login cada 45 s (2 intentos fallidos por pasada),
 * contra el 98 % de éxito que Rappi exige. Al terminar la pausa se vuelve a intentar; si el login ya funciona, todo sigue normal.
 * Un pedido que llega por el sondeo Y por el webhook, en cualquier orden, choca en el índice único `dedupKey` y se registra UNA
 * vez (`guardarPedidoSondeadoRappi`).
 *
 * Ritmo: el cron toca cada 15 s (segundos 7, 22, 37 y 52: nunca :00, `.claude/rules/cron-jobs.md`) y una pasada sale sólo si
 * pasaron 45 s desde que empezó la anterior (`INTERVALO_SONDEO_MS`, lo que Rappi pide para descargar pedidos), con 1 s de holgura
 * para el retraso de un tick. Ningún patrón de cron da 45 s parejos: con éste, dos pasadas quedan a 45 s (las del grid), o a ~44 s
 * en el peor caso (si el tick anterior llegó hasta 1 s tarde), y nunca a 15 ni 30 s, ni después de una pasada lenta.
 *
 * 🔴 UNA SOLA INSTANCIA: el candado de «una pasada a la vez» es en memoria, y dos servidores con el interruptor prendido se
 * robarían los pedidos entre sí (`.claude/rules/una-sola-instancia.md`).
 */
export class RappiOrderPollJob {
  private job: CronJob | null = null

  /** Cada 15 s, en los segundos 7, 22, 37 y 52 — NUNCA :00 (regla anti-estampida). La pasada sale cada 45 s (ver `tick`). */
  private readonly CRON_PATTERN = '7,22,37,52 * * * * *'

  /**
   * El cron no es exacto al milisegundo: sin esta holgura, un tick que llega 2 ms antes de los 45 s se brincaría hasta los 60. El
   * costo: si el tick anterior llegó hasta 1 s tarde, dos pasadas pueden quedar a ~44 s (nunca menos).
   */
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

  /** Cuánto se pausa el sondeo cuando Rappi no nos da token: no se machaca un login que está fallando. */
  private readonly PAUSA_SIN_LOGIN_MS = 5 * 60_000

  /** Hasta cuándo dura la pausa por falta de token (`null` = sin pausa). En memoria: un reinicio la levanta, y eso está bien. */
  private pausadoHastaMs: number | null = null

  /** ¿Venimos de una racha sin token? Para avisar UNA vez al empezarla y decir cuándo volvió. */
  private enRachaSinLogin = false

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
    if (this.pausadoHastaMs !== null && Date.now() < this.pausadoHastaMs) {
      resumen.saltada = 'PAUSA_SIN_LOGIN' // ya se avisó al empezar la racha: ni login, ni GET, ni status/sent
      return
    }
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
    let sinToken = false
    await enParalelo(tiendas, this.TIENDAS_EN_PARALELO, async storeId => {
      // Sin token para una, no lo hay para ninguna (es uno por superficie): no se pide otra vez por cada tienda.
      if (sinToken) return
      const leida = await leerLista(() => sondearPedidosRappi(storeId), { storeId })
      if (!leida.ok) {
        resumen.fallidas++
        if (leida.sinToken) sinToken = true
        return
      }
      for (const p of leida.lista) await this.guardar(p, 'TIENDA', storeId, resumen, porProcesar)
    })

    if (sinToken) {
      // 🔴 Ni `status/sent` (sería OTRO login fallido) ni la siguiente pasada en 45 s: pausa de 5 min.
      this.pausarPorFaltaDeToken()
    } else {
      if (this.enRachaSinLogin) logger.info('🛵 [Rappi sondeo] el login volvió: el sondeo sigue normal')
      this.enRachaSinLogin = false
      this.pausadoHastaMs = null

      // 3. La recuperación: lo que está en SENT. Lectura global: sólo cuenta lo de nuestras tiendas.
      const elegibles = new Set(tiendas)
      const enviados = await leerLista(() => pedidosEnviadosRappi(), { lista: 'status/sent' })
      if (!enviados.ok) resumen.fallidas++
      else {
        for (const p of enviados.lista) {
          const identidad = identidadLegible(p)
          if (!identidad) {
            resumen.descartados++
            logger.warn('🛵 [Rappi sondeo] un elemento de status/sent con una identidad ilegible: no se guarda', { lista: 'status/sent' })
            continue
          }
          if (!identidad.storeId || !elegibles.has(identidad.storeId)) {
            resumen.ignorados++ // de otra tienda de la integración: no es nuestro, y no se dice nada
            continue
          }
          await this.guardar(p, 'ENVIADOS', identidad.storeId, resumen, porProcesar)
        }
      }
    }

    // 4. Procesar lo guardado. El procesador reclama la fila, así que el webhook o el carril de Rappi no lo repiten.
    await enParalelo(porProcesar, this.PROCESOS_EN_PARALELO, async eventRowId => {
      try {
        const r = await processRappiEvent(eventRowId)
        resumen.desenlaces[r.outcome] = (resumen.desenlaces[r.outcome] ?? 0) + 1
        if (r.outcome === 'PROCESSED') resumen.procesados++
      } catch (err) {
        resumen.desenlaces.LANZO = (resumen.desenlaces.LANZO ?? 0) + 1
        logger.error('❌ [Rappi sondeo] el procesamiento lanzó; el evento quedó guardado y lo retoma el carril de Rappi', {
          eventRowId,
          error: nombreDelError(err),
        })
      }
    })
  }

  /** Pausa el sondeo 5 min porque Rappi no nos dio token. Un solo warn por racha; las pausas siguientes de la misma racha, info. */
  private pausarPorFaltaDeToken(): void {
    this.pausadoHastaMs = Date.now() + this.PAUSA_SIN_LOGIN_MS
    const datos = { pausaMin: this.PAUSA_SIN_LOGIN_MS / 60_000 }
    if (!this.enRachaSinLogin) {
      logger.warn('🛵 [Rappi sondeo] Rappi no nos dio token: el sondeo se pausa para no machacar el login (lo tapa el webhook)', datos)
    } else logger.info('🛵 [Rappi sondeo] sigue sin token: otra pausa', datos)
    this.enRachaSinLogin = true
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
    const identidad = identidadLegible(pedido)
    if (!identidad) {
      resumen.descartados++
      logger.warn('🛵 [Rappi sondeo] un elemento con una identidad ilegible: no se guarda', { storeId, origen })
      return
    }
    const orderId = identidad.orderId
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
  saltada?: 'APAGADO' | 'EN_CURSO' | 'SIN_TIENDAS' | 'SIN_CREDENCIALES' | 'PAUSA_SIN_LOGIN' | 'FALLO'
  tiendas: number
  guardados: number
  duplicados: number
  /** Elementos sin id de pedido o sin tienda, o con una identidad que no se puede leer. */
  descartados: number
  /** De `status/sent`, de tiendas que no son nuestras. */
  ignorados: number
  /** Lecturas que no se pudieron hacer o leer (un GET por tienda o `status/sent`). */
  fallidas: number
  /** Pedidos que la base no dejó guardar (los recupera `status/sent`). */
  noGuardados: number
  /** Los que el procesador dejó PROCESSED (aceptados y registrados). El resto va en `desenlaces`. */
  procesados: number
  /** Cuántos dio cada desenlace del procesador (`IN_FLIGHT`, `FAILED`…; `LANZO` = el procesador lanzó). */
  desenlaces: Partial<Record<RappiProcessOutcome | 'LANZO', number>>
}

function resumenVacio(): ResumenDelSondeo {
  return {
    tiendas: 0,
    guardados: 0,
    duplicados: 0,
    descartados: 0,
    ignorados: 0,
    fallidas: 0,
    noGuardados: 0,
    procesados: 0,
    desenlaces: {},
  }
}

type ListaLeida = { ok: true; lista: unknown[] } | { ok: false; sinToken: boolean }

/**
 * Lee la lista de una respuesta. `ok: false` = no se pudo (red, un no-2xx, un 2xx que no es lista), con un `warn` que lleva la
 * tienda y el status, NUNCA el cuerpo (trae datos del cliente) ni un 🚨: con una tienda caída serían ~1,900 avisos al día. Un
 * cuerpo vacío es una lista vacía (no hay pedidos que perder).
 *
 * `sinToken`: la petición no salió porque no hubo token (el GET por tienda lleva el candado de escritura, así que `llamarRappi` lo
 * dice con `DeliveryWriteNotSentError('UNAVAILABLE')`). Sin warn aquí: el login ya avisó (🚨 al empezar la racha) y la pausa
 * avisa una vez.
 */
async function leerLista(llamar: () => Promise<RappiRespuesta>, datos: Record<string, string>): Promise<ListaLeida> {
  let r: RappiRespuesta
  try {
    r = await llamar()
  } catch (err) {
    if (err instanceof DeliveryWriteNotSentError && err.reason === 'UNAVAILABLE') return { ok: false, sinToken: true }
    logger.warn('🛵 [Rappi sondeo] no se pudo leer la lista de pedidos', {
      ...datos,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    })
    return { ok: false, sinToken: false }
  }
  if (!r.ok) {
    logger.warn('🛵 [Rappi sondeo] Rappi contestó un error a la lista de pedidos', { ...datos, status: r.status })
    return { ok: false, sinToken: false }
  }
  if (!r.raw.trim()) return { ok: true, lista: [] }
  try {
    const lista: unknown = JSON.parse(r.raw)
    if (Array.isArray(lista)) return { ok: true, lista }
  } catch {
    // cae abajo: el aviso es el mismo para «no es JSON» y «no es una lista»
  }
  logger.warn('🛵 [Rappi sondeo] la lista de pedidos no se entiende (no es una lista): lo que traía lo recupera status/sent', {
    ...datos,
    status: r.status,
    bytes: r.raw.length,
  })
  return { ok: false, sinToken: false }
}

/**
 * La identidad de un elemento de la lista, o `null` si no se puede leer: `extractIdentity` hace `.trim()` sobre los ids, y uno que no
 * es texto (`external_id: 123`) lanza TypeError. Sin esto, un elemento raro dejaba sin guardar a los que lo seguían en la lista (que
 * el GET ya había pasado a SENT) y tumbaba la pasada en `status/sent`.
 */
function identidadLegible(p: unknown): { storeId: string | null; orderId: string | null } | null {
  try {
    const { storeId, orderId } = rappiAdapter.extractIdentity(p)
    return { storeId, orderId }
  } catch {
    return null
  }
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

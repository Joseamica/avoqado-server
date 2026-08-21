// jobs/delivery-menu-sync.job.ts

import { CronJob } from 'cron'

import logger from '../config/logger'
import { scheduleJob } from '../observability/jobContext'
import { calcularTasaInyeccion, UMBRAL_OBJETIVO } from '../services/delivery-channels/core/injectionRate.service'
import { syncChannelAvailability, syncChannelMenu, syncableLinksWhere } from '../services/delivery-channels/core/menuSync.service'
import prisma from '../utils/prismaClient'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'

/**
 * Mantiene el menú de cada canal de delivery igual al de Avoqado.
 *
 * 🔴 POR QUÉ EXISTE (founder, 2026-08-20: "es importante que siempre los menús estén
 * actualizados, sino sería un problema grave"). Un menú viejo en el proveedor cuesta dinero
 * de dos formas y ninguna falla visiblemente:
 *   · El cliente paga el precio VIEJO — el proveedor cobra lo que SU menú dice, y la
 *     diferencia la come el negocio.
 *   · El cliente pide algo que ya no existe y hay que rechazar. Uber exige 99.9% de tasa de
 *     inyección y por debajo del 99% REVOCA el acceso: los rechazos por menú viejo se pagan
 *     con la integración completa.
 *
 * Compara por HUELLA, no por eventos (ver `menuSync.service.ts`): detecta cambios vengan de
 * donde vengan y se auto-corrige si una publicación se perdió.
 *
 * CADENCIA — 5 minutos, y el número está pensado, no elegido al azar: `PUT /menus` REEMPLAZA
 * el menú entero del proveedor, así que correrlo cada minuto mientras alguien edita su carta
 * lo republicaría 20 veces seguidas. Cinco minutos agrupa una tanda de ediciones en una sola
 * publicación y deja el menú viejo, a lo mucho, ese rato.
 */
export class DeliveryMenuSyncJob {
  private job: CronJob | null = null

  /** Cada 5 min al segundo :20 — NUNCA :00, regla anti-estampida (.claude/rules/cron-jobs.md). */
  private readonly CRON_PATTERN = '20 */5 * * * *'

  /** Tope por pasada: publicar un menú es una llamada pesada; una tanda grande se reparte. */
  private readonly BATCH_SIZE = 20

  start(): void {
    if (this.job) return
    this.job = scheduleJob('deliveryMenuSync', this.CRON_PATTERN, async () => {
      await this.runOnce()
    })
    logger.info('📋 Delivery menu sync job started — cada 5min, tope 20 canales')
  }

  stop(): void {
    this.job?.stop()
    this.job = null
  }

  async runOnce(): Promise<{ publicados: number; sinCambio: number; fallidos: number }> {
    let publicados = 0
    let sinCambio = 0
    let fallidos = 0

    try {
      // Regla del repo: la PRIMERA lectura del job va envuelta en retry — es la que muere
      // en la estampida de conexiones, y corre antes de cualquier efecto.
      const links = await retry(
        () =>
          prisma.deliveryChannelLink.findMany({
            where: syncableLinksWhere(),
            // El menos reciente primero: si hay más canales que el tope, todos avanzan por
            // turnos en vez de que unos pocos acaparen cada pasada.
            orderBy: { lastMenuSyncAt: { sort: 'asc', nulls: 'first' } },
            take: this.BATCH_SIZE,
          }),
        { shouldRetry: shouldRetryDbConnectionError, context: 'deliveryMenuSync.scan' },
      )

      for (const link of links) {
        // Aislamiento por canal: que el menú de un negocio no se quede viejo porque el de
        // otro reventó.
        const r = await syncChannelMenu(link)
        if (r.outcome === 'PUBLISHED') publicados++
        else if (r.outcome === 'UNCHANGED') sinCambio++
        else if (r.outcome === 'FAILED') fallidos++

        // La disponibilidad va SIEMPRE, aunque el menú no haya cambiado — de hecho es el
        // caso normal: el menú cambia una vez al mes y los productos se acaban a diario.
        // Va aparte y con su propio try/catch: que un fallo agotando un producto no impida
        // que el menú se publique (ni al revés).
        try {
          await syncChannelAvailability(link)
        } catch (error) {
          logger.error('🚨 [MenuSync] falló la disponibilidad — el proveedor puede estar vendiendo lo que no hay', {
            linkId: link.id,
            venueId: link.venueId,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }

      if (publicados > 0 || fallidos > 0) {
        logger.info('📋 [MenuSync] pasada terminada', { publicados, sinCambio, fallidos, revisados: links.length })
      }

      // 🔴 La tasa de inyección: el número con el que Uber decide REVOCAR el acceso (exige
      // 99.9%, revoca por debajo de 99%). Hasta hoy era invisible — se podía estar cayendo
      // semanas sin que nadie lo supiera hasta recibir el correo. Se revisa aquí en vez de
      // en su propio cron porque son los mismos canales y la misma cadencia; lo caro es
      // publicar el menú, no contar filas.
      for (const link of links) {
        try {
          const t = await calcularTasaInyeccion({ venueId: link.venueId, provider: link.provider })
          if (t.estado === 'CRITICO' || t.estado === 'ALERTA') {
            logger[t.estado === 'CRITICO' ? 'error' : 'warn'](
              t.estado === 'CRITICO'
                ? '🚨 [Inyección] BAJO EL UMBRAL DE REVOCACIÓN — el proveedor puede quitar el acceso'
                : `⚠️ [Inyección] por debajo del objetivo de ${UMBRAL_OBJETIVO}%`,
              {
                venueId: link.venueId,
                provider: link.provider,
                porcentaje: t.porcentaje,
                aceptados: t.aceptados,
                recibidos: t.recibidos,
                // Los motivos van en la MISMA línea: saber que va mal sin saber por qué
                // obliga a investigar desde cero justo cuando hay prisa.
                motivos: t.fallidos.slice(0, 5).map(f => f.motivo),
              },
            )
          }
        } catch (error) {
          logger.error('🚨 [Inyección] no se pudo calcular la tasa', {
            linkId: link.id,
            error: error instanceof Error ? error.message : error,
          })
        }
      }
    } catch (error) {
      // Nunca tumbar el cron: la siguiente pasada reintenta sola porque la huella no cambió.
      logger.error('🚨 [MenuSync] la pasada falló completa', { error: error instanceof Error ? error.message : error })
    }

    return { publicados, sinCambio, fallidos }
  }
}

export const deliveryMenuSyncJob = new DeliveryMenuSyncJob()

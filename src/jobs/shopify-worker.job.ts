/**
 * Worker del conector Shopify (spec 12 bis.10-11, §10.1-§10.2, §11.6, §11.9; plan v2 B8). Cada 30 s, SIN candado global:
 *  0. una LECTURA segura de entrada, con reintento (R04): si la base no contesta, la vuelta no reclama nada;
 *  1. buzón Avoqado → Shopify (una fila por reclamo; una en cuarentena no detiene a las demás, #12);
 *  2. eventos de Shopify (uno por reclamo, con lease; CUARENTENA sigue, N12);
 *  3. sucursales: cada una se reclama con su lease (`workToken`, 90 s, `SKIP LOCKED`, la que lleva más tiempo sin turno
 *     primero), hace UNA unidad y se suelta con `lastWorkedAt`; una unidad que falla espera (`nextWorkAt`). Ninguna
 *     acapara la vuelta (N18) y un lease vencido no deja a dos workers escribiendo (N19): todo efecto va cercado con el
 *     `workToken` (§11.2). Una sucursal sin avance o que falló no vuelve en la misma vuelta;
 *  4. avisos: los correos «Por revisar» que una vuelta dejó a medias;
 *  5. limpieza (una vez por hora, por tandas con tope).
 * Plazo absoluto (§11.6, N17): un vencimiento por vuelta y por fase. Antes de cada reclamo y después de él se recalcula lo
 * que queda; sin el mínimo, la unidad no empieza. El mensajero recibe `timeoutMs` = lo que queda; eventos y sucursales,
 * el vencimiento absoluto, que cada servicio recalcula antes de CADA petición. Nada de los reclamos ni de los avisos se
 * reintenta (R04): un reclamo que truena termina SU fase; una fila, un evento o una unidad que truena cuesta sólo eso.
 */
import prisma from '../utils/prismaClient'
import logger from '../config/logger'
import { scheduleJob } from '../observability/jobContext'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { DATABASE_JOB_SCHEDULES } from './jobSchedules'
import { claimShopifyOutbox, type ClaimResult } from '../services/commerce-channels/shopify/shopify.outbox.service'
import { claimShopifyEvent, processShopifyEvent } from '../services/commerce-channels/shopify/shopify.inbound.service'
import { seguirAvisosPendientes } from '../services/commerce-channels/shopify/shopify.reconcile.service'
import {
  conNegocio,
  enviarFila,
  ESPERA_FALLA_MS,
  limpiarShopify,
  MIN_UNIDAD_MS,
  planDeLaVuelta,
  PISO_ENVIO_MS,
  registrarFalla,
  soltarSucursal,
  tomarSucursal,
  unidadDeSucursal,
  type ResultadoUnidad,
  type SucursalTomada,
} from '../services/commerce-channels/shopify/shopify.worker.service'

// El contrato (§5) nombra estas piezas en el job: viven en el servicio y se re-exportan aquí.
export {
  enviarFila,
  limpiarShopify,
  soltarSucursal,
  tomarSucursal,
  unidadDeSucursal,
  type DepsUnidad,
  type ResultadoUnidad,
  type SucursalTomada,
} from '../services/commerce-channels/shopify/shopify.worker.service'

const PRESUPUESTO_TOTAL_MS = 25_000
type Fase = 'buzon' | 'eventos' | 'sucursales' | 'avisos' | 'limpieza'
/** R06: avisos tiene MÁS que `MIN_UNIDAD_MS` (con 1 s nunca alcanzaba para un correo pendiente). La suma es la vuelta. */
const PRESUPUESTO_MS: Record<Fase, number> = { buzon: 7_000, eventos: 5_000, sucursales: 8_000, avisos: 3_000, limpieza: 2_000 }

/**
 * R04 (cron-jobs.md:21): lo ÚNICO que se reintenta es esta lectura, antes de cualquier reclamo. Un reclamo cambia tokens
 * y contadores (y el del buzón avisa): reintentarlo podría dejar una fila tomada sin dueño conocido.
 */
const entradaSegura = () =>
  retry(() => prisma.shopifyLocationLink.findFirst({ select: { id: true } }), {
    retries: 2,
    initialDelay: 500,
    shouldRetry: shouldRetryDbConnectionError,
    context: 'shopify-worker.entrada',
  })

// ─── El job ─────────────────────────────────────────────────────────────────────────────────────────────────

export type ShopifyWorkerDeps = {
  now: () => Date
  cron: { start(): void; stop(): void }
  /** La lectura segura de entrada (R04): la única con reintento. */
  entrada: () => Promise<unknown>
  claimOutbox: (now: Date) => Promise<ClaimResult>
  /** El mensajero de A con `timeoutMs` = lo que le queda a la fase después del reclamo. */
  runOutboxRow: (id: string, claimToken: string, now: Date, timeoutMs: number) => Promise<unknown>
  claimEvent: (now: Date) => Promise<ClaimResult>
  processEvent: (id: string, claimToken: string, vence: number) => Promise<unknown>
  tomarSucursal: (now: Date, excluir: string[]) => Promise<SucursalTomada | null>
  /** `conTurno: false` = no hubo unidad por falta de tiempo: conserva su lugar en la fila (N18). */
  soltarSucursal: (id: string, workToken: string, now: Date, esperaMs: number | null, conTurno: boolean) => Promise<void>
  /** `revisarRetraso`: sólo la primera unidad de la sucursal en la vuelta revisa su retraso (U4). */
  unidad: (s: SucursalTomada, vence: number, revisarRetraso: boolean) => Promise<ResultadoUnidad>
  seguirAvisos: (vence: number) => Promise<void>
  limpiar: (now: Date, limite: number) => Promise<void>
}

export class ShopifyWorkerJob {
  private readonly deps: ShopifyWorkerDeps
  /** cron@4 no espera la vuelta anterior: en ESTE proceso corre una a la vez; entre procesos mandan los leases. */
  private running = false
  /** R3: el plan de cada negocio UNA vez por vuelta para el mensajero (#14: sólo un cambio nuevo lo pregunta). */
  private plan = planDeLaVuelta()

  constructor(overrides: Partial<ShopifyWorkerDeps> = {}) {
    this.deps = {
      now: () => new Date(),
      entrada: entradaSegura,
      claimOutbox: now => claimShopifyOutbox(now),
      runOutboxRow: (id, claimToken, now, timeoutMs) => enviarFila(id, claimToken, now, timeoutMs, { hasAccess: this.plan }),
      claimEvent: now => claimShopifyEvent(now),
      // Sin el plan de la vuelta a propósito: B2 lo resuelve una vez por negocio y evento, y ante CONTEXTO_CAMBIO lo relee
      // FRESCO (R2); una respuesta guardada de hace segundos escondería que se perdió.
      processEvent: (id, claimToken, vence) => processShopifyEvent(id, claimToken, { vence }),
      tomarSucursal,
      soltarSucursal,
      unidad: (s, vence, revisarRetraso) => conNegocio(s.venueId, () => unidadDeSucursal(s, vence, { revisarRetraso })),
      seguirAvisos: vence => seguirAvisosPendientes(vence),
      limpiar: limpiarShopify,
      cron:
        overrides.cron ??
        scheduleJob(
          'shopify-worker',
          DATABASE_JOB_SCHEDULES.shopifyWorker,
          // Se devuelve la promesa (sin `void`): el registro de jobs sabe cuándo terminó la vuelta.
          () =>
            this.runOnce().catch(err => {
              logger.error(`[SHOPIFY] worker: la vuelta falló: ${err?.message}`)
            }),
          null,
          false,
          'America/Mexico_City',
        ),
      ...overrides,
    }
  }

  start(): void {
    this.deps.cron.start()
  }

  stop(): void {
    this.deps.cron.stop()
  }

  async runOnce(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      // K19: la hora de la vuelta es la de su arranque (la limpieza la mira; las fases la empujarían más allá de :30).
      const inicio = this.deps.now()
      try {
        await this.deps.entrada()
      } catch (err) {
        logger.warn(`[SHOPIFY] worker: la base no contestó a la entrada; esta vuelta no reclama nada (${(err as Error)?.message})`)
        return
      }
      const tope = inicio.getTime() + PRESUPUESTO_TOTAL_MS
      this.plan = planDeLaVuelta()
      await this.paso('buzon', () => this.buzon(this.limite(tope, 'buzon')))
      await this.paso('eventos', () => this.eventos(this.limite(tope, 'eventos')))
      await this.paso('sucursales', () => this.sucursales(this.limite(tope, 'sucursales')))
      await this.paso('avisos', () => this.deps.seguirAvisos(this.limite(tope, 'avisos')))
      if (inicio.getUTCMinutes() === 7 && inicio.getUTCSeconds() < 30) {
        await this.paso('limpieza', () => this.deps.limpiar(this.deps.now(), this.limite(tope, 'limpieza')))
      }
    } finally {
      this.running = false
    }
  }

  /** El vencimiento absoluto de una fase: su presupuesto desde ahora, sin pasar el de la vuelta. */
  private limite(tope: number, fase: Fase): number {
    return Math.min(tope, this.deps.now().getTime() + PRESUPUESTO_MS[fase])
  }

  /** Lo que queda hasta `limite` (puede ser negativo). */
  private queda(limite: number): number {
    return limite - this.deps.now().getTime()
  }

  private async paso(nombre: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn()
    } catch (err) {
      registrarFalla(`la etapa ${nombre}`, err)
    }
  }

  private async buzon(limite: number): Promise<void> {
    while (this.queda(limite) >= MIN_UNIDAD_MS) {
      const ahora = this.deps.now()
      let fila: ClaimResult
      try {
        fila = await this.deps.claimOutbox(ahora)
      } catch (err) {
        return registrarFalla('reclamar una fila del buzón', err) // BR-5: termina la fase; nunca se reintenta a ciegas
      }
      if (fila.kind === 'VACIO') return
      if (fila.kind === 'CUARENTENA') continue // #12: la vencida ya quedó DEAD_LETTER; sigue la siguiente
      try {
        // Lo que queda DESPUÉS del reclamo es el corte de la petición (A lo aplica al fetch). Si el reclamo se comió el
        // margen, la fila sale con lo mínimo y su lease la protege; nunca se suelta una fila tomada.
        await this.deps.runOutboxRow(fila.id, fila.claimToken, ahora, Math.max(this.queda(limite), PISO_ENVIO_MS))
      } catch (err) {
        registrarFalla(`fila ${fila.id}`, err) // la fila sigue reclamada; su lease vencido la retoma
      }
    }
  }

  private async eventos(limite: number): Promise<void> {
    while (this.queda(limite) >= MIN_UNIDAD_MS) {
      let e: ClaimResult
      try {
        e = await this.deps.claimEvent(this.deps.now())
      } catch (err) {
        return registrarFalla('reclamar un evento', err)
      }
      if (e.kind === 'VACIO') return
      if (e.kind === 'CUARENTENA') continue // N12: quedó FAILED terminal; sigue el siguiente
      try {
        // S7: FAILED sin costo (CUPO) y DEFERRED (también ESPERA) no son errores; sin tiempo, vuelve sin gastar intento.
        await this.deps.processEvent(e.id, e.claimToken, limite)
      } catch (err) {
        registrarFalla(`evento ${e.id}`, err) // sigue PROCESSING; su lease vencido lo retoma
      }
    }
  }

  /** Una sucursal por reclamo, una unidad por sucursal; se suelta siempre (con espera si falló). */
  private async sucursales(limite: number): Promise<void> {
    /** Sin avance o con falla: no vuelven en esta vuelta (la siguiente las retoma). */
    const vistas: string[] = []
    /** U4: las que ya revisaron su retraso en esta vuelta (una sucursal puede tener varias unidades). */
    const conRetraso = new Set<string>()
    while (this.queda(limite) >= MIN_UNIDAD_MS) {
      let s: SucursalTomada | null
      try {
        s = await this.deps.tomarSucursal(this.deps.now(), vistas)
      } catch (err) {
        return registrarFalla('tomar una sucursal', err)
      }
      if (!s) return
      if (this.queda(limite) < MIN_UNIDAD_MS) {
        await this.soltar(s, null, false) // el reclamo se comió el margen: sin unidad, conserva su lugar
        return
      }
      let r: ResultadoUnidad = { ok: false }
      try {
        r = await this.deps.unidad(s, limite, !conRetraso.has(s.id))
        conRetraso.add(s.id)
      } catch (err) {
        registrarFalla(`sucursal ${s.id}`, err)
      }
      if (!r.ok || r.sinAvance) vistas.push(s.id)
      await this.soltar(s, r.ok ? (r.esperaMs ?? null) : (r.esperaMs ?? ESPERA_FALLA_MS), !r.sinTurno)
    }
  }

  /** Si soltar truena, el lease vence solo en 90 s: la vuelta sigue con la siguiente. */
  private async soltar(s: SucursalTomada, esperaMs: number | null, conTurno: boolean): Promise<void> {
    try {
      await this.deps.soltarSucursal(s.id, s.workToken, this.deps.now(), esperaMs, conTurno)
    } catch (err) {
      registrarFalla(`soltar la sucursal ${s.id} (su lease vence solo)`, err)
    }
  }
}

export const shopifyWorkerJob = new ShopifyWorkerJob()

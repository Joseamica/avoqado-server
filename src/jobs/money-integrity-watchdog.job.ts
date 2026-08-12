// jobs/money-integrity-watchdog.job.ts

import { CronJob } from 'cron'
import prisma from '../utils/prismaClient'
import logger from '../config/logger'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { scheduleJob } from '../observability/jobContext'

/**
 * Vigilante de integridad del dinero — PRUEBA TEMPORAL DE 4 DÍAS.
 *
 * Origen (2026-08-03): auditando clases de error de Odoo/ERPNext/Square encontramos un bug REAL
 * (descuentos apilados dejaban `Order.total` NEGATIVO y `remainingBalance = Math.max(0,…)` lo
 * disfrazaba de cuenta pagada). La orden de Mindform con −$1,776 estuvo 2 días en prod sin que
 * nadie lo notara, y unas propinas huérfanas de diciembre llevaban 7 meses ahí. Se encontraron por
 * casualidad, no por vigilancia.
 *
 * Este job convierte esas revisiones manuales en una alarma automática: corre cada 6 h, calla si
 * todo está bien, y grita con detalle si algo se rompe.
 *
 * 🔴 La prueba original era de 4 días (hasta 2026-08-07). El 2026-08-06 el founder decidió
 * EXTENDERLA: la primera corrida encontró 7 problemas reales de backlog y validó las 4
 * invariantes sin falsos positivos, así que sigue vigilando hasta WATCHDOG_UNTIL (abajo).
 * Para volverlo permanente de verdad: quitar el bloque de expiración. Para matarlo antes:
 * quitar el .start() en server.ts.
 *
 * ── Calibración (verificada contra producción 2026-08-03, NO cambiar a ciegas) ────────────────
 * Estas convenciones son la diferencia entre una alarma útil y 1,465 falsos positivos:
 *  • `Order.paidAmount` = Σ(Payment.amount) + Σ(Payment.tipAmount)  → la propina SÍ va incluida.
 *  • Las órdenes con REEMBOLSO no cuadran por diseño (el cobro original permanece) → se excluyen.
 *  • Los venues demo/seed traen datos sembrados con otras convenciones → se excluyen.
 *  • `Order.total` incluye la propina en el camino TPV; los seeds la omiten. Por eso NO validamos
 *    la fórmula del total: solo que no sea NEGATIVO, que es el bug real.
 */

/** Última fecha (inclusive) en que el vigilante trabaja. Después: no-op. */
const WATCHDOG_UNTIL = new Date('2026-12-31T00:00:00-06:00')

/**
 * Filtro de venues reales — los demo/seed usan convenciones propias.
 *
 * 🔴 Excluir por slug NO basta: la org de pruebas del founder ("Grupo Avoqado Prime") tiene 4 venues
 * y sólo UNO trae "demo" en el slug. `Avoqado Full` (147 órdenes) se colaba y aportaba 89 de los 92
 * falsos positivos de sobrepago del 2026-08-04. Se filtra por ORGANIZACIÓN, no por nombre de venue.
 */
const REAL_VENUES = `v.slug NOT LIKE '%demo%' AND v.name NOT LIKE 'Live Demo%'
        AND NOT EXISTS (SELECT 1 FROM "Organization" org WHERE org.id = v."organizationId" AND org.name = 'Grupo Avoqado Prime')`

/**
 * Casos YA revisados que NO se pueden arreglar de nuestro lado: dependen de la decisión de
 * un TERCERO. Se excluyen de la alarma (con motivo escrito) para que el vigilante pueda
 * llegar a verde — una alarma que grita lo mismo cada 6 h entrena a todos a ignorarla, que
 * es justo lo que este job existe para evitar.
 *
 * 🔴 NO agregues aquí un caso "para que deje de sonar". Sólo entra lo que ya se investigó y
 * cuya resolución NO está en nuestras manos. Todo lo demás se arregla.
 *
 * Revisión: 2026-08-08 (el resto del backlog se limpió; ver ActivityLog `origen:
 * reparacion-manual-money-watchdog`).
 */
const TRIAGED_AWAITING_THIRD_PARTY: Record<string, string> = {
  // Venta de SIM de $100 en efectivo sobre un ítem de catálogo con precio $0. Su
  // SaleVerification quedó COMPLETED y revisada el 2026-06-16 → ya fue la base de lo que
  // Walmart le pagó a PlayTelecom. Reescribir el precio ahora desincroniza un registro ya
  // aprobado y facturado. Decisión de Isaac Mayoral.
  cmpxaycfu012vnh29j14xha8k: 'BAE: venta de SIM ya aprobada y facturada a Walmart — espera decisión de PlayTelecom',

  // Cuenta de $380 (VISA) con dos cobros AMEX posteriores ($122 y $232, otro día,
  // autorizaciones distintas): son ventas REALES de otro cliente que cayeron sobre un
  // cheque ya cerrado. No es doble cobro; es atribución. Reconstruir qué se vendió sería
  // inventar datos. Decisión de Mindform.
  cmqnz0gkb0bc9o12a0fuc6deg: 'Mindform: cobros reales atribuidos a un cheque cerrado — espera que Mindform identifique la venta',
}

interface Violation {
  check: string
  venue: string
  orderId: string
  detalle: string
}

export class MoneyIntegrityWatchdogJob {
  private job: CronJob | null = null
  private expiredAnnounced = false

  /** Cada 6 h, en el minuto 17 para no chocar con la estampida del :00 (ver cron-jobs.md). */
  private readonly CRON_PATTERN = '17 */6 * * *'

  constructor() {
    this.job = scheduleJob('money-integrity-watchdog', this.CRON_PATTERN, this.run.bind(this), null, false, 'America/Mexico_City')
  }

  start(): void {
    if (!this.job) return
    this.job.start()
    logger.info(`💰 Money integrity watchdog started — ${this.CRON_PATTERN}, se auto-apaga el ${WATCHDOG_UNTIL.toISOString().slice(0, 10)}`)
  }

  stop(): void {
    if (this.job) {
      this.job.stop()
      logger.info('💰 Money integrity watchdog stopped')
    }
  }

  private async run(): Promise<void> {
    if (new Date() >= WATCHDOG_UNTIL) {
      if (!this.expiredAnnounced) {
        this.expiredAnnounced = true
        logger.info('💰 [Money watchdog] Periodo de prueba de 4 días terminado — el vigilante ya no revisa nada.')
      }
      return
    }

    try {
      const allViolations = await this.check()

      const violations = allViolations.filter(v => !TRIAGED_AWAITING_THIRD_PARTY[v.orderId])
      const silenced = allViolations.filter(v => TRIAGED_AWAITING_THIRD_PARTY[v.orderId])

      // Se reportan como INFO (no error) para que no se pierdan de vista sin disparar alarma.
      if (silenced.length > 0) {
        logger.info(`💰 [Money watchdog] ${silenced.length} caso(s) ya triado(s), esperando a un tercero`, {
          casos: silenced.map(v => ({ orderId: v.orderId, check: v.check, motivo: TRIAGED_AWAITING_THIRD_PARTY[v.orderId] })),
        })
      }

      if (violations.length === 0) {
        logger.info('💰 [Money watchdog] Todo cuadra ✅')
        return
      }

      // BetterStack debe alertar sobre '🚨 [Money watchdog]'.
      for (const v of violations) {
        // `venueName` (not `venue`) is the field the rest of the platform stamps, so a money
        // alert filters and reads exactly like every other log line.
        logger.error(`🚨 [Money watchdog] ${v.check}`, { venueName: v.venue, orderId: v.orderId, detalle: v.detalle })
      }
      logger.error(`🚨 [Money watchdog] ${violations.length} problema(s) de dinero detectado(s)`, {
        porTipo: violations.reduce<Record<string, number>>((acc, v) => ({ ...acc, [v.check]: (acc[v.check] ?? 0) + 1 }), {}),
      })
    } catch (err) {
      logger.error('❌ [Money watchdog] La revisión falló', { error: err instanceof Error ? err.message : err })
    }
  }

  /** Las 3 invariantes de dinero. Consultas probadas contra prod el 2026-08-03. */
  private async check(): Promise<Violation[]> {
    // Entry read con retry por la regla de cron-jobs.md (lectura pura, segura de reintentar).
    const rows = await retry(
      () =>
        prisma.$queryRawUnsafe<Array<{ check: string; venue: string; order_id: string; detalle: string }>>(`
        -- 1. Cuentas en NEGATIVO (el bug de descuentos apilados, corregido en 268c5fc6).
        --    remainingBalance usa Math.max(0,…), así que una cuenta negativa APARENTA estar pagada.
        SELECT 'TOTAL NEGATIVO' AS check, v.name AS venue, o.id AS order_id,
               'total=' || o.total || ' subtotal=' || o.subtotal || ' descuento=' || o."discountAmount" AS detalle
        FROM "Order" o JOIN "Venue" v ON v.id = o."venueId"
        WHERE o.total < 0 AND ${REAL_VENUES}

        UNION ALL

        -- 2. Descuento MAYOR que el consumo — regalaría más de lo que vale la cuenta.
        SELECT 'DESCUENTO EXCEDE EL CONSUMO', v.name, o.id,
               'descuento=' || o."discountAmount" || ' > subtotal=' || o.subtotal
        FROM "Order" o JOIN "Venue" v ON v.id = o."venueId"
        WHERE o."discountAmount" > o.subtotal AND o.subtotal > 0 AND ${REAL_VENUES}

        UNION ALL

        -- 3. La propina de la orden no coincide con la de sus cobros → propina perdida o duplicada.
        SELECT 'PROPINA NO CUADRA', v.name, o.id,
               'orden=' || o."tipAmount" || ' cobros=' || COALESCE(pp.propina, 0)
        FROM "Order" o
        JOIN "Venue" v ON v.id = o."venueId"
        LEFT JOIN (
          SELECT "orderId", SUM("tipAmount") AS propina
          FROM "Payment" WHERE status = 'COMPLETED' AND type <> 'REFUND' GROUP BY "orderId"
        ) pp ON pp."orderId" = o.id
        WHERE (o."tipAmount" > 0 OR COALESCE(pp.propina, 0) > 0)
          AND ROUND(o."tipAmount"::numeric, 2) <> ROUND(COALESCE(pp.propina, 0)::numeric, 2)
          -- Los reembolsos descuadran por diseño: el cobro original permanece registrado.
          AND NOT EXISTS (SELECT 1 FROM "Payment" r WHERE r."orderId" = o.id AND r.type = 'REFUND')
          AND ${REAL_VENUES}

        UNION ALL

        -- 4. SOBREPAGO: se cobró MÁS de lo que la cuenta vale.
        --    recordOrderPayment no filtra por estado, así que una cuenta ya COMPLETED/PAID sigue
        --    aceptando cobros — y remainingBalance = Math.max(0,...) los vuelve invisibles. Caso real:
        --    Mindform 2026-06-21/22, cuenta de $380 con $734 cobrados en 3 tarjetazos (2026-08-04).
        --    Se compara contra Payment.amount (SIN propina): la propina es dinero extra legítimo.
        SELECT 'SOBREPAGO', v.name, o.id,
               'cobrado=' || ROUND(pg.cobrado::numeric, 2) || ' cuenta=' || ROUND(pg.cuenta::numeric, 2) ||
               ' exceso=' || ROUND((pg.cobrado - pg.cuenta)::numeric, 2) || ' cobros=' || pg.n
        FROM "Order" o
        JOIN "Venue" v ON v.id = o."venueId"
        JOIN LATERAL (
          SELECT SUM(p.amount) AS cobrado, COUNT(*) AS n,
                 (o.subtotal - o."discountAmount" + o."taxAmount" + COALESCE(o."serviceChargeAmount", 0)) AS cuenta
          FROM "Payment" p
          WHERE p."orderId" = o.id AND p.status = 'COMPLETED' AND p.type <> 'REFUND'
        ) pg ON TRUE
        WHERE pg.cobrado > pg.cuenta + 0.01
          AND NOT EXISTS (SELECT 1 FROM "Payment" r WHERE r."orderId" = o.id AND r.type = 'REFUND')
          AND ${REAL_VENUES}

        LIMIT 200
      `),
      { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'money-watchdog.check' },
    )

    return rows.map(r => ({ check: r.check, venue: r.venue, orderId: r.order_id, detalle: r.detalle }))
  }
}

export const moneyIntegrityWatchdogJob = new MoneyIntegrityWatchdogJob()

// jobs/money-integrity-watchdog.job.ts

import { CronJob } from 'cron'
import prisma from '../utils/prismaClient'
import logger from '../config/logger'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { scheduleJob } from '../observability/jobContext'
import { baseQueDebeCubrirseSql, COBRO_QUE_CUBRE, criterioPagadaPeroAbiertaSql } from '../services/shared/pagadaPeroAbierta'

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
 *  • (2026-09-02) La propina sólo se juzga cuando la orden TIENE cobros. El 31-ago-2026 se borraron
 *    a propósito 1,092 `Payment` (limpieza de cuentas Blumon "Externo"; respaldo en
 *    `Avoqado/respaldos/2026-08-31-limpieza-blumon/`) y sus 1,091 órdenes siguen PAID sin cobro:
 *    comparar contra una suma que vale 0 disparó 672 alertas de un dato que nadie va a restaurar
 *    (decisión del founder). Una orden PAID sin ningún cobro es OTRA invariante (abajo), acotada
 *    a lo creado después de esa limpieza para que el pasado no entrene a ignorar la alarma.
 *  • El resumen reporta el total REAL por tipo (consulta de conteo sin tope); el detalle sí lleva
 *    `LIMIT`. Antes el «201 constante» en Better Stack era el tope, no el estado.
 */

/** Última fecha (inclusive) en que el vigilante trabaja. Después: no-op. */
const WATCHDOG_UNTIL = new Date('2026-12-31T00:00:00-06:00')

/**
 * Corte de la invariante «orden pagada sin cobro»: sólo órdenes creadas desde este día. Es la
 * fecha de la limpieza Blumon del 31-ago-2026 (ver calibración arriba). Va inline en el SQL como
 * literal, NO como bind de fecha — es una fecha civil fija, no un instante.
 */
export const HUERFANAS_DESDE = '2026-08-31'

/** Tope del DETALLE (una línea de log por violación). Los totales se cuentan aparte, sin tope. */
export const DETAIL_LIMIT = 200

/**
 * El vigilante sólo alerta lo que el barrido paid-order-reconciler YA tuvo oportunidad de
 * cerrar: su gracia (5 min sobre `updatedAt`) más un ciclo completo suyo (corre cada 10 min).
 * Por debajo de esto una orden pagada-pero-abierta es un estado que se sana solo; alertarlo
 * enseña a ignorar la alerta.
 */
export const VENTANA_DEL_BARRIDO_MIN = 15

/**
 * Corte de la invariante «orden sin vale de inventario»: sólo órdenes creadas desde este día.
 * Es cuando el outbox durable de `InventoryPosting` llegó a `main` —y con él a producción—
 * (630e917f el 13-ago-2026, a6e34471 el 14). ANTES de esa fecha ninguna orden pudo tener vale,
 * así que sin este piso el vigilante gritaría por la historia entera de cada venue con recetas y
 * entrenaría a todos a ignorarlo, que es justo lo que este job existe para evitar. No es una
 * precaución teórica: medido el 3-sep-2026 contra la base local, el check pasa de **0** alertas
 * a **774** al quitarlo. Va inline en el SQL como literal, igual que HUERFANAS_DESDE: es una
 * fecha civil fija, no un instante.
 */
export const VALES_DESDE = '2026-08-14'

/**
 * «Esta venta descuenta inventario», en SQL — espejo de a quién le nace una LÍNEA de deducción
 * en `createSalePostingInTx` (`services/inventory/inventoryPosting.service.ts`), que clasifica
 * con `getProductInventoryMethods`. No se inventa aquí un criterio propio: uno más ancho
 * gritaría por ventas que nunca debieron descontar nada, y uno más estrecho callaría el caso
 * que este check existe para ver.
 *
 * Renglón por renglón, tal como lo decide el bucle del cobro:
 *  · `if (!item.productId) continue` — sin producto NO hay línea, **ni siquiera por modificador**;
 *  · producto deducible = del MISMO venue (el aislamiento por tenant que pide `venueId` en la
 *    clasificación), con `trackInventory`, y con `inventoryMethod` explícito o —fallback de los
 *    productos legacy— una `Recipe`;
 *  · o el renglón trae un modificador con materia prima, que descuenta aunque el producto no
 *    lleve inventario (`itemHasInventoryModifiers` exige `rawMaterialId` Y `quantityPerUnit`).
 *
 * 🔴 Si `createSalePostingInTx` cambia a quién le crea línea, esto cambia en el MISMO trabajo:
 * son las dos mitades de la misma pregunta.
 */
export const ORDEN_DESCUENTA_INVENTARIO = `EXISTS (
            SELECT 1 FROM "OrderItem" oi
            WHERE oi."orderId" = o.id AND oi."productId" IS NOT NULL
              AND (
                EXISTS (
                  SELECT 1 FROM "Product" pr
                  WHERE pr.id = oi."productId" AND pr."venueId" = o."venueId" AND pr."trackInventory"
                    AND (pr."inventoryMethod" IS NOT NULL OR EXISTS (SELECT 1 FROM "Recipe" rc WHERE rc."productId" = pr.id))
                )
                OR EXISTS (
                  SELECT 1 FROM "OrderItemModifier" oim
                  JOIN "Modifier" m ON m.id = oim."modifierId"
                  WHERE oim."orderItemId" = oi.id AND m."rawMaterialId" IS NOT NULL AND m."quantityPerUnit" IS NOT NULL
                )
              )
          )`

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
export const TRIAGED_AWAITING_THIRD_PARTY: Record<string, string> = {
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

export interface WatchdogRun {
  expired: boolean
  /** Total REAL de violaciones (sin tope), ya sin los casos triados. */
  total: number
  /** Cuántas se escribieron al log (acotado por DETAIL_LIMIT). */
  mostrados: number
  porTipo: Record<string, number>
}

/**
 * Las 7 invariantes de dinero como un CTE, y dos consultas encima: los totales por tipo (sin
 * tope) y el detalle (con tope). Exportado puro para poder probar su forma y correrlo a mano
 * contra producción en sólo lectura. Consultas probadas contra prod el 2026-08-03 y el 2026-09-02.
 */
export function buildWatchdogSql(): { counts: string; details: string } {
  const cte = `
    WITH v AS (
        -- 1. Cuentas en NEGATIVO (el bug de descuentos apilados, corregido en 268c5fc6).
        --    remainingBalance usa Math.max(0,…), así que una cuenta negativa APARENTA estar pagada.
        SELECT 'TOTAL NEGATIVO' AS "check", v.name AS venue, o.id AS order_id,
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
        --    🔴 JOIN, no LEFT JOIN: sin ningún Payment no hay con qué comparar (ver calibración:
        --    los 1,092 cobros borrados a propósito el 31-ago-2026). Una orden PAID sin cobro es la
        --    invariante 5; una CANCELLED con propina precalculada y sin cobro no es un problema.
        SELECT 'PROPINA NO CUADRA', v.name, o.id,
               'orden=' || o."tipAmount" || ' cobros=' || pp.propina || ' pagos=' || pp.n
        FROM "Order" o
        JOIN "Venue" v ON v.id = o."venueId"
        JOIN (
          SELECT "orderId", COUNT(*) AS n,
                 COALESCE(SUM("tipAmount") FILTER (WHERE status = 'COMPLETED' AND type <> 'REFUND'), 0) AS propina
          FROM "Payment" GROUP BY "orderId"
        ) pp ON pp."orderId" = o.id
        WHERE (o."tipAmount" > 0 OR pp.propina > 0)
          AND ROUND(o."tipAmount"::numeric, 2) <> ROUND(pp.propina::numeric, 2)
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

        UNION ALL

        -- 5. ORDEN PAGADA SIN COBRO: dice PAID con dinero y no tiene ni un Payment detrás.
        --    Acotada a lo creado desde HUERFANAS_DESDE: las 1,091 huérfanas de la limpieza del
        --    31-ago-2026 son deliberadas (decisión del founder, 2026-09-02) y no se restauran.
        --    paidAmount > 0 deja fuera las ventas de $0 (SIM de PlayTelecom), que son normales.
        SELECT 'ORDEN PAGADA SIN COBRO', v.name, o.id,
               'pagado=' || o."paidAmount" || ' total=' || o.total || ' creada=' || o."createdAt"::date
        FROM "Order" o JOIN "Venue" v ON v.id = o."venueId"
        WHERE o."paymentStatus" = 'PAID' AND o."paidAmount" > 0
          AND o."createdAt" >= '2026-08-31'
          AND NOT EXISTS (SELECT 1 FROM "Payment" p WHERE p."orderId" = o.id)
          AND ${REAL_VENUES}

        UNION ALL

        -- 6. PAGADA PERO ABIERTA: los cobros YA cubren la cuenta y la orden sigue sin cerrar.
        --    Caso semilla ORD-1788276418170 (Testarudo, 1-sep-2026): el Payment quedó COMPLETED
        --    y la transición a PAID nunca aterrizó, así que el Cierre del día la lista como
        --    pendiente para siempre — y esa pantalla es de sólo lectura.
        --    🔴 El criterio NO se escribe aquí: sale del MISMO módulo que usa el barrido
        --    paid-order-reconciler.job.ts (cada 10 min). Si divergieran, el barrido cerraría un
        --    conjunto de órdenes y el vigilante vigilaría otro.
        --    Qué puede aparecer aquí SIN que el barrido haya fallado — son tres clases, y por eso
        --    esto NO es «lo que el barrido no pudo cerrar» a secas:
        --      · lo que intentó y no pudo cerrar (p. ej. falló el vale de inventario): el motivo
        --        está en el log de ESE job, y una que reaparece pasada tras pasada NO se cierra
        --        a mano;
        --      · lo anterior a su lookback (LOOKBACK_DAYS = 30 días): nunca lo intentó. Es el
        --        rezago viejo de producción, el que cierra el script de la fase 5;
        --      · lo que excede su lote por tick (50 órdenes por pasada): lo alcanza en los
        --        ticks siguientes.
        --    Y lo que la ventana de VENTANA_DEL_BARRIDO_MIN deja fuera es, a propósito, lo que
        --    todavía está a tiempo de sanarse solo.
        --    Sin tope de fecha a propósito, al revés que la invariante 5: el barrido sólo mira
        --    30 días hacia atrás, así que el rezago más viejo no lo vigila nadie más.
        SELECT 'PAGADA PERO ABIERTA', v.name, o.id,
               'status=' || o.status || ' paymentStatus=' || o."paymentStatus" ||
               ' base=' || ${baseQueDebeCubrirseSql('o')} ||
               ' pagado=' || (SELECT COALESCE(SUM(p.amount), 0) FROM "Payment" p WHERE p."orderId" = o.id AND ${COBRO_QUE_CUBRE})
        FROM "Order" o JOIN "Venue" v ON v.id = o."venueId"
        WHERE ${criterioPagadaPeroAbiertaSql('o')}
          AND o."updatedAt" < (NOW() AT TIME ZONE 'UTC') - INTERVAL '${VENTANA_DEL_BARRIDO_MIN} minutes'
          AND ${REAL_VENUES}

        UNION ALL

        -- 7. ORDEN SIN VALE DE INVENTARIO: se cerró vendiendo mercancía que descuenta stock y no
        --    existe el vale (InventoryPosting) que lo respalda — la deducción se perdió, y sin
        --    esta invariante se pierde EN SILENCIO.
        --    Caso semilla ORD-1788276418170 (Testarudo, 1-sep-2026, $74.75, 1 CAPUCCINO): la
        --    segunda transacción del cobro murió, así que el vale nunca nació — y por eso mismo
        --    la orden se quedó abierta. Cuando el barrido la cerró (2-sep) hizo lo correcto, pero
        --    con eso borró la ÚNICA señal que quedaba: la invariante 6 dejó de verla y ninguna
        --    otra la mira. Medido el 3-sep-2026: de 219 órdenes COMPLETED de Testarudo del 1 y 2
        --    de sep, 217 tienen vale y 2 no.
        --    🔴 Esto OBSERVA, no repara, y es deliberado: inventory-posting-sweeper sólo
        --    reclama vales que YA existen (PENDING/PARTIAL_FAILED/APPLYING) y no puede rescatar
        --    uno que nunca nació; y crear el vale días después reabriría la doble deducción que
        --    settledBeforeThisPayment existe para evitar. El faltante ya se contó en el
        --    inventario físico: descontarlo tarde lo cobra dos veces.
        --    ⚠️ Lo que también va a caer aquí y NO es ruido: b4bit y pos-sync cierran órdenes sin
        --    llamar a createSalePostingInTx ni deducir nada (verificado el 3-sep-2026). Un
        --    venue con recetas que cobre por esos caminos aparecerá en serie — es el MISMO
        --    defecto en otro camino, no un falso positivo. Lo mismo una cortesía total cerrada
        --    sin cobro. Si alguno resulta ser decisión de producto, va a
        --    TRIAGED_AWAITING_THIRD_PARTY con su motivo escrito, nunca se amplía el criterio.
        SELECT 'ORDEN SIN VALE DE INVENTARIO', v.name, o.id,
               'orden=' || o."orderNumber" || ' cerrada=' || COALESCE(o."completedAt"::date::text, 'sin fecha') ||
               ' total=' || o.total
        FROM "Order" o JOIN "Venue" v ON v.id = o."venueId"
        WHERE o.status = 'COMPLETED'
          AND o."createdAt" >= '${VALES_DESDE}'
          AND ${ORDEN_DESCUENTA_INVENTARIO}
          -- El vale de VENTA: una reversa (CANCELLATION/CUSTOMER_RETURN) no es una deducción.
          AND NOT EXISTS (
            SELECT 1 FROM "InventoryPosting" ip
            WHERE ip."orderId" = o.id AND ip."effectKind" = 'SALE'
          )
          -- Misma gracia que la invariante 6: una orden que el barrido acaba de cerrar todavía
          -- puede estar recibiendo su vale, y gritar por eso enseña a ignorar la alarma.
          AND o."updatedAt" < (NOW() AT TIME ZONE 'UTC') - INTERVAL '${VENTANA_DEL_BARRIDO_MIN} minutes'
          AND ${REAL_VENUES}
    )`

  return {
    counts: `${cte}
    SELECT "check", COUNT(*)::int AS n FROM v GROUP BY "check"`,
    details: `${cte}
    SELECT "check", venue, order_id, detalle FROM v ORDER BY "check", venue, order_id LIMIT ${DETAIL_LIMIT}`,
  }
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
    await this.runNow()
  }

  /** Una pasada completa. Nunca lanza: un fallo se reporta y el cron sigue vivo. */
  async runNow(now: Date = new Date()): Promise<WatchdogRun> {
    const quiet: WatchdogRun = { expired: false, total: 0, mostrados: 0, porTipo: {} }
    if (now >= WATCHDOG_UNTIL) {
      if (!this.expiredAnnounced) {
        this.expiredAnnounced = true
        logger.info('💰 [Money watchdog] Periodo de prueba de 4 días terminado — el vigilante ya no revisa nada.')
      }
      return { ...quiet, expired: true }
    }

    try {
      const { counts, rows } = await this.check()

      const violations = rows.filter(v => !TRIAGED_AWAITING_THIRD_PARTY[v.orderId])
      const silenced = rows.filter(v => TRIAGED_AWAITING_THIRD_PARTY[v.orderId])

      // Totales REALES (sin tope) menos lo triado. Si un caso triado quedara fuera del tope del
      // detalle, el total lo contaría de más en 1 — el sesgo aceptable va en esa dirección.
      const porTipo: Record<string, number> = {}
      for (const c of counts) porTipo[c.check] = c.n
      for (const s of silenced) porTipo[s.check] = (porTipo[s.check] ?? 0) - 1
      for (const k of Object.keys(porTipo)) if (porTipo[k] <= 0) delete porTipo[k]
      const total = Object.values(porTipo).reduce((a, b) => a + b, 0)

      // Se reportan como INFO (no error) para que no se pierdan de vista sin disparar alarma.
      if (silenced.length > 0) {
        logger.info(`💰 [Money watchdog] ${silenced.length} caso(s) ya triado(s), esperando a un tercero`, {
          casos: silenced.map(v => ({ orderId: v.orderId, check: v.check, motivo: TRIAGED_AWAITING_THIRD_PARTY[v.orderId] })),
        })
      }

      if (total === 0) {
        logger.info('💰 [Money watchdog] Todo cuadra ✅')
        return quiet
      }

      // BetterStack debe alertar sobre '🚨 [Money watchdog]'.
      for (const v of violations) {
        // `venueName` (not `venue`) is the field the rest of the platform stamps, so a money
        // alert filters and reads exactly like every other log line.
        logger.error(`🚨 [Money watchdog] ${v.check}`, { venueName: v.venue, orderId: v.orderId, detalle: v.detalle })
      }
      logger.error(`🚨 [Money watchdog] ${total} problema(s) de dinero detectado(s)`, {
        porTipo,
        mostrados: violations.length,
        tope: DETAIL_LIMIT,
      })
      return { expired: false, total, mostrados: violations.length, porTipo }
    } catch (err) {
      logger.error('❌ [Money watchdog] La revisión falló', { error: err instanceof Error ? err.message : err })
      return quiet
    }
  }

  /** Las 7 invariantes de dinero: totales sin tope + detalle acotado. */
  private async check(): Promise<{ counts: Array<{ check: string; n: number }>; rows: Violation[] }> {
    const sql = buildWatchdogSql()
    // Entry read con retry por la regla de cron-jobs.md (lecturas puras, seguras de reintentar).
    return retry(
      async () => {
        const counts = await prisma.$queryRawUnsafe<Array<{ check: string; n: number }>>(sql.counts)
        const rows = await prisma.$queryRawUnsafe<Array<{ check: string; venue: string; order_id: string; detalle: string }>>(sql.details)
        return {
          counts: counts.map(c => ({ check: c.check, n: Number(c.n) })),
          rows: rows.map(r => ({ check: r.check, venue: r.venue, orderId: r.order_id, detalle: r.detalle })),
        }
      },
      { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'money-watchdog.check' },
    )
  }
}

export const moneyIntegrityWatchdogJob = new MoneyIntegrityWatchdogJob()

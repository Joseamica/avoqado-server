/**
 * The facts «Clientes» shows of each organization — what it uses (terminal, POS), its plan level, whether it charges and what
 * it leaves Avoqado (C1b) —
 * each from ONE SQL expression over an Organization aliased `o` (plan C1, task 2). The cell reads these columns, the
 * filter puts the same expressions in the `WHERE` before the cursor and in the total, and the count groups by them: one
 * rule to paint, filter and count. The plan's CONDITION (paid, trial, courtesy…) is not here on purpose: its rule
 * (`elegirFilaDelPlan`) only exists in JS and is computed for the rows of the page (redesign after Codex r3).
 *
 * Every question is an `EXISTS` over the organization's REAL venues (`REAL_VENUE_SQL`) that stops at its first row by an
 * index. Enum values travel as SQL literals, never as text binds (`"OrderSource" = text` fails in Postgres); dates as
 * `utcTs`. Never `Order.terminalId` nor `lastHeartbeat`: what proves a device is how the sale was charged.
 */
import { Prisma } from '@prisma/client'
import { utcTs } from '../../utils/sqlDates'
import { REAL_VENUE_SQL, VENUE_HAS_MONEY_SQL } from './realVenueSql'

export {
  CONDICIONES,
  ESTADOS,
  INGRESOS,
  MOTIVOS_DEL_ALTA,
  NIVELES,
  PISTAS_DE_INGRESO,
  USA,
  USA_ESCRITO,
  type Condicion,
  type Estado,
  type Ingreso,
  type MotivoDelAlta,
  type Nivel,
  type PistaDeIngreso,
  type Usa,
  type UsaEscrito,
} from './clientCodes'

/** The window of «Usa» and «Cobra»: the last 30 × 24 h, moving (not a calendar month), inclusive. */
const WINDOW_MS = 30 * 24 * 60 * 60 * 1000

/** A SQL alias written into the text: only a plain identifier, so a caller can never inject through it. */
function alias(name: string): Prisma.Sql {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`Alias SQL inválido: ${name}`)
  return Prisma.raw(name)
}

/**
 * Does this `VenueFeature` row (aliased `rowAlias`) give access today? `ventanaDeAccesoWhere` of
 * `access/ventanaDeAcceso.ts` written in SQL, field by field — its parity test against `daAcceso` fails if the canonical
 * rule changes and this copy does not. Always true or false, never NULL (a missing grace is «no grace»), so it can be
 * selected or negated.
 */
export function ventanaDeAccesoSql(rowAlias: string, now: Date): Prisma.Sql {
  const r = alias(rowAlias)
  return Prisma.sql`(${r}."active" = true AND ${r}."suspendedAt" IS NULL
    AND (${r}."endDate" IS NULL OR ${r}."endDate" >= ${utcTs(now)} OR (${r}."gracePeriodEndsAt" IS NOT NULL AND ${r}."gracePeriodEndsAt" >= ${utcTs(now)})))`
}

/**
 * Does the venue aliased `venueAlias` hold a commercial grant of `tier` in force? The `where` of `getContractBaseTier`
 * (`access/basePlan.service.ts`) in SQL: a live `CapabilityGrant` of the venue whose `HybridContract` is of the same venue,
 * not ended, and of that `planTier`. Stops at the first row on `CapabilityGrant(venueId, featureCode, revokedAt, endsAt)`.
 * Its parity test against the canonical one fails if that rule changes and this copy does not.
 */
export function concesionComercialSql(venueAlias: string, now: Date, tier: 'PRO' | 'PREMIUM'): Prisma.Sql {
  const v = alias(venueAlias)
  const planTier = tier === 'PREMIUM' ? Prisma.sql`'PREMIUM'` : Prisma.sql`'PRO'`
  return Prisma.sql`EXISTS (
    SELECT 1 FROM "CapabilityGrant" cg JOIN "HybridContract" hc ON hc."id" = cg."contractId"
    WHERE cg."venueId" = ${v}."id" AND cg."revokedAt" IS NULL
      AND cg."startsAt" <= ${utcTs(now)} AND cg."endsAt" > ${utcTs(now)}
      AND hc."venueId" = ${v}."id" AND hc."endedAt" IS NULL AND hc."planTier" = ${planTier}
  )`
}

/**
 * 🟠 «Se quedó en el alta, no puso tarjeta» over `o` (spec §5.1.4): it has an `OnboardingProgress`, its signup did not
 * finish (`Organization.onboardingCompletedAt` or `OnboardingProgress.completedAt` empty), it never charged real money in
 * a real venue, and none of its venues has a Stripe subscription on a feature row nor a contract not ended. A card given
 * anywhere means it is not this case. No `now`: it does not depend on the date.
 */
export function altaPendienteSql(): Prisma.Sql {
  return Prisma.sql`(
    EXISTS (
      SELECT 1 FROM "OnboardingProgress" op
      WHERE op."organizationId" = o."id" AND (o."onboardingCompletedAt" IS NULL OR op."completedAt" IS NULL)
    )
    AND NOT EXISTS (SELECT 1 FROM "Venue" v WHERE v."organizationId" = o."id" AND ${REAL_VENUE_SQL} AND ${VENUE_HAS_MONEY_SQL})
    AND NOT EXISTS (
      SELECT 1 FROM "Venue" v JOIN "VenueFeature" vf ON vf."venueId" = v."id"
      WHERE v."organizationId" = o."id" AND vf."stripeSubscriptionId" IS NOT NULL
    )
    AND NOT EXISTS (
      SELECT 1 FROM "Venue" v JOIN "HybridContract" hc ON hc."venueId" = v."id"
      WHERE v."organizationId" = o."id" AND hc."endedAt" IS NULL
    )
  )`
}

/**
 * An «alta propia» that stopped at the plan screen, over `o`: `altaPendienteSql`, its `OnboardingProgress` carries an
 * `acquisitionSource` (only the self-service signup and the landing write it) and it has at least one real venue (the
 * business is created at «tipo de negocio», right before the plan screen). Organizations made by hand or signups that
 * never got past the email code do not match. Does NOT exclude the team's organization: the caller does.
 */
export function altaPropiaPendienteSql(): Prisma.Sql {
  return Prisma.sql`(
    ${altaPendienteSql()}
    AND EXISTS (SELECT 1 FROM "OnboardingProgress" op WHERE op."organizationId" = o."id" AND op."acquisitionSource" IS NOT NULL)
    AND EXISTS (SELECT 1 FROM "Venue" v WHERE v."organizationId" = o."id" AND ${REAL_VENUE_SQL})
  )`
}

/** An order of the venue `v` charged (fully or partly) in the window, of the given sources (SQL literals). */
const paidOrder = (sources: Prisma.Sql, desde: Date, extra: Prisma.Sql = Prisma.empty) => Prisma.sql`EXISTS (
  SELECT 1 FROM "Order" o2
  WHERE o2."venueId" = v."id" AND o2."source" IN (${sources}) AND o2."createdAt" >= ${utcTs(desde)}
    AND o2."paymentStatus" IN ('PAID', 'PARTIAL')${extra}
)`

/**
 * A reservation's order is born `TPV` at check-in wherever it is charged (`createOrderFromReservation.ts`): its source
 * proves nothing. The `Payment.source` of its charge does (`TPV` = the terminal, `APP` = the POS apps); any other source
 * does not say the device. Asked LAST in each `OR`, so it only runs when nothing cheaper answered.
 */
const reservationChargedFrom = (paymentSource: Prisma.Sql, desde: Date) => Prisma.sql`EXISTS (
  SELECT 1 FROM "Order" o2 JOIN "Payment" p ON p."orderId" = o2."id"
  WHERE o2."venueId" = v."id" AND o2."source" = 'TPV' AND o2."reservationId" IS NOT NULL
    AND o2."createdAt" >= ${utcTs(desde)} AND o2."paymentStatus" IN ('PAID', 'PARTIAL')
    AND p."status" = 'COMPLETED' AND p."amount" > 0 AND p."source" = ${paymentSource}
)`

/** Some real venue of `o` answers `condition` (over `v`). */
const anyRealVenue = (condition: Prisma.Sql) =>
  Prisma.sql`EXISTS (SELECT 1 FROM "Venue" v WHERE v."organizationId" = o."id" AND ${REAL_VENUE_SQL} AND (${condition}))`

/** The venue `v` holds `tier` today: a classic row in its access window, or a commercial grant in force. */
const nivelDeLaSucursalSql = (tier: 'PRO' | 'PREMIUM', now: Date) => Prisma.sql`(EXISTS (
      SELECT 1 FROM "VenueFeature" vf JOIN "Feature" ft ON ft."id" = vf."featureId"
      WHERE vf."venueId" = v."id" AND ft."code" = ${tier === 'PREMIUM' ? Prisma.sql`'PLAN_PREMIUM'` : Prisma.sql`'PLAN_PRO'`}
        AND ${ventanaDeAccesoSql('vf', now)}
    )
    OR ${concesionComercialSql('v', now, tier)})`

/** A real venue of `o` holds `tier` today. */
const nivelSql = (tier: 'PRO' | 'PREMIUM', now: Date) => anyRealVenue(nivelDeLaSucursalSql(tier, now))

// ── Ingreso (C1b): lo que cada cliente le deja a Avoqado ─────────────────────────────────────────────────────────────

/**
 * Was this payment (aliased `paymentAlias`) charged THROUGH Avoqado? The online channels of Avoqado — the platform's own rule
 * for «en línea de Avoqado» (`fundsFlow = AVOQADO_PROCESSED` or an e-commerce channel, `sales-summary.dashboard.service.ts`) —
 * or a card on Avoqado's terminal: `source = TPV` is written only by the terminal app and the AngelPay webhook
 * (`fuenteDelPago`); what an app only RECORDS (a card of another terminal) is `OTHER`, and a hand-recorded payment carries
 * `EXTERNAL_RECORDED`. Never `processor` (the terminal writes «TBD») nor the payment's `terminalId` (null when the serial does
 * not resolve). Superadmin test charges never count. Always true or false, never NULL, so `NOT (…)` keeps its rows.
 */
export function pagoPorAvoqadoSql(paymentAlias: string): Prisma.Sql {
  const p = alias(paymentAlias)
  return Prisma.sql`(${p}."source" <> 'DASHBOARD_TEST' AND (
    ${p}."fundsFlow" IS NOT DISTINCT FROM 'AVOQADO_PROCESSED'
    OR ${p}."ecommerceMerchantId" IS NOT NULL
    OR (${p}."fundsFlow" IS NULL AND ${p}."source" = 'TPV' AND ${p}."method" IN ('CREDIT_CARD', 'DEBIT_CARD', 'DIGITAL_WALLET'))
  ))`
}

/** `paymentCountsAsDrawerCash` (`shared/tenderSemantics.ts`) over `p`, with its precedence: fundsFlow → tender snapshot → method. */
const efectivoDeCajonSql = Prisma.sql`(CASE WHEN p."fundsFlow" IS NOT NULL THEN p."fundsFlow" = 'CASH_DRAWER'
  WHEN p."tenderCountsAsCash" IS NOT NULL THEN p."tenderCountsAsCash"
  ELSE p."method" = 'CASH' END)`

/** A real charge of the venue `v` in the window that answers `condition` (over `p`), on `Payment(venueId, status, createdAt)`. */
const cobroEnLaVentana = (desde: Date, condition: Prisma.Sql) => Prisma.sql`EXISTS (
  SELECT 1 FROM "Payment" p
  WHERE p."venueId" = v."id" AND p."status" = 'COMPLETED' AND p."amount" > 0 AND p."createdAt" >= ${utcTs(desde)}
    AND ${condition}
)`

/**
 * Does the venue `v` pay Avoqado a monthly plan of `tier` (or of any paid tier)? What the database knows is charged, without
 * Stripe and without picking «the» plan row (that choice stays in JS, `planesPorSucursal`; C1's guard forbids a second one):
 * - a classic plan row with a Stripe subscription, in its access window (`ventanaDeAccesoSql`) and not a trial — the rule of
 *   `derivePlanState`: an end in the future is a trial unless a collection grace is in force (then it is overdue, still billed);
 * - or a plan contract in force (the `where` of `contratosSql` / `planContractOrigin`) on a venue whose level is not Free (its
 *   grant delivers it).
 * On every single-origin plan state the parity test seeds, this is exactly «condición PAGADO or CAMPANA» of the page. With two
 * charging origins at once (a paid Pro and a Premium trial with card) it says what is charged; the Plan cell keeps the
 * platform's choice of row.
 */
function pagaSql(now: Date, tier?: 'PRO' | 'PREMIUM'): Prisma.Sql {
  const codigos =
    tier === 'PREMIUM' ? Prisma.sql`'PLAN_PREMIUM'` : tier === 'PRO' ? Prisma.sql`'PLAN_PRO'` : Prisma.sql`'PLAN_PRO', 'PLAN_PREMIUM'`
  const niveles = tier === 'PREMIUM' ? Prisma.sql`'PREMIUM'` : tier === 'PRO' ? Prisma.sql`'PRO'` : Prisma.sql`'PRO', 'PREMIUM'`
  return Prisma.sql`(
    EXISTS (
      SELECT 1 FROM "VenueFeature" vf JOIN "Feature" ft ON ft."id" = vf."featureId"
      WHERE vf."venueId" = v."id" AND ft."code" IN (${codigos}) AND vf."stripeSubscriptionId" IS NOT NULL
        AND ${ventanaDeAccesoSql('vf', now)} AND (vf."endDate" IS NULL OR vf."gracePeriodEndsAt" >= ${utcTs(now)})
    )
    OR (
      EXISTS (
        SELECT 1 FROM "HybridContract" hc
        WHERE hc."venueId" = v."id" AND hc."endedAt" IS NULL AND hc."planTier" IN (${niveles})
          AND (hc."cancelAt" IS NULL OR hc."cancelAt" > ${utcTs(now)})
      )
      AND (${nivelDeLaSucursalSql('PRO', now)} OR ${nivelDeLaSucursalSql('PREMIUM', now)})
    )
  )`
}

/**
 * The card money processed by Avoqado in the window over `o` (pesos, gross: refunds are their own negative rows and never
 * subtract; tips live in `tipAmount` and stay out, as «Cobrado este mes» of the ficha). The SAME `pagoPorAvoqadoSql` and window
 * as `f."ingreso"`, so the sum is positive exactly when the row says TRANSACCIONES or AMBOS. Only for the rows that show it.
 */
export function transaccionesSql(now: Date): Prisma.Sql {
  const desde = new Date(now.getTime() - WINDOW_MS)
  return Prisma.sql`(
    SELECT SUM(p."amount") FROM "Venue" v JOIN "Payment" p ON p."venueId" = v."id"
    WHERE v."organizationId" = o."id" AND ${REAL_VENUE_SQL}
      AND p."status" = 'COMPLETED' AND p."amount" > 0 AND p."createdAt" >= ${utcTs(desde)} AND ${pagoPorAvoqadoSql('p')}
  )`
}

/**
 * `LEFT JOIN LATERAL (…) f ON true` over `o`, with exactly: `f."usaTerminal"`, `f."usaPos"` (booleans), `f."ultimoCobroAt"`
 * (the newest real charge of its real venues, or null — a `timestamp` without zone holding UTC, like every Prisma column:
 * compare it in SQL only with a `utcTs` bind, never a bare `Date`), `f."usaMedido"` (`USA`), `f."nivel"` (`NIVELES`) and
 * `f."estado"` (`ESTADOS`). The same `now` for every expression of a request.
 *
 * - Terminal: a `TPV` order without reservation charged in the window; or a real charge processed on a `TPV_ANDROID` /
 *   `TPV_IOS` device (`Payment.terminalId`), asked after the order so a TPV order answers without reading `Payment`; or a
 *   reservation charged from the terminal. POS: an `AVOQADO_ANDROID` / `AVOQADO_IOS` order (Windows sends ANDROID), or a
 *   reservation charged from the apps. Charged without a device to blame: `NO_IDENTIFICADO`, never «sin ventas».
 * - Level: the `tier` of `getVenuePlanInfo` per venue (PREMIUM before PRO), the highest of its real venues.
 * - Estado: 🟠 `altaPendienteSql`, then a charge in the window, then a charge ever, then never.
 * - Ingreso (C1b): `f."mensualidad"` (`PREMIUM` / `PRO`: the highest paid plan Avoqado charges a real venue, else null), `f."ingreso"` (`INGRESOS`: that, card money through Avoqado in the window, both or neither) and
 *   `f."pistaIngreso"` (`PISTAS_DE_INGRESO`: a card recorded outside Avoqado, or only drawer cash in the window, or null).
 */
export function clientFactsLateral(now: Date): Prisma.Sql {
  const desde = new Date(now.getTime() - WINDOW_MS)
  const terminal = anyRealVenue(Prisma.sql`${paidOrder(Prisma.sql`'TPV'`, desde, Prisma.sql` AND o2."reservationId" IS NULL`)}
    OR EXISTS (
      SELECT 1 FROM "Payment" p JOIN "Terminal" t ON t."id" = p."terminalId" AND t."type" IN ('TPV_ANDROID', 'TPV_IOS')
      WHERE p."venueId" = v."id" AND p."status" = 'COMPLETED' AND p."amount" > 0 AND p."createdAt" >= ${utcTs(desde)}
    )
    OR ${reservationChargedFrom(Prisma.sql`'TPV'`, desde)}`)
  const pos = anyRealVenue(Prisma.sql`${paidOrder(Prisma.sql`'AVOQADO_ANDROID', 'AVOQADO_IOS'`, desde)}
    OR ${reservationChargedFrom(Prisma.sql`'APP'`, desde)}`)
  const inWindow = Prisma.sql`x."ultimoCobroAt" >= ${utcTs(desde)}`
  // C1b: a card charged outside Avoqado (the POS or the panel recorded it), and a real charge in the window that is not drawer
  // cash. Asked in the pista's CASE, in order, so a client with card through Avoqado never reads its whole window.
  const otraTerminal = anyRealVenue(
    cobroEnLaVentana(
      desde,
      Prisma.sql`p."method" IN ('CREDIT_CARD', 'DEBIT_CARD') AND p."source" NOT IN ('DELIVERY_PLATFORM', 'DASHBOARD_TEST') AND NOT ${pagoPorAvoqadoSql('p')}`,
    ),
  )
  const noSoloEfectivo = anyRealVenue(cobroEnLaVentana(desde, Prisma.sql`NOT ${efectivoDeCajonSql}`))

  // ponytail: se calcula al leer; si a 10× (≈260 clientes) la lista pasa de ~300 ms, estas columnas pasan a una fila por
  // organización que llena `runSweep` cada 5 min y la lista filtra por columnas (spec §5.1.6).
  return Prisma.sql`LEFT JOIN LATERAL (
    SELECT x."usaTerminal", x."usaPos", x."ultimoCobroAt", x."mensualidad",
      CASE WHEN x."mensualidad" IS NOT NULL AND x."porAvoqado" THEN 'AMBOS'
           WHEN x."mensualidad" IS NOT NULL THEN 'MENSUALIDAD'
           WHEN x."porAvoqado" THEN 'TRANSACCIONES'
           ELSE 'NINGUNO' END AS "ingreso",
      CASE WHEN ${otraTerminal} THEN 'TARJETA_OTRA_TERMINAL'
           WHEN x."porAvoqado" THEN NULL
           WHEN ${inWindow} AND NOT ${noSoloEfectivo} THEN 'SOLO_EFECTIVO' END AS "pistaIngreso",
      CASE WHEN x."usaTerminal" AND x."usaPos" THEN 'AMBOS'
           WHEN x."usaTerminal" THEN 'TERMINAL'
           WHEN x."usaPos" THEN 'POS'
           WHEN ${inWindow} THEN 'NO_IDENTIFICADO'
           ELSE 'NINGUNO' END AS "usaMedido",
      x."nivel",
      CASE WHEN ${altaPendienteSql()} THEN 'ALTA_SIN_TARJETA'
           WHEN ${inWindow} THEN 'COBRA'
           WHEN x."ultimoCobroAt" IS NOT NULL THEN 'SIN_COBROS'
           ELSE 'NUNCA' END AS "estado"
    FROM (
      SELECT ${terminal} AS "usaTerminal", ${pos} AS "usaPos",
        (
          SELECT MAX(lc."createdAt") FROM "Venue" v
          CROSS JOIN LATERAL (
            SELECT p."createdAt" FROM "Payment" p
            WHERE p."venueId" = v."id" AND p."status" = 'COMPLETED' AND p."amount" > 0
            ORDER BY p."createdAt" DESC LIMIT 1
          ) lc
          WHERE v."organizationId" = o."id" AND ${REAL_VENUE_SQL}
        ) AS "ultimoCobroAt",
        CASE WHEN ${nivelSql('PREMIUM', now)} THEN 'PREMIUM' WHEN ${nivelSql('PRO', now)} THEN 'PRO' ELSE 'FREE' END AS "nivel",
        CASE WHEN ${anyRealVenue(pagaSql(now, 'PREMIUM'))} THEN 'PREMIUM' WHEN ${anyRealVenue(pagaSql(now))} THEN 'PRO' END AS "mensualidad",
        ${anyRealVenue(cobroEnLaVentana(desde, pagoPorAvoqadoSql('p')))} AS "porAvoqado"
    ) x
  ) f ON true`
}

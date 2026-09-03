# Auditoría: binds de fecha sesgados en SQL crudo (timestamptz contra `timestamp without time zone`)

**Fecha:** 2026-09-01 · **Repo:** avoqado-server · **Estado:** corregido en el árbol de trabajo, **sin commitear**.

## El defecto, en una frase

Todas las columnas de fecha de este schema son `timestamp without time zone` y guardan UTC real. Un
`Date` de Prisma metido a `$queryRaw` / `$queryRawUnsafe` llega a Postgres como `timestamptz`, y al
compararlo contra esas columnas —directo o con `::timestamp`— Postgres lo convierte con la zona de
**sesión** (`America/Mexico_City`). El filtro queda corrido **6 horas**: entran las ventas de las
18:00–23:59 del día anterior y salen las del día pedido. Una segunda familia del mismo mecanismo:
un bucket construido con UNA sola aplicación de `AT TIME ZONE tz` sobre una columna que ya guarda
UTC interpreta el dato como hora local, y "el día/hora del negocio" sale en hora UTC (una venta de
las 20:00 cae al día siguiente, en la hora 02).

Verificado sobre literales en la base local, sin filas (`psql`):

| Expresión | Resultado para una venta a las 20:00 MX del 18 (guardada `2026-08-19 02:00`) |
|---|---|
| `col >= ${bind}` o `col >= ${bind}::timestamp` con bind = medianoche MX del 19 | **TRUE** — la mete al día 19 |
| `col >= (${bind} AT TIME ZONE 'UTC')` (`utcTs`) | FALSE — correcto |
| `DATE_TRUNC('day', col AT TIME ZONE tz)` (una aplicación, lo que había) | `2026-08-19 00:00-06` — día equivocado |
| `DATE_TRUNC('day', (col AT TIME ZONE 'UTC') AT TIME ZONE tz)` (doble) | `2026-08-18 00:00` — hora de pared correcta |
| `… AT TIME ZONE tz` de nuevo (triple) | `2026-08-18 00:00-06` — instante de medianoche local |
| `EXTRACT(HOUR FROM col AT TIME ZONE tz)` (una aplicación) | **2** (hora UTC); con la doble: **20** |
| `'…Z'::timestamp` (texto ISO, como los outbox) | ignora la Z: correcto |
| `UPDATE … SET col = ${bind}` | guarda `20:00` (hora MX) en vez de `02:00` UTC |

## Alcance real (barrido sistemático, no la lista inicial)

La tarea llegó con 6 sitios en 2 archivos. El barrido por la forma del defecto encontró **~90 binds
en 25 archivos**. Todo va ahora por `src/utils/sqlDates.ts`:

- `utcTs(d)` / `utcTsOrNull(d)` (Prisma.sql), `utcTsParam(n)` (`$queryRawUnsafe` posicional).
- `localWallClock` / `localWallClockRaw` (bucket doble = hora de pared) y `localInstantRaw`
  (triple = instante de medianoche/hora local, para los consumidores que formatean en la zona del venue).

| Archivo | Sitios | Qué cambió |
|---|---|---|
| `dashboard/shared-query.service.ts` | 6 funciones (13 binds) + bucket `TO_CHAR` | filtros `utcTs`; bucket doble. `getProfitAnalysis` mezclaba un `aggregate` correcto con un raw corrido |
| `dashboard/sales-by-item.dashboard.service.ts` | 3 queries posicionales + 6 buckets + 2 filtros por hora | `utcTsParam`; buckets **triple** (el `period` ISO se pinta en la zona del venue); horas dobles |
| `dashboard/sales-summary.dashboard.service.ts` | 3 filtros + 6 buckets | igual que sales-by-item. Sus queries por período ya pasaban el rango como TEXTO (correcto) y se dejaron tal cual |
| `dashboard/promotion-sales.dashboard.service.ts` | 1 filtro posicional + 1 bucket | `utcTsParam`; bucket **doble** (su etiqueta se formatea en UTC a propósito) |
| `tpv/historical-reports.service.ts` | 2 filtros + 5 buckets + cursor | triple (la TPV pinta `periodStart`); el cursor pasa a `::timestamptz`: con `::timestamp` la **página siguiente repetía el último período** |
| `dashboard/report.service.ts` | 7 (PMIX, uso de insumos, varianza de costo, cobertura) | `utcTs` |
| `dashboard/reservation.dashboard.service.ts` | **7 candados `FOR UPDATE`** (mesa, staff, capacidad × crear/editar/reagendar) | extraídos a `reservationOverlapSql` con `utcTs`. Ver abajo |
| `serialized-inventory/custody.service.ts` | `UPDATE … SET` de 4 fechas de custodia | `utcTsOrNull`. Guardaba hora local y, al conservar el valor previo, lo corría −6 h por transición |
| `settlement-report.service.ts` + `jobs/venue-commission-settlement.job.ts` | 6 (liquidación a agregadores) | `utcTs` |
| `jobs/nightly-sales-summary.job.ts` | 6 (correo nocturno al dueño) | `utcTs` |
| `command-center`, `organization.service`, `organizationDashboard`, `superadmin.service`, `superadmin/earnings`, `superadmin/paymentAnalytics`, `upsell/upsellImpression`, `mcp/tools/products`, `jobs/cash-drawer-reconciler`, `jobs/nightly-upsell-rules` | 26 | `utcTs` |
| `legacy/qrPayments.legacy.service.ts` | 6 buckets + 2 params | mismas expresiones (inline; corre contra la base legacy) y el rango viaja como texto ISO. **No verificable localmente** (esa base no es alcanzable desde aquí) |

**Correctos y no tocados:** los outbox (`toISOString()::timestamp`), `sale-verification.org.*` (patrón
`col AT TIME ZONE 'UTC' >= bind`), `command-center` y `availableBalance`/`generalStats` (ya dobles).

## Los dos hallazgos fuera de los reportes

1. **Candados de reservas.** El predicado `"startsAt" < ${fin} AND "blockedEndsAt" > ${inicio}`
   comparaba la agenda corrida 6 h: probado con una reserva real de 10:00–11:00 en la misma mesa, el
   candado devolvía **0 filas** al pedir el mismo horario y **1 fila** al pedir 16:00–17:00. Es decir,
   el candado bajo `FOR UPDATE` no protegía el mismo horario y sí rechazaba uno seis horas después.
   Queda por verificar de punta a punta si otras capas (`checkExternalBusyBlock`, disponibilidad)
   atrapaban el choque antes de llegar al candado; el candado ya es correcto.
2. **Custodia de SIMs (PlayTelecom).** El único `UPDATE` crudo que escribe fechas guardaba hora
   local; probado con una fila real: se escribe `NIGHT`, se relee igual, y una segunda transición
   que conserva el valor ya no lo mueve.

## Evidencia

- **Test de integración de borde** `tests/integration/dashboard/sql-date-binds-timezone.integration.test.ts`:
  martes 11-mar-2025 en México con cuatro ventas en los bordes (12:00, 20:00, 23:30 del día anterior,
  04:00 del siguiente). Antes de tocar código: **0/27** (todas devolvían 53 pesos en vez de 250, la
  venta de las 20:00 en la hora 02 o en el día 12, la página 2 de históricos repetía el día 12).
  Después: **28/28** (incluida custodia). `sales-report-accuracy` sigue en 17/17: sus fixtures son de
  mediodía y rangos amplios, así que sus números no debían moverse y no se movieron.
- **Golden before/after** (4 venues × 3 rangos × 41 respuestas, contra la base local; el before se
  capturó desde un worktree en `HEAD`): los **totales de cabecera que ya salían de Prisma no cambian
  en 12/12** (`salesSummary.summary`, `superadmin.*`, `organization.overview`, promociones summary…);
  cambia todo lo agrupado por día/hora (las ventas de 18:00–23:59 pasan al día correcto; la hora 20 deja
  de aparecer como hora 02) y los bordes de los rangos que cruzan medianoche. El `$0` de Amaena en el
  filtro 12:00–20:00 es un artefacto de su semilla (sus órdenes caen a las 0–8 y 21–23 hora local: la
  semilla escribió hora de pared como si fuera UTC); Atole, con horas de negocio reales (9–23), sale
  plausible. Detalle: `compare.md` en el scratchpad de la sesión.
- **Candado arquitectónico** `tests/unit/architecture/rawSqlDateBindGuard.test.ts`: un bind de fecha
  pelado en `src/` falla el test.
- **Suites unitarias de los servicios tocados** (25 suites vía `avq-verify`, en local): 485 en verde;
  7 tests de forma se ajustaron a la nueva firma (3 de reservas que afirmaban sobre el texto SQL del
  candado, 4 de custodia que esperaban el `Date`/`null` crudo en el payload del UPDATE) y pasan
  175/175, 17/17 y 11/11. El octavo fallo (`findManySinTopeGuard` sobre `orgInventoryByResponsible`)
  es WIP de otra sesión.
- **Typecheck 5.8** (`tsconfig.typecheck.json` vía `avq-verify`, local): `exit=0` en 503 s sobre el
  árbol con todos los cambios de `src/`.

## Pendientes declarados

- `orgStockControl.service.ts` y `orgInventoryByResponsible.service.ts`: **siguen sesgados**; los
  edita otra sesión. Están en la allowlist del candado con la instrucción de quitarlos al corregir.
- Buckets por **día UTC** (sin ninguna zona) en `organization.service.getRevenueTrends`,
  `superadmin.service.getRevenueBreakdown` y `paymentAnalytics.getProfitTimeSeries`: familia distinta
  (cero aplicaciones); el de organización necesita decidir qué zona usar en una org multi-sucursal.
- `createReservation` de punta a punta, `product_sales` del MCP, `queryPayments` privado del job de
  liquidación y los dos helpers privados del correo nocturno se corrigieron con el mismo helper pero
  sin test propio (el mecanismo lo prueban sus hermanos en el test de integración).
- Bridge legacy de QR (MindForm): corregido a ciegas, sin poder ejecutarlo aquí.

## Corrección (2026-09-01, tarde): la zona de sesión NO es la misma en producción

Medido con `SHOW timezone`: la Postgres local corre `America/Mexico_City`; **producción (Render,
PG 18.4) corre `UTC`**. Consecuencia, verificada con un bind real de Prisma (`pg_typeof` =
`timestamp with time zone`) bajo `SET LOCAL TIME ZONE` en las dos zonas:

| Forma | Sesión Mexico_City (local) | Sesión UTC (prod) |
|---|---|---|
| bind pelón / `::timestamp` | corrido 6 h | correcto |
| `utcTs` | correcto | correcto |
| bucket con UNA `AT TIME ZONE tz` | día/hora en UTC (mal) | día/hora en UTC (mal) |

O sea: los ~90 **filtros** corregidos estaban mal en desarrollo y casualmente bien en producción
(mientras Render siga en UTC); los **buckets** de una sola aplicación sí estaban mal en producción.
El arreglo con `utcTs` no depende de la zona de sesión, así que es seguro desplegarlo.
Prueba: `tests/integration/dashboard/org-stock-date-binds.integration.test.ts` (las dos zonas lado a lado).

`orgStockControl` y `orgInventoryByResponsible` quedaron corregidos ese mismo día por la sesión
dueña y salieron de la allowlist del candado. Pendiente declarado: `getOrgSummary` arma los siete
días de `salesLast7Days` desde la medianoche LOCAL del host de Node (`new Date(y, m, d)`), que en
producción es UTC: una venta de las 20:00 en México cae en la barra del día siguiente. Es la
familia del «`YYYY-MM-DD` pelado», no de los binds.

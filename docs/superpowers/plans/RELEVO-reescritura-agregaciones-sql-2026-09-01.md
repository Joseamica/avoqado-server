# RELEVO — Reescritura de agregaciones Node→SQL (2026-09-01)

> Documento de traspaso. Quien lo lea **no tiene el contexto de la sesión original**: aquí está todo
> lo necesario para continuar sin preguntar nada. Escrito porque la sesión que hizo el trabajo se
> quedó sin presupuesto de tokens.

## Resumen en cinco líneas

El 2026-09-01 producción se reinició porque un endpoint materializaba decenas de miles de filas en
Node y congeló el event loop (una vCPU, una instancia). La respuesta fue **mover las agregaciones a
`GROUP BY` en Postgres**, en tres servicios. Las fases 1 y 2 están **hechas, verificadas al centavo
y commiteadas** (`811c5652`). La fase 3 la tomó otra sesión en paralelo y está muy avanzada, sin
commitear. Una auditoría externa (Codex) encontró **cero defectos de dinero** y tres cambios de
comportamiento menores, dos de los cuales son mejoras. Lo único pendiente son **tres pruebas** que
cierran huecos de verificación reales.

---

## 1. Estado por fase

| Fase | Archivo | findMany sin tope | Estado |
|---|---|---|---|
| 1 | `src/services/dashboard/generalStats.dashboard.service.ts` | 19 → **3** | ✅ hecha, commiteada en `811c5652` |
| 2 | `src/services/dashboard/availableBalance.dashboard.service.ts` | 8 → **2** | ✅ hecha, commiteada en `811c5652` |
| 3 | `src/services/organization-dashboard/organizationDashboard.service.ts` | 15 → **5** | 🟡 otra sesión, **sin commitear** |
| — | Binds de fecha en TODO el repo (~90 en 25 archivos) | — | ✅ otra sesión; candado `tests/unit/architecture/rawSqlDateBindGuard.test.ts` |

El inventario vive en `tests/unit/architecture/findManySinTopeGuard.test.ts` y **solo puede
encoger**: si bajas un número sin limpiar el código, el test falla; si limpias sin bajarlo, también.

### Por qué quedaron findMany sin convertir (no es olvido)

- **generalStats (3):** devuelven las FILAS al dashboard, es contrato de la API. Quitarlos exige
  paginar también el cliente. Llevan `select` acotado.
- **availableBalance (2):** cada pago pendiente pasa por `projectPaymentSettlement`, el motor de
  liquidación vivo (configuración vigente por fecha, hora de corte con zona, días hábiles).
  Replicarlo en SQL sería **mantener la lógica del dinero en dos lenguajes**. Llevan `select`
  quirúrgico: de todas las columnas a los ~8 campos que el cálculo usa.

---

## 2. 🔴 Las reglas duras (lo más valioso de este documento)

Salieron de medir, no de suponer. Aplican a **todo `$queryRaw` nuevo en este repo**.

### 2.1 Bind de fecha: siempre `utcTs`, nunca `::timestamp`

Las columnas `DateTime` son `timestamp without time zone` y guardan **UTC real**. La sesión de
Postgres corre en `America/Mexico_City`. Un bind `Date` de Prisma llega como `timestamptz`:
comparado directo, o casteado con `::timestamp`, Postgres lo convierte **con la zona de la sesión** y
el filtro queda corrido **seis horas**.

```
WHERE o."createdAt" >= ${utcTs(from)}       -- ✅ mismas filas que findMany
WHERE o."createdAt" >= ${from}              -- ❌ corrido 6 horas
WHERE o."createdAt" >= ${from}::timestamp   -- ❌ corrido 6 horas
```

Helper en `src/utils/sqlDates.ts`. **Verificado con un experimento de borde exacto**: contar filas
`>=` un timestamp real existente, comparando `findMany` (1 fila) contra SQL crudo (2 filas). Un rango
ancho esconde el corrimiento; solo el borde exacto lo delata.

### 2.2 Bucket local: DOBLE `AT TIME ZONE`

```
((col AT TIME ZONE 'UTC') AT TIME ZONE ${tz})   -- ✅ día/hora del negocio
(col AT TIME ZONE ${tz})                        -- ❌ el bucket queda en hora UTC
```

Una sola aplicación lee el valor guardado como si ya fuera hora local. Una venta de las 20:00 aparece
al día siguiente a las 02:00.

### 2.3 SQL agrega, Node formatea

Postgres entrega `SUM`/`COUNT`. Las divisiones, `toFixed`, redondeos y formateo con locale se quedan
en Node **idénticos a los de antes**. Así los números no se mueven. Una sola divergencia apareció en
las fotos comparadas: un promedio que caía justo en el medio centavo (3763.00 / 8 = 470.375), donde
la suma vieja de flotantes daba 470.3749999 y la suma exacta de Postgres da lo correcto.

### 2.4 Otras trampas verificadas

- `lineRevenueSql` e `isItemLevelDiscountSql` (en `src/services/dashboard/lineRevenue.ts`) son los
  **gemelos SQL canónicos** de la fórmula de ingreso por línea. Nunca escribas la fórmula a mano.
- En JavaScript un `Decimal(0)` es **truthy**, así que `netSettlementAmount || calculado` conserva el
  cero guardado. `COALESCE` lo reproduce bien. Si alguna vez el valor llega como `Number`, cambia.
- `TransactionCost.paymentId` y `VenueTransaction.paymentId` son `@unique`: los JOIN no duplican
  filas. Si alguien quita esa restricción, todas estas sumas se rompen en silencio.
- **Un campo que falta en un `select` de Prisma llega como `undefined`, sin error.** Al recortar un
  `select`, verifica qué lee cada función consumidora: `paymentIsAvoqadoSettled`
  (`src/services/shared/tenderSemantics.ts`, usa `TENDER_SEMANTICS_SELECT`) y
  `projectPaymentSettlement` (`src/services/dashboard/settlementCalendar.dashboard.service.ts`).

### 2.5 Semántica rara que se replicó A PROPÓSITO

En `getAvailableBalance` y `getBalanceByCardType`, el `where` original era
`{ createdAt: { gt: lastCloseout }, ...dateFilter }`. **El spread pisaba el `gt`**, así que con un
rango explícito el corte de caja no acotaba, y sin rango sí. Se replicó igual para no mover el
número. El calendario sí compone las tres condiciones, porque ahí convivían. Está documentado en el
código y fijado en las pruebas de integración.

---

## 3. Método de verificación (reprodúcelo tal cual)

### 3.1 Fotos comparadas antes y después (lo que da la garantía real)

Los scripts viven en `scripts/temp-golden-*.ts`, marcados **DELETE AFTER** (no se commitean).
Capturan la respuesta actual de cada endpoint contra la base local, antes y después del cambio, y
comparan.

```bash
npx tsx --env-file=.env scripts/temp-golden-generalstats.ts capture before
# ... hacer el cambio ...
npx tsx --env-file=.env scripts/temp-golden-generalstats.ts capture after
npx tsx --env-file=.env scripts/temp-golden-generalstats.ts compare
```

🔴 **`tsx`, no `ts-node`**: `ts-node` verifica tipos y cargar los tipos de Prisma revienta por
memoria en este repo.

**Regla del método:** el comparador redondea al centavo, pero **cada archivo que difiere se investiga
hasta reproducir el número exacto desde la base**. Subir la tolerancia para que pase convierte la
comparación en decoración.

Venues usados (base local, elegidos por diversidad medida): `cmpe64yq2001f9k92m0lbhmf4` (El Atole,
228k pesos, modifiers, venta por peso, descuentos en ambos niveles), `c03fa68413463b26cdb8e8195`
(Chilanguita), `cmtd17w6k0001c9k0mjv5chbb` (Amaena, servicios), `cmpoei0id000j9kweoavvr26k` (vacío).

### 3.2 Pruebas

```bash
# Integración (necesita la variable EXPORTADA, no la lee del .env)
export TEST_DATABASE_URL=$(grep -E '^TEST_DATABASE_URL=' .env | head -1 | cut -d= -f2- | tr -d '"')
npx jest --selectProjects integration --runInBand --testPathPattern "dashboard/(generalStats|availableBalance)-sql-aggregation"

# Unitarias del módulo
npx jest --selectProjects unit --testPathPattern "services/dashboard" --ci

# Candado del inventario
npx jest --selectProjects unit --testPathPattern "findManySinTopeGuard"
```

### 3.3 Typecheck

```bash
npm run typecheck:fast                                    # TS7, rápido, para iterar
cd .. && ./scripts/avq-verify.sh avoqado-server npx tsc -p tsconfig.typecheck.json   # la verdad pre-commit
```

🔴 **`avq-verify` sale con código 0 aunque el comando de dentro haya fallado.** Lee el CUERPO de la
salida (`exit=`, `COINCIDEN`/`DIFIEREN`), nunca el código de salida. Y si una corrida de jest sale
con salida vacía, **no significa que todo pasó**: jest siempre imprime totales.

⚠️ El Alienware no respondió en toda la sesión del 1-sep, así que todo corrió en local sin
comparación dual. Si vuelve a responder, la verificación es la misma.

---

## 4. Auditoría externa (Codex) y su adjudicación

Corrió sobre el commit `811c5652`. **Cero P1. Ningún peso mal calculado.** Confirmó por su cuenta:
sin binds de fecha desprotegidos, sin buckets de una sola conversión, sin duplicación por JOIN, sin
inyección posible, y los `select` recortados completos.

| Hallazgo | Adjudicación |
|---|---|
| El orden de varias listas cambió | **REAL y es una mejora.** El dashboard hace `slice(0, 5)` y numera del 1 al 5 (`ProductAnalyticsMetrics.tsx:22`, `TableEfficiencyMetrics.tsx:22`). Antes la lista llegaba sin ordenar: ese "top 5" eran cinco elementos arbitrarios con aspecto de ranking. Ahora es el ranking real. **Las fotos comparadas NO lo detectaron** porque trataban esas listas como conjuntos sin orden. |
| `settlementDays` con dos merchants del mismo tipo | **REAL, de impredecible a predecible.** Antes se tomaba el merchant de la primera fila que devolviera la base; ahora el del pago más antiguo. Medido en la base local: 2 negocios con 2 merchants, el segundo sin configuración activa. **Falta prueba que lo fije.** |
| El instante que separa disponible de pendiente se toma antes | **REAL pero obligatorio.** Ese instante ahora viaja como parámetro DENTRO de la consulta, así que hay que capturarlo antes. El total no cambia, solo el reparto durante milisegundos. No se toca. |
| Las pruebas no cubren el borde exacto del rango | **REAL.** Ningún dato cae justo en `from` o `to`, así que no fijan el corte ni el corrimiento de seis horas. |
| Una prueba afirma que un cero guardado se respeta, sin dato que lo ejercite | **REAL.** Los datos usan 105, nulo y 49. Es el patrón "la prueba pasa por el motivo equivocado". |
| El candado de findMany admite falsos negativos | Cierto, **preexistente** y ya declarado en el propio archivo. Sin acción. |

⚠️ Codex se colgó en el primer intento (38 minutos sin escribir) por explorar todo el repositorio.
**Acótalo al commit** y ponle presupuesto de lecturas.

---

## 4-bis. Segunda revisión adversarial (independiente de Codex)

Se corrió un segundo revisor en paralelo, con las mismas preguntas. Fue **más lejos que Codex**:
reimplementó la lógica JavaScript vieja y la corrió lado a lado contra el código nuevo sobre la base
de desarrollo. **Veintiún reportes comparados, todos con números idénticos:** revenue-trends,
aov-trends, peak-hours, sales-by-weekday, order-frequency, sales-heatmap, channel-mix, category-mix,
staff-ranking, customer-satisfaction, kitchen-performance, best-selling, product-profitability,
prep-times, table-performance, weekly-trends, discount-analysis, getBalanceByCardType (6 negocios,
con y sin rango), getSettlementCalendar (92 días), projectHistoricalBalance y el efectivo agregado.

**También cero P1.** Coincide con Codex en el cambio de orden de las listas y en `settlementDays`.

### Lo que encontró y Codex NO vio

| Hallazgo | Estado |
|---|---|
| **La prueba que decía fijar el doble AT TIME ZONE no lo fijaba.** Sus dos aserciones pasaban igual con la composición INVERTIDA, que es el defecto de seis horas que el archivo existe para prevenir. | ✅ **ARREGLADO** el mismo día. Ahora fija el orden con dos expresiones regulares, una positiva y una negativa. Verificado con el contraste: la aserción vieja daba "pasa" sobre el texto invertido, la nueva da "falla". |
| **El motivo del incidente sigue vivo en tres endpoints.** `getAvailableBalance` y `getSettlementTimeline` materializan cada pago del rango y corren el motor de liquidación por fila (CPU por fila); `getGeneralStatsData` devuelve todos los pagos y reseñas del rango. Está declarado en el código, pero el mensaje del commit lo tapa. La guardia de runtime **sólo escribe en el log, no acota**. | ⚠️ Declarado, no resuelto. Un rango de un año en un negocio grande todavía puede tumbar la instancia por esos tres caminos. |
| **Una zona horaria corrupta ahora revienta con error 500**, donde antes degradaba en silencio produciendo un bucket basura. Fallar ruidoso es mejor, pero es un cambio de comportamiento no declarado. | ⚠️ Anotar. |
| **`getExtendedMetrics('prep-times')` sigue devolviendo valores inventados** (8, 12, 4, 2) mientras el comentario grande de la función vecina afirma que los inventados se eliminaron. Preexistente: ese camino nunca llamó a la función. Pero el comentario ahora se lee como falso. | ⚠️ Preexistente, el comentario engaña. |
| Código muerto: `const dateFilter: any = {}` en `availableBalance.dashboard.service.ts:359` ya no lo lee nadie. | Trivial. |
| `?? []` más un cast sobre un `$queryRaw` existe sólo para sobrevivir a un mock que devuelve indefinido. Ensucia el camino del dinero para acomodar una prueba. | Trivial. |
| `lineRevenueSql(alias)` interpola el alias en texto crudo. Hoy todos los llamadores pasan el literal `'oi'` y **no hay inyección**, pero nada impide que un futuro llamador pase algo derivado de un parámetro. | Riesgo latente. |
| `ORDER_NOT_DISCARDED` congela los valores del enum como texto: renombrar un valor de `OrderStatus` antes rompía en compilación, ahora cambia el filtro en silencio. | Riesgo latente. |

### Lo que verificó y NO es problema (vale tanto como los hallazgos)

Midió el bind contra la base: `pg_typeof` devuelve `timestamp with time zone`, la conversión correcta
da las 06:00 y el `::timestamp` da las 00:00, **seis horas corrido**. Confirmó que ningún bind se
escapó. Confirmó que la zona viaja parametrizada y que los cinco usos de texto crudo son constantes.
Confirmó que las relaciones son uno a uno y no hay duplicación. Confirmó que **todas las columnas de
dinero son NOT NULL**, así que la diferencia entre el `||` de JavaScript y `COALESCE` no puede
morder, y que el único caso donde sí mordía, la cadena vacía en el nombre de categoría, está resuelto
con `NULLIF`. Confirmó numéricamente en tres negocios que la rareza del corte de caja se replicó
fielmente. Y confirmó que el cliente de Prisma no tiene middleware oculto que el SQL crudo se salte.

### ⚠️ Ruido ajeno detectado, NO es de este trabajo

`npx jest --selectProjects unit --testPathPattern findManySinTopeGuard` **falla ahora mismo** por
`orgInventoryByResponsible.service.ts`, que tiene cambios sin commitear de otra sesión. No es de
`811c5652`. No lo toques: es de quien esté trabajando ese archivo.

---

## 5. Lo que falta, en orden

### 5.1 Tres pruebas (bajo riesgo, cierran huecos reales)

0. ~~**La aserción del doble AT TIME ZONE no fijaba el orden.**~~ ✅ **HECHO** el 1-sep: ahora usa una
   expresión regular positiva y una negativa, verificadas contra el texto invertido.
1. **Dato en el borde exacto del rango.** Sembrar un registro exactamente en `from` y otro en `to`, y
   comprobar que entran. Es lo único que fija de verdad el `>=`/`<=` y el corrimiento de seis horas.
2. **Caso con `netSettlementAmount = 0`.** Hoy el encabezado del test lo afirma y ningún dato lo
   ejercita. O se siembra, o se quita la afirmación.
3. **Caso de dos merchants** con reglas de liquidación distintas, que fije qué `settlementDays` se
   publica.

Archivos: `tests/integration/dashboard/{generalStats,availableBalance}-sql-aggregation.integration.test.ts`.

### 5.2 Fase 3 (otra sesión, verificar antes de dar por buena)

`organizationDashboard.service.ts` bajó de 15 a 5 y hay un test de integración **sin commitear**
(`tests/integration/dashboard/organizationDashboard-sql-aggregation.integration.test.ts`). Trampas
documentadas para ese archivo, verifícalas: las funciones de venta por semana comparten un defecto
en la etiqueta de semana, el "primer artículo serializado" no es determinista, y `getStaffAttendance`
devuelve campos de más vía `as any` que la firma TypeScript no declara (**toma la foto del resultado
en ejecución, no de los tipos**). Sus datos son de PlayTelecom y **no existen en la base local**.

### 5.3 Decisión de producto (no bloquea)

¿`settlementDays` debe representar al merchant más antiguo, o la API debería separar por merchant?
Hoy colapsa varios en uno, cosa que ya hacía antes de este cambio. Es marginal: dos negocios
afectados y el segundo merchant sin configuración.

### 5.4 Revisor pendiente

✅ Entregó. Sus hallazgos están en la sección 4-bis, ya cruzados con los de Codex.

---

## 6. Trampas del entorno (te ahorran una hora cada una)

- **El índice de git es COMPARTIDO** entre sesiones de IA. Commitea siempre con
  `git commit -- <ruta>`, nunca `git add` + `git commit` pelón, y comprueba con `git show --stat`
  después. Nunca `git reset --hard`, `git checkout .`, `git clean` ni `git stash`.
- **La base local es COMPARTIDA.** Los scripts que escriben deben empezar con `exigirBaseLocal()` de
  `scripts/_solo-base-local.ts`. No corras `prisma migrate dev` sin mirar: puede proponer un reset.
- **Archivos que cambian debajo de ti** son trabajo de otra sesión, no un conflicto. Relee y sigue.
- **El log del backend local** vive en `logs/development*.log`. El archivo activo se detecta por
  fecha de modificación (`ls -t ... | head -1`), nunca por número.
- Campos obligatorios que muerden al sembrar datos de prueba: `Payment` exige `feePercentage`,
  `feeAmount`, `netAmount`; `VenueTransaction` exige `type`; `Reservation` exige `confirmationCode`,
  `startsAt`, `endsAt`, `duration`, `blockedEndsAt`; `SettlementConfiguration` **no tiene** `venueId`.
- Para que un pago sea proyectable por el motor de liquidación necesita `Payment.merchantAccountId`,
  no solo el del costo.

---

## 7. Contexto de por qué existe todo esto

Incidente del 2026-09-01: el detalle de un negocio materializaba 33 mil órdenes y 33 mil pagos por
petición; Render reemplazó la instancia. El barrido posterior encontró 186 consultas sin tope en 88
archivos. Quedaron dos redes de seguridad: una guardia de runtime que denuncia resultados gigantes
(`src/utils/queryResultGuard.ts`) y el candado estático del inventario. Esta reescritura ataca a los
mayores productores de filas, que eran justo las pantallas más golpeadas.

Memoria del proyecto relacionada: `reescritura-agregaciones-sql`, `oom-fix-audit-procedure`,
`auditoria-binds-fecha-sql`.

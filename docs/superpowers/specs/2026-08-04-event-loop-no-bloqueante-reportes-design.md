# Reportes que no traban el servidor de pagos

**Fecha:** 2026-08-04 **Estado:** diseño aprobado, pendiente plan de implementación **Origen:** incidente 2026-08-04 14:53 — la página de
Ventas de PlayTelecom dejó el servidor sin responder

---

## 1. Qué pasó

Cuando alguien abre la página de Ventas de la organización PlayTelecom, el navegador dispara 12 peticiones a la vez (11 agregaciones + la
lista paginada). Cada una tardó entre 4 y 9 segundos; el 5% peor pasó de 12 s y dos se cortaron solas.

Postgres no es el problema: el `EXPLAIN ANALYZE` de la consulta exacta contra producción da **5.6 ms**. El 99.94% del tiempo ocurre después
de que la base ya contestó.

El daño no se quedó en esa pantalla. Node corre en **un solo hilo**, así que mientras un handler hace CPU síncrono nadie más existe: durante
la ráfaga de las 14:53, `/dashboard/auth/status` — un endpoint trivial — tardó **33.7 segundos**.

Somos una plataforma de pagos. Un reporte no puede tener esa capacidad.

## 2. Causa raíz

El código culpable vive todo en `src/services/dashboard/sale-verification.org.dashboard.service.ts`. Lo que sigue son las dos causas de
fondo (§2.1, §2.2), por qué la protección existente no las alcanzaba (§2.3), y una segunda puerta al mismo código que no estaba en el
reporte del incidente (§2.4).

### 2.1 Conversión de zona horaria fila por fila

Cuatro helpers (`toWeekLabel:351`, `toIsoWeekKey:363`, `toMonthKey:373`, `toDayKey:889`) hacen lo mismo:

```typescript
const local = new Date(d.toLocaleString('en-US', { timeZone: tz }))
```

Eso, **por cada fila**, construye un formateador ICU nuevo, formatea a texto y vuelve a parsear el texto. Con 5,446 filas y dos helpers por
endpoint son ~10,900 conversiones por petición.

Medición propia (esta máquina, `TZ=UTC`, 10,892 conversiones):

|                                    | tiempo   |
| ---------------------------------- | -------- |
| actual (`toLocaleString` por fila) | 1,814 ms |
| reusando un `Intl.DateTimeFormat`  | 110 ms   |
|                                    | **17x**  |

> La medición original del incidente reportó 13,504 ms → 33 ms (~400x). La diferencia es de máquina y de forma del bucle; la dirección es
> idéntica. Se documenta el número propio porque **cambia la conclusión**: 17x deja ~110 ms por endpoint × 11 ≈ **1.2 s de hilo retenido por
> carga de pantalla**. Cachear el formateador es analgésico, no cura.

La dosis-respuesta del incidente confirma el mecanismo: los endpoints con dos helpers por fila quedaron en 8-9 s, los de uno en 4-6 s, y
`summary` (que no los usa, 275 llamadas) en 425 ms.

### 2.2 Once lecturas de las mismas filas

Cada una de las 11 agregaciones hace su propio `findMany` de `SaleVerification` sobre el mismo rango. Una carga de pantalla materializa ~11
× 5,446 ≈ **60,000 filas** en objetos JS antes de siquiera empezar a agrupar. (La consulta 12ª, la lista, sí está paginada y solo lee su
página — esa no es parte del problema.)

### 2.3 Por qué la protección que ya existía no sirvió

Los endpoints del dashboard ya pasan por `analyticsLimiter` (`src/utils/concurrencyLimiter.ts:56`, máx. 4 concurrentes), puesto tras el
incidente de pool exhaustion de junio 2026.

**Ese limiter cuida el pool de Postgres, no el event loop.** Contra CPU síncrono las cuatro "vías" son el mismo hilo, así que no puede
ayudar — y de hecho serializa la latencia sin liberar nada. No falló por estar mal configurado: es la herramienta equivocada para este modo
de falla. Se queda como está, para lo que sí sirve.

### 2.4 El MCP de cliente es una segunda puerta, y esa no tiene ni limiter

`src/mcp/tools/saleVerifications.ts` consume **las mismas funciones del servicio** — `getOrgSalesSummary`, `getSalesByMonth`,
`getSalesByCity`, `getSalesByStore`, `getSalesBySupervisor`, `getSalesByPromoter`, `getSalesByPromoterDaily`, `getSalesByPromoterWeekly`,
`getSalesBySaleTypeWeekly`, `getSalesBySimTypeWeekly`, `listOrgSaleVerifications` — pero **llama al servicio directo, sin pasar por el
controller**, así que no toca el `analyticsLimiter`.

Consecuencia: un LLM pidiéndole ventas al MCP puede trabar el servidor de pagos exactamente igual que la pantalla, y sin siquiera el tope de
4 concurrentes. Es otra razón por la que el arreglo va **en la capa de servicio**, no en el controller: así cubre las dos puertas de un solo
golpe.

`getSalesByPromoterWeekly` es la única de las 12 funciones de agregación que **no** tiene ruta de dashboard: existe solo para el MCP. Cuenta
para el arreglo aunque no salga en la pantalla.

## 3. Dos bugs latentes descubiertos al verificar

Ninguno es la causa del incidente, pero ambos viven en el código que hay que reescribir, así que se corrigen en el mismo cambio o se
heredan.

### 3.1 El número de semana depende de la zona horaria de la máquina

`toWeekLabel` no pone la hora en cero antes de ajustar al jueves, y mezcla construcción en hora local con getters `getUTC*`. Resultado: el
epoch se recorre según el `TZ` del **proceso**. Es la misma trampa documentada en `.claude/rules/critical-warnings.md` y la misma raíz que
el bug de dinero del estado de resultados de junio (`c41b03d6`, `a8aa70a0`).

Barrido hora por hora contra ISO-8601 real:

| Ventana                         | prod (`TZ` sin definir → UTC) | dev (`TZ=America/Mexico_City`) |
| ------------------------------- | ----------------------------- | ------------------------------ |
| Datos reales (2026-03-30 → hoy) | ✅ 0 / 3,048                  | ❌ 114 / 3,048 (3.7%)          |
| Todo 2026                       | ✅ 0 / 8,760                  | ❌ 312 / 8,760                 |
| Resto de 2026                   | ✅ 0 / 3,600                  | ❌ 126 / 3,600                 |
| 2027                            | ❌ 8,320 / 8,760 (**95%**)    | ❌ 8,378 / 8,760               |

Dos consecuencias:

- **Hoy** dev y prod no coinciden: una venta del 30 de marzo sale en W14 en una Mac y en W13 en producción.
- **El 4 de enero de 2027**, sin que nadie toque nada, el 95% de las ventas del año se etiquetan una semana adelante. Cada gráfica semanal y
  cada reporte semanal a Walmart se recorre.

Esto explica por qué la auditoría de junio 2026 se contradijo consigo misma sobre 2026 (observaciones 27569 vs 27592): cada corrida se hizo
bajo un `TZ` de host distinto.

**Decisión del founder (2026-08-04): corregir a ISO-8601 real.** Bajo la zona de producción no mueve ningún número de 2026 — está verificado
hora por hora, todo el año — y desactiva 2027.

### 3.2 El tipo de SIM se elige de una lista sin orden

`getSalesBySimType:496` y `getSalesBySimTypeWeekly:592` resuelven la categoría con:

```typescript
v.payment?.order?.items?.find(oi => oi.serializedItem)
```

"El primer item que traiga un serializado" — pero la relación no tiene `orderBy`, así que el orden lo decide Postgres. Si una orden trae más
de un serializado de categorías distintas, el bucket sale al azar y puede cambiar entre corridas.

Es el mismo defecto de familia que la pérdida silenciosa de filas en listas paginadas arreglada la mañana del 2026-08-04 (`orderBy` no
único). En PlayTelecom casi siempre es un SIM por venta, así que el daño actual es chico — pero al pasar a SQL hay que poner un desempate
explícito, no heredar el azar.

## 4. Principio de diseño

> **El problema no es cuánto trabajo hay, es cuánto trabajo se hace sin soltar el hilo.**

Nueve segundos seguidos de CPU son nueve segundos en los que el servidor no existe para nadie más. Esos mismos nueve segundos partidos en
pedazos de milisegundos, con un respiro entre cada uno, dan **el reporte completo** — ni una fila menos — y en cada respiro se cobra normal.

Requisito del founder, textual: _"quiero que sí salga el reporte completo pero que no cause lo que está causando; y si eso es que tarde más
en generar el reporte, no me importa."_

De ahí salen dos reglas no negociables:

1. **Completitud sobre latencia.** Nunca se trunca, muestrea ni pagina un reporte para hacerlo rápido. Si hay que tardar más, se tarda más.
2. **Ningún handler retiene el event loop más de 50 ms.** Es holgado para cualquier cosa sana y brutalmente estricto contra los 9,000 ms de
   hoy. (Ese es el número que exige CI; el umbral de alerta en producción arranca más flojo — ver §9.)

## 5. Solución — cuatro capas

De la que más quita a la que menos.

### Capa 0 — dejar de traer 60,000 filas a JS

En su mayor parte **esto lo resuelve la Capa 1 sola**: en cuanto Postgres agrupa, cada endpoint devuelve ~20 renglones y el problema de
"once lecturas de 5,446 filas" se disuelve — siguen siendo once consultas, pero baratas.

Lo que queda como decisión aparte, y **no** es requisito para cerrar el incidente: si conviene consolidar las doce llamadas HTTP en menos.
Eso es forma de la API y toca al dashboard, así que se evalúa por separado una vez medido el resultado de la Capa 1. No se hace en este
cambio.

### Capa 1 — que Postgres agrupe, no Node

`GROUP BY` con `AT TIME ZONE` en Postgres. Las ~10,900 conversiones de zona por petición no se vuelven más rápidas: se vuelven **cero**,
porque las filas nunca cruzan a JS. Postgres ya contesta en 5.6 ms y hace ese trabajo en C.

Clasificación de las 12 funciones de agregación (11 con ruta de dashboard + 1 solo-MCP):

| Agregación                      | Destino         | Nota                                                                                 |
| ------------------------------- | --------------- | ------------------------------------------------------------------------------------ |
| `getOrgSalesSummary`            | SQL             | conteos + suma por status                                                            |
| `getSalesByMonth`               | SQL             | equivalencia ya probada en auditoría jun-2026 (obs. 27555)                           |
| `getSalesByWeek`                | SQL             | `IW` (ISO real)                                                                      |
| `getSalesBySaleTypeWeekly`      | SQL             | semana × `isPortabilidad`                                                            |
| `getSalesByCity`                | SQL             | join de 1 salto a `Venue.city`                                                       |
| `getSalesByStore`               | SQL             | venue × semana                                                                       |
| `getSalesByPromoter`            | SQL             | staff × mes                                                                          |
| `getSalesByPromoterWeekly`      | SQL             | staff × semana — **solo MCP**, sin ruta de dashboard (§2.4)                          |
| `getSalesByPromoterDaily`       | SQL             | staff × día                                                                          |
| `getSalesBySupervisor`          | **mixta**       | agrupado en SQL; el mapeo tienda→supervisor son ~39 venues en JS (trivial, se queda) |
| `getSalesBySimType` / `…Weekly` | SQL con cuidado | join profundo + desempate explícito del §3.2                                         |

### Capa 2 — lo que quede en JS, en tandas con respiro

Para lo que no baje limpio: procesar en tandas y soltar el hilo entre tandas. No se pierde ninguna fila; solo se reparte el trabajo en el
tiempo. Es el cinturón de seguridad genérico para cualquier bucle futuro.

### Capa 3 — un guardia, para que no dependa de que nos acordemos

- **En CI:** test que truena si una agregación retiene el hilo más de **50 ms**.
- **En prod:** medidor de lag del event loop que registra y alerta con el **nombre de la ruta** cuando un handler pasa de **200 ms** al
  arranque (§9 explica por qué el umbral de prod es más flojo que el de CI y cuándo se aprieta).

El guardia **detecta, no previene**. Si mañana alguien escribe otro bucle pesado, esto lo grita antes de que llegue a producción — pero no
lo arregla solo. Es la diferencia entre enterarnos nosotros y enterarnos por el cliente.

## 6. Alcance — lo que este trabajo NO cubre

Se documenta explícitamente para no vender de más. Ninguno de estos se arregla con este cambio:

- **426 `findMany` en servicios de dashboard**, varios sin `take`. Otro modo de falla —memoria y tiempo de serialización, el OOM de Render—
  con la misma consecuencia visible.
- **El N+1 del venue-switcher de plan-tier**, que recibe 50-129 peticiones por minuto.
- **Pool exhaustion** — mitigado en junio 2026, no eliminado.
- **Los tres problemas independientes del §6.1**, medidos en Better Stack.

Lo que sí aporta la Capa 3 a esos: hoy ninguno se ve hasta que ya trabó algo.

**Verificado (con matiz importante):** el **antipatrón** de conversión de zona fila por fila existe únicamente en
`sale-verification.org.dashboard.service.ts`. Los otros usos (`utils/datetime.ts:486-487`, `nightly-sales-summary.job.ts:237-238`,
`export.helpers.ts:117`) ocurren una vez por llamada, no por fila.

Eso **no** quiere decir que no haya otras pantallas lentas — sí las hay, por otras causas. Ver §6.1. La búsqueda fue del antipatrón, no de
la lentitud.

### 6.1 Lo que Better Stack midió, y que este cambio NO arregla

Datos del 2026-08-04, fuente `render log stream` (id 1720702).

**a) Los reportes SÍ degradan todo lo demás — confirmado con correlación temporal.** `/dashboard/auth/status` (un endpoint trivial), 201
llamadas hoy:

|                                    | llamadas | p50      | p95      | max           |
| ---------------------------------- | -------- | -------- | -------- | ------------- |
| minutos **sin** reportes corriendo | 113      | 1,655 ms | 2,854 ms | 4,394 ms      |
| minutos **con** reportes corriendo | 88       | 2,936 ms | 8,087 ms | **33,665 ms** |

Los reportes duplican la mediana y triplican el p95. Los picos caen exactamente en las ráfagas (14:50 → auth 11,950 ms; 14:52 → **33,665
ms**; 15:07 → 12,482 ms). El mecanismo del §1 queda probado, no inferido.

**b) Pero arreglar los reportes no deja sano a `auth/status`.** Sin un solo reporte corriendo ya está en **1,655 ms de mediana**. Un
endpoint de auth debería estar en decenas de milisegundos. Ese es un problema aparte —probablemente el N+1 del venue-switcher— y este cambio
no lo toca. Realista: la mediana baja de ~2.9 s a ~1.7 s, no a 50 ms.

**c) La lentitud del TPV —el camino del dinero— NO la causan los reportes.** En los 25 minutos más lentos del TPV (`/tpv/.../orders/*` entre
6 y 19 segundos) había **cero** reportes corriendo y el servidor casi ocioso (3 a 85 peticiones por minuto). El TPV es lento por su cuenta.
Es un problema independiente y probablemente **más urgente que este**, porque toca cobro directo y empata con las 29 órdenes PENDING
huérfanas detectadas la mañana del 2026-08-04.

**d) Hay otra pantalla lenta con otra causa.** `/organizations/.../stock-control/overview` (p50 3,547 ms, max 12,031 ms, 36 llamadas) y
`/venues/.../stock/categories` (max 13,778 ms). No tienen el antipatrón de zona horaria; su causa está sin diagnosticar.

### 6.2 🔴 El monitoreo está apagado — la Capa 3 depende de encenderlo

**Los 4 monitores de uptime de Better Stack están PAUSADOS desde 2026-06-26** (`avoqado.io`, `Demo — landing`, `Demo — dashboard app`,
`Demo — live-demo API canary`): seis semanas sin monitoreo de disponibilidad. El único incidente registrado desde el 3 de agosto es un pico
de errores del 2026-08-03 21:45 UTC, sin relación.

**Nada alertó por ninguno de los 33 segundos de hoy.** Nos enteramos por el reporte del founder.

Esto es un requisito nuevo para la Capa 3: se diseñó una alerta encima de un sistema de monitoreo que está apagado. Reactivar los monitores
(o decidir explícitamente que se quedan apagados y que la detección va solo por el log stream) es **parte de esta entrega**, no un pendiente
aparte. Un guardia que grita en un cuarto vacío no es un guardia.

**Sí queda cubierto, aunque no se mencione en el incidente:** el MCP de cliente (`src/mcp/tools/saleVerifications.ts`), porque el arreglo va
en la capa de servicio que ambos comparten (§2.4, D6). Sus tools no cambian de contrato — solo dejan de poder trabar el servidor.

**No se toca:** `analyticsLimiter` (se queda, cuida el pool), el arreglo de paginación del 2026-08-04, y nada del camino de cobro.

## 7. Cómo se prueba

1. **Equivalencia por agregación.** Cada migración a SQL se prueba contra la implementación JS actual sobre el mismo conjunto de datos.
   Números idénticos, o la diferencia queda explicada y aprobada (solo aplica al §3.1, y ahí es cero bajo la zona de producción).
2. **Semana ISO, barrido hora por hora 2026-2028**, corrido bajo `TZ=UTC` **y** `TZ=America/Mexico_City`. Que dev y prod coincidan tiene que
   quedar probado, no prometido. El test existente usa instantes de marzo/abril y pasaría en falso — hay que reforzarlo.
3. **Presupuesto de event loop.** Test que mide el lag durante una agregación con volumen realista y truena arriba de 50 ms.
4. **Regresión.** La suite completa verde, incluidos los tests de paginación de esta mañana. Los tools del MCP deben devolver exactamente lo
   mismo que antes — el contrato no cambia, solo deja de bloquear (§2.4).
5. **Verificación bajo la zona de prod.** Las pruebas de fecha corren con `TZ=UTC`, no solo con la zona local de la máquina.

## 8. Decisiones tomadas

| #   | Decisión                                                                                                      | Quién / cuándo                 |
| --- | ------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| D1  | Completitud sobre latencia: el reporte nunca se trunca ni se muestrea                                         | founder, 2026-08-04            |
| D2  | Presupuesto de 50 ms de event loop por handler (CI); 200 ms para alertar en prod al arranque (§9)             | propuesto, aprobado 2026-08-04 |
| D3  | Corregir la semana a ISO-8601 real (no replicar el bug)                                                       | founder, 2026-08-04            |
| D4  | `analyticsLimiter` se queda sin cambios                                                                       | 2026-08-04                     |
| D5  | Los tres puntos del §6 quedan fuera de alcance, documentados                                                  | 2026-08-04                     |
| D6  | El arreglo va en la **capa de servicio**, no en el controller, para cubrir dashboard y MCP de un golpe (§2.4) | 2026-08-04                     |
| D7  | Reactivar los monitores de Better Stack (o decidir explícitamente no hacerlo) entra en esta entrega (§6.2)    | pendiente de confirmar         |

## 9. Dos cosas que arrancan con un valor por defecto

Ninguna bloquea la implementación; se arranca con el default y se ajusta con datos reales.

- **Umbral de alerta en producción (Capa 3).** Arranca en **200 ms** para alertar, mientras el test de CI se queda en 50 ms. La asimetría es
  a propósito: CI debe ser estricto porque ahí el costo de un falso positivo es rehacer un test; producción debe ser tolerante las primeras
  semanas porque el costo de un falso positivo es ahogar el canal de alertas y que la gente aprenda a ignorarlo. Se baja a 50 ms cuando el
  ruido de las primeras dos semanas esté medido.
- **Aviso a PlayTelecom por el cambio de semana.** Los números de 2026 no se mueven (§3.1), así que no es un cambio que ellos vayan a ver —
  pero los reportes semanales alimentan el cobro a Walmart, así que se les avisa igual, como nota informativa, no como aprobación previa.
  Queda como tarea de la entrega, no como bloqueo.

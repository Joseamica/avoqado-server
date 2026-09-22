# RELEVO — Atribución del event loop (2026-09-22)

Trabajo **sin commitear**, verificado, con un gate de Codex a medias. Léelo entero antes de tocar nada.

---

## 🔴 LO PRIMERO: el índice de git tiene mi trabajo A MEDIAS

`git status` muestra mis 4 archivos como `MM`/`AM`: están **en el índice** con una versión VIEJA
(330, 33, 429 y 67 líneas de diferencia respecto al árbol, que es el bueno). Y el índice tiene
**30 archivos en total**, la mayoría de OTRAS sesiones (`prisma/schema.prisma`, una migración,
`src/services/access/*`, specs…).

**Consecuencia:** un `git commit` pelón se llevaría 30 archivos ajenos **y mi trabajo a medias**.
Es el incidente del 2026-08-27 (38 archivos) otra vez. Yo no lo toqué a propósito: desenredar el
índice compartido puede romper el trabajo de otras 3-4 sesiones vivas.

**Al retomar, antes que nada:** `git diff --cached --name-only` y decidir. Para commitear lo mío:
`git commit -- src/middlewares/eventLoopGuard.middleware.ts src/services/payments/settlementCalculation.service.ts src/app.ts src/server.ts tests/unit/middlewares/eventLoopGuardAtribucion.test.ts tests/unit/services/payments/settlementCalculationVolumenDeLog.test.ts`
(el pathspec **en el propio commit**, nunca `git add` + commit pelón) y después `git show --stat`.

---

## Qué problema se está resolviendo

Desde el deploy `c45035bd` (18-sep 02:59Z) producción tiene **~185 retenciones/hora de ~500 ms**
del event loop, repartidas entre rutas sin nada en común; el p99 de `display-mode-request` pasó de
68 a 550 ms. El 21-sep una de ellas **tumbó una reserva pública** de una clienta de Amaena con un
500 (transacción serializable expirada). **El culpable del fondo de ~500 ms sigue SIN demostrar.**

El guardia existente sólo decía cuánto duró la retención y qué peticiones esperaban — y
`topInFlight` lista a quien **esperaba**, no a quien ejecutaba. Este trabajo le da atribución para
que el siguiente paso (perfil V8 en producción) sepa dónde mirar.

## Estado: qué está hecho y verificado

| Pieza | Estado |
|---|---|
| `eventLoopGuard.middleware.ts` (+330 líneas) | señal `gc-dominante`/`cpu-alta`/`cpu-baja`/`indeterminada`; pausas de GC cruzadas **por ventana de tiempo**; aviso diferido un tick; buffer con contador de descartes que **invalida la ventana**; `gcEnVentana` fusiona intervalos; interruptor `EVENT_LOOP_GC_OBSERVER=off` |
| `settlementCalculation.service.ts` | el log por pago tras `logger.isDebugEnabled?.()` — **AUTORIZADO por Codex para desplegar solo** |
| `app.ts` + `server.ts` | el `stop()` del monitor deja de descartarse y se llama en `gracefulShutdown` |
| 2 archivos de prueba | **22 pruebas**, reloj y CPU inyectados |

**Verificación (22-sep, tras la 5ª pasada):** **95 suites / 912 pruebas** verdes con local y
Alienware COINCIDIENDO · **33 pruebas** en las dos suites del paquete · typecheck **sin errores
míos** · **13 sabotajes acumulados, 13 cazados**, cada uno tumbando sólo su prueba.

⚠️ **Intermitencia declarada, no cerrada:** antes de la última corrección hubo 1 fallo no
reproducido y conteos inconsistentes (852/808/892) mientras OTRO jest mío corría en paralelo. Tras
hacer determinista la prueba del buffer, 4 corridas seguidas dan 892/892. No afirmo que no quede
flaky; afirmo que no se reprodujo en 4 corridas limpias.

## El gate de Codex (gpt-6-astra xhigh): CINCO pasadas — ✅ AUTORIZADO en la 5ª

**Cuatro rechazos, y los cuatro encontraron algo real.** Resumen para no repetir la historia:

| # | Veredicto | Lo que encontró |
|---|---|---|
| 1ª | RECHAZADO (5) | Las pausas de GC se entregan **asíncronas**: durante un bloqueo llegan DESPUÉS. Verificado: **72 de 72** dentro de un bloqueo de 616 ms se entregaron al terminar, una con 602 ms de retraso. Acumular por momento de entrega decía `gcMs≈0` en el tramo que SÍ fue GC |
| 2ª | RECHAZADO (3) + **autorizó el logging** | El buffer truncaba y aun así decía `gcVentanaCompleta:true` · `app.ts` descartaba el `stop()` · dos pruebas no acreditaban nada |
| 3ª | RECHAZADO (2) | 🔴 La referencia de descartes se tomaba al **detectar** el tramo, no al **abrir**: un descarte anterior al tick detector ya venía incluido y desaparecía de la resta. Lo reprodujo con el buffer real (520 ms con 450 de GC ⇒ `cpu-alta`, ventana «completa», 0 descartes) · el cierre vivía dentro de `DEMO_MODE` y tras la salida de dev: medido, **demo 0 y desarrollo 0** llamadas |
| 4ª | AUTORIZADO **CON CAMBIOS** (1 nuevo) | 🔴 Y lo abrió MI arreglo del anterior: al mover el cierre al principio del apagado quedó antes del cierre HTTP y del plazo de 30 s ⇒ si `logger.warn` lanzaba, **frenaba el apagado entero** (HTTP sin cerrar, plazo sin armar, proceso sin salir, y el 2º intento tropezaba igual) |
| 5ª | ✅ **AUTORIZADO para desplegar** | Reprodujo 9 combinaciones (prod · demo · dev × logger sano / `warn` lanza / `warn` y `error` lanzan): observador desconectado, HTTP cerrado, plazo armado, `process.exit(0)` alcanzado |

Lo pedido en la 4ª quedó igual que lo exigió: el pendiente se retira **antes** de emitir, la emisión
va en `try/catch` (con el `logger.error` a su vez protegido) y `gc?.detener()` sigue en el `finally`.

🔑 **Dos lecciones de método que valen más que el código.** (a) Un arreglo puede abrir el defecto
siguiente: el del apagado nació de mover el cierre para cerrar el hallazgo anterior. (b) Se le
declaró una desviación en lugar de fingirla — pidió una prueba que ejecutara el apagado real y no
se escribió, porque `server.ts` arrastra base, sockets y ~40 módulos y el doble acabaría
acreditándose a sí mismo (el motivo por el que él mismo tumbó dos pruebas en la 2ª). Aceptó la
desviación y la cubrió con su propia reproducción.

## Lo siguiente, en orden

1. 🔴 **DECISIÓN DEL FOUNDER: commitear y desplegar.** Los 6 archivos están autorizados por
   Codex y verificados. Nada está commiteado — hace falta su permiso explícito.
2. **Jobs en vuelo** — `AUTORIZADO CON CAMBIOS para implementar`, diseño v2 escrito pero **sin una
   línea de código**. Sus 4 condiciones: (a) normalizar el thenable con `Promise.resolve` (un
   `thenable` sin `.finally()` lanza y deja el job registrado); (b) crear la promesa derivada
   **dentro** de `runWithContext` o el rechazo fatal pierde el contexto del job; (c) `scheduleCron`
   **también** pasa por `runInJobContext`, así que excluir node-cron exige separar el camino —
   `node-cron@4.2.1` SÍ espera el resultado (`runner.js:70`); (d) retener el historial hasta
   consumir la ventana pendiente. Y contestó mi pregunta: **no** añadir `cpuMs` por job.
3. **Perfil V8 en producción** (30-60 s) — el paso que de verdad nombra al culpable.

## Datos medidos que no hay que volver a averiguar

- 72/72 pausas de GC entregadas tarde (una con 602 ms de retraso).
- Winston formatea ANTES del filtro por nivel: **50 llamadas `debug` = 50 serializaciones, 0 escrituras**.
- V8 **no solapa** sus pausas (0 de 97 pares) — aun así `gcEnVentana` fusiona, por construcción.
- `cron@4.3.3` con `waitForCompletion=false` (default) no espera la promesa; `node-cron@4.2.1` **sí**.
- **78 registros de scheduler en 67 archivos**; 11 sin wrapper (incl. `server.ts` ×2, `reviewSync`);
  8 con `=> void` por mi regex (Codex contó 17 incluyendo otras formas).
- **El costo del observador de GC NO está cuantificado**: 3 intentos, el ruido de la Mac se comió la
  señal (+19.7 % resultó artefacto del orden; alternado dio −44 %). Falta medir en Node 20.
- 🔴 **Errores de tipos AJENOS vivos que tumban el CI** (su dueño ya cerró el del `attemptId`):
  `stripe.service.ts`, `onboarding.controller.ts` y el carril de obligaciones de cobro. Declarados,
  no tocados.
- ⚠️ **El typecheck local puede MENTIR por lo bajo:** su caché incremental
  (`node_modules/.cache/tsc/full.tsbuildinfo`) lo comparte el snapshot de avq-verify con el árbol
  real, así que el lado local **se salta archivos** — medido: 2 errores en local contra 7 en el
  Alienware, sobre el mismo código. Gana el remoto. Memoria: `tsbuildinfo-compartido-oculta-errores`.
- **El inventario de jobs se corrigió:** son **5** registros realmente sin envoltorio (`server.ts`
  ×2, los dos de catálogo, `reviewSync`), no 11 — tres de aquellas líneas eran comentarios que
  dicen «usa `scheduleJob`, no `new CronJob`», o sea trabajo ya hecho.

## Archivos de apoyo
- Informe completo de Codex (las dos pasadas): `~/render-error-monitor/reports/codex-audit-2026-09-22.md`
- Reporte del monitor que originó todo: `~/render-error-monitor/reports/latest.md`
- Sesiones de Codex para reanudar: `01a0c951-d24d-70a0-8037-4b94be91a81c` (1ª), y la 2ª en el log.

---

## Fallos AJENOS vistos de paso (no debuggeados, regla del árbol compartido)

Al correr un patrón amplio aparecieron 3 fallos que **no son de este trabajo** y conviene que su
dueño los sepa:

- `Codex R6-2 (c) · READ COMMITTED EXPLÍCITO en toda transacción del protocolo…` — carril de
  obligaciones/costo.
- `🔴 anular un plato con un descuento previo mayor ya no deja el total negativo`
- `anular un plato conserva el cargo por servicio: total $55, no $40`

Mi cambio toca el guardia del event loop, el log de liquidaciones y el cierre del monitor: nada
que roce anulación de platos ni el protocolo de costo. Se declaran, no se corrigen.

## Verificación de integridad al cerrar la sesión
- `src/server.ts` comprobado íntegro tras un sabotaje que se restauró en segundo plano
  (import en :8 + llamada en :151).
- Sin procesos pesados vivos: ni Codex, ni `avq-verify`, ni Jest.
- Sin temporales: `.codex-*` y `scripts/temp-*` de esta sesión, borrados.

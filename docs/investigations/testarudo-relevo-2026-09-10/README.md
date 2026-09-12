# LEER PRIMERO — relevo único Testarudo, Claude + Codex

Actualizado el **10 septiembre 2026, aproximadamente 09:55 America/Mexico_City**. El usuario se queda sin créditos en Claude y quiere UNA conversación nueva que continúe todo el trabajo autorizado. **Trabajo incompleto: no desplegar, no pushear, no commitear ni declarar el circuito de pagos resuelto.**

Este es el punto de entrada actual. Resume las dos conversaciones; enlaza el trabajo, las pruebas y las auditorías. Los archivos anteriores son históricos y contienen conclusiones que se corrigieron después. Si algo cambia tras esta captura, prevalecen el código actual y la evidencia verificable. No restaurar el árbol desde un checkpoint.

## 1. Lo que quiere el usuario y cómo continuar

El objetivo es que **Android POS → servidor → PAX/Blumon y Nexgo/AngelPay** cobren y registren correctamente, recuperen resultados inciertos sin volver a cobrar, y mantengan orden/saldos/inventario consistentes ante cancelación, reenvío, reinicio, internet/DNS defectuosos y servidor lento. Aproximadamente 95.5% de los cobros observados de Testarudo venían del POS; probar sólo el monto tecleado en TPV es insuficiente.

El usuario ya autorizó investigación, correcciones, pruebas, uso de las terminales de pruebas por ADB y auditoría. No pedir que elija cada siguiente paso. El modelo y el esfuerzo los elige él; no imponer "Medium" ni otro modelo por instrucciones antiguas. Una conversación coordina ahora el relevo: trabajar secuencialmente y evitar agentes paralelos o repetir investigaciones cerradas para gastar menos. No relanzar auxiliares sin créditos ni consumir resets.

Reglas vigentes:

- Leer `AGENTS.md` y `CLAUDE.md` del workspace y de cada repo antes de tocarlo. Workspace: `/Users/amieva/Documents/Programming/Avoqado`.
- Camino de DINERO: **TDD estricto**, prueba que falla por comportamiento antes del arreglo; suites del módulo e integración con PostgreSQL real cuando hay persistencia del servidor.
- Toda verificación pesada por `./scripts/avq-verify.sh` desde el workspace. Una pesada propia a la vez. Inspeccionar el cuerpo del veredicto, no sólo exit code. No declarar verde con DIFIEREN/INCONCLUSO ni ignorar vigencia.
- API aditiva: conservar campos y semántica para APK publicados; los viejos necesitan recibo en la respuesta. Dinero, orden pagada/saldos e invariantes que otros clientes leen deben quedar consistentes antes de responder.
- Outbox en la MISMA transacción que el pago; consumidores durables e idempotentes. No fire-and-forget sin respaldo. Bitácora `logAction` fuera de la transacción financiera. Consultas acotadas; no `take` que trunque sumas de dinero.
- Árbol compartido: WIP y commits ajenos son normales. No reset/checkout/stash/clean, cambio de rama para limpiar, git add global ni reversión de trabajo ajeno. **No commit, push ni deploy** en esta tarea. No matar procesos/servidores/DB ajenos.
- No hacer sabotajes en el árbol compartido para probar tests: usar una copia aislada. Claude dejó temporalmente código roto por un trap defectuoso; no repetirlo.
- Nunca imprimir `.env`, URLs con contraseñas, tokens ni credenciales. Claude reportó exposición de una contraseña local en su conversación; no está incluida en este paquete. No rotarla a ciegas afectando otras sesiones.

## 2. Estado ACTUAL y siguiente trabajo (este orden)

### A. P1 ABIERTO: REST puede cerrar la solicitud de la terminal equivocada

Codex lo reprodujo el 10-sep contra PostgreSQL local: mismo venue/orden/importe, Payment de terminal B etiquetado para la solicitud de A. `closeRowFromPaymentTx` por REST marca A COMPLETED; por SOCKET conserva SENT. La validación de terminal está condicionada a `source === 'SOCKET'`. Las llamadas de `payment.tpv.service.ts` usan REST por defecto.

**Siguiente paso:** RED PostgreSQL en la suite adecuada para el cierre REST, después corregir. Conservar el dinero capturado; negar que cierre/libere una solicitud ajena. Probar terminal/origen incorrectos y terminal correcta. No exigir indiscriminadamente una etiqueta que clientes existentes aún no mandan antes de la primera asociación: validar identidad sin romper compatibilidad.

Fuente: `avoqado-server/src/services/terminal-payment.service.ts` alrededor de 1039; llamadas `src/services/tpv/payment.tpv.service.ts` alrededor de 2546 y 4009.

### B. P1 ABIERTO: arnés financiero PAX y cobertura de comportamiento

Prueba `offline approval write failure keeps durable obligation and cannot publish success or cancellation` en `PaymentViewModelKernelDurabilityTest.kt`. Corrida propia Codex `sbDZFC`: **falla porque `StartCtlssTransUseCase.run` no fue llamado**. No certifica el escenario de aprobación: se atasca antes. Conserva `Thread.sleep` tras `selectMerchant` y mocks cuya sincronización se debe resolver.

**No tratarlo como ajeno:** es una regresión de esta misma tarea y debe quedar verificada. La hipótesis de una caché de comercios no está demostrada: el arnés construye un mock nuevo de `MultiMerchantSDKManager` en cada setup y configura `switchMerchant` para éxito. Determinar qué operación queda pendiente, no esperar más a ciegas.

Claude corrigió la llamada ausente `markKernelRefused` al recibir `RESULT_OFFLINE_DENIED` en venta, tanto sandbox como production. **Está implementada, pero aún falta la regresión ejecutando el ViewModel.** Sustituyó sus dos pruebas por invocaciones directas al ledger/Room y guardas que leen el fuente. Codex comprobó en memoria que `rama.contains("markKernelRefused")` sigue pasando con la llamada comentada: no equivale a prueba de comportamiento.

Siguiente paso: arreglar el arnés y ejecutar el ViewModel con kernel simulado y Room real. Cubrir aprobación + fallo de escritura (no falso éxito/cancelación, reserva permanece), rechazo explícito (reserva resuelta, siguiente venta permitida), y timeout/desconocido (reserva retenida, siguiente venta bloqueada). Cada test aislado → clase → módulo. Mantener guardas textuales sólo como complemento.

### C. AngelPay: progreso VERIFICADO, no repetir el diagnóstico viejo

Los documentos antiguos dicen que la recreación quedaba en Idle. El código y arnés cambiaron después: **las cinco pruebas actuales de `AngelPayPaymentReviewRoomTest` pasaron en `sbDZFC`**, incluidas recreación/callback vacío y rechazo tras recreación. Codex comparó los archivos relevantes con el snapshot y coincidían. No seguir afirmando que ese test sigue rojo por reportes antiguos. Todavía faltan suite financiera completa pertinente, build y QA con SDK/terminal física; cinco pruebas no certifican todo AngelPay.

### D. Servidor / outbox: avances reales, integración final PENDIENTE

- Los cinco hallazgos iniciales del relay tuvieron correcciones: socket desplazado no hereda identidad; recuperación valida terminal; socket perdido conserva resultado incierto; picker considera reserva física entre venues; descuadre de importe se conserva.
- Auditoría posterior Codex encontró dos huecos: rechazo contactless sin liberar (B arriba) y CONTRACT_MISMATCH incompleto. Este último **ya tiene `marcaDeDescuadre` en las rutas stale, UNKNOWN, TIMED_OUT y manual**, preservando dinero y sobre de conciliación. No confundirlo con el nuevo P1 REST de A.
- Comisión: el fallo final era que `calculateFinalRate` descartaba una tasa por meta al exigir tipo TIERED. El cambio acepta también `useGoalAsTier`. Claude reportó 38/38 PostgreSQL y 169/169 comisiones con prueba de regresión; distinguir reporte de Claude de ejecución independiente de Codex. No rehacer Task5 desde cero: ya existen outbox, planes de comisión, reembolso y reversión de referidos.
- Claude corrigió muchos mocks incompletos tras el refactor. Hubo errores propios (create usado para leer, montos previos omitidos, campos duplicados). Revisar contratos reales al tocar fixtures; no debilitar aserciones financieras para obtener verde.
- **Último reporte de suite completa: tres shards verdes, shard 2 con 26 fallos en referidos.** Claude los atribuye a otra sesión; esa atribución no está demostrada aquí y no cierra integración. Resolver o coordinar con evidencia. No decir "suite completa limpia" mientras exista ese rojo.
- Typecheck: Claude reportó 0 errores. `tsconfig.typecheck.json` excluye tests; `npm run typecheck` usa tsconfig raíz y destapó errores de fixtures. Verificar alcance adecuado.
- Guardián `findManySinTopeGuard`: traslado de una excepción de `referralRefund.service.ts` a `referralReversalPolicy.service.ts` implementado, sin aumento de conteo. El filtro por orden no certifica un tope de filas. No añadir `take` que deje reembolsos fuera. Una mejora de agregado debe preservar `SUM(ABS(amount))`, con TDD.

### E. Android POS / iOS

Ya tenían recuperación durable del request incierto, consumo de resultados y protección contra respuestas de una instancia vieja. Auditoría enfocada `task-3-rereview3.md` limpia; Android 113/113 (`Ks1kS6`) e iOS 61/61 (`ZBYhXt`) en la etapa inicial. El inventario de hashes de pagos de esos repos seguía igual al relevo; commits posteriores de inventario no son de esta tarea automáticamente. Falta QA del circuito completo.

## 2-bis. Continuación del 10-sep (sesión Claude Opus 5) — qué CAMBIÓ de lo de arriba

🔴 **Nada de esto está commiteado, pusheado ni desplegado.** Sigue faltando el QA físico del circuito
completo. Lo que cambia es el estado de A, de B y de la atribución de los 26 fallos de referidos.

### A — CERRADO en código y prueba (era P1 ABIERTO)

`closeRowFromPaymentTx` niega ahora el cierre cuando la terminal del Payment **contradice** la de la
solicitud, en **cualquier** origen (antes esa comprobación estaba condicionada a `source === 'SOCKET'`
y las dos llamadas reales entran por REST). El Payment **no se toca** y no se le estampa la etiqueta:
sólo se le niega cerrar esa petición, y se emite un `🚨 [Terminal-payment] Refused to close a request
with a Payment captured by another terminal`.

🔑 **Decisión de compatibilidad, deliberada:** se niega la *contradicción probada* (los dos seriales
conocidos y distintos), NO la falta de prueba. `deviceSerialNumber` es `z.string().optional()`
(`src/schemas/tpv.schema.ts:927`) y por REST ésta es la PRIMERA asociación, así que exigir el serial
dejaría atorada cada terminal cuyo cobro llegó sin él — el otro P1 conocido de esta flota.
**Desconocido ≠ contradicho.** La estrictez extra del camino SOCKET se conservó intacta.

Evidencia (todo con `AVQ_KEEP=1`, corridas locales por necesitar Postgres):

| Qué | Resultado | Corrida |
|---|---|---|
| RED por comportamiento, antes del arreglo | `1 failed, 38 passed` — falla sólo la prueba nueva (`Expected "SENT" / Received "COMPLETED"`) | `run-avoqado-server.klNRv4` |
| Verde tras el arreglo | `39 passed, 39 total`, exit=0 | `run-avoqado-server.bqAehU` |
| Sabotaje en COPIA AISLADA (guard a `false &&`) | falla **exactamente 1** prueba, las otras 38 verdes | copia borrada; árbol compartido nunca tocado |
| Suites unitarias de terminal-payment | `11 suites / 216 passed` | `run-avoqado-server.czr0JQ` |
| Typecheck completo (incluye tests) | `errores TS: 0`, local y alien **COINCIDEN** | `run-avoqado-server.NbJu0t` |

Pruebas nuevas en `tests/integration/payments/terminalPaymentRecovery.integration.test.ts`: la negativa
(`REST close cannot claim a Payment captured by a different physical terminal`) más **dos controles** —
la terminal correcta sigue cerrando, y un Payment **sin terminal resuelta** sigue cerrando (compatibilidad).

🔴 **Cómo NO leer mal el reproductor de Codex.** `rest-attribution-DATABASE_URL.cjs` ahora sale con
**exit 1 y `PROBE_INCONCLUSIVE`**, y eso es lo ESPERADO, no un fallo: el defecto ya no se reproduce
(`REST → state SENT, linkedToOtherTerminalPayment false`, contra `COMPLETED/true` antes) y el script
exige además que `caughtMethodErrors` esté vacío, mientras el arreglo avisa a propósito. Se dejó el
script **sin modificar** por ser evidencia de la auditoría. Corrida: `run-avoqado-server.quSWFe`.

### B — CERRADO, y la causa NO era la que se suponía

El test `offline approval write failure keeps durable obligation and cannot publish success or
cancellation` fallaba con `StartCtlssTransUseCase.run(...) was not called`. **No era una caché de
comercios ni el montaje del cambio de comercio**: era el arnés cruzando DOS relojes. `viewModelScope`
vive en el `TestDispatcher` (virtual) mientras `continuePaymentFlow()` y las suspensiones de Room
saltan a `Dispatchers.IO` REAL. La secuencia vieja era `Thread.sleep → advanceUntilIdle → verify`, o
sea que **lanzaba el trabajo de IO justo ANTES de comprobarlo**. El kernel "no fue llamado" por
carrera, no por comportamiento.

Arreglo: helper `esperarA(...)` que ALTERNA los dos relojes y para en cuanto la condición REAL se
cumple, con tope; y las esperas pasan a ser sobre el hecho (`currentMerchant != null`, `kernel > 0`),
nunca sobre un reloj de pared. Resultado: **6 tests, 0 failures** (`run-avoqado-tpv.doGG25`), con el
test de aprobación corriendo 8.2 s y el kernel invocado 1 vez.

🔴 **El P2 de la auditoría queda CONFIRMADO y cerrado.** `recreated VM cannot enter offline capable
kernel while previous instance is preparing` usaba el camino de VENTA con esos mismos `sleep` ciegos:
su `coVerify(exactly = 0)` pasaba **en vacío**, porque por ese camino el kernel no se alcanzaba nunca.
Reescrito para esperar a que el flujo ATERRICE. Bajó de 2.637 s a **0.806 s** — la firma de que ya no
quema esperas ciegas.

**Sabotaje (en copia aislada, nunca en el árbol compartido):** con `openAttempt → true` (candado
durable roto) falla **exactamente esa prueba**, y el mensaje demuestra que el kernel corrió («El lector
no aceptó esta tarjeta por contactless (código 12)»). Las otras 5 siguen verdes. ⚠️ Un primer sabotaje
(`findTerminalHold → null`) NO bastó: `openAttempt` rechaza por más de un camino — hay defensa en
profundidad dentro de la libreta, y conviene saberlo antes de diseñar el próximo sabotaje.

⚠️ **Corrección a un comentario del propio árbol:** en `PaymentViewModelKernelDurabilityTest.kt` había
una nota afirmando que en pruebas unitarias «el alta de cuenta del gestor de comercios nunca termina»
y que «esperar más no ayuda». **Esa medición no se sostiene**: el alta sí termina; lo que fallaba era
esperar en el reloj equivocado. Se dejó la nota original con una corrección fechada al lado, sin
reescribir la prueba que la citaba (no formaba parte del arreglo).

### D — Los 26 fallos de referidos NO son ajenos: son de esta tarea. 23 cerrados, 3 abiertos

La atribución previa a «otra sesión» **no se sostiene**, y ésta es la evidencia: los dos suites que
fallan (`onOrderPaid.test.ts`, `referralRefund.service.test.ts`) están **sin modificar** (en HEAD), y
lo que cambió es el código de producción del WIP de esta tarea —
`git diff HEAD -- src/services/referrals/` da `referralRefund.service.ts −47/+4`,
`referralQualification.service.ts +6` y el nuevo `referralReversalPolicy.service.ts +23`.

**23 de los 26 eran fixtures incompletas creadas por ese refactor**, no fallos de comportamiento:

- `referralRefund.service.test.ts`: el refactor añadió `tx.$queryRaw` (el `SELECT … FOR UPDATE`) y el
  mock local **no declara `$queryRaw`** → `TypeError` que el `try/catch` del hook se traga → retorno
  silencioso → 13 fallos con «Number of calls: 0».
- `onOrderPaid.test.ts`: la política de reversión ahora consulta los reembolsos de la orden y el mock
  compartido no tenía default para `payment.findMany` → `undefined.reduce` dentro de la transacción.

Ambos arreglos **completan la fixture al contrato nuevo; no relajan ni una aserción**. Medido:
`26 failed / 196 passed` → **`3 failed / 219 passed`** sobre las mismas 222 pruebas y 17 suites
(local y Alienware dan los mismos totales; el `DIFIEREN` es el falso positivo de orden/captura de jest
ya documentado en el `CLAUDE.md` del workspace).

🔴 **Los 3 restantes comparten UNA causa y son una decisión, no una fixture.** El refactor **borró la
guarda barata** del principio de `revertReferralRewardForOrder`:

```ts
const qualified = await prisma.referral.findFirst({ where: { qualifyingOrderId, venueId, status: 'QUALIFIED' } })
if (!qualified) return   // «la pregunta más barata primero», con su comentario, también eliminado
```

Consecuencias medidas, las tres en el camino del dinero: (a) **cada reembolso o cancelación abre ahora
una transacción y toma `SELECT … FOR UPDATE` sobre la orden**, aunque esa venta nunca haya calificado
un referido — el caso común; (b) `onOrderPaid` lee la orden **dos veces** por llamada, lo que además
descoloca los `mockResolvedValueOnce` de las pruebas; (c) una orden `REFUNDED` ahora llama
`referral.updateMany` para anular los `PENDING`, y una prueba de HEAD afirma explícitamente que
`updateMany` **no** se llama.

**Deliberadamente NO se reescribieron esas 3 aserciones.** Son camino del dinero y hacerlo taparía el
hallazgo. Hay que decidir si el cambio de contrato era intencional (el relevo sólo describe este
refactor como el traslado de una excepción del `findManySinTopeGuard`, no como un cambio de semántica).
Pruebas rojas: `onOrderCancelled › además intenta la reversa del premio` ·
`onOrderPaid › 🔴 tampoco califica con la orden en PENDING, ni con una orden que ya fue REFUNDED` ·
`revertReferralRewardForOrder › is idempotent`.

### Terminales: re-enumeradas el 10-sep — están las TRES conectadas

`adb devices -l` (lectura, no se instaló ni se cobró nada):

| Aparato | Conexión | SO | Paquete y versión |
|---|---|---|---|
| **PAX A910S** `2841548417` | inalámbrica (**recuperada**, el relevo la daba por perdida) | Android 12 | `…sandbox` **2.8.7-sandbox (104)** · también `…tpv` 2.8.1 (98), el flavor `.demo`, y `com.avoqado.pos` / `.dev` |
| **Nexgo N86** | USB | Android 9 | `…sandbox` **2.9.1-nexgo (105)** |
| OrderPAD_3 | `192.168.1.122` | — | ⚠️ el relevo advierte no asumir que es la tablet autorizada; **no se tocó** |

Coinciden con lo que el relevo registró, así que **nada cambió de versión**. Confirmado también que el
APK 2.9.2 (107) que se había preparado **no está instalado** en el Nexgo.

🔴 **Por qué el QA sigue bloqueado, y no es por permiso.** Los arreglos de A viven en el árbol de
trabajo, **sin commitear ni desplegar**: ningún servidor al que las terminales puedan apuntar los tiene.
Para probarlos hace falta el laboratorio que este mismo documento describe como incompleto —
bootstrap/seed/login/proxy sobre `codex_testarudo_lab_20260909`, con el launcher en el puerto 18800 y
la coherencia de `-Pavoqado.devBaseUrl` (REST) contra el socket dev (ngrok) resuelta. Montarlo es
trabajo propio y arriesgado (el propio relevo avisa del script demo que apunta a producción y de
arrancar `server.ts` con jobs/proveedores por accidente). **Lo que falta para el QA es el laboratorio,
no la autorización ni el hardware.**

### QA en hardware del 10-sep — lo que destapó (y un P1 NUEVO, de la casa)

Montaje real: Sunmi OrderPAD_3 (POS `com.avoqado.pos.dev` 2.18.3-dev) → servidor local :3000 **con el
arreglo de A dentro** → PAX A910S 2841548417 (`2.8.7-sandbox`) y Nexgo N86 (`2.9.1-nexgo`). Las tres
por ADB; las terminales alcanzan el servidor con `adb reverse tcp:8799 tcp:3000` (su APK apunta a
`localhost:8799`, que es el proxy de QA — sin el túnel dan `ECONNREFUSED`).

🔴 **El cobro NUNCA llegó a la terminal**, y no por el arreglo de A: `POST /mobile/.../terminal-payment`
respondió **409 TERMINAL_BUSY**. La PAX tiene **10 filas históricas** reteniendo su slot, la más vieja
del **2026-07-15** (`CANCELLED` con `cancelDisposition` distinto de ACCEPTED, y una `FAILED/TPV_ERROR`).

Y después el POS **también quedó atorado**: guardó ese intento como «cobro sin confirmar», consultó su
estado, recibió **404** (la fila nunca existió porque el POST fue rechazado) y **no lo trata como
resuelto** — se queda en «Cobro anterior sin confirmar / No vuelvas a pasar la tarjeta» y ya no deja
cobrar nada. Un 409 y un 404, los dos casos donde con CERTEZA no hubo cobro, acaban presentados como
«quizá te cobramos». (Detalle menor del mismo camino: el texto sale duplicado.)

#### 🔑 La causa de fondo: UN predicado contestando DOS preguntas — CORREGIDO

`UNRESOLVED_FINANCIAL_OUTCOME` se escribió para **la venta** (su propio comentario: «protects the sale
even when a legacy release freed its terminal») y se reusó para **la terminal**. Consecuencia: liberar
una terminal no la liberaba.

Y eso colisiona con trabajo de OTRO árbol: el worktree `.claude/worktrees/inventory-revision-task1-final`
(HEAD `80db1a08`) tiene la recuperación automática del proyecto «Terminal atorada» — tras 20 min, si la
terminal volvió y no hay pago, hace `UNKNOWN → TIMED_OUT` con `failureCode 'AUTO_RELEASED'`. **Allá eso
libera** porque su candado es `SLOT_HELD` (que excluye `TIMED_OUT`); **aquí no**, porque el predicado
nuevo sí bloquea con `TIMED_OUT`. Al fusionar, la liberación automática se volvería un **no-op**.

⚠️ **RETIRADO el 10-sep por la tarde (ver §2-ter):** Codex demostró que esto era una política de liberación por tiempo disfrazada, no un predicado; la corrida del árbol principal NO libera por plazo a propósito. Se revirtió.

~~**Arreglo aplicado (TDD, integración PostgreSQL):** `TERMINAL_SLOT_BLOCKED` = el predicado de la venta
**menos las filas ya liberadas**, y sólo las 4 consultas que preguntan por la TERMINAL lo usan
(`:426`, `:447`, `:504`, `:595`); las dos que preguntan por la VENTA (`orderId`) siguen con el original.
Es seguro porque `RELEASED_LATE_RECONCILE_WINDOW_MS` sigue barriendo 30 min una fila liberada por si su
pago llega tarde. RED escrito primero (`a released row frees the TERMINAL slot for a different sale`).~~

🔴 **Y una trampa de SQL que las pruebas cazaron y el compilador no:** el primer intento usó
`NOT: { failureCode: { in: RELEASE_FAILURE_CODES } }`, que **también excluye las filas con `failureCode`
NULL** (`NULL NOT IN (…)` es *desconocido*, no verdadero) — o sea que desbloqueaba justo las que más
bloquean, incluida una `UNKNOWN` recién nacida. Dos pruebas fallaron al instante. La forma correcta
trata el NULL explícito: `OR: [{ failureCode: null }, { failureCode: { notIn: … } }]`.

Verificación: **40/40 integración · 216 unitarias en 11 suites · typecheck 0 (local y alien COINCIDEN)**.

#### Lo que TODAVÍA faltaba para que la PAX del founder cobre (estado real en §2-ter)

1. Las 10 filas que la bloquean **no las libera nadie**: no tienen `failureCode` de liberación. La
   recuperación automática del otro árbol sólo cubre `UNKNOWN`; `CANCELLED`-sin-confirmar y `FAILED/*`
   no tienen salida. Extenderla es la siguiente fase de «Terminal atorada» y toca dinero — decisión
   pendiente del founder sobre la ventana de gracia (hay una anotada de 20 min sin su OK).
2. **POS (android + ios, juntos):** que un **409** y un **404** se lean como «no se cobró», limpien el
   pendiente local y ofrezcan reintentar. Hoy dejan la tablet sin poder vender. Riesgo del arreglo:
   ninguno — hoy convierte certezas en dudas.

### Lo que sigue faltando (sin cambios respecto a lo de arriba)

1. QA físico del circuito completo Android POS → servidor → PAX/Blumon y Nexgo/AngelPay.
2. Decidir los 3 rojos de referidos (arriba).
3. Suite completa por shards y build/typecheck de las variantes de TPV afectadas.
4. Commit/push/deploy: **nada de esto se hizo, y sigue sin autorizarse en esta tarea.**

⚠️ Nota de entorno: `~/.claude/avq-verify/forzar-dual` quedó plantado por la corrida de referidos.
Los totales de los dos lados COINCIDEN (26/196/222 y luego 3/219/222); la divergencia es el falso
positivo de orden/captura de jest ya documentado. No se retiró la bandera: sólo obliga a correr en
DUAL, que es el lado seguro.


## 2-ter. Continuación del 10-sep, tarde (sesión Claude Fable 5.1) — lo que CAMBIÓ tras la revisión de Codex

Codex contrastó §2-bis con el código (`docs/investigations/testarudo-revision-relevo-2026-09-10-codex.md`) y el
founder fijó dos límites: **no se libera una terminal por plazo + latido + ausencia de Payment** (sólo por
evidencia), y **no se repone a ciegas la guarda de referidos** (la protección contra jobs que llegan después del
reembolso se conserva). Todo lo de abajo está **sin commitear, sin push y sin deploy**, por instrucción.

### Correcciones a §2-bis (afirmaciones mías que Codex refutó)

| Decía §2-bis | Qué es cierto | Dónde |
|---|---|---|
| `tpv.schema.ts:927` es el esquema del cobro y `deviceSerialNumber` es opcional ahí | Ese esquema NO es el del cobro. El serial **no viaja en el cuerpo**: el login de TPV exige `Terminal` y el JWT lleva `terminalSerialNumber`; el controlador lo inyecta en `paymentData.deviceSerialNumber`. Por eso T10 exige identidad **acreditada** | `payment.tpv.service.ts` (2 sitios) · `terminal-payment.service.ts` `closeRowFromPaymentTx` |
| «dos worktrees se anulan» y `TERMINAL_SLOT_BLOCKED` | No demostrado; el árbol principal **no libera por tiempo a propósito**. `TERMINAL_SLOT_BLOCKED` se revirtió; la recuperación es por **evidencia de la propia terminal** (sonda) | `terminal-payment.service.ts` `SIN_DESENLACE_ACREDITADO`, `probeUnresolvedForTerminal`, `handleProbeResultFromSocket` |
| «no hay APK que instalar» | Cierto sólo para mis ediciones: la TPV tiene 29 archivos de producto sin commitear (2.9.2/107) y las terminales llevan 2.8.7 (PAX) y 2.9.1 (Nexgo) — sí hay que instalar | §«Circuito físico» abajo |
| «adb reverse 8799» es obligatorio | Los builds de depuración apuntan a ngrok por defecto; `localhost:8799` sólo si se compila con `-Pavoqado.devBaseUrl` | `app/build.gradle.kts:33-38` |

### T10 · Atribución REST por identidad ACREDITADA (cerrado)

`closeRowFromPaymentTx(tx, requestId, paymentId, venueId, reported?, source='REST', capturedBySerial?)`: la
identidad sale, en orden, de `Payment.terminal.serialNumber` → serial autenticado del llamador → `processorData.deviceSerialNumber`
persistido. **Sin identidad no se cierra** (`🚨 Refused to close a request: the Payment carries no accredited
terminal identity`); con identidad que **contradice** la terminal de la solicitud tampoco; y cuando cierra,
**persiste la procedencia** en `processorData.deviceSerialNumber`. Los dos llamadores reales pasan el serial del token.
Evidencia: integración `run-avoqado-server.fX5iV2` (49/49, PostgreSQL real, incluye el positivo con prefijo `AVQD-`
y el de ruta `recordOrderPayment`), unitarias `run-avoqado-server.I29MWA` (219/219), typecheck `run-avoqado-server.i2VNYQ`
(0 errores, local y Alienware COINCIDEN). Sabotajes en copia aislada: cada uno tumba sólo su prueba.

### T11/T12 · La terminal se recupera por EVIDENCIA, nunca por plazo (cerrado en código; hardware abajo)

- **Servidor:** capacidad `terminalPaymentProbeVersion` en el handshake (sólo con `identityVerified`); al conectar
  (tras el replay) y en cada barrido de 30 s el servidor manda `terminal:payment_probe` por cada fila
  `SIN_DESENLACE_ACREDITADO` de esa terminal (lote 25). La TPV contesta `terminal:payment_probe_result` con
  `RESOLVED` (replay del desenlace durable) · `RECEIVED_CANCELLED` (cancelación con `PRE_AUTHORIZATION`) · `ACTIVE`
  (se conserva) · `NOT_FOUND`. 🔴 `NOT_FOUND` **sólo libera** (`FAILED/TPV_NEVER_RECEIVED`) si la fila **nunca fue
  ACK-eada** (`acknowledgedAt` null) y no está en vuelo; con ACK es una **contradicción** (`🚨 Probe contradiction`,
  `TERMINAL_PAYMENT_PROBE_CONTRADICTION`) y **no se libera**. Bitácora `TERMINAL_PAYMENT_PROBE_RESOLVED/RELEASED`.
- **TPV:** `RemotePaymentInbox.probe()` responde desde la bandeja Room **sin entregar** nada; `SocketManager` declara
  `terminalPaymentProbeVersion=1`, escucha `terminal:payment_probe` y reemite el resultado persistido.
- Evidencia: integración `run-avoqado-server.fX5iV2` (describe «Sonda de conciliación», 6 pruebas: liberación sólo con
  evidencia, `NOT_FOUND` con/sin ACK, `ACTIVE`, terminal ajena, puerta por versión); TPV `run-avoqado-tpv.HI36r8` y
  `run-avoqado-tpv.m7ploe` (`RemotePaymentInboxTest` 11, `RemotePaymentInboxRoomTest` 16, `SocketManagerTest` 25,
  `PaymentViewModelKernelDurabilityTest` 8) y `run-avoqado-tpv.bDC62x` (`compileProductionDebugKotlin` exit 0).
- **Costo medido (base local, 141 filas, índice `(terminalId,status)`):** la consulta de la sonda por terminal ejecuta en
  **0.097 ms** (EXPLAIN ANALYZE, 15 filas casan, 126 descartadas) y **1.78 ms** ida y vuelta desde Node.

### T13 · Contactless conducido por el ViewModel (cerrado)

`PaymentViewModelKernelDurabilityTest`: rechazo explícito (`RESULT_OFFLINE_DENIED`) y resultado desconocido
(`RESULT_TRY_AGAIN`) **conducidos por el ViewModel**, no por el arnés; helper `esperarA` que alterna el reloj virtual y
`Dispatchers.IO`; la prueba «alta nunca termina» corregida con nota fechada. 8/8 (`run-avoqado-tpv.HI36r8`).

### T14 · Referidos: 26 → 3 → 0, sin perder la protección contra jobs tardíos (cerrado)

`revertReferralRewardForOrder` pre-comprueba **fuera** de la transacción si existe un referido `PENDING|QUALIFIED`
para la orden y sólo entonces abre la transacción con `FOR UPDATE`; `onOrderPaid` sigue anulando los `PENDING` de
órdenes reembolsadas (`voidReason: 'ORDER_REFUNDED'`). Las 3 pruebas rojas eran fixtures con estado incoherente
(`$queryRaw` sin declarar, `payment.findMany` sin default, cancelación sin referido vivo) y se corrigieron **sin
debilitarlas**. `run-avoqado-server.QVv82u`: 223/223. **Latencia** (bench contra la base de pruebas,
`$CLAUDE_JOB_DIR/tmp/bench-referral-hook.ts`): venta SIN referido 0.28 ms p50 / 0.59 ms p90 (antes 2.3 / 4.56 ms
con el lock de fila) — el hook cuesta ~8× menos en el caso común.

### T15 · POS (Android + iOS): un 409 `TERMINAL_BUSY` al CREAR no es incertidumbre — correlacionado por request (cerrado en código)

**Regla** (`CardChargeDecision.refusedForAnotherRequest`, espejo exacto en Kotlin y Swift): sólo si el 409 trae
`code: 'TERMINAL_BUSY'` **y** `blockingRequest.requestId` **distinto del mío** se concluye que este intento nunca se
creó — el servidor sólo lanza `TerminalBusyError` cuando la fila de ese `requestId` no existe (si existe hace replay,
`isPrismaUniqueViolation`). Entonces se **libera la llave durable** y se dice «Terminal ocupada: otro cobro de $X hace
N min (aparato). Este cobro NO se envió a la terminal, no se cobró nada…». Un `TERMINAL_BUSY` que nombre a **mi**
solicitud, o sin solicitud nombrada (server viejo), y cualquier 409/404 sin código **siguen mandando a consultar el
estado** (la regla del 2026-08-10 no se toca). Un cancel no lo cambia (nada se creó). iOS conserva `code`/`blockingRequest`
del 4xx del POST vía `preserveBusinessErrorPayload` (`APIBusinessError.blockingRequest`); el GET del estado no lo usa.
De paso: el aviso «Quedó un cobro sin confirmar de una venta anterior…» ya no repite la instrucción (prefijo + mensaje).

- Android: RED `run-avoqado-android.Og1CcJ` (126 pruebas, 9 fallan por la razón correcta) → GREEN `run-avoqado-android.vaCRB7`
  (`CardChargeDecisionTest` 39/0 · `TerminalPaymentServiceHttpTest` 34/0 · `PaymentFlowViewModelTest` 53/0, por XML).
  **Sabotajes en copia aislada: 4/4 cazados exactamente** (sin correlación → 3 caen; sin comparar con MI requestId → 2;
  sin liberar la llave → 2; frase repetida → 1). `CHANGELOG.md` actualizado.
- iOS: RED `run-avoqado-ios.BgJ196` (9 fallan / 40 pasan) → GREEN `run-avoqado-ios.lYc6sc` (`** TEST SUCCEEDED **`,
  73 pruebas en 3 clases, 12 nuevas). **Sabotajes en copia aislada: 4/4 cazados exactamente** (sin correlación → 2 caen;
  sin comparar con MI requestId → 2; sin liberar la llave → 1 (`XCTAssertNil` con la llave armada); frase repetida → 1).
- ⚠️ Límite declarado: el `preserveBusinessErrorPayload: true` del POST de iOS no lo ejercita ninguna unitaria (el
  transporte inyectado salta `APIClient`); lo cubre la prueba de parseo de `APIBusinessError` y el QA en aparato.

### T17 · Latencia, medida (no adjetivos)

| Tramo | Medición | Método |
|---|---|---|
| Hook de referidos en `recordPayment` (venta sin referido) | 0.28 ms p50 / 0.59 ms p90 (antes 2.3 / 4.56) | bench contra la base de pruebas, rollback |
| Consulta de la sonda por terminal (barrido 30 s + conexión) | 0.097 ms ejecución · 1.78 ms ida y vuelta | EXPLAIN ANALYZE + 20 ejecuciones, base local |
| `closeRowFromPaymentTx` (cierre por REST) | HEAD p50 0.9–1.6 ms → árbol actual p50 8.2–9.2 ms, p90 ~20 ms (N=200 ×2, **load 139**) | mismo arnés que el reproductor de Codex (compila el método real), rollback |

El delta del cierre por REST es de **todo el WIP del relevo**, no sólo de T10: HEAD hacía 2 operaciones (findFirst +
update) y ahora son 6 (`FOR UPDATE` del Payment, `findFirst` del Payment **con relación `terminal`**, `findFirst` de
reclamo cruzado, sello de procedencia). T10 añadió sólo la relación y el sello. Contra el p95 de **705–824 ms** del
endpoint completo medido el 7/8-sep, son ~1 %. ⬜ Falta la medición end-to-end de `POST …/terminal-payment` y
`POST /tpv/payments` durante el circuito físico (líneas `Request End … [Nms]` del log).

### Circuito físico (T16) — estado

Aparatos hoy: Sunmi OrderPAD_3 (POS `com.avoqado.pos.dev` 2.18.3-dev, sin T15) · PAX A910S 2841548417 (2.8.7-sandbox,
sin sonda) · Nexgo N86 (2.9.1-nexgo, sin sonda) · server local `:3000` + ngrok con sonda y T10.
Base local: **19 filas** con el slot de la PAX tomado; la sonda alcanza 15 (`SIN_DESENLACE_ACREDITADO`): 14 sin ACK
(julio, QA) que puede liberar como `TPV_NEVER_RECEIVED`, y 1 `CANCELLED` del 8-sep **con ACK** que sólo se resuelve si
la bandeja Room de la PAX conserva esa fila; las 4 `FAILED/QA_*` no bloquean (su `failureCode` no está en la lista).
Compatibilidad cliente viejo: con la PAX 2.8.7 conectada, el log no muestra **ninguna** sonda (puerta por versión).
**Hecho a las 15:00–15:25 (10-sep):**

- **APK construidos desde el árbol actual e instalados con `install -r`** (misma huella `c27a1420…` ⇒ actualiza sin
  desinstalar, conserva Room): PAX `2.9.2-sandbox` (`run-avoqado-tpv.LM2Icr`, `API_BASE_URL_DEV=http://localhost:8799`,
  `adb reverse tcp:8799 tcp:3000`), Nexgo `2.9.2-nexgo` (`ENABLE_PAX_SDK=false`), POS Sunmi `2.18.3-dev` (`run-avoqado-android.*`,
  ngrok). Copias en `$CLAUDE_JOB_DIR/tmp/apk/`.
- 🟢 **La sonda liberó la PAX en su PRIMERA conexión, con evidencia de la propia terminal** (15:01:52): 15 sondas
  enviadas, 15 respuestas; **14 filas de julio → `FAILED/TPV_NEVER_RECEIVED`** (nunca ACK-eadas; la PAX no las tiene
  en su bandeja) con 14 entradas `TERMINAL_PAYMENT_PROBE_RELEASED`. Logcat de la PAX: 15 × «Terminal payment probe
  received». La N86 conectó a las 15:10 sin filas que sondear (0). Con la PAX **vieja** (2.8.7) conectada antes de
  la actualización, **cero** sondas en el log: la puerta por versión funciona.
- 🟡 **La fila del 8-sep (`b71ae21c`) NO se liberó, y es correcto:** la bandeja Room de la PAX 2.8.7 (`remote_payment_requests`,
  que YA existía en ese APK) la tiene `RESOLVED` con `{"status":"cancelled","errorMessage":"Pago cancelado en la terminal",
  "completedAt":"2026-09-08T15:55:31.709Z"}` — **sin `outcomeEvidence`** (formato anterior), y la libreta `payment_attempts`
  no tiene ese intento (sus 10 filas empiezan a las 10:26 de ese día). Es evidencia «clase B».
- 🔴 **Defecto encontrado y CERRADO con TDD en el servidor:** esa respuesta sin evidencia pasaba por `closeRow`, movía
  la fila `CANCELLED → UNKNOWN` **en silencio**, y el barrido la volvía a «reconciliar» **cada 30 s** con dos avisos
  engañosos («Late result reconciled a stale row») y sin una sola entrada de auditoría. Ahora `handleProbeResultFromSocket`
  **no reconcilia** una respuesta sin evidencia acreditada: conserva la fila tal cual, escribe **una** entrada
  `TERMINAL_PAYMENT_PROBE_UNACCREDITED` con lo que la terminal guardó (`terminalOutcome`), y no vuelve a sondear esa
  solicitud en 15 min (`PROBE_UNACCREDITED_BACKOFF_MS`; un reinicio la pregunta una vez). RED contra Postgres
  (`Expected "CANCELLED", Received "UNKNOWN"`, `run-avoqado-server.vtwMUq`) → GREEN 50/50 (`run-avoqado-server.HRg259`);
  unitarias del área 116/116 local y Alienware COINCIDEN (`run-avoqado-server.g5ljnW`); typecheck del server **0 errores**,
  local y Alienware COINCIDEN (`run-avoqado-server.waUwxN`). Verificado en vivo: 1 entrada
  UNACCREDITED en la base de desarrollo y **silencio** en el log desde 15:16:39. ⚠️ La TPV además reemite el resultado
  persistido por el canal normal (`terminal:payment_result`), que sigue pasando por `closeRow` una vez por respuesta —
  con el backoff ya no se repite; queda anotado.
- 🔴 **`releaseUnknownRequest` NO libera en este árbol:** termina en `logger.warn('Release awaits execution
  confirmation')` y devuelve `released:false` (quedó así al retirar la liberación por tiempo). Probado con la fila
  `b71ae21c` (UNKNOWN): `¿PAX ocupada? true`. **No existe hoy un camino de operador**, ni por MCP ni por superadmin ni
  por móvil: los tres llaman a esta función.
- 🟢 **T15 visto en hardware, a medias:** la Sunmi (POS nuevo) muestra «Cobro anterior sin confirmar · Quedó un cobro sin
  confirmar de una venta anterior. Estamos confirmando el cobro. No vuelvas a pasar la tarjeta.» — **una sola vez** (la
  frase repetida desapareció). Pero es la **llave vieja** `39b349ef…` armada esta mañana por el APK anterior con el 409
  (sobrevive al `install -r`): «Volver a consultar» da `GET … 404` ×3 («No existe una solicitud de cobro con ese
  identificador») y la app concluye «indeterminado». **La tablet sigue sin poder cobrar con tarjeta por el residuo del
  defecto viejo**, así que el 409 nuevo (T15) y el circuito POS→terminal no se pudieron ejercitar desde ella.

🔴 **Hallazgo en hardware (16:10) — la LIBRETA de la TPV del árbol tiene un candado sin salida (WIP de otra sesión,
NO está en la versión publicada; `git show HEAD:…/PaymentAttemptDao.kt` no lo tiene):** con el APK compilado desde el
árbol, la Nexgo rechazó abrir el cobro de $10 («terminal reservada — entrada al procesador rechazada», pantalla «Error
en el pago… No se inició otro cobro») sin llegar a pedir tarjeta. `PaymentAttemptDao.reserveTerminal` niega la reserva
si existe **cualquier** fila en `PREPARANDO/KERNEL_ACTIVO/AUTORIZANDO/INDETERMINADO/HOST_RESPONDIO/AUTORIZADO/REGISTRO_FALLIDO`
— **sin cota de tiempo y sin filtro por venue ni terminal**. En la N86 la bloquea `30a673df` (REFUND del 7-sep en
`HOST_RESPONDIO`, cuyo `pending_refunds` está `SUCCESS`: el reembolso sí se registró y nadie cerró su fila); en la PAX,
2 `PREPARANDO` del 8-sep (abandonados antes del kernel), 1 `INDETERMINADO` REFUND y 1 `INDETERMINADO` SALE del 9-sep
(Blumon no tiene verificador ⇒ nunca se resuelve). Tres defectos para el dueño de ese WIP: (a) una fila `PREPARANDO`
o `HOST_RESPONDIO` vieja reserva la terminal **para siempre** y no hay salida manual; (b) el reembolso encolado no
cierra su fila de la libreta al sincronizar; (c) 🔴 `LedgerApprovalRecovery` toma `HOST_RESPONDIO` de **cualquier
`kind`** y llama `fast/order.recordPayment` — si el contexto de un REFUND llegara a parsear, **registraría una VENTA**
por un reembolso (hoy falla en `restoreContext` por suerte: `verify_attempts=3`). Para el circuito de hoy se compiló
la Nexgo desde **HEAD** (sin ese candado) en un worktree aparte.

🟢 **Nexgo · contactless en vivo (16:20, versión publicada compilada desde HEAD en un worktree, `run-avoqado-tpv.fyUryP`):**
«Pago rápido» $10.00 → AngelPay QA aprobó (auth `103520`, MASTERCARD) → `POST /api/v1/tpv/venues/…/fast → 201` en
**334 ms** (server) / 429 ms ida y vuelta (aparato, por `adb reverse` USB) → `Payment cmtw37hb1…` **COMPLETED $10.00**,
`source TPV`, ligado a `AVQD-N860W173397` y con `processorData.deviceSerialNumber = AVQD-N860W173397` (T10: la identidad
del JWT persiste al crear). Libreta: AUTORIZADO → REGISTRADO; QR del recibo en pantalla. **Sin tarjeta a tiempo** (2ª
ronda): AngelPay agotó la espera (`SDK U101`, ~36 s), la libreta marcó `DESCARTADA`, ticket de rechazo impreso, terminal
libre — limpio. 🟢 **Chip (16:36):** PIN offline validado (`OFFLINE_PIN_CORRECT`, CVM `EMV_CVMR_OFFLINEPIN_ENCIPHER`), aprobado
(auth `721770`) → `POST …/fast → 201` en **268 ms** (server) / 296 ms (aparato) → `Payment cmtw3sjsp…` **COMPLETED $10.00**,
terminal `AVQD-N860W173397`, procedencia persistida; libreta AUTORIZADO → REGISTRADO.

🟢 **PAX · contactless en vivo (17:21, misma versión HEAD por ngrok, app sandbox, PAX A910S `2841548417`):** el
flujo lo condujo esta sesión por adb (Pago rápido → $10 → sin calificación → sin propina → cuenta A `SN 2841548417` →
«Tarjeta» a las 17:20:55) y el founder acercó la tarjeta. **Aprobado a la primera.** Libreta Room de la PAX
(`payment_attempts`): intento `ac9aef58…` BLUMON · SALE · **REGISTRADO** (`state_version` 4) · 1000 ¢ · FAST ·
`operation_id 81919` · ref `832547942824` · auth `O4BNRD` · `host_approved 1` · `512912******000F` MASTERCARD
CONTACTLESS · creado 23:20:55.816 UTC → registrado 23:21:04.292 UTC (**8.5 s** del toque al registro, incluida la
inicialización del SDK). Servidor: `POST /api/v1/tpv/venues/…/fast → 201` en **192 ms** con `terminalSerial:
'AVQD-2841548417'` tomado del JWT (`correlationId 1fd5ed01…`). Postgres: `Payment cmtw5i86y001fc9pjswhamq9w`
**COMPLETED $10.00**, `CREDIT_CARD`, `source TPV`, `terminal AVQD-2841548417`, `processorData.deviceSerialNumber =
AVQD-2841548417` (T10: la procedencia persiste al crear), `merchantAccountId cmpe64xca…` (cuenta A) y
`idempotencyKey = ac9aef58…` — la MISMA llave que el intento de la libreta. Con esto las dos terminales aprobaron en
hardware con la versión HEAD: Nexgo (contactless y chip) y PAX (contactless).
⚠️ La misma libreta conserva un intento **INDETERMINADO** del 9-sep (`76226b8d…`, $10.06, cuenta `cmq850h9e…`, sin
`operation_id`): con el WIP del árbol (`PaymentAttemptDao.reserveTerminal` rechaza si existe CUALQUIER fila en
PREPARANDO/…/INDETERMINADO, sin cota de tiempo ni de venue) esa fila habría bloqueado este cobro con «terminal
reservada», como ya pasó en la Nexgo por la tarde. Es el defecto (a) del bloqueo de libreta, ahora con un caso concreto.

🔴 **PAX · reembolso (17:52): rechazado por Blumon ANTES de mover dinero, y es un problema previo, no de esta tanda.**
El founder tocó «Procesar Reembolso» sobre el cobro de las 17:21 (el modo automático no me deja tocar botones que mueven
dinero, y está bien así), eligió motivo y acercó la tarjeta (PICC, contactless). El preflight del SDK
`POST sandbox-core.blumonpay.net/device/validateCancelation` contestó `{"status":false, error:{httpStatusCode:409,
code:"TX_024", description:"TIEMPO EXCEDIDO PARA REALIZAR CANCELACIÓN"}}` (704 ms) y la app mostró «Esta transacción no
puede ser cancelada…». **Ni `CancelIcc` ni el servidor llegaron a ejecutarse**: 0 líneas de refund en el log local, 0
filas `REFUND` en Postgres. 🔑 **Es un defecto conocido y sin causa desde el 15-jul**: el comentario en
`avoqado-tpv/app/src/sandbox/…/PaymentViewModel.kt` (PASO 0, ~línea 5343) dice que el TX_024 sigue saliendo **a los 28 s
y a los 2.5 min** de la venta, que el tiempo no es la causa y que **ningún reembolso Blumon se ha verificado exitoso ni en
sandbox ni en producción**, pendiente de respuesta de Blumon; `CHANGELOG-archive-4.md:21` refutó la teoría de la
«ventana de tiempo». El founder lo confirmó en vivo («era un error ya desde antes… no sé si esa afiliación de prueba
tiene reembolsos configurados»). Por eso NO se gastó un cobro nuevo para reconfirmarlo. ⬜ El escenario «reembolso en la
PAX» del circuito queda **bloqueado por el procesador**, no por nuestro código — se cierra cuando Blumon conteste.
🔴 **Lo que SÍ es nuestro, encontrado al mirar la libreta:** el intento `6b5d2de1…` (`kind REFUND`) quedó en
**AUTORIZANDO** (`state_version 1`, sin `last_error`) y nadie lo cerró. Secuencia en el código sandbox (HEAD 2.9.2):
`markAuthorizing(refundAttemptId)` en la «barrera pre-SDK» (~4393) corre ANTES del preflight (PASO 0, ~5340), y la rama
de fallo del preflight devuelve `RefundAuthorizationResult(userFriendlyError=…)` (~5375) **sin tocar la libreta**. En HEAD
sólo es una fila mentirosa («autorizando» un reembolso que Blumon rechazó); con el WIP del árbol
(`reserveTerminal` rechaza ante CUALQUIER fila en AUTORIZANDO) **cada reembolso rechazado por TX_024 dejaría la terminal
«reservada» para siempre**, y `LedgerApprovalRecovery`/`LedgerUnknownRecovery` intentarían «recuperar» un reembolso
que nunca ocurrió. Es el defecto (a) del bloqueo de libreta con un segundo caso concreto, y pide su propio arreglo:
un preflight rechazado debe cerrar la fila (DESCARTADA con `last_error = TX_024`). No se tocó código: es camino del
dinero y el árbol tiene WIP ajeno en ese archivo.
⚠️ Tres P3 vistos de paso en la PAX 2.9.2: (1) «Historial de pagos» muestra **18:21** para el cobro de las 17:21 (+1 h;
aparato en `America/Chihuahua`, venue en `America/Mexico_City`, ninguna de las dos da UTC−5 — revisar el formateo de
esa lista, regla 18 del repo); (2) los dos cobros de la Nexgo salen etiquetados «PAX·Blumon»; (3) en el build
sandbox/debug el interceptor de OkHttp imprime el `Authorization: Bearer …` completo en logcat — confirmar que en
release no.

🔴 **TABLET → NEXGO (18:05–18:15): el caso de Testarudo, reproducido con la versión PUBLICADA y con evidencia en las tres
capas.** Prerrequisito: la Sunmi estaba trabada por la llave huérfana `39b349ef-4cdc-4ffe-8167-bc93e6451d01` (409 al crear
con el APK viejo; nunca existió en el servidor; `GET` 404 ×3). Se desbloqueó **por el camino normal de la app, sin cerrar
sesión**: se insertó en la base LOCAL una fila `FAILED / QA_MANUAL_RESOLVE_NO_MONEY` para ese `requestId` (precedente de
julio; `senderDevice` explica el motivo) → «Volver a consultar» → `GET … 200` (18:05:46) → «Cobro anterior resuelto: el
cobro anterior no se realizó» → llave liberada. Después: Cobrar $50.00 (importe personalizado que ya estaba en el carrito)
→ «Cobrar con terminal» → selector con las dos terminales «Conectada» (N86 y PAX; **no dice «ocupada»**: la fase 3 del
selector no está construida) → N86.
1. 18:07:07 `POST /terminal-payment` → «Sending payment request» → **18:07:08 `Durable ACK` de la N86** (socket
   `zCBf5uZg…`). 🔑 En ese momento la N86 mostraba el banner rojo «No se pudo conectar»: su latido HTTP fallaba
   (`ECONNREFUSED localhost:8799`, el túnel `adb reverse` se perdió al pasar el cable USB a la PAX) pero el **socket ya
   abierto sobrevivió** y por ahí entró el cobro. **El banner y el canal de cobros son dos cosas distintas**: puede decir
   «desconectada» y llegar cobros, y al revés (la PAX dormida decía «conectada» y no recibía nada).
2. El founder dio **atrás en la Nexgo**. La bandeja de la N86 (`remote_payment_requests`) quedó `RESOLVED` con
   `{"status":"cancelled","errorMessage":"Pago cancelado en la terminal"}` **sin `outcomeEvidence`** (el APK publicado no
   la manda). 18:09:11 el servidor recibió ese resultado y, por diseño (`terminal-payment.service.ts:937-938`: cancelado
   sin evidencia acreditada ⇒ se degrada a `timeout`), **no liberó**: fila `5add2e44` → **UNKNOWN**, `resultJson.status
   = timeout`, el `POST` de la tablet terminó **504 a los 123.9 s** y la tablet pasó a «Cobro sin confirmar. Estamos
   confirmando el cobro. No vuelvas a pasar la tarjeta» (llave durable armada).
3. 18:14 se restableció el túnel USB; la N86 reconectó (latido HTTP en la base) y el vigía anotó
   `terminalReturnedAt = 18:15:08`. **No hubo sonda**: el APK HEAD/2.9.2 no declara `terminalPaymentProbeVersion` (sólo el
   árbol de trabajo lo hace, `SocketManager.kt:214`), así que el servidor no tiene a quién preguntar. **La Nexgo queda
   «reservada» hasta una liberación manual** — y `releaseUnknownRequest` es no-op en este árbol.
🔑 **Lectura:** es exactamente el P1-1/P1-2 de la auditoría, ahora medido en hardware con la app en la calle: con el
servidor nuevo, un «cancelar en la terminal» de un APK viejo bloquea la terminal hasta que una persona la libere. Las
salidas son decisión del founder: (a) desplegar el APK con `outcomeEvidence` + sonda (el árbol) — el caso se resuelve
solo; (b) mientras tanto, liberación manual clase B con efecto real; (c) NO volver a aceptar «cancelado» sin evidencia
como «no cobró» (es la regla del cobro doble del 2026-08-10).
⚠️ Nada se ha liberado: `5add2e44` (N86) y `b71ae21c` (PAX, 8-sep) siguen bloqueando sus terminales en la base local.

🟢 **TABLET → PAX (18:20–18:25): el circuito completo, aprobado, con la atribución T10 por el camino de SOCKET.** Tras
liberar `5add2e44` y `b71ae21c` como **clase B** (decisión delegada por el founder: «lo que tú decidas»; UPDATE a
`FAILED/QA_MANUAL_RESOLVE_NO_MONEY` + dos asientos `TERMINAL_PAYMENT_MANUAL_RELEASE` en `ActivityLog` con la evidencia;
ambas sin `paymentId`, sin orden y sin Payment por solicitud — 0 bloqueadores después), la tablet soltó su «cobro sin
confirmar» con «Volver a consultar» y volvió sola al selector. Selector → «Debug 2841548417» → 18:21:10 `POST` →
**ACK de la PAX en 250 ms** (socket `A1tPeoc…`) → bandeja Room `PROCESSING` → la PAX navegó a la pantalla de pago
(`PaymentScreen COMPOSED` 18:21:10.289, `source=SOCKET`, $50.00). Paso 3 en la PAX (cuenta A + «Tarjeta») → contactless
MASTERCARD → 18:25:40 `POST …/fast → 201` en **402 ms** → `terminal:payment_result` → **la solicitud cerró COMPLETED con
`paymentId cmtw7tauq0028c9pjzeq0nrhz`** y el `POST` de la tablet terminó **200 a los 270 s** (esperó hasta el desenlace;
`expiresAt` era 18:26:10). Postgres: `Payment cmtw7tauq…` COMPLETED $50.00 `CREDIT_CARD`/`TPV`, `terminal AVQD-2841548417`,
`processorData.deviceSerialNumber = AVQD-2841548417`, `processorData.terminalPaymentRequestId = e48e23fd…`,
`idempotencyKey = 69c27497…` (= `attempt_id` de la libreta), `orderId cmtw7tauc…`. Libreta PAX: `69c27497…` SALE
**REGISTRADO**, `operation_id 81920`, auth `6U6484`, CONTACTLESS, 18 s del toque al registro. Bandeja: `e48e23fd`
`RESOLVED` con `status success` y el mismo `paymentId`. Tablet: pantalla de recibo «$50.00 · Tarjeta».
⚠️ **Trampa de QA (mía, no del producto):** entre medias la PAX mostraba el inicio aunque su log decía que la pantalla
de pago se había compuesto. Había **dos instancias de `MainActivity` en la misma tarea** (`Hist #0` STOPPED con el cobro,
`Hist #1` RESUMED en el inicio): mi segundo `am start -n …MainActivity` desde adb apiló una nueva porque el manifiesto
no fija `launchMode`. Un `BACK` destapó la de abajo con el cobro intacto. **No usar `am start` sobre la TPV ya abierta;
traer la tarea al frente** (`am start` con la app en primer plano no apila; con otra app encima, sí).
⚠️ Corrección al bloque del reembolso: la fila `6b5d2de1…` (REFUND) no se quedó en AUTORIZANDO para siempre — a las
18:04 el barrido de la libreta la pasó a **INDETERMINADO**. Sigue siendo mentira (Blumon rechazó el preflight y no hubo
dinero) y sigue siendo bloqueadora para el candado del árbol.

🔴 **CANCELAR DESDE LA TABLET con la PAX esperando tarjeta (18:32–18:34): el gesto diario del cajero deja la terminal
reservada con el APK publicado.** Venta $50 → PAX (`8019de4a`, ACK) → en la PAX cuenta A + «Tarjeta» → «Acerca o inserta la
tarjeta» (18:32:47; el founder NO pasó tarjeta) → 18:33:11 «Cancelar» en la tablet → `POST /cancel → 200` en 15 ms,
«Sending cancel to terminal», y el `POST` de cobro terminó **504 a los 30 s**. **La PAX obedeció al instante**
(`Terminal payment cancel received` → `Cancelling payment … (matches current)` → `navigating to Home`; bandeja Room
`RESOLVED` con `{"status":"cancelled","errorMessage":"Cancelado por el POS antes de iniciar el cobro"}`). Pero **el APK
publicado no le dice nada al servidor**: `RemotePaymentCoordinator.cancelSocketPaymentRequest` (HEAD) sólo marca su
bandeja; **cero eventos** de la PAX en el log del servidor tras el cancel. El servidor sólo marca `cancelDisposition =
ACCEPTED` si la terminal contesta — y eso lo hace **únicamente el árbol de trabajo** (`SocketManager.kt:1589-1592` emite
`terminal:payment_cancel_disposition` con la decisión de la bandeja, T12/T13). Sin respuesta, el vigía pasa
`CANCEL_REQUESTED` → **UNKNOWN / TIMED_OUT a los 30 s** (`CANCEL_GRACE_MS`, 18:34:08) con 🚨 y correo de ops ⇒ **PAX
reservada**. La tablet hizo lo correcto: 3 `GET` (`CANCEL_REQUESTED`, `inProgress`) → «Desenlace indeterminado» → «Se
canceló, pero el cobro no consta como no cobrado» → llave durable conservada (la regla del 2026-08-10) y volvió a la
pantalla de cobro. Liberada como clase B (`qa_release_8019de4a`, decisión delegada); la tablet la soltó por su camino
normal («Volver a consultar» → «El cobro anterior no se realizó»).
🔑 **Es el P1-1/P1-2 en su forma más frecuente: no hace falta un rechazo del banco ni que la PAX se duerma — basta que
el cajero cancele desde la tablet.** Con el servidor nuevo y los APK de la calle, cada cancelación reserva la terminal
hasta una liberación manual (hoy no-op). La salida está construida en el árbol (disposición del cancel + sonda +
`outcomeEvidence`), así que la decisión es **APK primero** (o el servidor tolera a los APK viejos con una regla acotada
que el founder aún no ha autorizado). ⚠️ En producción HOY (servidor viejo), esta misma cancelación deja la fila en
`CANCELLED` sin disposición: hay que medir cuántas de esas hay antes de desplegar (P1-2: «filas históricas que se vuelven
bloqueadores»).
⚠️ Tercer caso concreto del bloqueo de libreta: el intento de la PAX `2c98fe18…` (SALE) quedó en **PREPARANDO** al
abortar la lectura (`JobCancellationException` en `continuePaymentFlow`) y nadie lo cerró — con el candado del árbol,
cancelar desde la tablet dejaría además la PAX «reservada» en LOCAL.
⚠️ P2 de la tablet vista de paso: tras el cancel la venta vuelve al carrito, pero el selector de terminales no muestra
«ocupada» aunque la PAX ya esté reservada (fase 3 del selector sin construir) — el cajero descubre el bloqueo al enviar.

🔴 **REGLA NUEVA (founder, 18:45): la terminal NO está en una pantalla fija.** «Hay mil situaciones donde la TPV puede
estar en una pantalla o estado específico y no sabemos si, si lo mandamos de POS → TPV, vaya a romper algo, deje algo
huérfano o haya falsos positivos.» Escrita en `avoqado-tpv/.claude/rules/cobro-remoto-pos-a-tpv.md` (matriz «estado de
la terminal × evento», prioridades en su orden —el cobro pasa y no es lento · nunca doble ni perdido · registro correcto
aunque tarde · nada huérfano · pantalla honesta—, lo que existe, lo medido hoy y la receta de prueba) con apuntadores en
`avoqado-android`, `avoqado-ios` y `avoqado-server/.claude/rules/`. ⬜ **La matriz está DECLARADA, no ejercitada**: hoy
sólo se cubrieron las celdas Inicio × `payment_request` (PAX y Nexgo), Inicio × cancel (PAX), y de paso Recibo, dos
instancias apiladas y Doze. Es el siguiente bloque de QA: casi todas las celdas se prueban sin tarjeta.

🔴 **CORRECCIÓN IMPORTANTE (19:10, la destapó la auditoría de Codex a la regla nueva): la liberación automática por
tiempo SÍ está en `develop` y en `main` — y CORRE EN PRODUCCIÓN.** El commit `d26bb746` («implement manual and automatic
release for stuck terminal payments», 5-sep 00:59) está en `develop`, `main`, `origin/develop` y `origin/main`; el
HEAD del servidor (`3000f3d0`) escribe `TIMED_OUT/AUTO_RELEASED` (~línea 1175) y pasa `CANCEL_REQUESTED → CANCELLED`
por gracia (~984). **Lo que NO está commiteado es el árbol de trabajo de esta tanda, que los RETIRA** (`git diff HEAD`:
−`AUTO_RELEASED`, −`TERMINAL_PAYMENT_AUTO_RELEASED`, −`MANUAL_RELEASE`; 883+/344−). Better Stack lo confirma: el
**8-sep** el vigía de producción emitió «🚨 UNKNOWN request auto-released — terminal came back with no card payment»
(1 vez) tras un «Row went UNKNOWN». Consecuencias: (1) la afirmación de este relevo y de `proyectos-por-fases.md` de
que «la recuperación automática NO está en develop; AUTO_RELEASED existe sólo como constante» describe el ÁRBOL, no lo
desplegado — corregida; (2) la decisión del founder del 10-sep («no autorizo liberar por 2/20 min + latido + ausencia
de Payment») hoy está en contra de lo que corre en producción desde el 5-sep; (3) por eso mismo, en producción las
cancelaciones desde la tablet con APK viejo NO reservan la terminal para siempre: se liberan a los 20 min por plazo,
que es justo lo que el árbol elimina. **El orden de despliegue no es «APK primero»: es una decisión con tres patas —
qué hace producción hoy (libera por plazo), qué hace el árbol (sólo por evidencia) y qué APK hay en la calle (no manda
evidencia ni contesta cancel/sonda).** Ver el apuntador del servidor en `.claude/rules/cobro-remoto-pos-a-tpv.md`.
🔴 **Regla auditada por Codex (gpt-6-astra, esfuerzo máximo, 10-sep 18:45–19:06): RECHAZADA en su primera versión con
7 P1 + 4 P2** — entre ellos: poner «rápido» por encima de «nunca doble» podía leerse como licencia para reintentar; la
tabla de reacciones permitía fabricar `PRE_AUTHORIZATION` y prometía una cola que no existe; la receta de borrar Room
destruye evidencia de dinero; «cero bloqueadores» como criterio incentiva limpiar estados legítimos; «APK primero» no es
un plan de compatibilidad; la libreta no es lineal y la recuperación de aprobaciones no filtra SALE/REFUND; el `opened`
del reembolso remoto se contesta antes de abrir nada; el servidor bloquea también POR ORDEN. Las 11 ediciones exactas se
aplicaron a los cuatro archivos (informe: `$CLAUDE_JOB_DIR/tmp/codex-audit-regla/codex-out.md`). ⚠️ **La segunda pasada
de Codex NO se completó: «Your workspace is out of credits» a los 55 s (33 k tokens)** — la aprobación final queda
pendiente de recargar créditos; mientras, una revisión interina la hace un agente Fable nuevo sin contexto.
🔑 El evento de producción del 8-sep, con detalle: Testarudo, Nexgo `n860w173400`, orden `cmtt63cab…` de $280 + $28
de propina, 15:14 CDMX `terminal-payment` emitido «once to legacy socket» (APK sin ACK durable) → el cajero reintentó
**7 veces** en 23 min y recibió «Terminal busy» cada vez → 15:19 long-poll vencido → UNKNOWN → 15:40 auto-liberada
(«terminal came back with no card payment»). No aparece un pago tardío de esa orden en el log: la liberación no produjo
doble cobro, pero costó **26 minutos de caja**. Con el árbol (sin liberación por plazo) y ese mismo APK, habría quedado
reservada hasta una liberación manual que hoy es no-op.

🔴 **Escenario nuevo del founder (19:15): «se va el internet del local pero la TPV sí tiene internet por su SIM».**
Verificado en `avoqado-android`: (1) `probeTerminalAvailability` **falla en abierto** a propósito (sin red deja «Cobrar
con terminal» habilitado; la carga del selector es la que frena con error visible); (2) `TerminalPaymentService` trata
**cualquier** excepción del POST como `NetworkError` ⇒ `mustReconcile` ⇒ GET `Unreachable` ×3 ⇒ «cobro sin confirmar»
con llave armada — **también cuando el POST nunca salió** (`ConnectException`/`UnknownHostException`); al volver la red el
GET da 404 y por diseño no libera ⇒ tablet trabada hasta resolución manual, la trampa de la Sunmi por otro pasillo;
(3) la vía de escape es «Ya pagó de otra forma → Tarjeta (otra terminal)» (`ManualPaymentMethod.CARD_EXTERNAL`), que con
la terminal cobrando por SIM produce **dos registros** de una venta en Avoqado (no doble cobro; sí doble ingreso en
reportes y corte). Los tres puntos quedaron en la regla (`cobro-remoto-pos-a-tpv.md`, fila 17 de la matriz y párrafo
«Escenario del founder») con dos pendientes: distinguir «nunca se envió» sólo por fallo de CONEXIÓN (TDD, Android+iOS
juntos) y la regla de conciliación del registro manual (decisión de producto).
**Mercado (buscado en vivo, 19:30; precedente en `.claude/rules/product-decisions-industry-reference.md`):** Square, en
su modo más parecido al nuestro (tablet + Terminal pareada por la nube, Terminal API), **no permite** mandar un cobro sin
internet en el POS y lo dice: «The Terminal API does not support offline mode»; su plan B es operar la Terminal sola con
el *device code*. Toast y Clip no separan POS y lector (un solo aparato), así que el caso no se les presenta. Conclusión:
la respuesta del founder («lo correcto es no poder mandarlo») coincide con el mercado; lo que nadie tiene es nuestra
terminal cobrando sola por SIM, y por eso el hueco que importa es que la tablet distinga «nunca se envió».

🟡 **Revisión interina de la regla (agente Fable nuevo, sin contexto, 19:25): APROBADA CON CAMBIOS** — los 11 de Codex
atendidos; 10 hallazgos más, aplicados (informe: `$CLAUDE_JOB_DIR/tmp/codex-audit-regla/fable-review.md`). **Cuatro de
ellos describen lo que el ÁRBOL de la TPV hace hoy y pesan para el despliegue:** (N1) un `payment_request` remoto sobre
una venta LOCAL que aún no cobra la abandona sin aviso (`AppNavigation.kt` sólo rechaza con cobro activo); (N2) una fila
`PROCESSING` de la bandeja sin intento en la libreta (proceso muerto entre `markProcessingForVenue` y `openAttempt`) no
tiene salida: sonda `ACTIVE` para siempre, reentrega `AckOnly`, sin barrido, `releaseUnknownRequest` no libera; 🔴 (N3)
**con el árbol, un cancel remoto sobre una ejecución reclamada NO se refleja en la pantalla de la terminal** (el flujo
`paymentCancelRequests` de HEAD se retiró; `HomeViewModel` descarta `TerminalPaymentCancel`): la PAX sigue pidiendo
tarjeta y el cliente puede pagar un cobro que el cajero ya canceló — el reverso exacto del defecto del APK publicado
medido a las 18:33; (N4) la TPV no guarda `expiresAt` y reclama al terminar `awaitInitialization()` sea cual sea la edad.
Precisiones aplicadas: `releaseUnknownRequest` concilia a COMPLETED con Payment reconciliable pero nunca libera; el
servidor ya manda `busy` en `/terminals/online` y los DTO de Android/iOS lo descartan (la fase 3 del selector es cambio
de cliente); PREPARANDO lo libera `discardStalePreparing` (> 10 min, al iniciar sesión y cada 6 h) — INDETERMINADO y
HOST_RESPONDIO no. **Segunda pasada de Codex relanzada con créditos (19:3x)** sobre esta versión + escenario SIM.

🔴 **Codex, 2ª pasada (19:24–19:43): RECHAZADA otra vez, pero ya sólo por lo nuevo.** Los 11 suyos siguen atendidos;
de los 10 de Fable, 5 atendidos y 5 necesitaban precisión (S3–S6, P2/P3). Lo de fondo (S1, P1): **mi criterio «fallo de
CONEXIÓN ⇒ nunca se envió» es inseguro** — OkHttp 4.12 reintenta y reutiliza conexiones, así que la excepción final
(`ConnectException`/DNS/TLS) puede describir un SEGUNDO intento cuando el primer POST sí salió por una conexión ya
abierta; con proxies/ngrok y HTTP/2 tampoco vale «cero bytes». «Nunca se envió» exige evidencia correlacionada de TODOS
los intentos del mismo `requestId`, no la clase de la última excepción. S2 (P1): «PROCESSING sin libreta ⇒ no hubo
autorización» sobra: el APK publicado permite seguir con la libreta apagada o tras fallar su escritura. Los seis textos
exactos quedaron pegados (informe: `codex-out-v2-rechazada.md`). ⚠️ **La 3ª pasada (19:45) murió a los 3.5 min: «out of credits» otra vez** — la 2ª a esfuerzo máximo consumió la recarga. **Veredicto final de Codex PENDIENTE de créditos**; estado de la regla: v1 (11) + Fable (10) + v2 (6) aplicados, sin aprobación formal todavía. 🟢 **Verificación interina (3ª pasada, agente Fable nuevo, ~20:00): APROBADA CON CAMBIOS** — S1–S6 pegados byte a byte y comprobados contra el código (símbolos y líneas en `codex-audit-regla/fable-review-3a-pasada.md`); 0 restos del texto peligroso; sin P1. Cinco retoques de redacción aplicados: **H1** la fila «Desenlace pendiente» leída al revés contradecía S2 (ahora: PROCESSING sin libreta también contesta ACTIVE y va a conciliación, nunca NOT_FOUND ni PRE_AUTHORIZATION); **H2** el log de precedentes del workspace (`product-decisions-industry-reference.md`, entrada del 10-sep) todavía decía «no arma la llave … por algo que nunca salió» — lo contrario de S1 — y se alineó; H3 Clip sí separa POS y lector (Bluetooth); H4 ruta del precedente (raíz del workspace); H5 encabezado con las tres pasadas. **Decisión del founder (20:45): «necesitas a codex? fable 5.1 max te sirve no? tu mismo pues» ⇒ el veredicto FINAL lo da un auditor Fable 5.1 nuevo, sin contexto y adversarial, con el encargo de la 3ª pasada ampliado al texto añadido tras el QA de la matriz; Codex queda fuera** (script `run-v3.sh` conservado por si se quiere después). 🟢 **VEREDICTO FINAL (22:12, `codex-audit-regla/fable-review-final.md`): APROBADA CON CAMBIOS, sin P1 de dinero** — S1–S6, H1–H5, #1–#11 y N1–N10 atendidos con archivo:línea; el texto del QA de la matriz verificado contra código. 9 ediciones exactas aplicadas; la de fondo (P2-1): «sin ACK ⇒ nunca recibida» sólo vale para APK con bandeja durable (≥ `68641a4`); la PAX de Testarudo (v2.8.7) no la tiene, y **la sonda hoy libera filas del camino legacy que no debería: cambio pendiente en `handleProbeResultFromSocket`**. La regla queda aprobada; los cuatro archivos siguen sin commitear.
🔑 Lección para quien construya el hueco de la SIM: la distinción «nunca salió» NO se programa mirando la excepción; hay
que instrumentar los intentos (interceptor de OkHttp / `URLSessionTaskMetrics`) y persistir «ningún byte enviado por
ninguna copia» antes de soltar la llave.

🧪 **Matriz «estado de la TPV × evento» — primer bloque ejercitado en hardware (20:03–20:20, N86 HEAD 2.9.2-nexgo, servidor del árbol, tablet Sunmi POS 2.18.3-dev, SIN tarjeta).** Cuatro celdas, cada una leída en los tres lados (pantalla + logcat de la N86, fila del servidor, log `💳` y pantalla de la tablet); las filas se liberaron clase B en la base local con asiento `qa_release_<id>` (delegado por el founder), salvo la última, que se **concilió** (ver abajo).

| Celda (estado de la N86 al llegar `payment_request`) | Qué hizo la terminal | Servidor | Tablet |
|---|---|---|---|
| **Mensajes** (estado adicional) | ACK < 1 s; abandonó Mensajes y abrió «Método de Pago» ($50, cuenta Avoqado, botones **Tarjeta / Efectivo**). HEAD NO lanza AngelPay solo: espera que el cajero toque Tarjeta. Al cancelar desde la tablet volvió al **Inicio** (no a Mensajes) | `cmtwbbja`: CANCEL_REQUESTED → **UNKNOWN/TIMED_OUT** al vencer la gracia (HEAD emite `cancelled` sin evidencia) | cancel 200 → «desenlace no consta» → consultó 3× → «desenlace indeterminado»; llave y carrito conservados |
| **9 · Cobrar con carrito abierto ($100)** | Mismo camino. 🔴 **El carrito de $100 se PERDIÓ**: al volver a entrar a Cobrar tras el cancel, «$0.00 · Cobrar» | `cmtwbioe`: igual, UNKNOWN/TIMED_OUT | igual |
| **2 · Pago rápido capturando monto ($75 tecleado)** | Mismo camino. 🔴 **El $75 tecleado se perdió** (al volver a Pago rápido, «Cantidad personalizada» vacía). Aviso del sistema «Memoria baja · sólo 100 MB» | `cmtwbpim`: igual | igual |
| **Método de Pago del remoto × el cajero toca EFECTIVO** (celda nueva, la destapó la lectura de HEAD) | «Confirmar pago en efectivo… será registrado inmediatamente» → Confirmar → recibo «Pago en efectivo · $50.00». Registró una **venta rápida propia** (`Payment cmtwbtg08…` CASH COMPLETED $50, orden `cmtwbtfzx…`, `terminalId` de la N86) y emitió `payment_result status=success` **sin decir el método** (`SocketManager.emitTerminalPaymentResult` no lleva `method`; `cardDetails=null`) | 🔴 `cmtwbsla`: el servidor **sólo cierra con tarjeta** (`closeRowFromPaymentTx` filtra `CREDIT_CARD/DEBIT_CARD`, árbol `:1056`/`:1376` **y HEAD `:1052` — producción hoy**) ⇒ degradó a `{"status":"timeout","errorMessage":"El pago sigue pendiente de confirmar en Avoqado"}` y dejó la fila **UNKNOWN** (N86 reservada) con el dinero YA cobrado y registrado | «Cobro sin confirmar… no vuelvas a pasar la tarjeta» con el carrito de $50 vivo: **un segundo registro («Ya pagó de otra forma») a un toque**. Tras conciliar a mano la fila a COMPLETED con ese Payment (asiento `qa_reconcile_<id>`), «Volver a consultar» cerró la venta con **una sola** fila de Payment (no duplicó) pero el recibo de la tablet dice **«Tarjeta»** |

| **7 · Detalle de un pago** (hoja abierta desde Pagos) | Mismo camino que Mensajes: la hoja se reemplazó por «Método de Pago» ($0.50); al cancelar, Inicio | `cmtwbzdt`: UNKNOWN/TIMED_OUT | igual |
| **8 · Reembolso: motivo** | ⛔ **NO EJECUTADA**: llegar a «motivo» exige tocar «Procesar Reembolso» en el detalle de un cobro AngelPay, botón de dinero (reembolso real en el QA de AngelPay) que sólo toca el founder. Pendiente con él: «PORFAVOR TOCA "PROCESAR REEMBOLSO" Y DETENTE EN LA PANTALLA DEL MOTIVO» | — | — |
| **3 · Calificación (venta LOCAL en curso, $100 tecleados y ✓)** | 🔴 **Comportamiento distinto: NO navegó.** `AppNavigation`: «Payment already in progress - ignoring amount» → «Sent rejection» → `payment_result status=failed` **sin evidencia**. La venta local siguió intacta en Calificación (bien) | 🔴 `cmtwc7nz`: el servidor del árbol degradó ese `failed` sin `outcomeEvidence` a `{"status":"timeout","errorMessage":"El resultado del cobro sigue pendiente de confirmar"}` ⇒ **UNKNOWN en < 1 s** (ACK 20:28:48, UNKNOWN 20:28:49): **P1-1 de la auditoría medido en hardware** — servidor del árbol + APK de la calle ⇒ cada rechazo legítimo por «ocupada» reserva la terminal | 504 al instante → status UNKNOWN → «Cobro sin confirmar… no vuelvas a pasar la tarjeta» (llave atorada por un rechazo que nunca tocó el SDK). Con el servidor HEAD (prod) ese `failed` cerraría FAILED y la tablet diría «no se cobró» |
| **13 · Pantalla apagada** (`KEYCODE_SLEEP`, por USB ⇒ sin Doze, `deviceidle ACTIVE`) | El socket entregó y la app hizo **ACK en 3 s con la pantalla apagada**; `initPayment` corrió por debajo; la terminal **NO despertó** (`mWakefulness=Asleep`) y al despertarla mostró la pantalla de bloqueo: la tablet «esperando respuesta» frente a un aparato oscuro. Contraste con Doze (PAX, sin cargar): ahí ni siquiera hay socket | `cmtwcawx`: SENT/ACK → tras el cancel UNKNOWN/TIMED_OUT | igual que las anteriores |

| **14 · Arranque en frío** (`am force-stop` + relanzar, 20:35:25) | ⚠️ **Parcial.** Línea de tiempo del aparato: proceso 20:39:36 → SDK AngelPay listo +4 s → comercios +5 s → **socket conectado +12 s** (20:39:48) → sala del venue +14 s. El socket conecta DESPUÉS de inicializar, así que por esa vía la ventana «solicitud durante la inicialización» no existe desde la tablet | En esos ~12 s el selector de la tablet dijo «No hay terminales conectadas» (no se pudo crear ninguna fila); el caso real de arranque en frío es la **reproducción** de una fila pendiente al reconectar (`replayPendingForTerminal`), que el POS no puede provocar porque no ofrece una terminal desconectada | «No hay terminales conectadas» |

🔑 **Lo que sale de esto:** (a) en HEAD, un cobro remoto **reemplaza** la pantalla de la terminal y el cancel la manda al Inicio: carrito y monto tecleado se pierden (celdas 2 y 9 acreditadas en hardware; la regla las tenía sólo inferidas del árbol); (b) **Efectivo en un cobro remoto** es un hueco de producto de punta a punta: la UI lo ofrece sin condición (`AngelPayPaymentScreen.kt:595` `showCashOption = true`), el cliente lo registra y reporta éxito, y el servidor no lo reconoce como cierre — en producción (servidor HEAD) la solicitud queda sin cerrar hasta el auto-release por plazo de `d26bb746`, con la tablet diciendo «sin confirmar» y el cajero tentado a registrar la venta otra vez; en el árbol queda reservada sin salida. Decisión de producto pendiente: ocultar Efectivo en solicitudes remotas, o aceptar CASH como cierre y decirle a la tablet el método. (c) El payload de la venta en efectivo de la N86 llevó `deviceSerialNumber: 2841548417` (serial de la PAX, cacheado en el sandbox) y el servidor lo **corrigió** con el del JWT (`AVQD-N860W173397`): T10 en hardware, por segunda vez. (e) **La celda 3 es la evidencia de despliegue que faltaba**: un rechazo explícito y legítimo de HEAD («ya hay un cobro en curso») se vuelve UNKNOWN con el servidor del árbol porque viaja sin `outcomeEvidence`; el orden «servidor del árbol primero» convierte un fallo rápido de hoy en una terminal reservada. (f) Con la pantalla apagada por USB el cobro llega y se ACK-ea sin despertar el aparato: la tablet espera contra una pantalla negra (falta despertar/encender al recibir un remoto, o avisar al POS que la terminal está dormida). (d) La PAX no apareció en el selector durante todo el bloque: dormida (`mWakefulness=Asleep`, `deviceidle IDLE_PENDING`, sin cargar) — Doze otra vez, sin latido desde las 19:10.

🔴 **INCIDENTE 20:46 — la base local de desarrollo `av-db-25` quedó VACÍA (no fue esta sesión).** Confesión del otro LLM (sesión «Plataforma comercial unificada», workflow de subagentes): un `prisma migrate diff --shadow-database-url` cuya URL «desechable» se construyó con `sed` de sintaxis GNU (`\(...\)\?`), que en macOS falla en silencio ⇒ la base sombra fue la real y Prisma la vació a las 20:46:08; dos reintentos quedaron a medias (P3016) y por eso faltaba `_prisma_migrations`. Medido desde aquí antes de la confesión: 438 tablas recreadas en el mismo segundo, sólo 3 con filas (defaults del servidor), 76 tablas `Commercial*` + 116 funciones `commercial_*` (las migraciones del worktree `commercial-p3b-reconciled-r3-20260902` replicadas en la «sombra»), cero commits ni archivos comerciales en develop (**el aislamiento de CÓDIGO sí funcionó; la BASE no está aislada: todos los worktrees apuntan a `av-db-25`**). Consecuencias: latidos de la N86 y la PAX con 404 «Terminal not found» (banners «sin conexión»), errores transitorios del servidor en los 5 s del reset, y **todas las filas de QA de hoy perdidas** (la evidencia sobrevive en este relevo y en los logs). Sin dump reciente (`av-db-25-backup` es de mayo; `av-db-25-test`, `lab` y `test_20260909` son fixtures de 233 venues sin el venue de QA). Recuperación decidida por el founder («lo que más sirva para terminar el task») y **HECHA a las 22:06**: vaciado por lotes (el `DROP SCHEMA … CASCADE` directo revienta con «out of shared memory» por los 900+ objetos), `migrate deploy` (527, 367 tablas), seed del repo y alta manual de la Nexgo `AVQD-N860W173397` en Avoqado Full (`alta-n86.sql`). 🔑 **Tres condiciones para que el seed corra hoy, ninguna documentada:** (1) `SEED_RESET=true`, si no NO limpia y choca con lo que dejó una corrida anterior (`NotificationTemplate` único); (2) `TS_NODE_TRANSPILE_ONLY=1 NODE_OPTIONS=--max-old-space-size=8192`, si no ts-node muere por heap compilando 5,779 líneas contra los tipos de Prisma; (3) **parche al seed** (`prisma/seed.ts:3906`, sin commitear): los turnos históricos con `endTime` nacen `status: 'CLOSED'`, porque el CHECK del 6-sep (`Shift_status_endTime_check`) los rechazaba. Resultado: 4 venues (Avoqado Full/Empty/Wellness + PlayTelecom), 12 staff por venue, 38 productos, 349 órdenes, 336 pagos, PAX `AVQD-2841548417` + N86. Los ids cambiaron (Avoqado Full ahora `cmtwfpana001ic996lz8q2uuq`): las sesiones guardadas en tablet y terminales caducan y hay que volver a entrar. Producción intacta. 🟢 **Aparatos de vuelta a las 22:23, por adb con autorización explícita del founder**: tablet con Main Owner (la contraseña del dueño es la del staff `role: OWNER` del seed, no la de la organización), PAX y N86 reactivadas con `Terminal.activationCode` puesto en la base local (`QAPAX1`/`QAN861`, `POST /tpv/activate` 200) y PIN de `StaffVenue.pin`; las dos ACTIVE con `activatedAt`, latidos frescos y la N86 en la sala `venue_cmtwfpana…`. Receta completa en la memoria `recuperar-base-local-y-reactivar-terminales`. Caja del negocio abierta desde la tablet ($500, 22:21) para que la PAX pueda cobrar (el venue del seed tiene turnos habilitados); la PAX la vio en su pantalla de caja pero su Inicio siguió en «Sin turno» hasta reiniciar la app (P2 conocido del 7-sep). 📝 **Nota del founder (22:33) → celda 10b de la matriz, pendiente:** «¿qué pasa si abren el turno, la TPV aún no se refresca, y la TPV hace un pago o el POS le manda uno?».

🟢 **P2-1 del auditor final, IMPLEMENTADO con TDD (22:28–22:36, sin commitear):** la sonda liberaba con `NOT_FOUND` cualquier fila «sin ACK», incluidas las entregadas a un socket **legacy** (APK sin bandeja ni acuse, p. ej. PAX 2.8.7), donde «no la tengo» tras actualizar el APK no acredita nada. Cambio en `terminal-payment.service.ts`: (a) la rama legacy de `sendPaymentToTerminal` persiste `lastDeliveredAt` + `deliveryAttempts` **sin** `acknowledgedAt` (firma de la entrega sin acuse; antes no dejaba rastro); (b) `handleProbeResultFromSocket` trae `lastDeliveredAt` en su `select` y, ante NOT_FOUND sobre ese rastro, conserva la reserva, audita UNA vez `TERMINAL_PAYMENT_PROBE_UNACCREDITED` con `evidence: NOT_FOUND_AFTER_LEGACY_DELIVERY` (mismo mecanismo de «una vez por proceso + bitácora» y backoff de 15 min que la respuesta sin evidencia) y no libera; el `updateMany` de liberación exige además `lastDeliveredAt: null`. Pruebas: 2 nuevas en `terminalPaymentRecovery.integration.test.ts` (RED confirmado: 2 fallaban, 51 pasaban; GREEN 53/53 contra `codex_testarudo_test_20260909`, migrada a 527). 🔑 Lo que costó: el `select` del manejador no traía `lastDeliveredAt`, así que la guarda del `where` ya impedía liberar pero la auditoría nunca corría — sólo se vio con una traza dentro del servicio, porque la prueba aislada pasaba y con cualquier prueba previa fallaba. Sabotajes en copia aislada (`wt-server-sab`, borrada): quitar la rama de la sonda tumba sólo la prueba A; quitar el rastro legacy tumba sólo la B. Typecheck por avq-verify (`run-avoqado-server.3sgP7Z`): `errores TS: 0`, local y Alienware **COINCIDEN**.

🧪 **Matriz — segundo bloque, PAX A910S HEAD 2.9.2-sandbox (Blumon sandbox), 22:48–23:14, SIN tarjeta, tras la reconstrucción de la base** (Doze desactivado sólo durante el bloque y reactivado al final; filas liberadas clase B con asiento `qa_release_<id>` de un ayudante con valores explícitos, porque los asientos-plantilla se fueron con la base).

| Celda (PAX) | Terminal | Servidor | Tablet |
|---|---|---|---|
| **9 · Cobrar con carrito ($1.00; su teclado cuenta centavos)** | ACK 2 s; abrió «Seleccionar Cuenta · Paso 3 de 3 · $50» con **Tarjeta / Efectivo** (el SDK no arranca solo; Efectivo ofrecido igual que en la Nexgo). Cancel ⇒ Inicio. 🔴 **Carrito PERDIDO** («$0,00») | `cmtwh7zj` UNKNOWN/TIMED_OUT | igual que en la Nexgo |
| **2 · Pago rápido con $75 tecleado** | Mismo camino. 🔴 **$75 PERDIDO** | `cmtwhc40` | igual |
| **3 · Calificación con venta local en curso** | «Payment already in progress» → `failed` **sin evidencia**; la venta local sobrevivió | 🔴 `cmtwhg7d` **UNKNOWN en < 1 s** (P1-1 en la PAX también) | «cobro sin confirmar» |
| **7 · Detalle de un pago** | Mismo camino que 9 | `cmtwhikq` | igual |
| **13 · Pantalla apagada (batería, sin Doze)** | ACK en el mismo segundo, `PaymentViewModel` inicializado, **no despertó**; al encender ya estaba el Paso 3 | `cmtwhlm5` | igual |
| **10 · Turnos habilitados, SIN turno abierto (servidor y terminal)** | 🔴 **Acusó, navegó al cobro y volvió al Inicio sin mostrar nada** («Navigating to payment… Initialized» y de regreso; el guard de turno lo rebota): **ni rechazo ni resultado al servidor** | `cmtwhyn8` quedó **SENT** hasta el cancel (la tablet habría esperado 330 s) | «Esperando respuesta de la terminal» frente a un Inicio |
| **10b-a (nota del founder) · caja CERRADA desde la tablet, Inicio de la PAX rancio en «turno abierto»** | El tile NO se refresca al cambiar la caja desde otro aparato (sólo al reanudar la app). La **venta LOCAL avanzó sin freno** hasta el Paso 3 (Calificación → Propina → Cuenta); con tarjeta, ese cobro nacería sin turno en el servidor | — (sin remoto: los 4 «atrás» sacaron la app al lanzador; ver 503) | — |
| **10b-b (nota del founder) · caja REABIERTA desde la tablet, Inicio de la PAX rancio en «Sin turno»** | El remoto **SÍ entró** (Paso 3): para remotos el guard consulta al servidor, no el tile | `cmtwi391` | igual |
| **⚠️ Incidente lateral (23:04): el POST de la tablet recibió un 503 del túnel ngrok** (el servidor no registró ningún POST) | La PAX nunca vio la solicitud (0 menciones) | Sin fila | 🔴 **P1-3 de la auditoría en hardware**: «desenlace no consta (503)» → GET 404 ×6 «no acredita ausencia de cargo» → llave `f6bed36f…` **irresoluble**; destrabada con la fila QA `qa_f6bed36f_llave_huerfana_pax` (FAILED sin dinero) + asiento |

🔑 **Respuesta a la nota del founder («si abren el turno y la TPV no se refresca»):** el tile del Inicio de la PAX es rancio hasta que la app se reanuda; para un **cobro remoto** no importa (el guard consulta al servidor: con turno abierto entra, sin turno se descarta); para una **venta local** sí importa en las dos direcciones: con el tile en «abierto» y la caja cerrada, la venta avanza y el cobro nacería sin turno; con el tile en «Sin turno» y la caja abierta, el cajero ve «Abre la caja primero» hasta reanudar la app. Y la celda 10 destapa un defecto propio: **un remoto sin turno abierto se descarta en silencio** — la terminal debería contestar `failed + PRE_AUTHORIZATION` («abre la caja primero») para que la tablet no espere 330 s. Total del día: **16 celdas ejecutadas** (8 Nexgo + 8 PAX), 1 parcial, 1 no ejecutada; todas con la app publicada.

🔴 **11-sep 09:42 — CODEX sobre el orden de despliegue (pregunta en `codex-audit-regla/pregunta-despliegue-codex.md`, respuesta en `codex-despliegue-respuesta.md`): NO aprueba la C tal cual ni desplegaría la B.** Cuatro hallazgos, **los cuatro verificados en el código por Fable**: (1) hay TRES grupos de APK (2.8.7 sin acuse; 2.9.2 con acuse pero sin disposición/sonda/evidencia; árbol con todo), así que «liberar por tiempo sólo legacy» dejaría atorada también a la 2.9.2; (2) el rastro legacy del 10-sep se escribe DESPUÉS del `emit` y sin `await` (ventana de pérdida no cubierta por las 2 pruebas); (3) `replayPendingForTerminal` reenvía UNKNOWN/TIMED_OUT/FAILED-ACK/CANCELLED-sin-ACCEPTED según las capacidades del socket ACTUAL, sin procedencia de la entrega original ⇒ tras actualizar el APK un intento viejo puede REEJECUTARSE; y la sonda de la TPV «nunca inserta» ⇒ sin lápida contra una entrega tardía después de NOT_FOUND; (4) `UNRESOLVED_FINANCIAL_OUTCOME` bloquea todo TIMED_OUT sin mirar `failureCode` ⇒ las filas que prod liberó por tiempo (`AUTO_RELEASED`) volverían a bloquear el día del despliegue. Su orden: cerrar huecos + backend de transición por capacidades con procedencia durable ANTES de emitir; inventariar y conciliar pendientes de Testarudo antes de activarlo; terminal de reemplazo; migrar una terminal a la vez conservando Room; cobro remoto sólo donde el protocolo esté completo. **Decisión pendiente del founder sobre ese plan (D).**

🔴 **PAX · bloqueada por el APARATO, no por el código (16:21–16:29):** con cualquier APK (árbol, HEAD por `localhost:8799`,
HEAD por ngrok) la app da «Error al inicializar terminal». Causa medida: **el uid de la app no resuelve DNS**
(`run-as … ping host` → «unknown host»; el shell del mismo aparato resuelve y hace ping a la Mac en 6 ms), así que ni el
`config`, ni ngrok, ni `sandbox-tokener.blumonpay.net` salen. WiFi `VALIDATED` con DNS `192.168.1.254`, sin Private DNS,
sin restricción de `netpolicy`, la app no ata su proceso a ninguna red (`NetworkRequest` sólo para observar). Coincide
con la aparición de una SIM **LTE en roaming** como segunda red; apagar datos (`svc data disable`) no lo corrigió.
A las 15:01 la misma app sí tenía red (la sonda contestó por Socket.IO/ngrok).

🔑 **CAUSA ENCONTRADA (16:39, gracias a la observación del founder «la desbloqueé y agarró conexión sin reiniciar»):
la PAX estuvo 18 min con la pantalla apagada y en ese lapso la app no tenía red; a los 3 s de `SCREEN_ON` (16:39:44)
el socket conectó (16:39:47), el latido fue aceptado y el servidor recibió `GET …/config → 200` (16:39:50).** Es el
comportamiento de Doze/App Standby: con pantalla apagada e inactiva, Android suspende la red a las apps que no están en
la lista blanca de batería. `dumpsys deviceidle whitelist` en esta PAX: **`com.jaac.avoqado_tpv` (producción) SÍ está,
`com.jaac.avoqado_tpv.sandbox` NO** — y la app **no pide la exención en código** (`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`,
wake lock o servicio en primer plano: 0 resultados en manifiesto y fuentes). Una PAX en producción que nadie haya
exentado a mano se comporta como esta sandbox: **dormida = desconectada**, el servidor la marca offline y el POS no
puede mandarle cobros hasta que alguien la toca. **Candidato fuerte para el «terminal desconectada» de Testarudo.**
🟢 **REPRODUCCIÓN CONTROLADA HECHA (16:50 y 16:54–16:56 hora local, PAX local, app sandbox NO exenta):**
`dumpsys deviceidle force-idle` → el uid de la app pierde la red en el acto (`run-as com.jaac.avoqado_tpv.sandbox ping` →
`sendmsg: Operation not permitted`) mientras el shell del MISMO aparato hace ping en 55 ms; **el servidor deja de recibir
el latido HTTP** (`Terminal.lastHeartbeat` de `AVQD-2841548417` congelado 87 s en 22:53:42 UTC, con el latido normal cada
30 s); `dumpsys deviceidle unforce` → la app vuelve a tener red y el latido reaparece 15 s después (22:55:56 UTC). El
interruptor «Ahorro de energía» de Ajustes estaba **apagado** (captura del founder): Doze no depende de él — lo dispara
Android solo con pantalla apagada, sin cargar y sin movimiento. La PAX quedó `ACTIVE`, `mForceIdle=false`. Bitácora:
`$CLAUDE_JOB_DIR/tmp/doze-round2.log`. ⚠️ El «Sp Start Sleep / Sp out Sleep» de `PaxSPManager` sigue sin verificar aparte.

🟢 **11-sep 10:05–10:35 — PLAN D DE CODEX: los cuatro cierres de código, con TDD, sin commitear** (el founder dijo «si» a
arrancarlos a las 09:5x). Qué cambió y cómo se demostró:

- **Procedencia durable ANTES de emitir.** Columna `TerminalPaymentRequest.deliveryProvenance Json?` (migración
  `20260911150000_terminal_payment_delivery_provenance`, aplicada en `av-db-25` y en `codex_testarudo_test_20260909`;
  `docs/SCHEMA_MAP.md` regenerado, 366 modelos) = `{deliveries:[{protocol:'LEGACY'|'DURABLE', ackVersion,
  cancelDispositionVersion, probeVersion, socketId, at, replay}]}`. `null` = procedencia DESCONOCIDA (fila anterior a la
  columna; nunca se lee como «no entregada»); `[]` = creada y nunca entregada. `recordDelivery` la escribe con
  `$executeRaw` (append jsonb atómico + `deliveryAttempts`+1; `lastDeliveredAt` sólo para LEGACY, que no tiene ACK)
  **acotado a filas EN vuelo** (`PENDING/SENT/CANCEL_REQUESTED`); si no se graba, **no se emite** y la fila queda
  `UNKNOWN/DELIVERY_NOT_RECORDED`. Cierra el hallazgo 2 de Codex (el rastro legacy se escribía DESPUÉS del emit y sin
  esperar).
- **Replay restringido al intento original.** `replayPendingForTerminal` salta las filas entregadas a un socket LEGACY o
  de procedencia desconocida (auditoría `TERMINAL_PAYMENT_REPLAY_SKIPPED`, una vez por proceso + bitácora) y, antes de
  reenviar una DURABLE, graba la entrega con `replay:true`. Cierra el hallazgo 3: actualizar el APK no vuelve seguro un
  intento antiguo.
- **NOT_FOUND sólo para nunca entregadas.** La sonda libera (`FAILED/TPV_NEVER_RECEIVED`, evidencia
  `NOT_FOUND_NEVER_DELIVERED`) únicamente filas con procedencia exactamente `[]`, **y esa condición va dentro del propio
  UPDATE** (`deliveryProvenance: { equals: { deliveries: [] } }`), no sólo en la lectura previa. Con entregas (legacy, o
  durable con ACK perdido) ⇒ `NOT_FOUND_AFTER_DELIVERY`; con `null` ⇒ `NOT_FOUND_UNKNOWN_PROVENANCE`; en ambos se conserva
  la reserva y se audita UNA vez `TERMINAL_PAYMENT_PROBE_UNACCREDITED`. Sustituye al P2-1 del 10-sep
  (`NOT_FOUND_AFTER_LEGACY_DELIVERY` por `lastDeliveredAt` sin ACK).
- 🔑 **Por qué la lápida de la TPV (abajo) no rechaza una reentrega legítima** (frase CORREGIDA tras la re-auditoría de las
  11:30: la versión anterior decía que una fila «nunca está a la vez sondada y en entrega», y no es exacto). El replay sólo
  toma filas EN vuelo y la sonda sólo filas FUERA de vuelo, pero una entrega en TRÁNSITO sí puede cruzarse con una sonda:
  la fila pasó a UNKNOWN mientras el mensaje viajaba. Si la sonda llega primero, la TPV contesta NOT_FOUND y deja lápida, y
  la entrega que llega después se rechaza (`insert IGNORE` + `receive`): es exactamente la entrega tardía que Codex pidió
  bloquear, porque el servidor ya dio ese intento por incierto. Del lado del servidor, esa entrega ya consta en la
  procedencia, así que el NOT_FOUND no libera. Una reentrega que el servidor todavía espera (fila en vuelo) nunca coincide
  con una lápida, porque la sonda no pregunta por filas en vuelo.
- **Evidencia (servidor):** unit `tests/unit/services/terminal-payment.service.test.ts` **69/69** (+1 espejo «al reconectar
  NO reentrega procedencia desconocida ni legacy»; la fixture SENT del replay lleva ahora procedencia DURABLE; el
  `beforeEach` fija `$executeRaw→1` porque el mock global devuelve 0 y el servicio lee 0 —a propósito— como «no grabada»).
  Integración `tests/integration/payments/terminalPaymentRecovery.integration.test.ts` **57/57** contra
  `codex_testarudo_test_20260909` (dos pruebas reescritas para respetar `TerminalPaymentRequest_active_slot`: UNA fila en
  vuelo por terminal ⇒ los tres casos del replay van en secuencia, y la de «durable ANTES del emit» difiere el ACK hasta
  después de leer la fila y retira la fila entre iteraciones). **Sabotajes en copia aislada** (`rsync` del árbol sin `.git`
  a `$CLAUDE_JOB_DIR/tmp/sabotaje-provenance/`, `node_modules` por symlink; bitácora `sabotaje-provenance.log`): **A** emitir
  sin grabar ⇒ caen exactamente 3 (rastro legacy · durable-before-emit · provenance-cannot-be-written); **B** replay sin mirar
  la procedencia ⇒ 1 unit + 1 integración; **C** NOT_FOUND sin mirar la procedencia ⇒ 2; **control** 69/69 + 57/57.
  Typecheck `tsconfig.typecheck.json` **0 errores, local y Alienware COINCIDEN** (`run-avoqado-server.1IBSm5`); unit
  `--testPathPattern terminal` **46 suites · 537/537**, local y alien COINCIDEN (`run-avoqado-server.DvmNae`).
- **Lápida en la TPV (hallazgo 3, segunda mitad):** `RemotePaymentInbox.probe(requestId, venueId)` escribe
  `NOT_FOUND_ANSWERED` (sin contrato de dinero, nunca entregable; `venueId` del evento de la sonda como tenant) ANTES de
  contestar NOT_FOUND; `receive` rechaza esa solicitud si llega después; la sonda repetida contesta lo mismo; carrera
  lectura/lápida ⇒ contesta por lo que hay, nunca NOT_FOUND; sin lápida escrita (Room falla, sin venue) ⇒ no contesta y el
  servidor conserva; cancel sobre lápida ⇒ ACTIVE. `SocketManager` reenvía `venueId` al coordinator. CHANGELOG
  `[Unreleased]`. Pruebas: `RemotePaymentInboxTest` +7, `RemotePaymentInboxRoomTest` +1 (Room real), `SocketManagerTest`
  +1. **Evidencia (TPV, `avq-verify` → corrida verde de las 10:2x (sin `AVQ_KEEP` la carpeta `run-…` no se conserva; los XML de resultados quedaron en `~/.claude/avq-verify/snap-avoqado-tpv/app/build/test-results/testSandboxDebugUnitTest/`), `JAVA_HOME` zulu-17, 29 s):** `RemotePaymentInboxTest` 17/17 (era 11: −1 reescrita «NOT_FOUND sin insertar nada» → «deja LÁPIDA, nunca una solicitud entregable», +7), `RemotePaymentInboxRoomTest` 17/17 (+1 sobre Room real: lápida escrita, entrega tardía rechazada, no reclamable, sonda idempotente, 0 obligaciones pendientes, cancel ACTIVE), `SocketManagerTest` 26/26 (+1: el `venueId` del evento viaja al coordinator), `RemotePaymentCoordinatorTest` 2/2. La primera corrida cayó en COMPILACIÓN (cuatro pruebas viejas con la firma `probe(requestId)`), corregida. Todo en `main/` (ningún archivo de variante): sandbox y production comparten el cambio. **Sabotajes en un worktree aislado** (`git worktree add --detach` + `rsync` del árbol de trabajo, `AVQ_TREE` por avq-verify; bitácora `$CLAUDE_JOB_DIR/tmp/sabotaje-lapida.log`): **S1** contestar NOT_FOUND sin escribir la lápida ⇒ caen exactamente 4 de 34 (lápida en Room · «deja LÁPIDA» · «si Room falla no contesta» · la carrera) — `run-avoqado-tpv.8gG80o`; **S2** `receive` sin rechazar la lápida ⇒ cae exactamente 1 de 34 («llega DESPUÉS de contestar NOT_FOUND se rechaza»; la cazó la aserción sobre el MOTIVO, porque sin el candado la fila cae al rechazo genérico por contrato distinto) — `run-avoqado-tpv.o5s7hH`; **control** sin sabotaje en el mismo worktree: 34/34, exit 0. Worktree retirado. **`compileProductionDebugKotlin` exit 0 (80 s)** sobre el árbol compartido. Receta en la memoria `sabotaje-tpv-en-worktree-aislado`.

🟡 **11-sep 10:40–11:00 — AUDITORÍA INDEPENDIENTE del plan D (Fable 5.1, sólo con el diff, el plan y las reglas): sin P1
de dinero.** Cita: «no hay forma de que este cambio cobre dos veces ni libere un cobro que pudo ocurrir — cada carrera que
probé la cierra un UPDATE atómico». Revisó las 17 pruebas nuevas: **ninguna decorativa**. Sus hallazgos y qué se hizo:

- **P2-1 · textos que decían lo contrario del código** (docstring de `handleProbeResultFromSocket`, la regla de la TPV
  «Sin ACK ⇒ nunca recibida» y el nombre de una prueba): alineados. La regla de la TPV dice ahora por qué no se acepta el
  NOT_FOUND de una bandeja durable: la bandeja puede vaciarse DESPUÉS de ejecutar el cobro (downgrade por `INSTALL_VERSION`
  —destructivo, `DatabaseModule.kt:162`—, borrado de datos, reinstalación, `FACTORY_RESET`).
- 🔴 **P2-2 · consecuencia NO declarada, y es decisión del founder:** con el árbol, una PAX dormida (Doze) que pierde el ACK
  queda con su fila `UNKNOWN/ACK_TIMEOUT` y procedencia DURABLE; al despertar, su bandeja contesta NOT_FOUND ⇒
  `NOT_FOUND_AFTER_DELIVERY` ⇒ reserva conservada, y `releaseUnknownRequest` no libera. **La terminal queda reservada para
  siempre.** Ayer el árbol la liberaba (`acknowledgedAt: null`) y producción la libera a los 20 min por plazo. No se cambió
  la regla (es lo aprobado el 11-sep: «NOT_FOUND sólo para nunca entregadas»); se plantea al founder con opciones.
- **P3-1** una sonda sin `requestId` contestaba NOT_FOUND sin lápida ⇒ ahora ACTIVE (`RemotePaymentCoordinatorTest` +1).
- **P3-2** `markResolved` (`status != 'RESOLVED'`) alcanzaba la lápida ⇒ ahora `NOT IN ('RESOLVED','NOT_FOUND_ANSWERED')`
  (`RemotePaymentInboxRoomTest` +1: un resultado tardío no pisa la lápida).
- **P3-3** `deliveryAttempts` sumaba al entregar Y al acusar (2 por entrega) ⇒ sólo `recordDelivery` suma.
- **P3-4** una entrada de procedencia malformada se FILTRABA y la fila se leía como «nunca entregada» `[]` (lo que autoriza a
  liberar y a reenviar) ⇒ ahora toda la procedencia pasa a DESCONOCIDA (`null`); también un `protocol` que no sea
  LEGACY/DURABLE (unit +3).
- **P3-5** el conjunto de auditorías de replay crecía sin tope ⇒ tope de 10 000 (la bitácora sigue impidiendo el doble asiento).

🔴 **Y un defecto NUEVO que salió al escribir la prueba de P3-3, presente también en PRODUCCIÓN (`HEAD:618`):** el ACK de un
REPLAY se escribía con `void prisma.terminalPaymentRequest.updateMany(…)` **sin `.then`/`.catch`/`await`**, y una consulta de
Prisma es PEREZOSA: sin eso **no se ejecuta nunca**. Una fila reentregada y acusada por la terminal se quedaba PENDING, sin
`acknowledgedAt` y sin la vigencia renovada. Lo destapó un diagnóstico en la corrida (2 emits, 2 entregas grabadas,
`acknowledgedAt` inmóvil 3 s). Barrido de `src/`: los otros 7 `void prisma.` encadenan `.then`/`.catch` y sí corren; éste era
el único. Arreglo: `.catch(err => logger.warn(…))`, que dispara la consulta y evita un rechazo sin manejar (que `server.ts`
convierte en gracefulShutdown). Guardado por la prueba del replay (la fila acusada pasa a SENT) y por la del contador.

**Evidencia:** server unit **72/72** · integración **58/58** contra `codex_testarudo_test_20260909` · sabotajes en copia
aislada (`$CLAUDE_JOB_DIR/tmp/sabotaje-auditoria-server{,-2,-3}.log`): **S-A** ACK del replay otra vez perezoso ⇒ caen
exactamente 2 (replay y contador); **S-B** el ACK vuelve a sumar ⇒ cae exactamente 1 (contador); **S-C** procedencia filtrada
⇒ cae exactamente 1 (unit); control 72/72 + 58/58. ⚠️ Honestidad del registro: la primera pasada de S-A no se aplicó (patrón
que no casaba) y la de S-C dejó el archivo sin compilar («0 total»); ninguna de las dos se contó, y se repitieron con
reemplazos literales. **TPV:** árbol compartido por avq-verify (`run-avoqado-tpv.I2tcJ5`, `AVQ_KEEP=1`): `RemotePaymentInboxTest` 17/17 · `RemotePaymentInboxRoomTest` 18/18 · `RemotePaymentCoordinatorTest` 3/3 · `SocketManagerTest` 26/26; sabotajes en worktree aislado (`sabotaje-auditoria-tpv.log`): **S3** `markResolved` alcanza otra vez la lápida ⇒ cae exactamente 1 de 21 (`run-avoqado-tpv.xRvrE1`); **S4** sonda sin id vuelve a NOT_FOUND ⇒ cae exactamente 1 de 21 (`.jHdMWY`); control 21/21 (`.cLhFXu`); `compileProductionDebugKotlin` exit 0. ⚠️ Una primera corrida del árbol compartido NO se ejecutó (zsh pasó los filtros como un solo argumento: `Unknown command-line option`); no se contó y se repitió. **Typecheck del server 0 errores, local y Alienware COINCIDEN** (`run-avoqado-server.OHm96Z`).

🟡 **11-sep 11:10–11:40 — SEGUNDA auditoría, sólo de los arreglos (Opus 5: la de Fable murió por el límite de uso de Fable,
no por un hallazgo): sin P1 de dinero; tres P2 CAUSADOS POR MI ARREGLO del ACK perezoso, todos cerrados con TDD.**
- **P2-1** ahora que el ACK del replay sí se escribía, renovaba `expiresAt = ACK + 5 min` también sobre filas ya SENT: cada
  reconexión alargaba la fila y el vigía nunca la pasaba a UNKNOWN (sin 🚨), la sonda no la veía y el POS la leía «en curso»
  para siempre (escenario real: celda 10, sin turno la TPV reclama y no contesta). ⇒ el ACK de un replay **sólo confirma una
  fila PENDING**, igual que `markDelivered` en el camino fresco. El ACK se movió a un método propio que se puede esperar,
  `registrarAckDeReplay`.
- **P2-3** el filtro de estado de ese ACK (lo único que impide revivir a SENT una fila COMPLETED/UNKNOWN/CANCELLED o en
  CANCEL_REQUESTED) no lo guardaba ninguna prueba ⇒ prueba de integración que recorre los seis estados contra Postgres.
- **P2-2** la rama de CONTRADICCIÓN de la sonda (NOT_FOUND sobre fila acusada) no marcaba la espera: cada barrido de 30 s
  escribía otro 🚨 y otra fila de bitácora (≈2 880 al día por fila) ⇒ espera de 15 min + asiento único.
- **Una sola regla de «auditar una vez»** (`debeAuditar`), para las cuatro anomalías (replay saltado, dos de sonda y
  contradicción): antes estaba copiada en cuatro sitios, sin filtro por `entity` (no usaba el índice `[entity, entityId]`) y,
  si la consulta a la bitácora fallaba, la fila perdía su única auditoría del proceso. Ahora la marca se retira si la
  consulta falla. Tope de 10 000 también en la espera de la sonda.
- P3: textos obsoletos de la regla de la TPV (rastro legacy «después del emit», «la sonda no deja lápida») marcados como
  cerrados en el árbol y abiertos en producción; la premisa «una fila nunca se sonda y se entrega a la vez» corregida en la
  regla del servidor, en este relevo y en la tabla de fases (una entrega EN TRÁNSITO sí puede cruzarse con la sonda: lo
  seguro es la procedencia no vacía + la lápida); nota en el relevo del 9-sep sobre el nuevo significado de
  `deliveryAttempts`; espera de 1 s → 3 s en una prueba.
- **Evidencia:** integración 60/60 y unit 72/72; sabotajes en copia aislada (`sabotaje-reaudit-server{,-2}.log`): **S-D**
  el ACK vuelve a renovar SENT ⇒ cae exactamente la prueba de los estados; **S-E** sin filtro de estado ⇒ la misma; **S-F**
  contradicción sin espera ni asiento único ⇒ cae exactamente la suya; **S-G** el callback deja de escribir el ACK ⇒ cae
  exactamente la del replay; control verde. (S-D y S-E no se aplicaron a la primera, porque el patrón casaba cuatro veces;
  no se contaron y se repitieron anclados.) Typecheck **0 errores, local y Alienware COINCIDEN** (`run-avoqado-server.AlBuSj`).

🟢 **11-sep 11:40–12:10 — el P1 de SERVIDOR de la auditoría de Codex sobre el 409: `cancelOrder` ahora es ATÓMICO (TDD
contra Postgres).** Antes leía `paymentStatus`, consultaba la reserva y hacía el UPDATE en tres pasos sin lock: una admisión
o un registro de dinero podía colarse entre la lectura y el UPDATE, y la orden terminaba CANCELLED con un cobro vivo o ya
pagada. Ahora:
- `cancelOrder` es una transacción que toma `SELECT … FROM "Order" … FOR UPDATE`, que es el MISMO lock que la admisión
  (`terminal-payment.service.ts`) y el registro del dinero (`payment.tpv.service.ts`). Dentro del lock relee el
  `paymentStatus` y los cobros sin desenlace acreditado.
- El 409 lleva `code: 'ORDER_CANCEL_BLOCKED_BY_TERMINAL_CHARGE'` y `details: { requestId }` del cobro que bloquea. Es la
  pieza 1 del contrato que Android e iOS necesitan, y es aditiva. El comentario falso («CANCEL_REQUESTED does NOT block») y
  dos nombres de pruebas unitarias quedaron corregidos.
- La admisión rechaza un cobro NUEVO sobre una orden `CANCELLED/DELETED` (400 «está cancelada»). La réplica de una
  solicitud ya existente se sigue devolviendo, y el registro de una aprobación que YA ocurrió no se toca.
- Nuevo `findChargeBlockingOrderCancel(venueId, orderId, client)`, que corre dentro de la transacción del llamador.
- Beneficia a los tres llamadores: el controlador móvil, el de mesas de la TPV y la reproducción de la cola offline
  (`sync.mobile.service.ts`).
- **Pruebas** (integración, contra `codex_testarudo_test_20260909`): (1) un cobro nuevo sobre una orden cancelada no crea fila
  ni emite; (2) con una admisión a medio camino que retiene el lock, `cancelOrder` espera y después contesta 409 con el
  código; la orden no queda CANCELLED; (3) igual con un registro de pago a medio camino: 400, la orden sigue PAID y no
  CANCELLED; (4) control: sin bloqueos, cancela. Antes del arreglo fallaban (1), (2) y (3), y el control pasaba.
- ⚠️ Mismo defecto, NO tocado: el dashboard (`order.dashboard.service.ts:~606`, sí revisa pagos) y la TPV al anular todos
  los artículos (`order.tpv.service.ts:~2845`, con CAS de versión) cancelan una orden SIN mirar cobros de terminal ni tomar
  el lock. Fuera de lo que auditó Codex; decisión pendiente.
- Piezas 2 y 3 del contrato (desenlace canónico en el GET y estado durable en el POST cancel): NO se hicieron. Van con los
  DTO de Android e iOS cuando el founder autorice el arreglo A, como pide Codex.
- **Evidencia:** integración **64/64** (archivo completo) y unit **110/110** (`order.mobile.service` + `terminal-payment.service`); sabotajes en copia aislada (`sabotaje-cancel.log`): **S-H** `cancelOrder` sin el `FOR UPDATE` ⇒ caen exactamente las dos pruebas de carrera; **S-I** la admisión vuelve a aceptar una orden cancelada ⇒ cae exactamente la suya; **S-J** el 409 sin código ni cobro bloqueador ⇒ cae exactamente la de la admisión; control 4/4. Typecheck **0 errores, local y Alienware COINCIDEN** (`run-avoqado-server.G6niRB`). **Revisión independiente de este cambio (Opus 5): sin P1; el lock no puede producir deadlock** (`cancelOrder` toma sólo el lock de su fila y no espera nada más con él tomado; admisión: advisory de la terminal → Order; registro: vales → Order → Payment → Shift; ningún llamador de `cancelOrder` está dentro de otra transacción). Sus P2/P3 y qué se hizo:
  - ✅ la cola offline (`sync.mobile.service.ts`) marcaba REJECTED un `P2028` (transacción agotada con el pool saturado) ⇒ ahora es reintentable (unit +1).
  - ✅ el 400 «está cancelada» de la admisión viajaba sin código ⇒ `code: 'ORDER_CANCELLED_NO_NEW_CHARGE'` + `details: { requestId }`: el servidor PRUEBA que ese cobro no se creó (va después de la réplica y bajo el lock).
  - ✅ las dos pruebas de carrera discriminaban por reloj (300 ms) ⇒ ahora esperan a que Postgres muestre la sesión esperando el lock (`pg_stat_activity`, `wait_event_type='Lock'`) y comprueban que la cancelación no terminó antes. Más la dirección inversa (una admisión que llega con la cancelación reteniendo el lock espera y rechaza con el código).
  - ✅ P3 preexistente en el código que se movió: cancelar SIN motivo sobrescribía las notas del cliente con el estado («PENDING») ⇒ sin motivo ya no se tocan (unit +1).
  - ⬜ declarado: la ruta `/tpv` del cancel descarta `code`/`details` (la PAX no los usa; el contrato llega por `/mobile`).
  - 🔴 para el founder, NO es código: con el predicado del árbol (`UNRESOLVED_FINANCIAL_OUTCOME`, que incluye CANCEL_REQUESTED y los negativos sin evidencia) casi toda cancelación desde la tablet con los APK publicados devuelve 409 y la orden queda abierta; y el mismo defecto de carrera sigue abierto por tres puertas más: `deleteOrder` del dashboard (`order.dashboard.service.ts:575-606`), `mergeOrders` (orden origen, `order.mobile.service.ts:~1826-1936`) y `voidItems` al anular todo (`order.tpv.service.ts:~2696,2845`).
  **Evidencia final:** unit **183/183** (`sync.mobile.service` + `order.mobile.service` + `terminal-payment.service`), integración **65/65**; sabotajes (`sabotaje-cancel2.log`): **S-K** P2028 no reintentable ⇒ cae 1 (sync); **S-L** vuelve a pisar las notas ⇒ cae 1; **S-M** el 400 sin código ⇒ caen 2 (orden cancelada y dirección inversa); **S-N** leer el cobro bloqueador ANTES del lock —el caso que antes podía pasar por reloj— ⇒ cae exactamente la carrera de admisión; control verde. Suites vecinas `order|terminal-payment|sync.mobile|payment.tpv`: 82 suites · 917/917, local y alien COINCIDEN (`run-avoqado-server.qUe26i`). Typecheck final **0 errores, COINCIDEN** (`run-avoqado-server.PeD3U3`).

🔴 **11-sep ~11:00 — lo que midió la sesión hermana (fork `error_terminal_atascada`) en PRODUCCIÓN, sólo lectura (Better Stack
+ base de prod), a partir de un log que el founder le mandó.** Se copia aquí para que el relevo lo tenga; la sesión hermana es
quien lo reporta al founder y no toca código:

1. **El 409 «Hay un cobro en curso en la terminal para esta orden» (16:23:04 UTC) NO es una fila atorada: es una CARRERA del
   POS Android.** `PaymentFlowViewModel.cancel()` / `cancelAndExit()` disparan en paralelo `cancelCurrentPayment()`
   (fire-and-forget) y `orderRepository.cancelOrder()`; el DELETE de la orden llegó 59 ms ANTES que el cancel del cobro, rebotó
   con 409 y la orden quedó ABIERTA. La fila pasó a CANCELLED por la gracia de 30 s. **Sobre el dinero, sólo lo que consta**
   (frase corregida tras la auditoría de Codex, que refutó «no hubo cobro doble / son dos clientes»): la orden del intento
   cancelado no tiene `Payment`, y en `ProviderEventLog` (webhooks del procesador) no hay ninguna `VENTA APROBADA` en la
   ventana del intento `2e183233` (16:22:49–16:23:42 UTC); las cuatro aprobaciones de 16:15–16:30 están ligadas cada una a
   su `Payment`. Límite: un webhook puede no llegar y el portal de Blumon no se revisó; que las dos aprobaciones de $88 sean
   de dos clientes es inferencia.
2. **Órdenes huérfanas** (abiertas, sin pago, con su cobro de terminal CANCELLED/FAILED/TIMED_OUT), últimos 14 días:
   Testarudo **21 ($4,132.25)**, Amaena **3 ($1,414)**.
3. 🔴 **Históricos cuantificados (confirma el hallazgo 4 de Codex con números):** producción NO tiene la columna
   `cancelDisposition`; la migración del árbol `20260909181000` la agrega en NULL sin rellenar ⇒ el predicado
   `UNRESOLVED_FINANCIAL_OUTCOME` del árbol contaría HOY como bloqueadoras: PAX de Testarudo `2841653112` **304 filas
   históricas** (296 CANCELLED, 1 TIMED_OUT, 7 FAILED de ACK/TPV) + 1 en vuelo al consultar, Nexgo `n860w173400` **53**,
   Nexgo de Amaena `n860w173570` **12** (cifras reconfirmadas por Codex). Y
   `hasChargeBlockingOrderCancel` usa ese mismo predicado (con CANCEL_REQUESTED): con el árbol ni un POS que cancele en el orden
   correcto podría cancelar la orden, y los APK publicados nunca mandan la disposición. Testarudo canceló 16 cobros desde la
   tablet el 11-sep (7 en la PAX, 9 de 10 en la Nexgo). ⇒ **desplegar el árbol tal cual bloquearía las tres terminales desde
   el primer minuto.**
4. `origin/main` ya es `0265daaa` (merge del PR #121, 10-sep 23:08 -0500), no `3000f3d0`; `terminal-payment.service.ts` no
   cambió entre los dos (último cambio `d26bb746`, con `AUTO_RELEASED`).

🔴 **Veredicto de Codex sobre el brief (11-sep, [`409-cancelar-orden-2026-09-11-auditoria-codex.md`](409-cancelar-orden-2026-09-11-auditoria-codex.md)):**
«el diagnóstico de la carrera Android está sustentado; el plan requiere correcciones antes de implementarlo. No retirar la
protección del 409». Tres P1: (1) el arreglo A no puede usar un `CANCELLED` de producción (gracia de 30 s) como «no se
cobró»; (2) **`cancelOrder` del servidor no es atómico**: lee `paymentStatus`, consulta la reserva y cancela en operaciones
separadas, sin el lock de `Order` que usan la admisión (`terminal-payment.service.ts:551`) y el registro del dinero, y la
admisión de un cobro NUEVO no rechaza una orden cancelada — **lo toma esta sesión con TDD** (ver abajo); (3) la cancelación
diferida (B) exige un contrato durable y visible, no una cancelación silenciosa tras un 409. P2 de Android/iOS (salida que
oculta el resultado, intención a persistir ANTES de la primera petición, `TablesViewModel`, iOS no secuencia y
`cancelCurrentOrder()` sin llamador) y N3 con la frontera de dinero: los lleva la sesión hermana si el founder autoriza.

📄 **Brief para auditar este 409 con Codex** (lo escribió la sesión hermana a pedido del founder): línea de tiempo con
`correlationId`, causa con `archivo:línea` en Android, prod, árbol, TPV e iOS, arreglos A–E, siete preguntas y lo NO verificado —
[`409-cancelar-orden-2026-09-11.md`](409-cancelar-orden-2026-09-11.md). Ningún archivo de avoqado-android ni de avoqado-ios se ha
editado por este hallazgo; el arreglo del «Cancelar» de Android espera la autorización del founder.

### Cruce con producción (Better Stack `render log stream`, 7–10 sep): la PAX de Testarudo tiene la firma de Doze

Datos del servidor de producción, sólo lectura (ClickHouse sobre `t284025_render_log_stream_s3`, venue «Testarudo Cafe»):

- Cada terminal manda por Socket.IO un latido de salud **cada 5 min** (`HealthMonitor.kt`, `socket:tpv:heartbeat`; el
  servidor lo registra siempre: «Registering terminal» + «Terminal heartbeat», 12/12 por hora). Las terminales de
  Testarudo son la PAX **`AVQD-2841653112`** y la Nexgo `AVQD-N860W173400`.
- **De noche (19:00–07:00 CDMX, local cerrado, la PAX en su base): 12 latidos/hora exactos. En horario de tienda: 0–8.**
  La Nexgo del MISMO local: 12/hora día y noche desde el 8-sep. Tres días (8–10 sep): PAX **3.1 latidos/h de día vs 11.8
  de noche**; Nexgo 10.2 vs 9.7. Es la firma de Doze (sin cargar + pantalla apagada ⇒ Android corta la red a la app),
  no de un Wi-Fi malo — la Nexgo lo comparte y no lo sufre.
- Lo que ve la tablet: `GET …/terminals/online` (cada ~60 s) devuelve sólo terminales con socket vivo
  (`terminal-registry.ts`: la entrada se borra al desconectarse el socket; no hay TTL). Consultas que vieron a la PAX:
  **7-sep 154/381 (40 %) · 8-sep 269/361 (75 %) · 9-sep 243/357 (68 %) · 10-sep 44/197 (22 %)**. Hoy la PAX no dio un solo
  latido de 11:00 a 14:00 CDMX y el personal cobró con la Nexgo (PAX 4 intentos contra 69 de la Nexgo).
- **Cero 404 «no está conectada» en 4 días**: el selector no ofrece la terminal dormida, así que el cajero ni puede
  intentarlo; lo que ve es «desconectada» hasta que alguien la toca (lo que el founder observó en vivo: `SCREEN_ON` →
  socket en 3 s).
- La app de la PAX se **reinició 9 veces en 4 días** (`[Observability] Observability system initialized`: 7-sep 08:39,
  08:43, 11:39 · 8-sep 08:42, 13:16, 15:11 · 9-sep 08:49, 17:44 · 10-sep 08:43 CDMX) — el remedio casero del personal.
- ⚠️ **No atribuir a Doze los 409.** Son resultado `cancelled` (⇒ 409 tras 5–65 s, media 8–20 s de espera) y
  `TERMINAL_BUSY` (~25 ms). PAX en 4 días: 200 ×237 · 409 ×156 (46 % el 7-sep). Entre ellas hay **76 «Contactless no
  aceptado por el kernel: DENIED_BY_KERNEL»** (T13) — tema aparte que merece su propia mirada.
- Lo que NO se puede saber desde el servidor: si `com.jaac.avoqado_tpv` está exento de batería en la PAX de Testarudo.
  En la PAX local la exención de producción es de tipo `user` (alguien la puso a mano); la de sandbox no existe y por eso
  reprodujo el síntoma. **Pregunta al founder.**

**Arreglo de producto (decisión del founder, no construido):** (a) la app pide la exención
(`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`: hoy 0 resultados en manifiesto y fuentes) y/o corre el socket en un servicio en
primer plano; (b) mientras tanto, exentar a mano «Avoqado» en Ajustes → Batería de cada PAX; (c) el POS podría decir
«terminal dormida: tócala» en vez de «desconectada». Cómo se mide el arreglo: la consulta de latidos/hora día vs noche
pasa de 3 → 12 en `AVQD-2841653112`.

**Definición de la evidencia para recuperar una terminal SIN permitir recobros (lo que pidió el founder):**

| Clase | Qué la acredita | Quién libera | Estado |
|---|---|---|---|
| A · Terminal | Respuesta de sonda con `outcomeEvidence` (`PRE_AUTHORIZATION` / `PROCESSOR_DECLINED`), o `NOT_FOUND` sobre una solicitud **nunca ACK-eada** | El servidor, solo | ✅ construida y vista en hardware (14/15) |
| B · Terminal + procesador | La bandeja de la terminal dice cancelado/fallido **sin** `outcomeEvidence` (APK anterior) **y** el portal del procesador no muestra cobro para esa terminal/monto/ventana; sin Payment | Un **operador**, con motivo, dejando `MANUAL_RELEASE` y la vigilancia de 30 min por si aparece un Payment (🚨) | ⬜ **decisión del founder**: hoy la liberación manual está sin efecto (`Release awaits execution confirmation`) |
| C · Contradicción | `NOT_FOUND` sobre una solicitud ACK-eada, o la terminal dice cobrado y no hay Payment | Nadie automático; se investiga con el portal | ✅ 🚨 `TERMINAL_PAYMENT_PROBE_CONTRADICTION` |

**Lo que sólo el founder puede desbloquear (se le pregunta en el reporte):** (1) dar efecto a la liberación manual clase B
(o dejar `b71ae21c` bloqueando la PAX local); (2) limpiar la llave vieja de la Sunmi (`pm clear` + volver a iniciar
sesión) o decidir una regla del POS «404 sostenido + antigüedad ⇒ nunca se envió», que toca dinero (un 404 por
retención de filas viejas la volvería peligrosa); (3) poner tarjeta: contactless y chip en la N86 (AngelPay QA) y en la
PAX (Blumon sandbox) — en «Pago rápido» de la propia terminal se ejercita T10 (serial del JWT → `Payment.terminal` →
procedencia persistida) sin necesitar la Sunmi.

### Auditoría independiente del 10-sep (tarde) — Fable 5.1, sólo con el diff, el contrato y las reglas

Se le dio el diff, el contrato del 409 y las reglas de los repos; **no** el razonamiento de esta sesión. Cada P1 se
verificó contra el código antes de aceptarlo. Confirmó como correcto lo central (contrato del 409 e invariante «`TERMINAL_BUSY`
que nombra a otra ⇒ mi fila no existe», identidad acreditada del cierre REST, registro de sockets, sin liberación por
plazo, Room sin cambios de esquema, referidos con la regla en un solo sitio). Y encontró lo siguiente.

**Arreglado en esta sesión (pequeño y seguro):**

- **P2-6** `socketManager.ts:228/231`: los dos `void` (`replayPendingForTerminal`, `probeUnresolvedForTerminal`) sin
  `.catch` — un P2024 del pool en una tormenta de reconexiones sería un `unhandledRejection`, que `server.ts:326`
  convierte en `gracefulShutdown` a propósito. Ahora con `.catch` + `warn`.
- **P2-7** las suites de `tests/integration/payments/` exigían la base `codex_testarudo_test_*`; CI usa
  `avoqado_h1a_test_20260808` (`.github/workflows/ci-cd.yml:64`). La guarda acepta ahora las dos familias. ⚠️ La
  carpeta entera está **sin trackear** (6 archivos de varias sesiones): hoy CI ni la ve.
- **P3** un `RESOLVED success` cuyo Payment no se puede ligar contaba como «acreditado» y volvía a `closeRow` cada 30 s
  (reescribiendo `lateResult`, perdiendo `failureCode`): entra al mismo backoff. Prueba nueva; sabotaje en copia aislada
  la tumba (1/51). Integración **51/51** (`run-avoqado-server.cNYE3i`). Typecheck tras estos cambios: 0 errores, local y Alienware COINCIDEN (`run-avoqado-server.6GxH2h`).

**Confirmado y SIN arreglar — son decisiones de despliegue/dinero del founder (ver «Preguntas»):**

- 🔴 **P1-1 · Los APK en la calle no mandan `outcomeEvidence`** (`git grep outcomeEvidence HEAD` en avoqado-tpv: 0; sólo
  el árbol lo hace, en 4 archivos de WIP). Con el servidor nuevo desplegado ANTES que el APK (regla obligatoria: la PAX
  tarda 3-5 días), **el primer rechazo del banco o cancelación en una terminal 2.8.x/2.9.1 la deja `UNKNOWN` = reservada**,
  sin sonda (no anuncia la capacidad) y sin liberación manual (abajo). Opciones: (a) semántica por capacidad — a un
  APK sin capacidad se le acepta el `failed`/`cancelled` pelón del socket autenticado como antes; (b) no desplegar el
  servidor hasta que la flota tenga el APK; (c) ambas + migración de datos.
- 🔴 **P1-2 · Todas las filas históricas se vuelven bloqueadores al desplegar:** `UNRESOLVED_FINANCIAL_OUTCOME` incluye
  `TIMED_OUT`, `FAILED/TPV_ERROR` (= cada declinación histórica) y `CANCELLED` con `cancelDisposition IS NULL` (= cada
  cancelación histórica; la migración `20260909181000` sólo añade la columna), sin cota de fecha. Es Testarudo escalado
  a la flota. **Medir en producción antes de cualquier deploy:**
  `SELECT "terminalId", count(*) FROM "TerminalPaymentRequest" WHERE status='TIMED_OUT' OR (status='FAILED' AND "failureCode" IN ('ACK_TIMEOUT','ACK_REJECTED','TPV_ERROR')) OR (status='CANCELLED' AND "cancelDisposition" IS NULL) GROUP BY 1;`
  Falta una migración de datos acotada por fecha (filas anteriores al modelo de evidencia) y la liberación de operador
  clase B.
- 🔴 **P1-3 · El POS arma una llave que nunca podrá soltar cuando el POST falla ANTES de crear la fila:** 404 «no está
  conectada» (`S:474`), 422 «sin socket» (`S:478`) y 400 «la cuenta no existe» (`S:533`) se lanzan antes de `reserve` y
  viajan **sin `code`**; Android (y ahora iOS, por WIP ajeno en `CardChargeOutcome.swift`) los reconcilian → GET 404 ×3 →
  llave armada para siempre. Es el escenario diario «la PAX estaba dormida». El arreglo es el patrón de T15, pero
  exige antes **reordenar el servidor**: honrar la fila existente (replay) ANTES de comprobar conectividad, para que un
  `code` pre-fila signifique «nunca se creó» por construcción incluso ante un reintento del mismo `requestId`.
- **P2-1** `findReconcilablePayment` exige `processorData.terminalPaymentRequestId`, que sólo escribe el propio
  `closeRowFromPaymentTx`: los barridos «el dinero gana» no alcanzan un Payment cuyo cierre se negó (serial distinto,
  `claimed`, `orderId` distinto). Pruebas de integración de los barridos siembran la etiqueta a mano.
- **P2-2** bloqueador de OTRO venue (terminal migrada): el 409 llega bien (`requestId:'unknown'`) pero ni la sonda ni el
  barrido lo alcanzan (filtran por venue). **P2-3** `releaseUnknownRequest` es no-op y el MCP (`release_terminal_payment`)
  y superadmin prometen una capacidad que no existe. **P2-4/P2-5** `cancelPayment` resuelve el long-poll como `timeout`
  antes de emitir el cancel, y no emite si el CAS `IN_FLIGHT` no tocó fila; `hasChargeBlockingOrderCancel` vuelve a incluir
  `CANCEL_REQUESTED` — WIP previo de este relevo, no de esta sesión; queda para decidir.
- P3 restantes en el informe del auditor (regla triplicada `UNRESOLVED_FINANCIAL_OUTCOME`/`SIN_DESENLACE_ACREDITADO`/
  `hasUnprovenLegacyOutcome`; rama muerta `newStatus === TIMED_OUT`; `mockRejectedValueOnce(P2002)` sin consumir en
  unitarias; mensaje de «elige otra terminal» en el 409 por ORDEN).

## 2-quater. 11-sep, tarde-noche — decisión A + B, diseño, auditorías e implementación (sesión Claude Opus 5)

🔴 **NO DESPLEGAR EL SERVIDOR TAL COMO ESTÁ (11-sep).** El árbol tiene el predicado ESTRICTO activo: el día del
despliegue bloquearía las 375 filas históricas de producción (343 CANCELLED sin disposición, 30 FAILED/TPV_ERROR, 2
TIMED_OUT) en las tres terminales de Testarudo y Amaena, y **todavía no existe B**, que es la única salida. El orden
seguro está en la sección I.6 del diseño: primero el servidor con el predicado estricto **apagado por venue**, después
conciliar las 375 con B, después los APK terminal por terminal, y sólo entonces encender el predicado. Mientras tanto,
nada de este trabajo está commiteado.


**Decisión del founder:** A (identidad de bandeja) como recuperación automática, B (liberación con conciliación
documentada) como respaldo, C descartada; continuar el §8. **El founder audita; esta sesión implementa** (instrucción
del 11-sep: no gastar tokens dos veces).

**Documentos (esta carpeta):**
- `diseno-A-B-seccion8-2026-09-11.md` — diseño **v3**. La sección I (veredicto del auditor) manda sobre las anteriores.
- `investigado-11-sep-diseno-A-B-s8.md` — todo lo investigado: 40 hallazgos de 6 revisores, con 32 veredictos de un
  escéptico; la investigación D.7; los puntos V1–V5 de Codex y los datos de producción.
- `auditoria-fable-diseno-A-B-s8-2026-09-11.md` — veredicto del auditor independiente (Fable 5.1, en lugar de Codex, que
  se quedó sin créditos). A: aprobado con cambios. B: rechazado hasta reescribir sus bases. C.1, C.3 y D: aprobados con
  cambios. F: rechazado; nuevo orden de despliegue en la sección I.6 del diseño.
- `nexgo-auth-arranque-sin-red-2026-09-11.md` — T26, verificado por código, con la evidencia de producción de la
  sesión hermana.
- `codex-auditoria-diseno-A-B-s8.md` y `codex-auditoria-investigado-11-sep.md` — textos para Codex.

**Producción, sólo lectura (11-sep):** 375 filas bloquearían con el predicado estricto: 343 CANCELLED sin disposición,
30 FAILED/TPV_ERROR y 2 TIMED_OUT. Hay 6 filas COMPLETED/TPV_ERROR, todas en las Nexgo de Amaena y Testarudo: un
rechazo reportado seguido de un reintento aprobado. Las 6 órdenes tienen un solo pago, así que el patrón existe y
todavía no ha causado un cobro doble.

**Implementado (sin commit, push ni deploy):**

| Pieza | Estado | Evidencia |
|---|---|---|
| T26 · Nexgo: la auth de AngelPay se recupera sola; auth antes de la espera de 8 s; SIN_RED / SIN_CREDENCIALES / CUENTA_NO_EN_CONFIG; serial real; regla H.3 para PRE_AUTHORIZATION; candado único auth → alineación → SDK; nunca la primaria en multicuenta; alineación contra la sesión viva | código hecho, TDD | `run-avoqado-tpv.yE31tx`: 318 pruebas, 1 falla (una prueba ROJA ajena de D.7, en curso); compilan nexgoDebug y productionDebug; 11 sabotajes ejecutados. Falta QA en la N86 sin red |
| C.6 · Toda ruta que cancela o anula una orden respeta el candado y el cobro vivo (DELETE y PUT del dashboard, anular artículos, fusión, vales, POS-sync y delivery con 🚨), anular por debajo de lo cobrado ⇒ 400 `ORDER_VOID_BELOW_PAID`, `details` en la cola offline, `ORDER_UPDATED`, toast del dashboard | código hecho, TDD | integración 44/44 · unitarias 1328 (COINCIDEN, `run-avoqado-server.tWUabE`) · typecheck 0 (`.grAorp`) · dashboard `tsc -b` 0 (`run-avoqado-web-dashboard.7KMzCj`) · 34 sabotajes |
| H.5/H.6 · Lápida de admisión: todo rechazo pre-fila (404/422/403/409/400) deja una fila FAILED/`REJECTED_*` y una copia tardía del mismo POST reproduce el rechazo; P2028/P2034 ⇒ 503 `TERMINAL_PAYMENT_ADMISSION_RETRY` | **APLICADO Y VERIFICADO en el árbol** (el founder corrió el `git apply`; el clasificador lo bloqueaba para la sesión) | ROJO: la segunda copia se emitía. VERDE en el worktree: integración 77/77, unitarias 158/158, typecheck 0. **Verificación en el árbol compartido, ya con C.6 encima:** integración 121/121 en los dos archivos (`run-avoqado-server.s7srT3`), unitarias 987 pasan y 1 omitida en 86 suites (COINCIDEN, `.0dUw0d`), typecheck 0 en ambos lados (COINCIDEN, `.xnBxya`) |
| D.7 · Un id de solicitud pegado al contexto de pago de otra (re-etiquetado de la pantalla que sale; atrás del sistema) — AngelPay y Blumon | código hecho, TDD | La navegación congela los 35 argumentos de cada cobro en su propia entrada y los borra del lanzador; los dos ViewModels fijan la fuente en su PRIMERA asignación y rechazan otro id (non-fatal a Crashlytics). ROJO: `run-avoqado-tpv.f6WiF3` (4 fallos) y `.4qDWqG` (5). VERDE: `.NQVXzK` 449/0, incluidas las 117 de PaymentViewModelTest; compila nexgoDebug + productionDebug (`.anevfK`); sabotaje `.M6NGfi` (8 caídas exactas). Falta QA en la N86 y la PAX |
| C.4 · Cancelación durable Android + iOS | en curso | — |
| N3 + H.3 + evidencia por intento + libreta SHADOW + efectivo oculto en SOCKET (TPV) | en curso | — |
| C.1/C.2 · Desenlace canónico del GET, POST cancel con estado durable, predicado coherente y MCP | en curso | — |

🔴 **Incidente, 11-sep 13:45:38:** alguien corrió `git stash` en avoqado-server y sacó del árbol el WIP de 71 archivos
de varias sesiones (reflog `reset: moving to HEAD`, `stash@{0}`). No aparece en ningún transcript de Claude ni de
Codex. Se restauró con `git stash apply stash@{0}` (sin pop: el stash queda como respaldo). **No se debe volver a
aplicar.** Borrarlo lo decide el founder, idealmente después de commitear.

**Siguiente (servidor, en serie sobre `terminal-payment.service.ts`):** aplicar la lápida → contrato C.1/C.2 (lista
blanca por `(status, failureCode)`, conservar `ACCEPTED`, predicado con filas en vuelo, cancel en la procedencia) →
flag por venue del predicado estricto (I.6) → B reescrita (I.2) → A servidor (I.1). **TPV, después de D.7:** A
identidad (I.1) → N3 + H.3 en Blumon + evidencia por intento + una sola tabla de códigos + efectivo y cripto ocultos en
cobros SOCKET (P2-9, interino) + migración de la libreta SHADOW.

## 3. Lectura mínima y fuentes de verdad

1. **Este README**, luego [auditoría independiente Codex 10-sep](../testarudo-audit-2026-09-10-codex.md) y su [evidencia/reproductor](../testarudo-audit-2026-09-10-evidence/).
2. **Checkpoint más reciente de Claude:** [CHECKPOINT-huellas-2026-09-09-1940.md](../testarudo-checkpoint-2026-09-09/CHECKPOINT-huellas-2026-09-09-1940.md), 809 líneas en esta captura. Está en OTRO archivo que el README original; sus últimas secciones son las más recientes. Sus "cerrado/ajeno" deben contrastarse con la auditoría posterior. Copia histórica conservada [aquí](./historico/claude-checkpoint-809-lineas.md).
3. [Checkpoint original Codex con actualizaciones](../testarudo-checkpoint-2026-09-09/README.md), 485 líneas en esta captura. Leer sólo la sección requerida; contiene estados históricos incompatibles. Sus [reportes por Task1–5](../testarudo-checkpoint-2026-09-09/reports/) dan decisiones, diseños y auditorías. Copia histórica [aquí](./historico/codex-checkpoint-inicial-con-actualizaciones.md).
4. Memorias solicitadas por el usuario: `/Users/amieva/.claude/projects/-Users-amieva-Documents-Programming-Avoqado/memory/pax-registro-del-cobro-vs-timeout-10s.md` y `testarudo-terminales-trabadas-2026-09-08-diagnostico.md` en la misma carpeta. Son contexto histórico; las conclusiones posteriores corrigieron algunas hipótesis.
5. Reglas de servidor: `.claude/rules/bounded-queries-and-server-load.md`, reglas de dinero/bitácora referenciadas por `CLAUDE.md`; reglas de TPV/Android/iOS según archivos tocados.

No hace falta volver a leer miles de mensajes ni repetir todas las consultas de producción. Este documento organiza el trabajo; la evidencia y los repos viven en esta Mac. Los históricos copiados conservan texto, pero sus enlaces relativos apuntan a su ubicación original: preferir los enlaces anteriores para navegar.

## 4. Qué se investigó ya sobre el incidente (no reabrir sin evidencia nueva)

- La cola histórica cercana a 10 s de recordPayment se investigó separando respuestas terminadas de cierres prematuros. Tras cambiar la ruta de conexión a PostgreSQL el 6-sep, se midieron p95 aproximados de 705 ms el 7-sep y 824 ms el 8-sep. No atribuir todo el atasco posterior a los 10 s.
- PAX, orden 319: se identificaron dos aprobaciones de host para el mismo request/intento tras GenericFailure y relanzamiento del SDK. Operaciones Blumon 24237797 y 24237873: primera sin Payment localizado, segunda registrada. No equiparar aprobación a liquidación definitiva ni hacer reparación financiera automática sin conciliación.
- Nexgo, orden 308: desconexión/lost ACK y pago sustituto en efectivo unos 59 s después; ausencia en CSV/webhook no prueba por sí sola que no hubo cargo.
- El 95.5% del flujo observado venía de Android POS. Los 61 reenvíos rápidos no eran todos cancelaciones ignoradas de tablet: se distinguieron 57 cancelaciones de terminal y 4 watchdog.
- Informes: `docs/investigations/testarudo-2026-09-09-android-tpv-relay.md`, `testarudo-2026-09-09-conciliacion-portales.md`, `testarudo-2026-09-08-codex.md`. CSV aportados: `/Users/amieva/Downloads/tableExport (6).csv` (Blumon), `/Users/amieva/Downloads/transacciones__.csv` (AngelPay).
- Benchmark local del código anterior: 100k filas por tabla, rollback verificado, consultas puntuales sub-ms; count ~10 ms, selección de claim ~13 ms. Ver `testarudo-2026-09-09-query-plans.md/.json`. No demuestra latencia HTTP completa ni hardware; no repetir salvo cambio relevante de query/índice.

## 5. DB, herramientas y verificaciones concretas

DB propia de integración: **`codex_testarudo_test_20260909` en localhost**. No tocar/resetear la base compartida. Se aplicaron ahí las cinco migraciones nuevas de cancelación/outbox/índices, no se desplegaron. Sacar credencial de `.env` sin imprimirla, validar localhost y sustituir pathname. Los preparadores están en `../testarudo-checkpoint-2026-09-09/lab-harness/`.

Para integración usar `--selectProjects integration unit` (integration primero) o `--selectProjects integration`, para que avq-verify la deje local. Generar Prisma cuando el cliente no coincida con schema, en la misma invocación de verificación. Nunca tomar fallo de entorno como RED de comportamiento.

Comando de la última selección TPV (desde workspace):

```sh
JAVA_HOME=$(/usr/libexec/java_home -v 23) AVQ_KEEP=1 ./scripts/avq-verify.sh avoqado-tpv ./gradlew -I /Users/amieva/Documents/Programming/Avoqado/avoqado-server/docs/investigations/testarudo-checkpoint-2026-09-09/reports/task-2-room-java17.gradle :app:testSandboxDebugUnitTest --tests 'com.jaac.avoqado_tpv.features.payment.presentation.PaymentViewModelKernelDurabilityTest.offline approval write failure keeps durable obligation and cannot publish success or cancellation' --tests '*AngelPayPaymentReviewRoomTest' --max-workers=1
```

Corrida `sbDZFC`: seis tests, cinco AngelPay pasan, uno PAX falla antes del kernel. Evidencia segura conservada en `../testarudo-audit-2026-09-10-evidence/tpv-test-results.json`, no depender de XML compartidos en `snap-*` que otra corrida puede reemplazar.

Reproductor P1 REST (NO es arreglo ni test de HTTP):

```sh
AVQ_KEEP=1 ./scripts/avq-verify.sh avoqado-server node /Users/amieva/Documents/Programming/Avoqado/avoqado-server/docs/investigations/testarudo-audit-2026-09-10-evidence/rest-attribution-DATABASE_URL.cjs
```

Corrida `hhZ2VG`: reproduce REST→COMPLETED incorrecto / SOCKET→SENT correcto, rollback, cero organizaciones sobrantes. Exit 0 significa que **reprodujo el defecto**, no que el producto pasó.

Ambas corridas avisaron cambio de huella global. Codex comparó los bytes de los archivos relevantes y coincidían con snapshots; no afirmó un verde global. Claude documentó un posible falso positivo de vigencia de avq-verify con `app/build` anidado: tratarlo como diagnóstico de tooling, no como permiso de ignorar todas las advertencias. No gastar cuatro agentes buscando quién cambió un árbol compartido.

Variantes útiles: PAX sandbox `assembleSandboxDebug`, PAX production `testProductionDebugUnitTest`/`compileProductionDebugKotlin`, Nexgo QA `assembleNexgoDebug`. No existe `nexgoSandbox`. La compatibilidad de imports del SDK puede requerir arnés por variante; no asumir que una guarda de texto demuestra comportamiento de production.

## 6. Laboratorio y terminales: estado histórico, refrescar antes de usar

El usuario autorizó PAX por depuración inalámbrica y Nexgo por USB, con tarjeta de pruebas. **No se ejecutó todavía la validación final del circuito con los arreglos actuales.** ADB debe volver a enumerarse; no dar por conectados aparatos de ayer.

- Nexgo N86, serial real `N860W173397`, identificador Avoqado `AVQD-N860W173397`. Última instalación observada por Codex: sandbox 105/2.9.1. Claude reportó preparado un APK 2.9.2 (107), aún no instalado: verificar artefacto, hash, flavor, backend y afiliación, no asumir que ese APK contiene TODO el trabajo actual.
- PAX A910S, serial `2841548417`, `AVQD-2841548417`; última observación Codex sandbox 104/2.8.7. La conexión inalámbrica se perdió. Pedir IP:puerto/pareo sólo si ADB no puede recuperarla. Usuario había colocado tarjeta insertada; comprobar situación actual al hacer QA.
- Había otra OrderPAD en `192.168.1.122`; no tocar por asumir que es la tablet autorizada. Identificar con el usuario el POS de pruebas si falta.
- DB lab **`codex_testarudo_lab_20260909`** fue creada desde la DB propia de tests. El bootstrap/seed/login/proxy NO se completó. Scripts seguros copiados en `lab-harness`; tienen rutas /tmp que se deben revisar. No usar el script demo que apunta a producción ni arrancar `server.ts` con jobs/proveedores por accidente.
- El launcher previsto usa app+Socket.IO, secretos nuevos, entorno saneado y puerto 18800. Su guardia de TCP sólo fue probada con cuatro tests; no es certificación de aislamiento de SDK nativo. No tocar el servidor ajeno en 3000.
- `-Pavoqado.devBaseUrl` afectaba REST, mientras el socket dev apuntaba a ngrok. Verificar/corregir coherencia de ambos antes de QA. El sufijo sandbox no garantiza afiliación/backend de pruebas. Los metadatos de cuentas QA y fuentes para sembrar están en el checkpoint inicial, no exponer credenciales.

QA de aceptación: Android envía venta → TPV cobra → contrastar portal Blumon/AngelPay, Payment de Avoqado y saldos/estado de la orden. Cubrir normal/rechazo, cancelar desde POS durante SDK y reenviar, red/DNS/servidor lento, aprobación seguida de fallo de registro, cierre/reinicio/recuperación, resultado/job duplicado y reembolso. Una operación bancaria, registro correcto, cero reautorización mientras el desenlace esté incierto. Una prueba física favorable no corrige tests rojos ni sustituye auditoría.

## 7. Estado Git y alcance de la captura

| Repo | Rama | HEAD a la captura |
|---|---|---|
| avoqado-server | develop | 74bebba2aedf92c358affd4a52d7f0660dbee9e8 |
| avoqado-tpv | main | aea0169507e3c8f62ca02121e8f79cef7d78485a |
| avoqado-android | main | 46c5cdcd86381e5d9886e22649e8ff0135d75052 |
| avoqado-ios | main | b7ad204fa2573ea115f0125e21a022f00abd631e |

[manifest.json](./manifest.json) guarda hashes de fuentes WIP, no autoría ni una orden de restauración. Los cuatro archivos `*-status.txt` capturan índice/working tree. La base de comparación de la etapa inicial está en el manifest del checkpoint del 9-sep. El HEAD de server y Android avanzó por otras sesiones (watchdog/inventario), no revertir esos commits.

El nuevo LLM debe continuar A→B→integración→QA/auditoría final, actualizar ESTE documento con estado vigente y enlazar evidencia. Preservar historia aparte sin acumular "abierto/cerrado" contradictorios. Sólo detener trabajo dependiente por un bloqueo real y explicar qué falta; continuar lo independiente autorizado.

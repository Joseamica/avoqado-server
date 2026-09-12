# RELEVO — 11-sep-2026, noche. Cobro remoto tablet → terminal (Testarudo): A, B, §8 y Nexgo

**Para quien retome este trabajo.** Este documento es autónomo: no hace falta leer la conversación anterior.
Lo escribo porque la cuota se agotó y **cuatro agentes murieron a media tarea** (límite de sesión, HTTP 429). Aquí está
todo: lo hecho, lo descubierto, lo auditado, lo que quedó a medias y lo que falta, con sus rutas y comandos.

**Nada está commiteado, pusheado ni desplegado.** Instrucción vigente del founder.

---

## 0. Lo que NO se debe hacer

1. 🔴 **No desplegar el servidor tal como está.** El árbol tiene el predicado estricto activo: el día del despliegue
   bloquearía 375 filas históricas de producción y **todavía no existe B**, que es la única salida. Orden seguro: §7.
2. 🔴 **Nunca `git add`, `commit`, `stash`, `reset`, `checkout .`, `clean` ni cambio de rama.** El árbol es compartido
   por ~20 sesiones. Hoy alguien hizo `git stash` en `avoqado-server` y se llevó el WIP de 71 archivos de varias
   sesiones (13:45:38, reflog `reset: moving to HEAD`). Se restauró con `git stash apply`. **`stash@{0}` sigue ahí
   como respaldo: no volver a aplicarlo.** Borrarlo lo decide el founder, idealmente después de commitear.
3. 🔴 **No debilitar pruebas.** Si una prueba vieja choca, entender por qué y ajustarla sin perder lo que guarda.
4. 🔴 **Sabotaje sólo en copias aisladas** (worktree + rsync), nunca en el árbol compartido.
5. **Máximo dos agentes pesados a la vez** (decisión del founder, 11-sep: la Mac estaba con carga 869 sobre 10
   núcleos y 1.4 GB de swap libre).

## 1. Mapa de documentos (todos en `avoqado-server/docs/investigations/testarudo-relevo-2026-09-10/`)

| Archivo | Qué es |
|---|---|
| `README.md` | Relevo maestro. §2-bis, §2-ter y §2-quater (11-sep) son el estado vigente con evidencia |
| `diseno-A-B-seccion8-2026-09-11.md` | **Diseño v3.** Su sección I (veredicto del auditor) MANDA sobre las anteriores |
| `auditoria-fable-diseno-A-B-s8-2026-09-11.md` | Veredicto independiente por sección, con archivo:línea |
| `investigado-11-sep-diseno-A-B-s8.md` | 40 hallazgos de 6 revisores + 32 veredictos de escépticos + investigación D.7 + puntos V1–V5 de Codex |
| `nexgo-auth-arranque-sin-red-2026-09-11.md` | Verificación por código del defecto de Nexgo, con evidencia de producción |
| `codex-auditoria-diseno-A-B-s8.md`, `codex-auditoria-investigado-11-sep.md` | Textos listos para pegar en Codex |
| `409-cancelar-orden-2026-09-11.md` y su auditoría | El incidente que originó C.6 |
| Regla del circuito | `avoqado-tpv/.claude/rules/cobro-remoto-pos-a-tpv.md` (léela antes de tocar cualquier lado) |

## 2. La decisión del founder (11-sep) y qué significa

- **A** (identidad de bandeja) es la recuperación automática; **B** (liberación con conciliación documentada) es el
  respaldo; **C descartada**. Condiciones de A: el servidor guarda el identificador de la bandeja antes de enviar;
  sobrevive reinicios; pérdida o restauración (incluida una copia antigua con el mismo id) invalida la identidad;
  NOT_FOUND libera sólo con continuidad acreditada y con la lápida escrita antes de responder; id cambiado, datos
  faltantes o solicitud histórica no liberan; A no es retroactivo para APK viejos.
- **B** exige conciliación documentada **y** prueba de que el intento ya no puede autorizar. La ausencia de la
  operación en el portal, por sí sola, no basta.
- **El founder audita; la sesión implementa** (instrucción del 11-sep, para no gastar tokens dos veces).
- Condición de dinero que domina todo: **nunca un cobro doble ni uno perdido**. Timeout, cancel, desconexión o
  ausencia de `Payment` NO prueban ausencia de cargo.

## 3. Veredicto del auditor independiente (Fable 5.1; Codex se quedó sin créditos a los 10 min)

| Sección | Veredicto | Qué cambia |
|---|---|---|
| A | APROBADO CON CAMBIOS | El mecanismo se queda. Contador ACTUAL en cada reconexión (o la regresión se juzga contra el último handshake); reactivar una identidad cuando su contador ≥ su propia marca; `fsync` del directorio tras el rename y `PRAGMA synchronous = FULL`; no admitir cobros en un socket no confiable (lápida pre-fila) |
| B | **RECHAZADO** hasta reescribir sus bases | `TERMINAL_FINAL_ANSWER` sólo con respuestas negativas con evidencia (nunca NOT_FOUND de otra identidad ni RESOLVED-éxito); `DEVICE_DECOMMISSIONED` exige un handshake posterior con identidad distinta (el ACK del FACTORY_RESET sale ANTES de borrar); `lastProbe*` debe vivir en la fila (hoy en memoria); `LEGACY_NO_RESUME` sólo para 2.8.x (las Nexgo 2.9.x SÍ reanudan la bandeja); el lote va POR TERMINAL con ventana comprobada; la vigilancia de 72 h necesita escritor vivo |
| C.1 | APROBADO CON CAMBIOS | Lista blanca por `(status, failureCode)`, incluidos los códigos que HEAD ya escribió (`AUTO_RELEASED`, `MANUAL_RELEASE`, `MANUAL_RECONCILE` ⇒ UNRESOLVED); **conservar `cancelDisposition = ACCEPTED`** (anularlo deja sin salida la llave de Android 2.18.3 y del iOS del árbol); las filas EN VUELO siguen bloqueando |
| C.3 | APROBADO CON CAMBIOS | La lápida de admisión cierra el hueco si la decisión va dentro del candado, la fila se escribe en la misma transacción y **todos** los rechazos pre-fila la dejan |
| D (Nexgo) | APROBADO CON CAMBIOS | La recuperación de fondo NO produce cobro por otra afiliación (las guardas existen); queda P2: evaluar la alineación contra la sesión que el SDK va a usar, dentro del mismo candado |
| F (despliegue) | **RECHAZADO** | Sustituido por el orden de §7 |

## 4. Lo que se implementó hoy (código en el árbol, con pruebas)

| Pieza | Repo | Evidencia |
|---|---|---|
| **T26 · Nexgo**: la auth de AngelPay se recupera sola al volver la red; el cobro autentica ANTES de la espera de 8 s del comercio; tres errores distintos (`SIN_RED`, `SIN_CREDENCIALES`, `CUENTA_NO_EN_CONFIG`) y sin red ya no cae a la cuenta primaria; `app_terminal_serial` real; candado único desde `startCardPayment` hasta lanzar el SDK; alineación contra la sesión viva; el efectivo ya no se apaga durante la auth de fondo | tpv | `run-avoqado-tpv.yE31tx`: 318 pruebas, 1 falla ajena; compilan nexgoDebug y productionDebug; 11 sabotajes confirmados |
| **D.7 · Un cobro hablando por otro**: la navegación congela los argumentos de cada cobro en su propia entrada y los borra del lanzador; los dos ViewModels (AngelPay y Blumon sandbox+production) fijan la fuente en su PRIMERA asignación y rechazan otro id, con non-fatal a Crashlytics | tpv | ROJO `f6WiF3` (4) y `4qDWqG` (5); VERDE `NQVXzK` 449/0 incluidas las 117 de PaymentViewModelTest; compila; sabotaje `M6NGfi` (8 caídas exactas) |
| **C.6 · Rutas que cancelan órdenes**: helper `orderCancelGuard.ts` (candado de la orden, relectura, 400 con dinero, 409 `ORDER_CANCEL_BLOCKED_BY_TERMINAL_CHARGE` + `details.requestId`) usado por cancelOrder móvil, DELETE y PUT del dashboard, anular artículos, fusión (origen) y vales; POS-sync y delivery avisan con 🚨 sin rechazar; anular por debajo de lo cobrado ⇒ 400 `ORDER_VOID_BELOW_PAID`; `details` en la cola offline; `ORDER_UPDATED` tras el commit; toast real en el dashboard | server + web-dashboard | integración 44/44 · unitarias 1328 (COINCIDEN `run-avoqado-server.tWUabE`) · typecheck 0 (`.grAorp`) · dashboard `tsc -b` 0 (`.7KMzCj`) · 34 sabotajes |
| **Lápida de admisión (H.5/H.6)**: todo rechazo pre-fila (404 `TERMINAL_NOT_CONNECTED`, 422 `TERMINAL_NO_SOCKET`, 403 `TERMINAL_NOT_IN_VENUE`, 409 `TERMINAL_BUSY`, 400 `ORDER_CANCELLED_NO_NEW_CHARGE`, 409 `ORDER_ALREADY_PAID`, 400 `ORDER_NOT_FOUND`) se decide bajo el candado y deja una fila `FAILED` + `REJECTED_*` con la respuesta original; una copia tardía del mismo POST reproduce el rechazo y nunca crea; P2028/P2034 ⇒ 503 `TERMINAL_PAYMENT_ADMISSION_RETRY` (reintentar con el MISMO requestId) | server | ROJO: la segunda copia se emitía. VERDE en el árbol con C.6 encima: integración 121/121 (`run-avoqado-server.s7srT3`), unitarias 987 en 86 suites (COINCIDEN `.0dUw0d`), typecheck 0 (COINCIDEN `.xnBxya`) |

## 5. Lo que quedó A MEDIAS (los 4 agentes que murieron por cuota, 11-sep ~17:0x)

Ninguno entregó reporte. Esto es lo que se ve en el árbol; **verifícalo antes de seguir**.

### 5.1 Servidor · contrato C.1/C.2 (agente `aa7be549…`)
Su última línea fue «Both avq-verify runs are green and coincide. Final confirmation on the current tree for my files»,
o sea que estaba casi terminado. Debía dejar: `desenlaceCanonico` exportada (lista blanca por `(status, failureCode)`),
campos `outcome` / `outcomeEvidence` / `evidenceClass` / `reconciliationRequired` en el GET, traducción de `status`
por lista blanca (una lápida NO se traduce: sale FAILED), `cancelDisposition` conservando `ACCEPTED`, predicado de
bloqueo equivalente con las filas en vuelo dentro, `resultFromRow` usando la misma función, POST cancel con
`cancelIntent` / `cancelEmitted` / `payment`, errores tipados propagados, y el MCP con la misma proyección.
**Qué hacer:** `git diff` de `src/services/terminal-payment.service.ts`, `src/controllers/mobile/terminal-payment.mobile.controller.ts`
y `src/mcp/tools/terminals.ts`; correr las pruebas de §8 y completar lo que falte.

### 5.2 TPV · lote N3 (agente `a45b0f12…`)
Murió justo al empezar la capa de ViewModels («Now let me write the AngelPay ViewModel edit spec»). Lo que debía
hacer, en orden: (a) Room **v34** con `cancel_accepted_at`, `execution_started_at`, `final_emitted_at` en
`remote_payment_requests` y `legacy_shadow` en `payment_attempts` (marcando en 1 las filas existentes); (b) CAS del
cancel tras reclamar, en una transacción de Room; (c) cerca durable en `reserveTerminal` (lápida, cancel aceptado o
final emitido ⇒ ningún intento nuevo); (d) las filas `legacy_shadow` no reservan la terminal pero se siguen contando;
(e) CAS de efectivo y cripto, y ocultarlos en cobros SOCKET (interino); (f) una sola tabla de códigos de rechazo.
Después venía la capa de ViewModels: H.3 (retener el final mientras haya «Reintentar»; al salir, `failed +
PROCESSOR_DECLINED`), evidencia por intento, aviso del cancel en pantalla y `terminalPaymentCancelDispositionVersion = '2'`.
🔴 **Dejó una copia de sabotaje sin borrar:** `avoqado-tpv/.claude/worktrees/sabotaje-c5`. Comprueba que el árbol
compartido no tenga sabotaje y bórrala con `git -C avoqado-tpv worktree remove --force .claude/worktrees/sabotaje-c5`.

### 5.3 Android · cancelación durable C.4 (agente `ac2311a7…`)
Estaba en la fase de sabotaje («Sabotage 5 proves the fold-level guard is the one that carries the weight»), o sea que
la implementación y las pruebas ya existían. Tocó: `PaymentFlowViewModel`, `PaymentFlowScreen`, `PaymentResultScreen`,
`PaymentModels`, `TerminalPaymentService`, `OrderRepository`, `CardChargeOutcome`, `ServerErrorText`, `AvoqadoApp`,
`AvoqadoNavGraph`, `QuarantineSheet/ViewModel`, mesas y 7 archivos de prueba. **Verifica** que la compilación y
`payment/` estén en verde, y revisa si dejó worktrees en `.claude/worktrees/agent-*`.

### 5.4 iOS · cancelación durable C.4 (agente `af97f168…`)
Murió esperando un build. Es el que menos avanzó y el que más riesgo tiene de haber quedado a medias. Sus archivos de
interés: `Payment/PaymentFlowViewModel.swift`, `PaymentFlowView.swift`, `PaymentModels.swift`, `PaymentResultViews.swift`,
`CardChargeOutcome.swift`, `Services/TerminalPaymentService.swift`, `OrderRepository.swift`, `APIClient.swift`,
`Database/DatabaseManager.swift`, `Protocols/Repositories.swift`, `Components/QuarantineView.swift`, `POS/Views/MainTabView.swift`.
⚠️ En ese repo hay WIP de OTRAS sesiones (Inventory, Printing, CashDrawer): no lo toques.
**Verifica primero que el proyecto compile** antes de seguir.

### 5.5 Textos que deben ser idénticos en Android y iOS
| Situación | Texto |
|---|---|
| Cancelando | «Cancelando el cobro…» |
| Pendiente, título | «Cancelación pendiente» |
| Pendiente, cuerpo | «La terminal todavía no confirma que el cobro se detuvo. La venta se cancelará sola en cuanto conste que no se cobró.» |
| Botones | «Volver a consultar» · «Salir (queda pendiente)» · «Cancelar la venta» |
| Sin red en la tablet | «Sin conexión en esta tablet: la cancelación se enviará en cuanto vuelva la red. La terminal podría seguir mostrando el cobro.» |
| No se pudo guardar | «No se pudo guardar la cancelación en este equipo. Inténtalo de nuevo.» |
| Se cobró al final | «La terminal sí cobró este pago: la venta queda pagada.» |
| Banner | «Cancelaciones pendientes: N» |
| Terminal no conectada | «La terminal no está conectada. Este cobro NO se envió; no se cobró nada.» |
| Cuenta cancelada | «La cuenta está cancelada: este cobro NO se envió, no se cobró nada.» |
| Cuenta pagada | «La cuenta ya está pagada. Este cobro NO se envió.» |
| Cuenta inexistente | «La cuenta ya no existe. Este cobro NO se envió.» |
| Anular o fusionar con cobro vivo | «Hay un cobro con tarjeta en curso para esta cuenta: cancélalo o espera a que termine.» |

## 5-bis. ACTUALIZACIÓN de la noche del 11-sep (sesión siguiente)

### Las cuatro piezas de §5 NO estaban a medias: estaban SIN VERIFICAR. Ya están verificadas.

Los cuatro agentes murieron **después** de implementar. Medido:

| Pieza | Evidencia |
|---|---|
| Servidor · contrato C.1/C.2 | 245 pruebas en 9 suites, local y alien **COINCIDEN** (`run-avoqado-server.vt3syr`). Los 9 elementos que §5.1 enumeraba están, incluidos los errores tipados (P2-14) |
| TPV · lote N3 | 82 pruebas en 9 clases, 0 fallos. Room v34, cerca durable, efectivo/cripto ocultos en SOCKET, `cancelDispositionVersion='2'`, tabla única de textos |
| Android · cancelación durable | 409 pruebas en 26 clases, 0 fallos |
| iOS · cancelación durable | 101 pruebas en 5 clases, `** TEST SUCCEEDED **` (destino `iPad Pro 11-inch (M4)`, id `087E1EDF-…`; el nombre «iPad Air 11-inch (M2)» NO es elegible para este esquema) |
| Textos §5.5 | los 15 coinciden palabra por palabra entre Android e iOS; sólo difieren logs internos |

**Lo único roto eran 2 pruebas del TPV** que el cambio de H.3 dejó desactualizadas (esperaban `cancelled` y un
`ResultadoIncierto` mudo). Se actualizaron APRETÁNDOLAS. 98/98.

🔴 **Y el sabotaje destapó algo que conviene saber: H.3 vive en DOS capas redundantes** —
`emitirDeclinacionRetenida` manda `failed` directo y `statusFinal` lo corregiría si llegara `cancelled`—. Rota
UNA sola, las 98 siguen en verde; rotas las DOS caen 6. Queda escrito en el propio código para que nadie borre
la segunda creyendo que alguna prueba la cubre. El worktree `sabotaje-c5` se borró; el árbol quedó limpio.

### El interruptor (pieza 2): CONSTRUIDO, auditado por Codex y corregido

`codex-auditoria-interruptor-2026-09-11.md` (el encargo) y `…-RESULTADO-…md` (el veredicto, gpt-6-astra high).
**Codex RECHAZÓ la v1: 4 P1 + 3 P2.** Todos atendidos.

🔴 **La decisión del founder (11-sep, con los números de producción enfrente): el interruptor relaja SÓLO la
ranura física de la terminal. El bloqueo por ORDEN es estricto SIEMPRE.** Medido en producción ese día
(sólo lectura): **386** filas bloquearían al desplegar (no 375: siguen creciendo), **386 con `orderId`**, y sólo
**29 cobros sobre 27 CUENTAS distintas** con la orden todavía abierta (0 de ellas ya pagadas) — Testarudo 24, Amaena 5, del 27-ago al 11-sep. O sea: destrabar la ranura
desbloquea 386 aparatos; conservar el candado de orden protege las 29 donde de verdad cabe un cobro doble.

Forma final: `Venue.terminalPaymentStrictEnabled` (encendido) **+** `terminalPaymentStrictSince` (el corte),
**separadas a propósito** — apagar conserva la fecha, así que reencender no desplaza el corte ni descubre el
periodo ya protegido. Migración `20260911200000`, aditiva e idempotente, aplicada a las bases LOCALES.

Qué se corrigió de la auditoría:

- **P1-1 · el candado de la orden**: estricto siempre, apagado el interruptor o no. ✅ cerrado.
- **P1-2 · el rodeo del pago rápido: NO está cerrado, y el rastro que se añadió cubre un camino que en
  producción casi no existe.** Un cobro sin `orderId` no pasa por el candado de orden; se le puso un 🚨 con el
  monto y la venta del bloqueador (no un bloqueo: el servidor no puede distinguir «misma venta» de «venta
  nueva», y bloquear volvería a trabar el aparato). 🔴 Pero medido en prod el 11-sep (auditoría de Fable):
  **1 sola fila remota sin `orderId` en toda la historia** contra 1477 con orden en 30 días — la tablet siempre
  manda la cuenta. El recobro realista es el **Pago rápido LOCAL de la terminal**, que no pasa por la admisión
  del servidor ni por ningún candado, y sigue siendo la decisión de producto pendiente del §8. **Tratarlo como
  resuelto sería falso.**
- **P1-3 · la caché**: `invalidarVenuesEstrictos` forzaba una lectura que podía ser ANTERIOR al cambio, así que
  apagar el interruptor podía no surtir efecto. Ahora espera una lectura que empieza después. El `findMany` lleva
  `take`.
- **P1-4 · el estado sin salida: cerrado A MEDIAS, y el matiz importa.** Una `COMPLETED` **sin** `Payment`
  bloqueaba, la sonda no le preguntaba (se excluían TODAS las COMPLETED «por ser dinero registrado») y la
  liberación manual sólo acepta `UNKNOWN`. Ahora se excluye sólo la COMPLETED **con** pago, así que **la sonda
  sí la alcanza con evidencia negativa**. 🔴 Lo que sigue sin alcanzarla es un **`Payment` tardío**:
  `closeRowFromPaymentTx` filtra `status ≠ COMPLETED` (`:1971`), o sea que si el dinero aparece después, esa
  fila no se cierra por esa vía. Medido en producción: **0 filas** en ese estado (1093 COMPLETED, todas con
  pago), así que es teórico — pero no está cerrado del todo.
- **P2-5 · equivalencia**: `failureCode` llamado `constructor`/`__proto__` encontraba una propiedad HEREDADA y
  acreditaba un «no se cobró» con evidencia `undefined`; y `paymentId` cadena vacía divergía entre JS y SQL. Los
  dos alineados **hacia el lado seguro** (retener la ranura), con aserciones directas además de la tabla.
- **P2-6 · la vista previa mentía**: contaba la diferencia entre regímenes SIN aplicar el corte. Ahora da dos
  números —las que quedarán reservadas y **las que el corte NO va a cubrir**— y, al apagar, cuántas protecciones
  se retiran.
- **P2 · permiso**: subido a **superadmin**. `tpv:update` lo tiene MANAGER (`permissions.ts:1019`) y esto lo
  opera Avoqado, no el negocio.

**Verificado:** 128 de integración contra Postgres real (las 3 suites), 89 + 71 unitarias, typecheck 0.
Las 12 pruebas que el cableado puso en rojo: **5 volvieron solas** al devolver la orden a estricto y **7 (todas
de ranura física) se mudaron al régimen estricto** con `encenderRegimenEstricto()` — ninguna se debilitó.

⬜ **Lo que Codex deja abierto y NO se hizo:** el control canónico en el dashboard (hoy sólo MCP), el recorrido
justo de la sonda (siempre las 25 más antiguas ⇒ la 26 puede no sondearse nunca), la vigilancia de 72 h de I.2
(hoy 30 min y sólo `TIMED_OUT`), y comprobar capacidad/confianza del socket al activar. **`bloqueaLaRanura` sigue
sin consumidores de producción: su razón de ser es la prueba de equivalencia.**

⬜ **Y los tres de su P2-7, que la primera versión de esta sección se saltó** (los añade la auditoría de Fable):
el `busy` del MCP (`terminals.ts:241`) se calcula con `desenlaceCanonico` e **ignora el interruptor**, así que una
histórica puede figurar ocupada ahí mientras el selector y la admisión la dan por libre; **abrir un reembolso**
conserva su propio filtro `status IN SLOT_HELD` (`:2575`), así que una fila estricta puede impedir cobrar y a la
vez dejar abrir la devolución en ese aparato; y el listado del MCP **corta en 100 sin paginar**, con
`busyTerminals` derivado sólo de esas 100.

🔴 **Un matiz sobre «apagado = exactamente producción hoy»:** es cierto para el PREDICADO (mismo `SLOT_HELD`),
pero el árbol **retiró** la liberación automática de `UNKNOWN` a los 20 min que producción sí tiene hoy
(`d26bb746`). Tras desplegar, un `UNKNOWN` nuevo bloquea **hasta que exista B**. Está en §6.2, pero el comentario
del código (`terminal-payment.service.ts:352`) no lo dice.

## 6. Lo que falta, en orden

1. **Terminar las cuatro piezas de §5** (contrato del servidor, lote N3 de la TPV, cancelación durable de Android y de iOS).
2. **Interruptor por venue del predicado estricto** (servidor, pieza chica): apagado ⇒ bloquean sólo las filas en vuelo
   y las UNKNOWN (lo que hoy bloquea producción, sin liberación por tiempo, que el founder no autorizó); encendido ⇒
   lista blanca estricta, y las filas anteriores a la fecha de encendido de ese venue se evalúan con el predicado viejo.
   Esta definición la tomé por defecto: es reversible y el founder puede cambiarla.
3. **B reescrita** (servidor + MCP + permisos), con las bases de §3 y el modo lote POR TERMINAL.
4. **A**: servidor (tabla `TerminalPaymentInbox`, identidad por entrega, posesión, replay a la misma bandeja, regla de
   liberación por continuidad) y terminal (centinela, contador, espejo en `noBackupFilesDir`, rotación y cuarentena).
5. **Pruebas físicas** (§7) y las decisiones de producto pendientes (§8).

## 7. Orden de despliegue aprobado (sustituye al anterior)

1. **Servidor #1** con B, procedencia, lápida de admisión y la migración acotada por fecha, pero con el **predicado
   estricto apagado por venue**: nada nuevo bloquea.
2. **Conciliar las 375 filas con B**, por terminal (343 CANCELLED sin disposición, 30 FAILED/TPV_ERROR, 2 TIMED_OUT;
   medido en producción el 11-sep, sólo lectura).
3. **APK por terminal**, sólo con esa terminal sin filas en vuelo ni UNKNOWN y **conservando Room**.
4. Con el **100 %** de las terminales del venue en el APK nuevo, **encender el predicado** para ese venue.
5. **Apps POS al final**; iOS con `releaseType = MANUAL`.

**Además:** un APK de retroceso (la 2.9.2 recompilada con esquema v34 y migración sin efecto), porque la 2.9.2 borra la
base al bajar de versión y se llevaría cobros aprobados sin registrar; la libreta SHADOW de las 2.9.2 necesita un paso
de migración al primer arranque; exención de Doze en las PAX; y las pruebas físicas con tarjeta y sin red en PAX,
Nexgo, tablet Android e iPad.

## 8. Decisiones de producto pendientes del founder

1. **Efectivo en un cobro remoto.** Hoy la terminal lo ofrece, registra CASH y el servidor sólo cierra con tarjeta:
   la fila queda UNKNOWN con el dinero cobrado. Interino propuesto: ocultar efectivo y cripto en cobros SOCKET.
2. **Quién puede liberar con B** (se propuso un permiso nuevo `terminal-payments:reconcile` para OWNER y ADMIN).
3. **Qué hacer con las 21 + 3 órdenes huérfanas** de producción.
4. **Borrar `stash@{0}`** de `avoqado-server` después de commitear.

## 9. Trampas ya pagadas (no repetirlas)

- **`avq-verify` sale con código 0 aunque falle por dentro.** El veredicto está en el CUERPO: `exit=`, `Tests:`,
  `errores TS:`, `COINCIDEN`/`DIFIEREN`. Una salida sin totales es INCONCLUSA.
- **Mandarle un mensaje a un agente que está dentro de un flujo levanta una SEGUNDA copia** que trabaja en paralelo
  sobre los mismos archivos. Si necesitas corregir el rumbo, mejor deja terminar y haz una ronda aparte.
- **El clasificador de permisos bloquea `git apply` a la sesión.** El founder lo corre con `!`.
- **Un `grep --include=*.kt` sin comillas en zsh no falla: no encuentra nada.** Así concluí mal que el downgrade de
  Room no era destructivo. Lo corrigió Codex: `DatabaseModule.kt:162` sí tiene `fallbackToDestructiveMigrationOnDowngrade`.
- **El daemon de Kotlin se queda sin memoria** con la Mac cargada: `--max-workers=1 -Pkotlin.compiler.execution.strategy=in-process`.
- **Producción es sólo lectura**, con `PGOPTIONS="-c default_transaction_read_only=on"`; la URL vive en
  `RENDER_DATABASE_URL` del `.env` y nunca se imprime.
- **Base de pruebas**: sólo `codex_testarudo_test_20260909`, derivando la URL de `DATABASE_URL` y comprobando el
  destino antes de correr. Nunca comandos que puedan vaciar `av-db-25`.

## 10. Comandos de verificación

```
# Servidor: integración (Postgres real)
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server
DB=$(grep -E '^DATABASE_URL=' .env | cut -d= -f2- | tr -d '"')
export TEST_DATABASE_URL=$(python3 -c "import sys,urllib.parse as u; p=u.urlsplit(sys.argv[1]); assert p.path=='/av-db-25'; print(u.urlunsplit(p._replace(path='/codex_testarudo_test_20260909')))" "$DB")
npx jest --selectProjects integration --runInBand --runTestsByPath tests/integration/payments/terminalPaymentRecovery.integration.test.ts tests/integration/payments/orderCancelRoutes.integration.test.ts

# Lo pesado, siempre por la fila (desde la raíz del workspace)
cd /Users/amieva/Documents/Programming/Avoqado
AVQ_KEEP=1 ./scripts/avq-verify.sh avoqado-server npx tsc -p tsconfig.typecheck.json
AVQ_KEEP=1 ./scripts/avq-verify.sh avoqado-server npx jest --selectProjects unit --testPathPattern "terminal-payment|terminalPayment|order" --ci
JAVA_HOME=/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home AVQ_KEEP=1 ./scripts/avq-verify.sh avoqado-tpv ./gradlew :app:testSandboxDebugUnitTest --tests '*AngelPay*'
AVQ_KEEP=1 ./scripts/avq-verify.sh avoqado-android ./gradlew testDebugUnitTest --tests '*payment*'
```

## 11. Estado de git al cerrar (11-sep, noche)

| Repo | Archivos con cambios | Nota |
|---|---|---|
| avoqado-server | 160 contra HEAD | Incluye WIP de otras sesiones. `stash@{0}` es respaldo del incidente; worktree `lapida-admision-0911` se puede borrar |
| avoqado-tpv | 67 | Worktree `sabotaje-c5` **pendiente de borrar** |
| avoqado-android | 24 + 16 sin rastrear | C.4 a medias |
| avoqado-ios | 45 + 25 sin rastrear | C.4 a medias; hay WIP ajeno de inventario e impresión |
| avoqado-web-dashboard | 14 | Toast del 409 |


## 12. Verificación del árbol DESPUÉS del corte (11-sep, 17:51–18:01)

Corrida en cadena, de una en una, con los cuatro agentes ya muertos y su trabajo a medias en el árbol:

| Repo | Comprobación | Resultado |
|---|---|---|
| avoqado-server | `tsc -p tsconfig.typecheck.json` por avq-verify | **0 errores**, local y Alienware COINCIDEN |
| avoqado-tpv | `:app:compileSandboxDebugKotlin` + `:app:compileProductionDebugKotlin` | **exit 0** (275 s) |
| avoqado-android | `compileDebugKotlin` | **exit 0** (15 s) |
| avoqado-ios | `xcodebuild` | ⬜ **NO se corrió** (es lo más pesado y la Mac estaba saturada). Es lo PRIMERO que hay que comprobar antes de tocar iOS |

O sea: los tres árboles que se comprobaron quedaron consistentes; lo que falta de las piezas a medias es
funcionalidad y pruebas, no código roto. Las suites completas NO se volvieron a correr después del corte: córrelas
antes de construir encima (comandos en la sección 10).

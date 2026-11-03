# Cobro remoto POS → TPV (lado que ARBITRA)

🔴 La regla completa vive en `avoqado-tpv/.claude/rules/cobro-remoto-pos-a-tpv.md` — léela antes de
tocar `src/services/terminal-payment.service.ts`, `terminal-payment.mobile.controller.ts`,
`terminal-registry.ts` o los handlers de socket de terminal. La terminal **no está en una pantalla
fija** cuando llega el cobro: hay una matriz «estado de la terminal × evento» que hay que declarar y
probar en hardware, con los tres lados leídos (servidor, terminal, POS).

**Condición obligatoria** (founder, 10-sep): nunca volver a autorizar con un desenlace pendiente ni perder
evidencia de dinero. Dentro de esa condición, las prioridades son: cobro disponible y sin demoras
evitables; registro correcto y recuperable; obligaciones con responsable; pantalla honesta.

Invariantes de este lado, ya construidos y con prueba — no los debilites:

- **UNA solicitud en vuelo por terminal Y por orden**: el 409 dice monto, antigüedad y aparato
  (`blockingRequest`), sólo de filas del mismo venue; sobre una orden con desenlace pendiente no se inicia
  otro cobro (ni en otra terminal) ni se cancela la orden para eludirlo.
- **Nunca liberar a ciegas**: `UNKNOWN` retiene la ranura. La recuperación es por EVIDENCIA de la
  propia terminal (sonda a quien declara `terminalPaymentProbeVersion`; `outcomeEvidence`
  acreditada; `cancelDisposition ACCEPTED` sólo si la terminal contesta), nunca por plazo — decisión
  del founder del 10-sep (no se autorizó liberar por 2/20 min + latido + ausencia de Payment).
  **El webhook del procesador TAMBIÉN es evidencia** (founder, 21 y 23-sep; memorias root
  `webhook-del-banco-antes-que-preguntarle-al-cajero` y `webhook-angelpay-llega-en-segundos-y-el-silencio-si-informa`):
  (1) un RECHAZO del webhook correlacionado con la fila libera la ranura (AngelPay por `integratorReference` =
  `attemptId`; Blumon por la ranura, porque una terminal sólo tiene un cobro en vuelo); (2) en un comercio con
  webhook COMPROBADO (cada uno de sus últimos 10 cobros con tarjeta tiene su `ProviderEventLog`), si al reabrir
  la terminal el webhook no llega en 10 s, se libera sola, y si llega tarde se avisa «ese cobro SÍ pasó».
  Sin webhook comprobado (p. ej. ESTOCOLMO/Doña Simona) el silencio no prueba nada. Esto es evidencia, no
  plazo: no contradice la regla de arriba ni la debilita en ningún otro caso.
  **Procedencia de cada entrega (11-sep, plan D de Codex):** `TerminalPaymentRequest.deliveryProvenance`
  (`{deliveries:[{protocol:'LEGACY'|'DURABLE', ackVersion, cancelDispositionVersion, probeVersion, socketId,
  at, replay}]}`, migración `20260911150000`) se escribe con `$executeRaw` ANTES de emitir, en los dos
  protocolos; si no se puede grabar, no se emite y la fila queda UNKNOWN/`DELIVERY_NOT_RECORDED`. `null` =
  procedencia DESCONOCIDA (fila anterior a la columna) y nunca se lee como «no entregada»; `[]` = creada y
  nunca entregada. NOT_FOUND de la sonda libera (`FAILED/TPV_NEVER_RECEIVED`, `NOT_FOUND_NEVER_DELIVERED`)
  SÓLO filas con procedencia exactamente `[]`, y esa condición va dentro del propio UPDATE; con entregas
  (legacy o durable con ACK perdido) o procedencia `null` se conserva la reserva y se audita UNA vez
  `TERMINAL_PAYMENT_PROBE_UNACCREDITED` (`NOT_FOUND_AFTER_DELIVERY` / `NOT_FOUND_UNKNOWN_PROVENANCE`). El
  replay al reconectar (`replayPendingForTerminal`) reentrega SÓLO filas cuya procedencia es DURABLE — una
  entregada a un socket legacy o de procedencia desconocida no se reenvía a una bandeja que no la conoce
  (auditoría `TERMINAL_PAYMENT_REPLAY_SKIPPED`, una vez). Una entrega en tránsito SÍ puede
  cruzarse con una sonda (la fila pasó a UNKNOWN mientras el mensaje viajaba). Lo que lo hace seguro no es que los
  estados estén separados: es que la procedencia ya no está vacía (el servidor no libera) y que la lápida de la TPV
  (`NOT_FOUND_ANSWERED`, `insert IGNORE`) rechaza la entrega que llegue después del NOT_FOUND — es la entrega tardía
  que Codex pidió bloquear. El ACK de un replay sólo confirma una fila PENDING: nunca renueva la vigencia de una SENT
  (la dejaría «en curso» para siempre) ni revive una cerrada o en cancelación. TDD del
  11-sep: unit 69/69, integración 57/57 contra Postgres, sabotajes A/B/C en copia aislada, typecheck 0 local
  + Alienware. Commiteado el 12-sep (`9dcc216e`; la migración `20260911150000` ya está en `main`).
  ⚠️ El commit `d26bb746` («implement manual and automatic release…», 5-sep) introdujo `TIMED_OUT/AUTO_RELEASED`
  y el paso `CANCEL_REQUESTED → CANCELLED` por gracia. Antes de afirmar qué camino de liberación corre en un
  entorno, mira el código desplegado ahí; no lo des por hecho desde esta regla.
- 🔴 **«No se cobró» por silencio sólo con TODAS las cuentas comprobadas; si no, se suelta SÓLO LA RANURA** (founder, 21-oct,
  bloque «ninguna duda de un cobro de la tablet sin salida», D2 → «A»). Soltar la ranura libera la TERMINAL, no la VENTA:
  la fila queda `TIMED_OUT/AUTO_RELEASED` (UNRESOLVED, cercada en cualquier terminal) y «no se cobró» lo dice el cajero con
  un toque (`reconcileUncharged`, permiso `payments:reconcile-uncharged`; el mesero, con PIN de gerente). Al POS que espera
  se le contesta 504 «La terminal ya quedó libre. Esta venta necesita confirmación…» (`TEXTO_RANURA_LIBRE_VENTA_EN_DUDA`).
  Un aprobado tardío (REST o webhook) la concilia a COMPLETED con 🚨. Dos caminos:
  - **S2, la terminal certifica el cese** (`soltarRanuraTrasCierre`, A4b): la TPV nueva sella `executionClosedAt`; ≥ 10 s
    después se suelta la ranura (asiento `TERMINAL_PAYMENT_SLOT_RELEASED_EXECUTION_CLOSED`) sin esperar 20 min. Nunca mide
    el banco ni escribe «no se cobró». Sin la marca (TPV vieja), sigue el reloj de 20 min con latido.
  - **La ventana de 30 s** (`releaseUnprovenNegative`, A8) ante un negativo de la TPV sin respuesta del banco: escribe
    `FAILED/NO_EVIDENCE_AFTER_WINDOW` sólo si TODAS las cuentas con las que pudo cobrar la terminal pasan
    `avisoDelBancoComprobado` (`src/services/tpv/avisoDelBancoComprobado.ts`, la misma regla de «sin instrumento»), medido
    DENTRO de la transacción del CAS. El conjunto (`cuentasConLasQuePudoCobrar`) es el `assignedMerchantIds` EXACTO de la
    terminal, incluidas las cuentas INACTIVAS y los ids colgados (fallan cerrado); si está vacío, la unión del negocio
    (`getVisibleMerchants`, sólo activas + slots). Vacío, no AngelPay o alguna sin comprobar ⇒ sólo ranura, asiento
    `TERMINAL_PAYMENT_SLOT_RELEASED_WEBHOOK_NOT_PROVEN` con el resultado por cuenta y su `motivo`. Medido en prod el 21-oct:
    Testarudo sigue automático; una terminal con una cuenta inactiva asignada pasa al toque del cajero hasta que soporte la
    desasigne. Residuo sin arreglo barato (una cuenta DESASIGNADA poco antes del cobro): `docs/audit/deuda-encontrada.md`.
- **El cierre por REST exige procedencia acreditada.** La selección actual del serial es:
  `Payment.terminal.serialNumber`, después el serial autenticado aportado por el llamador
  (`capturedBySerial`, del JWT) y finalmente `processorData.deviceSerialNumber`. Si falta la identidad
  seleccionada o no coincide con la terminal reservada, no se cierra la solicitud y se conserva el
  `Payment` para conciliación. Esta precedencia no equivale a comprobar que las tres fuentes coincidan
  entre sí (T10).
- 🔴 **Compatibilidad y despliegue pendientes de demostrar.** «APK primero» fue una propuesta puntual del
  relevo; no es una autorización general ni prueba de compatibilidad. Antes de desplegar, verificar las
  combinaciones de servidor anterior/nuevo y APK anterior/nuevo, incluidos cancel `ACTIVE`, resultados sin
  evidencia y pérdida de conexión. La regla general del workspace sigue siendo **backend compatible y
  estable antes de las aplicaciones**; cualquier excepción debe documentar por qué conserva las garantías
  de dinero. Medido el 10-sep: con el servidor del árbol y el APK publicado, cancelar desde la tablet
  deja la terminal reservada (la TPV no contesta la disposición).
- Medir todos los estados incluidos en `UNRESOLVED_FINANCIAL_OUTCOME` (no sólo `CANCELLED` sin
  disposición: también `TIMED_OUT` y `FAILED` con `ACK_TIMEOUT/ACK_REJECTED/TPV_ERROR`), definir su
  conciliación histórica y resolver los errores anteriores a crear la fila (404/422/400 sin `code`) sin
  convertir un GET 404 en prueba de ausencia de cargo. **La liberación clase B sigue pendiente**
  (`releaseUnknownRequest` concilia a COMPLETED si existe un `Payment` reconciliable, pero nunca libera:
  `released:false`): no presentarla como salida disponible. Ni la antigüedad ni un resultado legacy sin
  evidencia autorizan una liberación automática.
- Un cobro aprobado puede registrarse tarde (medido: 65 s – 3 h). Mientras su desenlace siga incierto, se
  conserva la protección de la solicitud y de su orden: no se inicia otro cobro sobre esa venta ni se
  cancela la orden para eludirla. El `Payment` exacto, con procedencia acreditada, permite reconciliar a
  `COMPLETED`. Si contradice una cancelación o un fallo previos, se alerta (🚨 `money moved despite
  cancel`) para investigar y devolver **únicamente si corresponde**; la demora del registro no demuestra
  por sí sola un doble cobro.
- 🔴 **Con la ranura ya suelta, el ACTIVE de una TPV sin `executionVersion` ya no veta a la persona** (3-nov, Codex contra versiones
  viejas). La TPV publicada contesta ACTIVE mientras su bandeja siga PROCESSING, aunque su ejecución ya haya muerto: tras A8 nadie podía
  cerrar esa venta. `sondaVetaLaDeclaracion` (`src/services/tpv/sondaActiva.ts`): con `AUTO_RELEASED`/`MANUAL_RELEASE`, sólo veta quien
  anunció `executionVersion >= 1` en su entrega (`deliveryProvenance`); la declaración deja `terminalReportabaActiva: true` en la bitácora.
  Con la ranura suelta, `proyectarEstado` manda `cancelDisposition=null` (`fueSoltadaPorPolitica`): «El cobro sigue activo» ya no sale.
- 🔴 **El EFECTIVO sobre una venta con la tarjeta en duda se deja cobrar y sólo se avisa** (founder, 2-nov, D10 → «B»; medido en
  prod, 90 días: 0 casos en 8,098 cobros). «No se inicia otro cobro» de arriba es de la TERMINAL: no le pongas una guarda al efectivo.
  Después del commit queda `CASH_WITH_CARD_IN_DOUBT` (`avisarEfectivoConTarjetaEnDuda`, sin esperarlo: nunca tumba ni demora el cobro).
  Si la tarjeta resulta aprobada (REST o webhook), su `Payment` se registra y grita 🚨 [Sobrepago] con `SOBREPAGO_DETECTADO`
  (`tests/integration/payments/efectivoConTarjetaEnDuda.integration.test.ts`).
- 🔴 **La terminal también declara «no se cobró», y es la MISMA declaración** (botón del banner verde, founder, 3-nov: «A»):
  `POST /tpv/venues/:venueId/terminal-payment/requests/:requestId/uncharged-declaration`, con las puertas del POS y `reconcileUncharged`
  sin tocar. Lo único distinto: el origen (`source: 'TPV'`) y que no libera a secas (`UNCHARGED_STATEMENT_REQUIRED`, antes de la cubeta).

Evidencia y clases de evidencia (A/B/C): `docs/investigations/testarudo-relevo-2026-09-10/README.md` §2-ter.

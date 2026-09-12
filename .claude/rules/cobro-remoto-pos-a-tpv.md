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
  + Alienware; sin commitear.
  ⚠️ El commit `d26bb746` («implement manual and automatic release…», 5-sep), contenido en `develop` y
  `main` (HEAD `3000f3d0`), SÍ contiene `TIMED_OUT/AUTO_RELEASED` y el paso `CANCEL_REQUESTED → CANCELLED`
  por gracia; el árbol de trabajo (sin commitear) los retira. No dar por hecho cuál de los dos corre en un
  entorno sin mirar el código desplegado.
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

Evidencia y clases de evidencia (A/B/C): `docs/investigations/testarudo-relevo-2026-09-10/README.md` §2-ter.

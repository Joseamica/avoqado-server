# Cobro remoto POS → TPV (lado que ARBITRA)

🔴 La regla completa vive en `avoqado-tpv/.claude/rules/cobro-remoto-pos-a-tpv.md` — léela antes de
tocar `src/services/terminal-payment.service.ts`, `terminal-payment.mobile.controller.ts`,
`terminal-registry.ts` o los handlers de socket de terminal. La terminal **no está en una pantalla
fija** cuando llega el cobro: hay una matriz «estado de la terminal × evento» que hay que declarar y
probar en hardware, con los tres lados leídos (servidor, terminal, POS).

🔴 **Regla vigente: «cobro simple» (founder, 22-nov-2026, «A todo automático»; S1 de
`docs/superpowers/plans/2026-11-22-cobro-simple.md` del workspace).** Manda lo que contesta el procesador:
- **Aprobado** (SDK o aviso) ⇒ se registra UNA vez (llave del intento; el árbitro detecta la segunda captura).
- **Rechazado** ⇒ al momento, con su motivo (`TPV_CONFIRMED_NO_CHARGE` + evidencia, o `BANK_DECLINED` del aviso de AngelPay, que
  ahora es un CAS directo en `reconcileBankDeclined` FUERA de vuelo). Con la solicitud EN VUELO el aviso sólo se guarda: la Nexgo
  2.20 ofrece «Reintentar» dentro de la MISMA solicitud y cerrarla le quitaría el permiso al intento B (dos cargos sucesivos); el
  rechazo guardado decide al entrar a «sin respuesta» (Codex S1 r2, R2-6).
- **Sin respuesta** (la terminal no dio veredicto, no acusó en 5 s —también una reentrega, y una PENDING del protocolo con acuse
  que lleva 30 s sin acusar desde su último envío—, se desconectó 10 s, no contestó al cancel en 10 s, contestó «sigo cobrando»
  más de 30 s tras el cancel, o acusó y lleva > 60 s sin final y no dice ACTIVE a la sonda; tope 150 s desde el acuse) ⇒ `UNKNOWN`
  + `noResponseAt` (`src/services/tpv/sinRespuesta.ts`) y a los **10 s** `cerrarSinRespuesta` la cierra «no
  cobrada»: `FAILED / NO_EVIDENCE_AFTER_WINDOW`, `outcome NOT_CHARGED`, `cancelDisposition` null, causa en `noChargeCause`
  (campo aditivo). Es la única forma que ANDROID 2.22+, iOS 1.13 y la TPV ≥ 2.11.1 pintan como «puedes volver a cobrar». La red
  del temporizador es el vigía (`cerrarSinRespuestaVencidas`, cada 30 s) y la primera lectura del GET (POS o TPV). Mientras el
  cierre no DECIDE, el GET la proyecta EN VUELO (`SENT`, sin `cancelDisposition`), por ESTADO y no por edad (R3-8). Todos los
  sellos que se comparan con esos plazos (`noResponseAt`, `cancelRequestedAt`) son del reloj del SERVIDOR (R3-11); «contestó
  ACTIVE» se decide con el sello guardado `probeActiveAt` contra sí mismo, y el CAS de entrada lo exige igual (R3-9).
- **Aprobado tardío** ⇒ el cierre común reabre a `COMPLETED` con 🚨 y avisa al DUEÑO y a los gerentes (`avisarAprobadoTardio`).
- **Ningún cierre negativo gana a un aprobado ya conocido** (`aprobacionBancariaConocida`, la afirmación de la terminal
  `claimedSuccess` —un `success` sin ids también lo es— y los vetos de `sinVetoDeDineroSql`): queda «aprobado, por registrar»
  (UNKNOWN, la cuenta cercada; el POS sigue esperando y el GET la proyecta en vuelo hasta la alarma: 🚨 a los 5 min sin `Payment`,
  que la marca en el sobre `aprobadoPorRegistrarAt` y desde ahí sale UNKNOWN, como develop).
  Vale para TODO escritor de un negativo (Codex S1 r3): el cierre de 10 s, `reconcileBankDeclined`, el negativo de la terminal
  (`cerrarConNegativo`, que conserva la afirmación en el sobre) y el cancel `ACCEPTED`, que pasa por ese mismo escritor. La
  prueba de tabla señal × escritor vive en `tests/integration/payments/cobroSimple.elAprobadoManda.integration.test.ts`.
- **Al POS que espera (long-poll) se le contesta con UNA regla y UN lector** (`leerParaLaEspera`, Codex S1 r4): final ⇒ ese final
  (un «no cobrado» con un `claimedSuccess` guardado NO cuenta como final para despertarlo); en «sin respuesta» sin decisión ⇒ sigue
  esperando; si no ⇒ el `timeout` de siempre. Todo escritor que despierta al POS pasa por `resolverEsperaDelPos`, que usa ese lector.
- **La RANURA de la terminal sólo existe en vuelo** (`PENDING/SENT/CANCEL_REQUESTED`; índice parcial migrado el 22-nov). La CUENTA
  se cerca en vuelo, en «sin respuesta» (UNKNOWN), con COMPLETED sin `Payment`, y —sólo hasta que el barrido las cierra— las filas
  viejas sin desenlace (TIMED_OUT sin `Payment`, FAILED y CANCELLED sin desenlace acreditado) (`UNRESOLVED_FINANCIAL_OUTCOME`). Nada aparta la terminal por una duda; un doble cobro teórico se DETECTA y se avisa, nunca con
  un candado ni con el paso de una persona.
- Nadie declara ni pone PIN. Las rutas viejas (`/release`, `/uncharged-declaration`, `no-instrument-resolution` con solicitud)
  siguen vivas hasta S3, que las deja contestando en corto. La ventana de 30 s, S2 (cese certificado), el reloj de 20 min y el
  techo D26 ya no corren en el vigía; su código se borra en S3.

Invariantes de este lado que SIGUEN (no los debilites):

- **UNA solicitud en vuelo por terminal Y por orden**: el 409 dice monto, antigüedad y aparato (`blockingRequest`), sólo de filas
  del mismo venue; sobre una orden cercada no se inicia otro cobro (ni en otra terminal) ni se cancela la orden para eludirlo.
- **Procedencia de cada entrega (11-sep, plan D de Codex):** `TerminalPaymentRequest.deliveryProvenance` se escribe con
  `$executeRaw` ANTES de emitir; si no se puede grabar, no se emite y la fila entra a «sin respuesta» (`DELIVERY_NOT_RECORDED`).
  El replay al reconectar reentrega SÓLO filas cuya procedencia es DURABLE. El ACK de un replay sólo confirma una fila PENDING.
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
- Un cobro aprobado puede registrarse tarde (medido: 65 s – 3 h). El `Payment` exacto, con procedencia acreditada, reabre la
  fila a `COMPLETED` por el cierre común aunque ya estuviera «no cobrada»; si contradice una cancelación o un cierre previos, se
  alerta (🚨 `money moved despite cancel`) y se avisa al dueño para devolver **únicamente si corresponde**.
- 🔴 **El EFECTIVO sobre una venta con la tarjeta en duda se deja cobrar y sólo se avisa** (founder, 2-nov, D10 → «B»; medido en
  prod, 90 días: 0 casos en 8,098 cobros). «No se inicia otro cobro» de arriba es de la TERMINAL: no le pongas una guarda al efectivo.
  Después del commit queda `CASH_WITH_CARD_IN_DOUBT` (`avisarEfectivoConTarjetaEnDuda`, sin esperarlo: nunca tumba ni demora el cobro).
  Si la tarjeta resulta aprobada (REST o webhook), su `Payment` se registra y grita 🚨 [Sobrepago] con `SOBREPAGO_DETECTADO`
  (`tests/integration/payments/efectivoConTarjetaEnDuda.integration.test.ts`).
  🔴 **La tarjeta ya cobrada no se rechaza porque la cuenta se cerró como «pago completo»** (D7, encargo a25cd7, 22-nov): si la
  cuenta quedó `FULLPAYMENT` (p. ej. en efectivo) y llega tarde una tarjeta COMPLETED de otra forma, `recordOrderPayment` la
  registra (`tarjetaYaCobradaPorElBanco`) con la forma de la cuenta, sin reparto por producto (la de la terminal va en
  `posRawData.splitTypeDeLaTerminal`), y salta el sobrepago. Un cruce entre divisiones de una cuenta ABIERTA sigue con el 400. En
  **Pago rápido** no hay cuenta con qué chocar: toda tarjeta que llega aprobada ≥ 1 min después de su intento (la TPV manda
  `edadDelIntentoMs`, una duración con su propio reloj; se guarda `processorData.intentoAbiertoEn` en el reloj del servidor) deja
  UNA fila `LATE_CARD_RECORDED` para que el dueño revise si se cobró de otra forma (`avisoDeTarjetaTardia.ts`). A propósito NO se
  empareja con un efectivo (Codex r1 y r2: siempre quedan huecos). Nunca bloquea. Es de MEJOR ESFUERZO: sus límites conocidos están
  en la cabecera de `avisoDeTarjetaTardia.ts` (Codex r5).
Evidencia y clases de evidencia (A/B/C): `docs/investigations/testarudo-relevo-2026-09-10/README.md` §2-ter.

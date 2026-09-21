# Auditoría de Codex — conciliación operable del cobro sin confirmar

**Fecha:** 2026-09-18 · **Modelo:** gpt-6-astra, `model_reasoning_effort=xhigh` · **Alcance:** commits `3faf0a84..6a3a9e5b`

**Veredicto: RECHAZADO.** 6 P1 de dinero y elegibilidad, 8 P2, 1 P3. Textual de Codex:

> Corregiría los P1 antes de usarla para destrabar ventas reales; no hace falta reescribir el precedente.

🔴 **Lo que sí quedó confirmado limpio:** la REGRESIÓN (el camino viejo de `/release` intacto, el precedente sin tocar) y la AUTORIZACIÓN (el permiso no concede de más, no se puede eludir con un cuerpo manipulado).

⚠️ **Límite declarado por el propio Codex:** no pudo correr Jest (entorno de sólo lectura, `EPERM`), así que **no validó las carreras contra PostgreSQL real**. Las pruebas de integración de esta sesión sí lo hacen, pero por el servicio, no por HTTP.

⚠️ **El hallazgo 15 ya está cerrado:** la auditoría corrió sobre los commits previos a `f0b0bd0`, que añadió la emisión en vivo del aviso.

---

1. **P1 · Dinero — `claimedSuccess` no veta la declaración.**  
   [uncharged-reconciliation.service.ts:209](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/tpv/uncharged-reconciliation.service.ts:209)

   **Entrada → salida:** solicitud `UNKNOWN`, sin `Payment`, con `resultJson = {status:"timeout", claimedSuccess:{authorizationCode:"103520"}}`. Es exactamente el sobre que produce un éxito de terminal cuyo pago todavía no pudo acreditarse. El servicio sólo comprueba señales de primer nivel y escribe `FAILED/OPERATOR_RECONCILED_NO_CHARGE`. El CAS tampoco examina `claimedSuccess`: libera la venta pese a la afirmación de cobro.

   **Arreglo mínimo:** vetar esa afirmación tanto en la lectura como en el SQL de escritura, usando la semántica conservadora existente. Reproducido en memoria.

2. **P1 · Dinero — falta la identidad del pago por intento para estados distintos de `COMPLETED`.**  
   [uncharged-reconciliation.service.ts:217](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/tpv/uncharged-reconciliation.service.ts:217)

   **Entrada → salida:** intento `A` vinculado a la solicitud; existe `Payment(PENDING, idempotencyKey=A)` con evidencia de colisión, pero sin columna ni etiqueta de solicitud. La consulta inicial no busca `idempotencyKey`. El CAS sólo busca por intento pagos con tarjeta `COMPLETED`; su comprobación adicional de conciliación exige `terminalPaymentRequestId`. La declaración pasa sobre evidencia pendiente.

   Esto puede ocurrir con registros sin solicitud explícita y vínculos publicados posteriormente.

   **Arreglo mínimo:** comprobar pagos por **todos los intentos relacionados**, sin limitar el veto a `COMPLETED`, y repetir ese veto completo en el CAS.

3. **P1 · Dinero — las contradicciones bancarias de procedencia desaparecen del veto.**  
   [uncharged-reconciliation.service.ts:265](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/tpv/uncharged-reconciliation.service.ts:265)

   **Entrada → salida:** un intento ligado tiene un webhook aprobado recibido por otro venue, marcado `LINK_VENUE_MISMATCH`. No nace `Payment`. El servicio no consulta eventos; el SQL compartido exige `e.venueId = venueId`, por lo que descarta precisamente esa contradicción y permite declarar.

   Además, ese SQL sólo reconoce `send_transaction` con estado anidado, mientras la consulta existente de `processorEvidence` también interpreta estado en la raíz. No implementa el veto completo exigido por el spec.

   **Arreglo mínimo:** añadir al servicio nuevo un veto por eventos de todos los intentos que incluya aprobaciones y contradicciones de venue/terminal, y revalidarlo al escribir.

4. **P1 · Dinero — el candado de solicitud no serializa el ingreso normal del webhook.**  
   [uncharged-reconciliation.service.ts:170](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/tpv/uncharged-reconciliation.service.ts:170)

   **Entrada → salida:** el ingreso bancario toma `candadoDeIntento(A)` e inserta una aprobación todavía sin commit. La declaración toma únicamente el candado de solicitud; su CAS no ve el evento sin confirmar y escribe el negativo. El webhook puede confirmar mientras termina la transacción de declaración. Ambos commits son posibles.

   El `NOT EXISTS` revalida lo visible en la fotografía de esa sentencia; no sustituye el candado compartido.

   **Arreglo mínimo:** solicitud → enumerar intentos dentro de la transacción → bloquearlos ordenadamente → orden/fila → veto y CAS. Conservar el CAS para escritores sin candado. No requiere modificar el precedente.

5. **P2 · Dinero — la fecha nueva no es reconocida al detectar posibles recobros.**  
   [uncharged-reconciliation.service.ts:256](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/tpv/uncharged-reconciliation.service.ts:256)

   **Entrada → salida:** declaración a las 10:00, segundo cobro a las 10:01, toque del fallback bancario que mueve `updatedAt` a las 10:02, registro tardío a las 10:03. `instanteDeDeclaracion()` sólo lee `operatorResolution.acceptedAt`; aquí se escribe `operatorReconciliation`. Cae a `updatedAt` y el conteo omite el segundo cobro de las 10:01.

   **Arreglo mínimo:** ampliar únicamente el lector de fecha para reconocer la declaración nueva. Mantener intacto `closeRowFromPaymentTx`.

6. **P2 · Dinero — el aviso atribuye al banco un importe incompleto o distinto del registrado.**  
   [avisoDeCobroTardio.ts:43](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/tpv/avisoDeCobroTardio.ts:43)

   **Entrada → salida:** solicitud de $65 + $9.75 de propina → aviso «El banco aprobó $65.00». También usa el importe solicitado aunque el pago tardío tenga `CONTRACT_MISMATCH`.

   **Arreglo mínimo:** leer el `Payment` identificado por `paymentId`, acotado al venue, y mostrar su importe registrado más propina.

**Regresión:** no encontré cambios funcionales en el camino antiguo de `/release` sin declaración. Comparé y permanecen iguales `no-instrument-resolution.service.ts`, `closeRowFromPaymentTx`, la ventana, `desenlaceCanonico` y `UNRESOLVED_FINANCIAL_OUTCOME`. `reason` y `confirm:true` no activan implícitamente la declaración.

**Autorización:** no encontré concesión excesiva del permiso ni evasión mediante cuerpo manipulado. CASHIER obtiene únicamente la capacidad nueva; no obtiene `tpv:update` ni `payments:resolve-no-instrument`. El MCP conserva `requireWriteScopeAlways`. Sí falta esta validación de pertenencia:

7. **P2 · Pertenencia — se ignora que el candado de la orden no encontró ninguna orden autorizada.**  
   [uncharged-reconciliation.service.ts:177](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/tpv/uncharged-reconciliation.service.ts:177)

   **Entrada → salida:** solicitud del venue A cuyo `orderId` —referencia sin FK— apunta a una orden inexistente o del venue B. El `SELECT ... FOR UPDATE` devuelve cero filas, pero el servicio continúa y declara. Reproducido en memoria.

   La búsqueda de terminal tampoco comprueba su venue y los vínculos de intentos no se validan. No es una evasión de permisos por JSON; es incumplimiento del contrato ante datos incoherentes.

   **Arreglo mínimo:** exigir exactamente una orden del venue cuando exista `orderId`, comprobar que sigue siendo la misma y validar terminal normalizada y vínculos.

Usar un latido reciente posterior al vencimiento es compatible con la **conectividad** que acepta el spec; no demuestra que terminó el cobro. Encontré estos huecos adicionales de elegibilidad:

8. **P1 · Elegibilidad — puede declararse un cobro `SENT` antes de vencer.**  
   [uncharged-reconciliation.service.ts:152](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/tpv/uncharged-reconciliation.service.ts:152) y [línea 231](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/tpv/uncharged-reconciliation.service.ts:231)

   **Entrada → salida:** solicitud recién enviada, `expiresAt` dentro de 90 segundos, terminal con reloj adelantado una hora. El heartbeat admite timestamps del aparato; ambas comparaciones pasan porque no hay límite superior. `SENT` es `UNRESOLVED` y sólo se excluye `PENDING`, así que se libera un cobro todavía en vuelo. Reproducido en memoria.

   **Arreglo mínimo:** lista explícita de estados admitidos, vencimiento comprobado contra el reloj servidor y heartbeat observado por servidor o validado también contra el futuro.

9. **P1 · Elegibilidad — `ACTIVE` puede dejar de vetar sin una respuesta que lo desmienta.**  
   [sondaActiva.ts:41](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/tpv/sondaActiva.ts:41) y [terminal-payment.service.ts:6381](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/terminal-payment.service.ts:6381)

   **Entrada → salida:** una `TIMED_OUT` recibe `ACTIVE`; pasan 15 minutos con heartbeat reciente y sin otra respuesta → la declaración pasa. La premisa «cada barrido lo habría repetido» es falsa: el disparador periódico parte de filas `UNKNOWN`, y la sonda limita sus candidatos a 25.

   Además, la marca vive en `resultJson`: un timeout posterior que reemplaza el sobre puede borrarla antes de esos 15 minutos. El lector sí veta fechas basura y futuras; el mecanismo completo no falla cerrado.

   **Arreglo mínimo:** conservar la observación fuera del sobre reemplazable y, cuando exista un `ACTIVE` sin resolver, consultar esa solicitud específicamente antes de levantar el veto.

10. **P1 · Idempotencia — el replay anuncia liberación aunque ya apareció dinero.**  
    [terminal-payment.service.ts:5438](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/terminal-payment.service.ts:5438)

    **Entrada → salida:** declaración aceptada → aprobación tardía que deja `COMPLETED` o `TIMED_OUT/BANK_APPROVED_AWAITING_PAYMENT` → replay con el mismo UUID. El servicio devuelve la declaración histórica correctamente, pero el wrapper responde incondicionalmente `released:true`; el controlador muestra «Terminal liberada». Tampoco devuelve el `paymentId` actual. Reproducido en ambos estados.

    **Arreglo mínimo:** separar «declaración aceptada anteriormente» del desenlace actual; proyectar la fila fresca y derivar `released`, mensaje y pago de ella.

11. **P2 · Idempotencia — el MCP fabrica otro UUID en cada reintento.**  
    [terminals.ts:579](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/mcp/tools/terminals.ts:579)

    **Entrada → salida:** el primer `confirm:true` confirma la transacción pero se pierde la respuesta. Repetir exactamente la llamada genera otro `resolutionId` y termina en `RESOLUTION_CONFLICT`. El tool tampoco devuelve la resolución aceptada.

    **Arreglo mínimo:** transportar una clave estable entre vista previa, confirmación y reintentos, y devolverla. El servicio sí conserva una sola declaración y un solo asiento bajo su candado de solicitud.

12. **P2 · Contrato — el cuerpo HTTP documentado no funciona.**  
    [terminal-payment.mobile.controller.ts:391](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/controllers/mobile/terminal-payment.mobile.controller.ts:391)

    **Entrada → salida:** POST a la URL con `requestId`, enviando `{statement, statementVersion, resolutionId}`, como establece la Task 5 → `409 ATTEMPT_NOT_ELIGIBLE`. El controlador pasa el cuerpo intacto y el esquema exige también `requestId` dentro del JSON. Incluso añadiéndolo, la respuesta omite `requestId`, `outcome` y `outcomeEvidence` prometidos.

    **Arreglo mínimo:** construir la identidad desde la ruta y devolver la proyección canónica más la resolución. Añadir la prueba HTTP con el cuerpo documentado.

13. **P2 · Contrato — no existe la consulta de recuperación de la declaración durable.**  
    [uncharged-reconciliation.service.ts:262](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/tpv/uncharged-reconciliation.service.ts:262)

    **Entrada → salida:** se confirma la declaración, muere la app y después llega el pago, reemplazando `resultJson`. La columna conserva la declaración, pero el GET de estado y el listado MCP no la proyectan. El cliente no puede consultar si **su** `resolutionId` fue aceptado, como exige el spec.

    **Arreglo mínimo:** exponer la resolución durable en una lectura autorizada por solicitud. La recuperación no debe depender de volver a enviar una operación que podría aceptar una declaración nunca recibida.

14. **P2 · Avisos — una retención intermedia suprime el aviso del cobro tardío.**  
    [terminal-payment.service.ts:1466](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/terminal-payment.service.ts:1466)

    **Entrada → salida:** declaración → aprobación sin pago registrable → `BANK_APPROVED_AWAITING_PAYMENT` → finalmente se registra el pago. El cierre ya no encuentra `OPERATOR_RECONCILED_NO_CHARGE` como código previo, no produce `lateAfterWindow` y la función retorna antes del aviso nuevo. La declaración sigue guardada, pero el cajero nunca recibe notificación.

    **Arreglo mínimo:** decidir el aviso por la declaración durable y el pago registrado, independientemente del código intermedio, con deduplicación por resolución/pago.

15. **P2 · Avisos — guardar la notificación no avisa al aparato en ese momento.**  
    [avisoDeCobroTardio.ts:44](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/tpv/avisoDeCobroTardio.ts:44)

    **Entrada → salida:** llega el cobro mientras el cajero sigue en la pantalla de venta → sólo se inserta una fila. No se llama al broadcast ni al despacho push del servicio de notificaciones. En Android, el buzón consulta al abrirse/refrescarse; el cajero puede seguir cobrando sin ver el aviso.

    **Arreglo mínimo:** conservar la notificación durable y despacharla por el canal del usuario después del commit, manteniendo aislados los errores del dinero.

16. **P3 · Spec — el correo de operaciones atribuye una declaración diferente.**  
    [terminal-payment.service.ts:1454](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/terminal-payment.service.ts:1454)

    **Entrada → salida:** alguien declara «revisé y no se cobró» → el correo afirma que declaró «no se presentó tarjeta». El spec exige ampliar ese texto.

    **Arreglo mínimo:** distinguir el tipo de declaración o usar un texto común que no atribuya esa afirmación.

La comprobación combinó lectura completa, comparación estructural y reproducciones con el código real y dobles de base de datos. **No validé las carreras contra PostgreSQL real**: Jest no arrancó porque el entorno de sólo lectura impide escribir su caché (`EPERM`). Las pruebas del rango simulan el CAS; no demuestran su SQL ni sus intercalaciones.

El camino anterior quedó conservado, pero la conciliación nueva todavía puede dar por no cobrado algo con señales de cobro.  
Corregiría los P1 antes de usarla para destrabar ventas reales; no hace falta reescribir el precedente.  
No modifiqué archivos y no necesito ninguna decisión tuya para sustentar estos hallazgos.

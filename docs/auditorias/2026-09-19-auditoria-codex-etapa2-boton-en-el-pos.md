# Auditoría de Codex (gpt-6-astra, esfuerzo max) — ETAPA 2: el botón en el POS

**Fecha:** 2026-09-19 · **Veredicto: RECHAZADO** · 2 P1 · 6 P2
**Qué se auditó:** avoqado-android `00668ca` y avoqado-ios `08ca08d`, estado final, contra el
contrato del servidor en `avoqado-server/develop`.
**Alcance declarado por el auditor:** revisión ESTÁTICA — no corrió builds, suites ni aparatos.

## Verificado por mí contra el código (no me fié del informe)

- **P1-1 CONFIRMADO y es mío.** `PaymentFlowViewModel.kt:850` nace el estado con
  `totalAmount = amount` (el importe de la venta NUEVA) mientras `pending` es el requestId del
  cobro VIEJO. Con `fromPreviousSale=true`, el diálogo afirma un importe y la declaración va
  sobre otro cobro. El cajero **firma con su nombre** una afirmación sobre el importe equivocado.
- **P1-2 CONFIRMADO en el mecanismo, DISCREPO en la severidad (es P2).** `statusClient` deriva de
  `baseClient`, que lleva `.authenticator(tokenRefreshAuthenticator)`, y `buildRetry` reenvía el
  MISMO POST tras refrescar. Incumple la restricción literal que escribí, y el `resolutionId`
  determinista no protege (el primer envío rechazado nunca registró nada). Pero el reenvío ocurre
  en SEGUNDOS, dentro de la misma acción que el cajero acaba de confirmar: la afirmación no ha
  caducado en ese lapso. El arreglo es barato y se hace igual.
- **#8 CONFIRMADO y es mío.** El commit `08ca08d` arrastró DOS líneas de WIP ajeno
  (`BaseDePropina.sinIva`, base de propina sin IVA) dentro de `PaymentFlowViewModel.swift`, y
  `BaseDePropina.swift` sigue SIN versionar ⇒ **el commit no compila en un checkout limpio**.
  🔑 Lección: `git show --stat` verifica QUÉ ARCHIVOS entraron, no QUÉ LÍNEAS. En un archivo
  compartido, el pathspec no basta.

---

Encontré **8 hallazgos: 2 P1 y 6 P2**. Revisé el estado final de ambos commits contra el servidor en `develop`. Fue una revisión estática: no ejecuté builds, suites ni pruebas en aparatos por el entorno de solo lectura.

1. **P1 — Se confirma el importe de una venta y se libera otra.**  
   [Android: PaymentFlowScreen.kt:364](/Users/amieva/Documents/Programming/Avoqado/avoqado-android/app/src/main/java/com/avoqado/pos/payment/presentation/PaymentFlowScreen.kt:364) · [iOS: PaymentFlowView.swift:417](/Users/amieva/Documents/Programming/Avoqado/avoqado-ios/avoqado-ios/Payment/PaymentFlowView.swift:417).

   **ENTRADA → SALIDA:** queda pendiente A por $100; se abre una venta B por $500 → el diálogo afirma «el cobro de $500 no pasó», pero la declaración lleva el `requestId` de A. Ambas apps toman el importe del carrito actual, incluso con `fromPreviousSale=true`. La declaración humana termina asociada a un cobro distinto del descrito; el servidor no recibe el importe para detectar esa discrepancia.

   **Arreglo mínimo:** construir y congelar el objetivo del diálogo desde el contexto del request pendiente: importe, terminal, venue e identidad. Confirmar debe enviar exactamente ese objetivo.

2. **P1 — Ambas apps reenvían automáticamente la declaración tras un 401.**  
   [Android: TokenRefreshAuthenticator.kt:231](/Users/amieva/Documents/Programming/Avoqado/avoqado-android/app/src/main/java/com/avoqado/pos/core/data/network/TokenRefreshAuthenticator.kt:231) · [iOS: APIClient.swift:217](/Users/amieva/Documents/Programming/Avoqado/avoqado-ios/avoqado-ios/Services/APIClient.swift:217).

   **ENTRADA → SALIDA:** cajero confirma con el access token vencido → `/release` responde 401 → el transporte refresca la sesión y vuelve a enviar el mismo POST, sin otra confirmación. Los servicios nuevos usan estos transportes sin excluir ese comportamiento. Esto incumple expresamente la restricción de no reintentar sola una afirmación que caduca. El `resolutionId` no lo evita: el primer envío rechazado nunca registró la declaración.

   **Arreglo mínimo:** excluir esta operación de los reenvíos automáticos. Tras recuperar la sesión, devolver el control al cajero para que confirme nuevamente.

3. **P2 — iOS queda permanentemente en «Consultando…» después de liberar y cerrar el selector.**  
   [PaymentFlowViewModel.swift:2731](/Users/amieva/Documents/Programming/Avoqado/avoqado-ios/avoqado-ios/Payment/PaymentFlowViewModel.swift:2731) · [PaymentFlowView.swift:486](/Users/amieva/Documents/Programming/Avoqado/avoqado-ios/avoqado-ios/Payment/PaymentFlowView.swift:486).

   **ENTRADA → SALIDA:** pendiente propio → declaración aceptada → aparece el selector de terminal → cajero cierra el selector → vuelve a `.undetermined(checking:true)`. La rama `.released` devuelve `true` sin cambiar ese estado; cerrar el selector solamente oculta la hoja. Consultar, declarar, cancelar y salir quedan deshabilitados.

   **Arreglo mínimo:** pasar a un estado utilizable, como `.confirming(...)`, antes de abrir el selector. Su cancelación debe conservar una salida operable.

4. **P2 — Una consulta anterior puede volver a poner la llave que la declaración acaba de liberar.**  
   [Android: TerminalPaymentService.kt:769](/Users/amieva/Documents/Programming/Avoqado/avoqado-android/app/src/main/java/com/avoqado/pos/payment/data/TerminalPaymentService.kt:769) · [iOS: TerminalPaymentService.swift:853](/Users/amieva/Documents/Programming/Avoqado/avoqado-ios/avoqado-ios/Services/TerminalPaymentService.swift:853).

   **ENTRADA → SALIDA:** el POST original sigue vivo; el cajero cancela, sale dejando pendiente y abre otro cobro → una recuperación del POST viejo lee `UNKNOWN`, pero su respuesta demora → la declaración libera y borra la llave → llega aquel GET y ambos servicios vuelven a persistir el request como pendiente. La siguiente venta vuelve a bloquearse por el cobro recién liberado.

   **Arreglo mínimo:** registrar la declaración aceptada en el mecanismo común de resultados por request, impidiendo que consultas anteriores publiquen otra vez `Undetermined`. Las señales positivas posteriores deben seguir prevaleciendo.

5. **P2 — La declaración apunta al venue actual, aunque el pendiente pertenezca a otro.**  
   [Android: TerminalPaymentService.kt:744](/Users/amieva/Documents/Programming/Avoqado/avoqado-android/app/src/main/java/com/avoqado/pos/payment/data/TerminalPaymentService.kt:744) · [iOS: TerminalPaymentService.swift:833](/Users/amieva/Documents/Programming/Avoqado/avoqado-ios/avoqado-ios/Services/TerminalPaymentService.swift:833).

   **ENTRADA → SALIDA:** usuario con acceso a A y B deja un cobro pendiente en A y cambia a B → la llave sobrevive → declarar envía `/venues/B/.../requestA/release` → rechazo y bloqueo conservado. Las consultas existentes sí recuperan el venue original desde el contexto durable.

   **Arreglo mínimo:** resolver el venue del request correlacionado, igual que la consulta. El servidor impide liberar una fila ajena; aquí el defecto es impedir recuperar la correcta.

6. **P2 — Android aplica una respuesta de declaración sobre un flujo reiniciado por rotación.**  
   [PaymentFlowViewModel.kt:2018](/Users/amieva/Documents/Programming/Avoqado/avoqado-android/app/src/main/java/com/avoqado/pos/payment/presentation/PaymentFlowViewModel.kt:2018).

   **ENTRADA → SALIDA:** declarar un pendiente propio → rotar antes de la respuesta → la nueva composición ejecuta `startPaymentFlow`, incrementa generación y limpia método y orden → llega el `Liberada` anterior y coloca `SelectingTerminal` usando el contexto capturado → elegir terminal termina en «Método de pago no seleccionado». Con productos, puede crear otra orden antes de descubrirlo.

   **Arreglo mínimo:** capturar y comprobar `paymentGeneration` antes de modificar la pantalla, como ya hace `reconcileThenOffer`; conservar el resultado durable del servicio.

7. **P2 — iOS convierte un rechazo de permisos en un supuesto fallo de conexión.**  
   [APIClient.swift:325](/Users/amieva/Documents/Programming/Avoqado/avoqado-ios/avoqado-ios/Services/APIClient.swift:325) · [TerminalPaymentService.swift:867](/Users/amieva/Documents/Programming/Avoqado/avoqado-ios/avoqado-ios/Services/TerminalPaymentService.swift:867).

   **ENTRADA → SALIDA:** cajero sin permiso, con autorización por PIN habilitada → servidor responde 403 `overridable` → iOS abre el PIN → cajero cancela → `APIError.forbidden` cae en el `catch` genérico y aparece «Necesitas conexión…». Se pierde el rechazo del servidor. Android conserva ese rechazo mediante `LOCAL_ERROR_HEADER`.

   **Arreglo mínimo:** suprimir la intervención global de permisos para esta llamada y conservar el cuerpo del 403 para presentarlo localmente, como Android.

8. **P2 — El commit iOS referencia una dependencia que no contiene.**  
   [PaymentFlowViewModel.swift:1373](/Users/amieva/Documents/Programming/Avoqado/avoqado-ios/avoqado-ios/Payment/PaymentFlowViewModel.swift:1373).

   **ENTRADA → SALIDA:** checkout limpio de `08ca08d` → `calculateTipAmount` referencia `BaseDePropina.sinIva` → falta la definición. `git grep` sobre ese commit encuentra únicamente la referencia; `BaseDePropina.swift` aparece como archivo **no versionado** en el workspace. El commit incluye ese cambio adicional de propinas y no es autocontenido para compilar.

   **Arreglo mínimo:** incorporar la dependencia completa o separar ese cambio de propinas, conservando el trabajo ajeno del workspace.

Las pruebas nuevas dejan pasar estos defectos: Android sustituye completamente el servicio, por lo que su prueba «NO se encola» solo comprueba pantalla y mensaje; iOS sustituye el transporte y omite los reenvíos reales. Además, su prueba de éxito comprueba el booleano y la llave, pero no el estado que queda al cerrar el selector.

No encontré un cargo iniciado directamente por declarar ni una cola explícita de declaraciones. **Sin verificar:** un doble cargo provocado específicamente por doble toque o reconsulta simultánea; no lo cuento como hallazgo.

**VEREDICTO: RECHAZADO — hay errores de correlación financiera, reenvíos automáticos prohibidos, bloqueos operativos y una dependencia ausente del commit iOS.**

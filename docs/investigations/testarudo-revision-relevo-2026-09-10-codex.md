# Revisión del relevo de Claude — Codex, 10 septiembre 2026

**Dictamen: hay correcciones comprobadas; no aprobar liberación por plazo ni declarar terminado el circuito.** Esta revisión contrasta la conversación de 939 líneas entregada por el usuario con el código posterior al relevo de las 09:55. No cambia código del producto, instalaciones, datos operativos ni ramas. Sin commit/push/deploy.

## Alcance y comparación

- El manifiesto del relevo contiene hashes de 146 archivos. Conservan sus bytes 142; cambiaron el servicio de arbitraje, su integración PostgreSQL, el arnés PAX y el ViewModel iOS.
- En memoria se retiraron del servicio exclusivamente el predicado nuevo de disponibilidad (y sus cuatro usos) y la validación REST nueva: el resultado coincide **exactamente** con el SHA256 del relevo. No se restauró ningún archivo del workspace.
- En iOS, retirar en memoria únicamente el cambio del cálculo de efectivo también recupera exactamente el hash del relevo. El resto de sus cambios de recuperación son heredados.
- Se revisaron además los diffs nuevos de dos fixtures de referidos y del cálculo/recibo de efectivo de Android con sus pruebas. Se inspeccionó la prueba de efectivo correspondiente de iOS. Son nueve archivos revisados. El manifiesto original omitió varios tests iOS: su estado ya figuraba en `avoqado-ios-status.txt`, pero no existe un hash inicial para afirmar identidad histórica de todos ellos.
- El commit posterior `ee16b578` de analítica de modificadores pertenece a otro trabajo y no contiene estos arreglos. Cambios simultáneos no prueban autoría de Claude: los de efectivo tampoco aparecen en el texto pegado.
- No se volvió a auditar desde cero todo el outbox ni todas las aplicaciones: el código registrado que no cambió conserva los límites y pendientes de la auditoría anterior.

## Lo que está bien

1. **REST ahora rechaza una terminal conocida distinta** y conserva el Payment. El control positivo usa serial con prefijo y mayúsculas frente a la llave normalizada. La comparación reutiliza datos ya consultados: no introduce otra consulta por sí misma.
2. **El fallo de SQL con NULL quedó corregido.** El predicado nuevo incluye explícitamente `failureCode: null`. Las 40 pruebas PostgreSQL pasan en la corrida propia descrita abajo.
3. **El arnés PAX fue mejorado:** espera efectos observables y comprueba que alcanzó el kernel, además de esperar el error posterior a la aprobación. Ese cambio está en pruebas y no añade espera al APK.
4. **Las dos correcciones de mocks de referidos son concretas:** agregan `$queryRaw` y una lista vacía de reembolsos; no suprimen aserciones.
5. **El cambio de efectivo tiene sentido:** dinero recibido menos total realmente registrado. Android e iOS incluyen el caso $550 recibidos/$544.50 cobrados; Android comprueba también el recibo. Esta revisión no recompiló esas dos apps ni certifica su QA físico.

## Riesgos y pendientes que siguen abiertos

### P1 — Una marca histórica de liberación no acredita que el SDK terminó

`src/services/terminal-payment.service.ts:211` excluye del bloqueo las filas con `AUTO_RELEASED` o `MANUAL_RELEASE`. La prueba nueva permite otra venta en esa terminal basándose sólo en una fila TIMED_OUT/AUTO_RELEASED, sin respuesta del SDK ni confirmación durable del aparato. La venta original sigue protegida por orden, pero eso no demuestra disponibilidad física segura, especialmente con APK antiguos.

Separar disponibilidad de terminal y desenlace de venta es razonable; falta una condición verificable que permita liberar la primera. El comentario que atribuye seguridad a un barrido de 30 minutos no la demuestra. Un pago puede registrarse después de esa ventana y un heartbeat sólo acredita conectividad.

Además, la defensa por venta de `sendPaymentToTerminal` sólo entra con `request.orderId`. La prueba nueva incluye una orden; no certifica el cobro rápido sin orden previa. Ese camino también necesita demostrar que liberar la terminal no permite reenviar la misma venta bajo otro request.

La descripción de «dos trabajos correctos por separado» tampoco está demostrada: el código actual de `reconcileUnknownRequests` conserva `released = 0` y dice expresamente que tiempo/heartbeat no liberan ejecución. `releaseUnknownRequest` tampoco libera sin evidencia. Encontrar una implementación anterior en otro worktree no autoriza reintroducirla ni prueba que la supresión fuera un accidente.

**Acción:** definir recuperación con evidencia del intento/SDK o resultado del procesador, preservando la incertidumbre financiera. Probar pérdida de confirmación, resultado tardío y reinicio. No elegir 2/20 minutos como sustituto de esa evidencia ni afirmar riesgo cero para una liberación manual.

### P1 — La atribución REST mejoró, pero sigue aceptando ausencia de identidad

`src/services/terminal-payment.service.ts:1082` sólo niega seriales conocidos y contradictorios. El test `REST close still completes when the Payment has no resolved terminal` exige que un Payment con `terminalId: null` cierre la solicitud. Esto es comportamiento comprobado en la corrida PostgreSQL, no una hipótesis sobre el resultado del test.

El comentario reconoce que la ausencia puede venir de un token sin serial o de no resolver la terminal en ese venue. Esos casos tampoco prueban que el Payment corresponda al aparato reservado. La compatibilidad es una restricción válida, pero no demuestra atribución física.

**Acción:** verificar la procedencia autenticada y cómo conservarla cuando la relación `Payment.terminal` no resuelve; preservar el Payment y la recuperación sin afirmar un cierre de terminal no acreditado. Probar ese caso por la ruta real del controlador/servicio. No basta el control positivo sin terminal para dar por cerrado todo el P1 original.

### P2 — Sigue faltando la regresión de rechazo/desconocido ejecutando el ViewModel

`PaymentViewModelKernelDurabilityTest.kt:617` y `:659` siguen llamando directamente al ledger sobre Room. `RechazoContactlessLiberaLaTerminalTest.kt` sigue buscando texto con `contains("markKernelRefused")`. Esa guarda no distingue una llamada real de una llamada comentada: no ejecuta el cableado.

El relevo cerró otra prueba que pasaba sin alcanzar el kernel, lo cual es útil, pero no cerró el P2 original entero. Falta conducir la respuesta de rechazo y la desconocida por el ViewModel y comprobar tanto la reserva como el siguiente intento. El arnés reparado permite retomar ese pendiente; no es trabajo nuevo ajeno al relevo.

### Referidos — Los tres fallos no demuestran una sola regresión por el lock

Corrida propia: los tres siguen rojos, pero las causas visibles son distintas:

- `onOrderPaid.test.ts:74`: `mockResolvedValueOnce(PENDING)` sólo cubre la primera lectura. La segunda retorna el default PAID; el claim usa un mock sin resultado y falla al leer `count`. Debe representar una orden coherente durante toda la transacción.
- `referralRefund.service.test.ts:539`: el fixture entrega dos veces un referido QUALIFIED porque esperaba dos lecturas por ejecución. El código actual hace una: las dos ejecuciones reciben artificialmente un referido vigente. La aserción cuenta **actualizaciones del referido**, no transacciones. No prueba por sí sola una doble reversión real.
- `referralRefund.service.test.ts:582`: la prueba no prepara una orden cancelada existente; la política retorna antes de consultar QUALIFIED. Debe preparar el estado que pretende medir.

Sí existe coste adicional al abrir la transacción y bloquear la orden antes de saber si hay referido. Eso requiere evaluación separada. Reponer ciegamente el filtro de sólo QUALIFIED puede omitir PENDING que ahora se cancelan para impedir que un job atrasado premie una venta reembolsada. Corregir fixtures conservando las invariantes y probar reembolso versus job tardío; no trasladar al founder una elección entre tres tests rojos y quitar un lock sin analizar la carrera.

## Lectura de la conversación

- Claude detectó y corrigió el NULL, el control de normalización y la explicación incorrecta sobre el serial. No se reportan aquí como errores todavía presentes.
- También retiró su propuesta de interpretar genéricamente 409/404 como «no se cobró». Su observación más precisa —rechazo de creación de un intento nuevo confundido con incertidumbre— merece una corrección correlacionada por request y compatible con reintentos.
- Decir «no hay APK que instalar» sólo describe las ediciones recientes de esa sesión; el relevo completo incluye cambios de producción TPV aún por instalar y verificar. Probar clientes antiguos comprueba compatibilidad, no el conjunto completo.
- La antigüedad de una fila no demuestra cuántos días estuvo bloqueada la terminal, ni identifica por sí sola la causa de un incidente de producción.

## Verificación propia y límites

- `avq-verify`, servidor, corrida `ZpkgEO`: **40/40 integración PostgreSQL**, más una selección de referidos de **148/151**. Total **188/191**, dos suites rojas. Se usó exclusivamente `codex_testarudo_test_20260909`, con los fixtures y limpieza acotados de la suite. Los cuatro archivos revisados del servidor coinciden con el snapshot ejecutado.
- PAX: la primera verificación `14S84C` recuperó 6/6 de caché. No se presenta como nueva ejecución del comportamiento. La segunda, `67pCmc`, usó `--rerun` sólo en la tarea de test: **6/6, cero fallos**, timestamp XML `2026-09-10T18:48:09.973Z`. El test y los archivos de producción TPV registrados coinciden con el snapshot. El aviso global de vigencia no se interpreta como certificación de todo el árbol.
- No se ejecutaron suite completa, builds de todos los APK, QA de tarjetas ni benchmark del circuito en esta revisión. No se certifica menor latencia ni preparación para producción.
- Los hashes y resúmenes propios se conservan en [la evidencia de esta revisión](./testarudo-revision-relevo-2026-09-10-evidence/server-results-summary.json), junto a [PAX](./testarudo-revision-relevo-2026-09-10-evidence/pax-results-summary.json) y [hashes](./testarudo-revision-relevo-2026-09-10-evidence/reviewed-hashes.json). No se copiaron variables de entorno ni credenciales.

**Recomendación para continuar:** conservar los avances, cerrar los pendientes anteriores y diseñar recuperación por evidencia. El founder no necesita escoger ahora un plazo de liberación a ciegas.

# Auditoría de continuación Testarudo — Codex, 10 septiembre 2026

**Veredicto: NO listo para cerrar ni desplegar.** Revisión enfocada de los cambios de servidor/TPV que continuaron el checkpoint; no es una certificación de todo el ecosistema. Se leyó código real, se ejecutó una selección de pruebas TPV y se reprodujo un defecto del servidor contra PostgreSQL local. No se modificó código de producción, no se saboteó el árbol compartido y no se instaló ningún APK. No commit/push/deploy.

## Hallazgos que deben resolverse

### P1 — El cierre por REST todavía acepta el pago de otra terminal física

`src/services/terminal-payment.service.ts:1038` condiciona la atribución física a `source === 'SOCKET'`. Las llamadas de `payment.tpv.service.ts:2546` y `:4009` usan el valor por defecto REST. Así, una solicitud de A puede quedar COMPLETED con un Payment capturado por B, aunque A siga procesando. La validación añadida a `findReconcilablePayment` no protege este cierre directo.

**Reproducción independiente:** se extrajo sin editar el cuerpo actual de `closeRowFromPaymentTx` y su función de comparación de importes, y se ejecutó sobre transacciones Prisma reales contra `codex_testarudo_test_20260909`. Mismo venue/orden/importe y etiqueta de request, distinta terminal física:

- REST: solicitud A pasó a COMPLETED y quedó vinculada al Payment de B.
- SOCKET: solicitud A permaneció SENT, sin vínculo.
- Cero organizaciones del fixture tras rollback; cero excepciones capturadas por el método.

La prueba ejecuta el método financiero con SQL real, no el endpoint HTTP completo. El script termina con exit 0 cuando reproduce el defecto; **eso no significa que el producto esté correcto**. Evidencia: [postgres-reproduction.json](./testarudo-audit-2026-09-10-evidence/postgres-reproduction.json), [reproductor](./testarudo-audit-2026-09-10-evidence/rest-attribution-DATABASE_URL.cjs).

Corregir con RED primero: el registro de dinero capturado debe conservarse, pero sólo puede cerrar/liberar la solicitud de la terminal a la que pertenece. La primera asociación REST puede necesitar añadir la etiqueta para clientes existentes; eso no justifica saltarse la identidad física. Añadir control positivo de la terminal correcta y controles negativos de terminal/origen incorrectos, tanto en cierre directo como recuperación.

### P1 — La regresión financiera de PAX sigue fallando sin alcanzar el kernel

`PaymentViewModelKernelDurabilityTest.kt:405` conserva el test de fallo de escritura tras aprobación offline. Ejecución propia por avq-verify: **1 test, 1 fallo**, `StartCtlssTransUseCase.run(...) was not called`. No demuestra que el manejo de aprobación esté mal: demuestra que el arnés no está ejercitando el escenario que se pretende certificar. Los `Thread.sleep` y el montaje del cambio de comercio deben resolverse.

No se puede clasificar como trabajo ajeno y dar por validada la continuidad de esta tarea: protege precisamente una de sus invariantes de dinero. El gestor de comercios de este arnés es un mock nuevo en cada setup; una explicación de caché real requiere evidencia adicional.

### P2 — Las nuevas guardas contactless no sustituyen la prueba de comportamiento

`RechazoContactlessLiberaLaTerminalTest.kt` busca `rama.contains("markKernelRefused")`. Comprobación en memoria, sin editar archivos: **la aserción sigue pasando cuando la llamada se convierte en comentario**. Las otras dos pruebas invocan la libreta directamente sobre Room; no ejecutan la rama del ViewModel.

Las llamadas correctivas sí están presentes en sandbox y production. Lo que falta es demostrar el cableado ejecutándolo: rechazo explícito del kernel → fila resuelta → siguiente intento permitido; resultado desconocido/timeout → fila retenida → siguiente intento bloqueado. Las guardas de texto pueden quedar como complemento, no como sustituto. Ejecutar controles de las variantes relevantes; producción tiene tareas Gradle de test propias, aunque el arnés deba adaptarse al SDK del flavor.

## Qué sí avanzó

- La rama de venta `RESULT_OFFLINE_DENIED` llama ahora a `markKernelRefused` en sandbox y production. El defecto concreto de llamada ausente está corregido en fuente; la cobertura de comportamiento queda pendiente arriba.
- `marcaDeDescuadre` está aplicada a recuperación stale, UNKNOWN, TIMED_OUT y resolución manual. Se conserva el Payment y se guarda el sobre de conciliación cuando difieren los importes. Esta revisión no repitió toda la matriz PostgreSQL de ese cambio.
- Las **cinco** pruebas actuales de `AngelPayPaymentReviewRoomTest` pasaron en la corrida propia, incluidas recreación/callback vacío y rechazo tras recreación. Esto actualiza los reportes viejos que lo mantenían enteramente rojo; no sustituye el SDK físico ni la suite financiera completa.
- La reserva atómica del ledger, el chequeo del socket desplazado, el traslado del inventario findMany y la corrección de tasa por meta están presentes. No se encontró en esta revisión breve otro defecto específico en esos cambios.

## Verificaciones y límites de vigencia

TPV, corrida `sbDZFC`: 6 tests, 5 pasan y 1 falla. Comando desde el workspace:

```sh
JAVA_HOME=$(/usr/libexec/java_home -v 23) AVQ_KEEP=1 ./scripts/avq-verify.sh avoqado-tpv ./gradlew -I /Users/amieva/Documents/Programming/Avoqado/avoqado-server/docs/investigations/testarudo-checkpoint-2026-09-09/reports/task-2-room-java17.gradle :app:testSandboxDebugUnitTest --tests 'com.jaac.avoqado_tpv.features.payment.presentation.PaymentViewModelKernelDurabilityTest.offline approval write failure keeps durable obligation and cannot publish success or cancellation' --tests '*AngelPayPaymentReviewRoomTest' --max-workers=1
```

Reproductor PostgreSQL, corrida `hhZ2VG`: reprodujo la atribución incorrecta por REST y el control correcto por SOCKET, con rollback. Para volver a ejecutarlo usando el artefacto conservado:

```sh
AVQ_KEEP=1 ./scripts/avq-verify.sh avoqado-server node /Users/amieva/Documents/Programming/Avoqado/avoqado-server/docs/investigations/testarudo-audit-2026-09-10-evidence/rest-attribution-DATABASE_URL.cjs
```

El nombre DATABASE_URL hace que avq-verify lo dirija a la Mac. El script lee la credencial local sin mostrarla y rechaza hosts no locales; no usa producción ni reinicia/resetear ninguna base.

**Ambas corridas avisaron que cambió la huella global del árbol.** No se presenta su resultado como un verde global vigente. Se compararon los bytes de los archivos relevantes con sus snapshots: el método del reproductor y los archivos TPV revisados coincidían al guardar la evidencia. Ver [huellas](./testarudo-audit-2026-09-10-evidence/source-hashes.json) y [resultados TPV](./testarudo-audit-2026-09-10-evidence/tpv-test-results.json). Revalidar tras las correcciones; no basarse sólo en el estado del workspace ni en XML compartidos sin conservarlos.

## Pendientes para completar el trabajo

1. Cerrar el P1 de atribución REST con prueba PostgreSQL y conservar el dinero capturado.
2. Corregir el arnés PAX y recuperar pruebas de comportamiento independientes; prueba sola, clase y módulo financiero.
3. Resolver/atribuir con evidencia los 26 fallos de referidos del reporte recibido. No se ejecutó de nuevo aquí la suite completa: tres shards verdes y uno rojo no equivalen a suite limpia. La responsabilidad de otra sesión no elimina el pendiente de integración.
4. Build/typecheck de las variantes/proyectos afectados y verificación final coherente sobre el código corregido. No extrapolar estas seis pruebas a todo TPV ni una prueba del método al endpoint completo.
5. QA físico Android POS → PAX/Blumon y Nexgo/AngelPay en cuentas/tarjetas de pruebas: aprobación, rechazo, cancelación/reenvío, internet/DNS/servidor lento, aprobación seguida de fallo de registro, reinicio y reembolso. Contrastar procesador, Payment y saldos de la orden. Instalar sólo APK/flavor y afiliación de pruebas verificados.
6. Consolidar el checkpoint: tiene estados históricos incompatibles mezclados con actualizaciones. Encabezar con la verdad actual y referencias a evidencia; no dejar que otro LLM interprete una sección histórica como el estado vigente.

No hacen falta más permisos para corregir lo ya autorizado. Los sabotajes para verificar pruebas deben hacerse en copias aisladas: un trap de restauración no protege las corridas de otras sesiones durante la ventana en que el árbol compartido está roto.

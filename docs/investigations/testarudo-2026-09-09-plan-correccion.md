# Propuesta de corrección: cobros Android → PAX / Nexgo

9 de septiembre de 2026. Propuesta basada en la [investigación del relay y del error PAX](./testarudo-2026-09-09-android-tpv-relay.md). No es una implementación ni un resultado de pruebas. No hubo cambios de código, instalación de APK, push ni despliegue en esta entrega.

## Objetivo y orden

Primero evitar una segunda autorización cuando el primer resultado es desconocido; después recuperar automáticamente registros y comunicación; finalmente reducir carga del registro con el outbox. El caso $319 no lo corrige acelerar Postgres: la primera aprobación se perdió antes del registro en Avoqado.

La unidad a proteger es la venta/intento, además del aparato. El servidor conserva la obligación de resolver el dinero aunque la terminal ya haya terminado su ejecución. Un aparato sólo puede atender otra venta cuando consta que la ejecución anterior terminó y su resultado pendiente quedó guardado; reiniciar, recibir un heartbeat o vencer un reloj no constituyen esa prueba.

## 1. Corregir el significado de un error y de Reintentar

PAX: GenericFailure, timeout, interrupción de red y excepciones tras entrar en autorización son resultado desconocido, salvo evidencia explícita que determine el resultado. Nunca convertirlos automáticamente en rechazo bancario ni en una nueva llamada SaleIcc/SaleCtls.

Nexgo: conservar resultados inciertos del SDK, incluido G505 aunque el estado externo diga DECLINED. Auditar clasificación, consulta y recuperación como una sola cadena; añadir sólo el clasificador no basta.

Antes de llamar al procesador, persistir el intento con identidad estable y contexto de dinero: venue, venta/orden, terminal, procesador/afiliación, importe, propina y las referencias de correlación disponibles. Conservar la relación requestId POS ↔ attemptId TPV ↔ identificador del procesador; no suponer que la clave idempotente de Payment hace idempotente al SDK.

| Resultado conocido | Conducta |
|---|---|
| Aprobado | Guardar aprobación durable y registrar/reconciliar esa operación; nunca volver a autorizarla |
| Rechazo definitivo o cancelación confirmada antes de autorizar | Puede ofrecerse otro intento deliberado |
| Resultado desconocido | Mostrar «Estamos confirmando el cobro. No vuelvas a pasar la tarjeta» y consultar el intento guardado |
| Aprobado, pendiente de registro en Avoqado | Mostrarlo como cobrado con sincronización pendiente; recuperar registro, no tarjeta |

Cerrar la pantalla, cambiar de pestaña, morir el proceso o reiniciar el equipo debe conservar el pendiente. La protección debe acompañar la venta y su recuperación en otros dispositivos; crear otra orden o elegir otra terminal no debe ser el atajo normal para recobrar una venta incierta.

## 2. Reparar recepción, cancelación y reentrega

Reutilizar inbox Room, requestId, ACK y claim existentes, corrigiendo estas transiciones con pruebas antes del código:

- ACK confirma que la solicitud quedó guardada. **Un ACK perdido no confirma que no se inició cargo.** Sustituir el actual ACK_TIMEOUT → FAILED/400 por un desenlace incierto compatible con la recuperación del cliente.
- Reentregar con la misma identidad y contrato de dinero. Un duplicado devuelve estado/resultado persistido; no vuelve a abrir el SDK.
- Persistir la decisión de cancelación después de comprobar si puede ejecutarse. Una cancelación rechazada por haber dinero en vuelo no puede escribir RESOLVED/cancelled en Room.
- Responder explícitamente a la petición de cancelar: cancelación aceptada, ejecución todavía activa o resultado ya conocido. No reutilizar un payment_result failed para expresar que falló el intento de cancelar un cobro vivo.
- El servidor no debe convertir CANCEL_REQUESTED sin respuesta en una afirmación de no cobrado por el mero transcurso de 30 segundos. Vencer la espera cambia la recuperación/UI, no el hecho financiero.
- Separar «ejecución activa en esta terminal» de «resultado financiero pendiente de esta venta». Sólo liberar el aparato para otras ventas con evidencia de ejecución terminada y pendiente durable; mantener protegida la venta original hasta resolución.

Compatibilidad: conservar las respuestas y campos que leen los APK actuales; las nuevas capacidades se negocian explícitamente. No reentregar comandos a clientes viejos que no pueden deduplicar. Los estados inciertos deben conducir también a los clientes viejos a consultar, no a interpretar un 4xx como permiso para recobrar.

## 3. Recuperar el resultado y el registro

Fuentes de recuperación: aprobación guardada en la TPV, Payment del servidor y confirmación del procesador. Reintentos de consulta/sincronización acotados, con espera creciente y una ejecución coordinada; evitar multiplicar cinco reintentos del caso de uso por otros cinco del worker.

Para aprobaciones guardadas localmente, reproducir únicamente el registro con la misma clave. Arranque y reconexión deben activar recuperación sin exigir que siga abierta la pantalla del recibo. Una respuesta de registro perdida, incluso después del commit, no provoca otro cargo.

**AngelPay:** aprovechar historial e integratorReference, verificando afiliación, terminal, estado y datos de la operación. No declarar NoCobrado por tres consultas vacías, por una página parcial, por una respuesta con retraso, por un historial de otra afiliación o sólo porque haya/no haya un código de autorización. El contrato real de la consulta debe permitir una conclusión definitiva; de lo contrario sigue pendiente. El verificador local en curso termina actualmente en NoCobrado después de consultas exitosas sin coincidencia y requiere revisión antes de adoptarlo.

**Blumon:** el adaptador unificado actual devuelve UnsupportedOperationException para historial. Esto no acredita que el proveedor carezca de una API/SDK apropiada, pero sí que esta aplicación no tiene allí implementada la recuperación. Confirmar con documentación/soporte técnico cómo consultar una autorización perdida usando una identidad exacta obtenible antes de perder la respuesta, y qué garantías tiene de duplicación/finalidad. No prometer recuperación automática del caso GenericFailure hasta verificar ese mecanismo.

Los webhooks ya se guardan; integrarlos como evidencia durable de aprobación y alerta temprana. Cuando existe una referencia fuerte, vincular y recuperar mediante el mismo servicio de registro de dinero. Si sólo coinciden monto/hora/tarjeta enmascarada o hay varios candidatos, conservar el evento sin atribuirlo automáticamente a una orden. Ausencia de webhook no prueba ausencia de cargo.

Si ninguna fuente puede confirmar el resultado, mostrar el pendiente y habilitar un procedimiento de conciliación explícito. Cobrar nuevamente no es una estrategia de recuperación. La UX debe permitir continuar otras ventas cuando sea seguro, sin ocultar ésta ni marcarla pagada antes de tener evidencia.

## 4. Registro transaccional y efectos posteriores

Retomar el outbox después de asegurar autorización/recuperación. Antes de responder, conservar dinero persistido, saldo y estado pagado coherentes, asignaciones y obligaciones de inventario, y el recibo mínimo útil para los APK publicados.

Las obligaciones diferidas nacen en la misma transacción que el hecho financiero que las origina. Reutilizar customerApprovalOutbox: claims acotados, FOR UPDATE SKIP LOCKED, lease, attempts al reclamar y CAS. Cada efecto requiere idempotencia durable propia; entrega al menos una vez no significa efecto único automáticamente.

Integrar la reconciliación de lealtad que ya existe. Distinguir entrega/enriquecimiento de recibo, comisiones, reseña y referidos de los cambios de saldo y de la consulta de disponibilidad de autofactura. `logAction` queda fuera de las transacciones; no confundirlo con el outbox financiero.

Medir por intento: recepción, persistencia, inicio/fin de chip, autorización, resultado, commit de Payment/orden y entrega al POS. Conservar razón de desconexión y clase de excepción del SDK sin volcar PAN/PIN, tags sensibles ni respuestas completas. Separar Request End y Request Closed Prematurely.

## 5. Pruebas que definen la aceptación

TDD estricto: reproducir primero cada transición incorrecta en tests que fallen. Integración con Postgres real y pruebas desde Android hacia cada procesador, además de unit tests.

| Fallo provocado | Resultado exigido |
|---|---|
| Aprobación del procesador y error/pérdida de respuesta del SDK | Pendiente recuperable; cero nueva autorización por pulsar consultar/reintentar recuperación |
| Solicitud persistida en TPV y ACK perdido | Mismo requestId; no FAILED/no-cobrado inventado; una sola ejecución |
| Historial vacío o retrasado después de aprobar | Conservar incertidumbre; no habilitar otro cargo |
| Cancelar desde Android durante autorización | Ambos aparatos muestran que sigue activo; no escribir cancelación financiera falsa |
| Cancelar antes de iniciar autorización | Cancelación confirmada; no ejecutar después un mensaje viejo/reentregado |
| Caída antes del commit | Sin efectos financieros parciales; recuperación del mismo intento |
| Commit realizado y respuesta perdida | Un Payment, orden/saldo coherentes, mismo recibo y sin nueva autorización |
| Muerte de Android, TPV o servidor | Identidad/contexto y aprobación sobreviven; recuperación al volver |
| Wi-Fi/DNS fallan, cambian o se recuperan | Estado visible y consultas acotadas; no doble cargo ni abandono silencioso |
| Servidor lento o indisponible después de aprobar | Guardado local durable y posterior registro, sin volver a pasar tarjeta |
| Entrega duplicada del job o caída tras aplicar el efecto | Sin duplicar recibo, comisión, inventario, lealtad u otros efectos |

Los fallos contra el procesador se provocan únicamente con sandbox y tarjeta de pruebas; un mock del SDK no acredita su comportamiento real. Verificar chip y contactless en PAX y el flujo SDK Nexgo, siempre iniciando desde Android. No basta Pago rápido en la terminal.

Typecheck/build y suite por avq-verify, Postgres y hardware locales, auditoría de Codex al final. Un fix en el árbol compartido no cuenta como publicado: coordinar por rutas y respetar el WIP existente.

Entrega posterior a las pruebas: backend compatible primero y actualización controlada de Android/PAX/Nexgo con artefactos correspondientes, observando el flujo completo antes de ampliar. Este documento no autoriza ni ejecuta distribución.

## El incidente existente

En paralelo al software, comprobar reverso/liquidación de Blumon 24237797 y 24237873. La corrección evita repetir el mecanismo, pero no resuelve por sí sola los dos cargos ya aprobados. No reconstruir un Payment ni devolver dinero automáticamente a partir de una correlación aproximada.

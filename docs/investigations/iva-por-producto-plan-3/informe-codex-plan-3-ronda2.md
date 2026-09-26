**RECHAZO** — falta cerrar la recaptura incierta, conservar los desenlaces reales del PAC y completar la barrera de delivery. B+ puede mantenerse.

Revisé la v2 del commit `3013508b`, el informe anterior y el código actual.

1. **P1 — Los 10 minutos permiten duplicados; el CAS sólo protege la fila local.**  
   Referencias: [plan:58](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/.claude/worktrees/iva-por-producto/docs/superpowers/plans/2026-09-26-iva-por-producto-plan-3-facturacion.md:58), [plan:472](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/.claude/worktrees/iva-por-producto/docs/superpowers/plans/2026-09-26-iva-por-producto-plan-3-facturacion.md:472).

   **Escenario:** A envía $116 al 16 % y pierde la respuesta. Al minuto 11, una búsqueda negativa permite recapturar y B timbra al 0 %. Después aparece el documento de A. Quedan **dos CFDI reales**; precisamente el caso que la prueba 10 acepta mediante una alerta.

   Tampoco está demostrado el límite del proveedor: Facturapi documenta recuperación de solicitudes pendientes hasta el **minuto 50**. Eso no demuestra que una búsqueda negativa concreta sea incorrecta, pero sí descarta asumir que su procesamiento termina a los 10 minutos. [Intermitencias de Facturapi](https://docs.facturapi.io/docs/guides/invoices/intermitencias/).

   Además, [plan:383](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/.claude/worktrees/iva-por-producto/docs/superpowers/plans/2026-09-26-iva-por-producto-plan-3-facturacion.md:383) reutiliza el mismo `external_id` entre versiones: si después se recupera A, puede asociarse su XML al 16 % con la entrada nueva al 0 %, pasando el CAS de la versión actual.

   **Mínimo:** conservar el intento y su entrada mientras el resultado sea incierto. Una búsqueda negativa y tiempo transcurrido no prueban cierre definitivo. Aplicar ese mismo criterio a la definición de factura **VIVA** en [plan:553](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/.claude/worktrees/iva-por-producto/docs/superpowers/plans/2026-09-26-iva-por-producto-plan-3-facturacion.md:553), que todavía permite dejar de excluir por una mera consulta negativa.

2. **P1 — “Error con cuerpo de respuesta” no significa rechazo definitivo, y hoy el adaptador no hace esa distinción.**  
   Referencias: [plan:455](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/.claude/worktrees/iva-por-producto/docs/superpowers/plans/2026-09-26-iva-por-producto-plan-3-facturacion.md:455), [facturapi.provider.ts:215](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/.claude/worktrees/iva-por-producto/src/services/fiscal/providers/facturapi.provider.ts:215).

   El adaptador registra el mensaje y relanza el error. El SDK instalado, **4.17.0**, convierte las respuestas HTTP fallidas en `Error(message)`, descartando código HTTP y campos estructurados: [SDK:799](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/.claude/worktrees/iva-por-producto/node_modules/facturapi/dist/index.es.js:799).

   **Escenario:** se timbra, pero la API falla después y responde `500` con JSON. Clasificarlo como definitivo permite otro envío inmediatamente, aunque el documento anterior exista.

   **Mínimo:** conservar código HTTP y código de error; admitir como definitivos únicamente rechazos conocidos que demuestren que no hubo timbre. `500`, red, timeout y resultados desconocidos permanecen inciertos. Facturapi recomienda decidir por `code`, no por el mensaje. [Contrato de errores](https://docs.facturapi.io/docs/getting-started/errors/).

3. **P1 — Una respuesta `202 pending` termina como “timbrada” sin UUID.**  
   Referencias: [facturapi.provider.ts:604](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/.claude/worktrees/iva-por-producto/src/services/fiscal/providers/facturapi.provider.ts:604), [plan:493](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/.claude/worktrees/iva-por-producto/docs/superpowers/plans/2026-09-26-iva-por-producto-plan-3-facturacion.md:493).

   **Escenario:** Facturapi devuelve `202`, `status: pending`, sin UUID. `toStamped` transforma cualquier estado distinto de `canceled` en `valid`; `toSummary` hace lo mismo. El finalizador puede guardar `STAMPED` sin folio fiscal. Cuando el PAC lo obtiene después, el nuevo reparador sólo completa archivos y desglose; el [webhook:251](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/.claude/worktrees/iva-por-producto/src/services/fiscal/facturapiWebhook.service.ts:251) revisa cancelaciones. **El UUID queda sin incorporarse**, bloqueando operaciones que lo requieren, como sustituir o emitir el egreso.

   **Mínimo:** conservar `pending` y el identificador del proveedor; finalizar únicamente con estado válido y UUID. Reutilizar la conciliación existente para completar la identidad.

4. **P1 — Delivery puede activarse después de encender IVA por producto.**  
   Referencias: [plan:26](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/.claude/worktrees/iva-por-producto/docs/superpowers/plans/2026-09-26-iva-por-producto-plan-3-facturacion.md:26), [deliveryStoreClaim.service.ts:373](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/.claude/worktrees/iva-por-producto/src/services/delivery-channels/core/deliveryStoreClaim.service.ts:373).

   **Escenario:** negocio sin delivery → enciende IVA por producto → conecta Uber. Venta de tres artículos de $116; primer retiro devuelve $116 con IVA de $16; corrigen el producto a 0 %; segundo retiro vuelve a caer en `FISCAL_PENDING` antes de registrar la devolución.

   **Mínimo:** en el plan 6, imponer la incompatibilidad también al conectar o reanudar delivery, comprobándola de forma atómica. Puede seguir diferido el cálculo de delivery.

5. **P2 — Una validación corregida queda sin camino de reintento.**  
   Referencias: [plan:448](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/.claude/worktrees/iva-por-producto/docs/superpowers/plans/2026-09-26-iva-por-producto-plan-3-facturacion.md:448), [plan:452](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/.claude/worktrees/iva-por-producto/docs/superpowers/plans/2026-09-26-iva-por-producto-plan-3-facturacion.md:452).

   **Escenario:** una venta mixta falla porque falta confirmar IVA incluido. Nace `VALIDATION_FAILED`, `enviadoAt = NULL`, `falloDefinitivo = false`. El dueño confirma el contrato y reintenta: nunca hubo envío, pero ninguna condición definida permite recapturar. Puede quedar respondiendo “en proceso” indefinidamente.

   **Mínimo:** contemplar expresamente el intento nuevo que **nunca se envió**. No extrapolar ese permiso a filas históricas con `enviadoAt = NULL`.

6. **P2 — Reclamar para consultar invalida una respuesta legítima sin haber enviado otra factura.**  
   Referencias: [plan:446](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/.claude/worktrees/iva-por-producto/docs/superpowers/plans/2026-09-26-iva-por-producto-plan-3-facturacion.md:446), [cfdi.service.ts:580](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/.claude/worktrees/iva-por-producto/src/services/fiscal/cfdi.service.ts:580).

   **Escenario:** A sigue procesándose; al minuto 4, B reclama y aumenta `attempts`. Su búsqueda es negativa y devuelve 409 porque aún no pasan 10 minutos. A termina después: su versión ya es vieja y se registra `CFDI_TIMBRE_DUPLICADO`, aunque **sólo existe un documento**. La fila queda fallida; el barrido actual sólo busca `STAMPING`.

   **Mínimo:** avanzar la versión del envío cuando realmente se sustituya la entrada tras cerrar el intento anterior. Una consulta de recuperación no debe convertir ese envío en obsoleto.

Los cierres que sí están bien **en el plan**:

- Egreso al 16 % de la original: cierra el cambio posterior del catálogo.
- Bloquear órdenes y releer elegibilidad: cierra la carrera de selección global ↔ individual; falta el criterio de vida señalado arriba.
- Entrada histórica `NULL`, motivo del egreso por la ruta real, CAS de cancelación y golden ampliadas: correctos.

**Lo que sobra**

7. **P3 — Volver a sellar en cada finalización resulta redundante.**  
   En [plan:493](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/.claude/worktrees/iva-por-producto/docs/superpowers/plans/2026-09-26-iva-por-producto-plan-3-facturacion.md:493), los sellos ya nacieron atómicamente con la reserva; `RESET` los conserva y una cancelación confirmada impide finalizar. Cerrada correctamente la vida del intento, esa segunda pasada por los renglones no resuelve otro escenario.

Quitar el enum y guardar `params` resueltos son buenas simplificaciones. La relación renglón ↔ CFDI y el control de versión sí tienen una razón concreta para quedarse. La sonda de idempotencia también sirve, pero no demuestra la seguridad de los 10 minutos.

Revisión sólo de lectura: no modifiqué archivos, no consulté bases ni ejecuté pruebas.

La v2 mejora varios cierres, pero todavía puede duplicar una factura o dejarla sin folio en Avoqado.  
B+ sigue siendo suficiente; estos problemas no requieren ampliar el producto.  
Para autorizar, necesito que el plan cierre los escenarios anteriores.
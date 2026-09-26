**RECHAZO el plan 3 como está.** Lista mínima: cerrar la vida del intento, hacer atómica la exclusión global ↔ individual, corregir el cálculo del egreso y condicionar la convivencia con delivery. B+ puede mantenerse.

La entrada congelada y la separación entre tasa cero y exento están bien. No hacen falta globales mixtas ni un motor de notas de crédito mixtas para resolver lo siguiente.

1. **P1 — Re-sellar después de una respuesta tardía no cierra la condición 1.**

   El [plan:435](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/.claude/worktrees/iva-por-producto/docs/superpowers/plans/2026-09-26-iva-por-producto-plan-3-facturacion.md:435) libera y recaptura tras una búsqueda negativa; el [plan:473](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/.claude/worktrees/iva-por-producto/docs/superpowers/plans/2026-09-26-iva-por-producto-plan-3-facturacion.md:473) acepta expresamente que el envío anterior termine después. El reconciliador actual escribe por ID, sin comprobar la versión: [cfdiReconcile.service.ts:328](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/.claude/worktrees/iva-por-producto/src/services/fiscal/cfdiReconcile.service.ts:328).

   **Escenario:** A envía $116 al 16 %; la consulta todavía no lo encuentra; se libera, cambia el producto a 0 % y B timbra $116 al 0 %. Después A también termina. Hay dos documentos reales. Re-sellar A encuentra `SELLO_DIVERGENTE` y puede revertir además la persistencia de su UUID.

   **Mínimo:** una búsqueda negativa no autoriza recapturar mientras el envío anterior pueda completar. Usar la versión del intento en reclamación, fallo, liberación y finalización; `idempotencyKey` solo no distingue las recapturas. El finalizador tampoco debe resucitar una cancelación confirmada.

2. **P1 — La nota de crédito puede acreditar un IVA distinto del original.**

   La [tarea 11:550](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/.claude/worktrees/iva-por-producto/docs/superpowers/plans/2026-09-26-iva-por-producto-plan-3-facturacion.md:550) bloquea originales mixtas, pero conserva el cálculo que lee `Product.taxRate`: [cfdiCreditNote.service.ts:565](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/.claude/worktrees/iva-por-producto/src/services/fiscal/cfdiCreditNote.service.ts:565).

   **Escenario:** factura original de $116, base $100 e IVA $16, sellada al 16 %. Se corrige el producto a IVA_0 y se devuelven $116. La original pasa el filtro todo-16, pero el egreso sale sin IVA: quedan $16 fiscales sin revertir.

   **Mínimo:** calcular desde el tratamiento de la original. Si B+ sólo admite originales todo-16, no necesita consultar el catálogo para repartir el egreso.

3. **P1 — La exclusión global ↔ individual todavía permite una carrera.**

   La [tarea 10:524](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/.claude/worktrees/iva-por-producto/docs/superpowers/plans/2026-09-26-iva-por-producto-plan-3-facturacion.md:524) separa selección y reserva sin exigir que se relean las exclusiones bajo el bloqueo de cada orden. Hoy los candidatos se cargan antes de reservar: [cfdiGlobal.service.ts:130](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/.claude/worktrees/iva-por-producto/src/services/fiscal/cfdiGlobal.service.ts:130).

   **Escenario:** la global selecciona una venta de $116; la individual reserva y confirma; la global reserva usando su selección anterior. Ambas timbran esa venta. El candado organizacional **compartido** permite ambas emisiones, y la unicidad `(cfdiId, orderId)` tampoco las excluye.

   **Mínimo:** bloquear las órdenes en orden estable y releer elegibilidad dentro de la reserva; construir manifiesto y documento con esa selección definitiva. También debe consumirse el motivo devuelto por `excluirSiEstaEnGlobal`: el `await` aislado de la tarea 6 no bloquea nada.

4. **P1 — Globales y egresos conservan reintentos que pueden duplicar documentos.**

   Las tareas 10 y 11 añaden protocolo y admisión, pero no sustituyen los caminos actuales que continúan tras encontrar una reserva fallida o vencida: [cfdiGlobal.service.ts:207](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/.claude/worktrees/iva-por-producto/src/services/fiscal/cfdiGlobal.service.ts:207), [cfdiCreditNote.service.ts:309](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/.claude/worktrees/iva-por-producto/src/services/fiscal/cfdiCreditNote.service.ts:309).

   **Escenario:** el PAC timbra un egreso de $58, pero se pierde la respuesta. El siguiente intento encuentra `STAMP_FAILED` y vuelve a emitir: quedan $116 acreditados por una devolución de $58. La global tiene el mismo problema.

   **Mínimo:** aplicarles el mismo reclamo y recuperación del intento individual, conservar el documento enviado y persistir su identidad antes de descargar archivos. Poner `protocoloIva = 1` no demuestra esas garantías.

5. **P1 — El reconciliador puede recuperar la factura de otra venta.**

   Tras fallar la búsqueda por identidad, el código compara RFC, total y condición de global: [cfdiReconcile.service.ts:238](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/.claude/worktrees/iva-por-producto/src/services/fiscal/cfdiReconcile.service.ts:238), [264](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/.claude/worktrees/iva-por-producto/src/services/fiscal/cfdiReconcile.service.ts:264). La tarea 7 conserva esa recuperación.

   **Escenario:** A es una venta de $116 al 0 % cuyo intento no produjo documento. En Facturapi existe B, emitida desde su portal al mismo RFC por $116 al 16 %. El respaldo encuentra B y la asocia con A; el nuevo finalizador sella A al 0 %, pero entrega el XML de B con $16 de IVA.

   **Mínimo:** los intentos nuevos deben recuperarse por identidad comprobada del documento/intento. Coincidir en RFC e importe no prueba identidad. Los históricos ambiguos quedan para revisión.

6. **P1 — Delivery diferido necesita una barrera antes del encendido.**

   El [plan:18](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/.claude/worktrees/iva-por-producto/docs/superpowers/plans/2026-09-26-iva-por-producto-plan-3-facturacion.md:18) considera inocuo dejarlo igual. Sin embargo, se recalcula la venta con tasas actuales y se restan devoluciones con IVA congelado: [deliveryFiscalDelta.ts:113](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/.claude/worktrees/iva-por-producto/src/services/fiscal/deliveryFiscalDelta.ts:113).

   **Escenario:** tres artículos de $116 al 16 %, total $348. Delivery retira uno: devolución de $116 con $16 de IVA congelado. Se corrige el producto a 0 % y después se retira otro. El cálculo obtiene IVA negativo y sale por `FISCAL_PENDING` **antes de registrar la segunda devolución**: [deliveryReconciliation.service.ts:360](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/.claude/worktrees/iva-por-producto/src/services/delivery-channels/core/deliveryReconciliation.service.ts:360).

   **Mínimo para conservar B+:** impedir temporalmente esa convivencia al habilitar IVA por producto, con motivo visible, hasta cerrar el cálculo de delivery. No exige construirlo dentro del plan 3, pero sí reconocerlo como condición de encendido.

7. **P2 — No se puede inventar una entrada histórica desde la orden actual.**

   El [plan:435](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/.claude/worktrees/iva-por-producto/docs/superpowers/plans/2026-09-26-iva-por-producto-plan-3-facturacion.md:435) manda capturar la orden viva cuando encuentra un documento anterior sin entrada. El loader utiliza cantidades, precios y pagos actuales: [cfdi.service.ts:952](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/.claude/worktrees/iva-por-producto/src/services/fiscal/cfdi.service.ts:952).

   **Escenario:** el intento antiguo timbró $116; después se amplió y cobró la cuenta a $232. La recuperación encuentra aquel XML, pero guarda una entrada de $232 asociada con él. Que ambos sean todo-16 no resuelve la discrepancia.

   **Mínimo:** recuperar lo demostrable del documento original; conservar como desconocido lo que no pueda reconstruirse. No certificar una foto actual como entrada histórica.

8. **P2 — El bloqueo nuevo del egreso no llega siempre con su motivo al usuario.**

   La tarea 11 introduce el mensaje «la nota de crédito… todavía no está disponible». La emisión lanza el mensaje de elegibilidad en [cfdiCreditNote.service.ts:235](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/.claude/worktrees/iva-por-producto/src/services/fiscal/cfdiCreditNote.service.ts:235), pero el controlador sólo reconoce otras frases: [cfdi.dashboard.controller.ts:485](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/.claude/worktrees/iva-por-producto/src/controllers/dashboard/cfdi.dashboard.controller.ts:485).

   **Escenario:** se solicita directamente un egreso de original mixta; queda bloqueado, pero la respuesta es `500 / Error interno`, sin explicar el motivo.

   **Mínimo:** incorporar esa respuesta de negocio al controlador y comprobarla por la ruta real.

**Compatibilidad y verificación.** Para productos coherentes `IVA_16`, no encuentro un cambio inevitable de `objetoImp` o impuestos en la tarea 3. Pero las cuatro golden sólo fijan `CreateInvoiceParams`: faltan los importes persistidos, los motivos y una orden con IVA separado (`taxAmount > 0`). La exclusión global añade un motivo deliberadamente nuevo y debe declararse como excepción a «idéntico a hoy».

Las carreras necesitan pruebas con pausas controladas: entre consulta y reserva, entre consulta negativa y respuesta tardía, y entre cancelación confirmada y respuesta antigua. La cancelación directa hoy usa un `update` incondicional —[cfdi.service.ts:1308](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/.claude/worktrees/iva-por-producto/src/services/fiscal/cfdi.service.ts:1308)—; la tarea 8 debe **crear** allí el CAS, además de conservar los de los otros caminos.

Adelantaría una comprobación puntual del contrato del PAC: su [documentación actual](https://docs.facturapi.io/api/) distingue `external_id`, sin unicidad, de `idempotency_key` en el cuerpo para evitar duplicados. El [adaptador:175](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/.claude/worktrees/iva-por-producto/src/services/fiscal/providers/facturapi.provider.ts:175) documenta pruebas con otros campos/ubicaciones y no lo envía. Verificarlo en sandbox puede simplificar el cierre; **no lo doy por probado en esta auditoría**.

**Lo que sobra**

- **El enum `SelloIvaCausa` puede quitarse en B+.** Individual/global ya se deduce del CFDI. **La relación renglón ↔ CFDI sí debe quedarse:** original y sustituta pueden coexistir, incluso siendo ambas individuales; cancelar una no debe liberar la otra.
- **La reconstrucción doble de la entrada puede simplificarse.** Guardar los parámetros ya resueltos del documento, junto con los renglones que sella y la evidencia necesaria, evita reconstruir `AvoqadoSaleInput` y volver a resolver claves SAT. Incluir la relación de sustitución en esa foto.

La revisión fue sólo de lectura: no modifiqué archivos, no consulté bases ni ejecuté pruebas.  
B+ sigue siendo viable; los huecos están en reintentos, exclusión y lecturas del IVA vivo.  
Necesito que esos cierres queden explícitos en el plan antes de autorizarlo; no hace falta ampliar el producto.
**RECHAZO** — quedan caminos para duplicar CFDI durante la recaptura y entre emisiones distintas; la declaración humana de los 60 minutos tampoco demuestra que el intento terminó.

Revisé la v3 `d7502cea`, incluida en `HEAD`, contra la ronda 2 y el código actual. Seis hallazgos:

1. **P1 — El reintento puede entrar después de que la global tomó la venta.**  
   Referencias: [plan:464](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/.claude/worktrees/iva-por-producto/docs/superpowers/plans/2026-09-26-iva-por-producto-plan-3-facturacion.md:464), [plan:471](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/.claude/worktrees/iva-por-producto/docs/superpowers/plans/2026-09-26-iva-por-producto-plan-3-facturacion.md:471).

   **Escenario:** venta pagada de $116 con `VALIDATION_FAILED` por RFC incorrecto. El dueño corrige y reintenta: la transacción A comprueba que no hay global y sale a consultar al PAC. Mientras tanto, la global reserva esa venta, porque el intento fallido no cuenta como vivo. La transacción B recaptura sin repetir la exclusión. **Se timbran la global y la individual.**

   **Mínimo:** repetir la exclusión dentro de B, bajo el bloqueo de la orden, antes de reclamar y sellar.

2. **P1 — El CAS concreto de recaptura pierde la comprobación de “nunca enviado”.**  
   Referencias: [plan:471](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/.claude/worktrees/iva-por-producto/docs/superpowers/plans/2026-09-26-iva-por-producto-plan-3-facturacion.md:471), [plan:473](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/.claude/worktrees/iva-por-producto/docs/superpowers/plans/2026-09-26-iva-por-producto-plan-3-facturacion.md:473).

   **Escenario:** B lee `STAMPING`, versión 1, `enviadoAt = NULL`. A registra el envío y llama al PAC. B reclama usando únicamente `status + attempts`, que siguen iguales, recaptura y envía la versión 2. **Ambos documentos pueden timbrarse.**

   La regla general sí menciona `enviadoAt`; la receta concreta lo omite. **Mínimo:** comprobar atómicamente que sigue siendo nunca enviado o rechazado; quien pierda el CAS no llama al PAC.

3. **P1 — Los 60 minutos permiten declarar cerrado un reenvío todavía en vuelo.**  
   Referencias: [plan:75](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/.claude/worktrees/iva-por-producto/docs/superpowers/plans/2026-09-26-iva-por-producto-plan-3-facturacion.md:75), [plan:244](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/.claude/worktrees/iva-por-producto/docs/superpowers/plans/2026-09-26-iva-por-producto-plan-3-facturacion.md:244).

   **Escenario:** el envío inicial no llega al PAC. Al minuto 61 comienza un reenvío idéntico; `enviadoAt` conserva la hora inicial. Una persona acaba de revisar el portal vacío y declara ausencia mientras ese reenvío viaja. Otro proceso recaptura y envía una versión nueva. **El reenvío anterior y la nueva versión producen dos documentos.**

   Facturapi documenta cinco **consultas de recuperación**, hasta el minuto 50; no garantiza que ese plazo pruebe ausencia definitiva. [Intermitencias de Facturapi](https://docs.facturapi.io/docs/guides/invoices/intermitencias/).

   **Mínimo:** quitar esta autorización de recaptura. Los 60 minutos son razonables para escalar a soporte, no para convertir incertidumbre en rechazo.

4. **P1 — Una sustituta incierta todavía permite emitir por otra llave.**  
   Referencias: [plan:461](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/.claude/worktrees/iva-por-producto/docs/superpowers/plans/2026-09-26-iva-por-producto-plan-3-facturacion.md:461), [cfdi.service.ts:298](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/.claude/worktrees/iva-por-producto/src/services/fiscal/cfdi.service.ts:298).

   **Escenario:** el PAC timbra la sustituta R, pero se pierde la respuesta y localmente queda `STAMP_FAILED` incierta. La original se cancela desde el portal y Avoqado recibe la confirmación. El dueño vuelve a facturar: el control actual de “otro carril” sólo bloquea `STAMPING` reciente; deja pasar una nueva emisión `-n2`. **Quedan R y la nueva factura vigentes.**

   **Mínimo:** aplicar la definición de VIVA también entre emisiones individuales y sustituciones de la misma orden, bajo su bloqueo; el intento incierto no caduca por TTL.

5. **P2 — No está demostrado que cualquier 400/422 sea rechazo definitivo.**  
   Referencia: [plan:474](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/.claude/worktrees/iva-por-producto/docs/superpowers/plans/2026-09-26-iva-por-producto-plan-3-facturacion.md:474).

   **Entrada problemática:** un 400/422 con `code` desconocido obtiene automáticamente `falloDefinitivo = true`. La sonda de un cuerpo inválido no demuestra que todos esos códigos HTTP signifiquen lo mismo.

   **Sí: hay que acotarlo por `code`.** Facturapi distingue validación de entrada (`invalid_request`), validación de timbrado y estados como `stamping_in_progress`; recomienda decidir por el código estructurado. No encontré una garantía universal para 400/422, por eso no lo presento como duplicado P1 demostrado. [Contrato de errores](https://docs.facturapi.io/docs/getting-started/errors/).

   **Mínimo:** lista pequeña de rechazos confirmados; desconocidos permanecen inciertos. Además, rechazar un **reenvío** no demuestra por sí solo qué pasó con el envío anterior.

6. **P2 — La versión sola no impide retroceder un estado ya finalizado.**  
   Referencia: [plan:517](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/.claude/worktrees/iva-por-producto/docs/superpowers/plans/2026-09-26-iva-por-producto-plan-3-facturacion.md:517).

   **Escenario:** el barrido obtiene una búsqueda negativa; una consulta concurrente recupera el UUID y guarda `STAMPED`; después el barrido escribe `RESET` con la misma versión. El CAS por `attempts` todavía coincide y devuelve la factura a `STAMP_FAILED`. También puede pisar una cancelación posterior.

   **Mínimo:** los fallos, `pending` y `RESET` deben comprobar también el estado permitido de origen. Una respuesta atrasada no puede degradar `STAMPED` ni `CANCELLED`.

Los cierres que sí están bien **en el plan**:

- `pending` conserva identidad y sólo `valid` con UUID finaliza: cierra el caso anterior de factura marcada timbrada sin UUID.
- Consultar sin incrementar `attempts` y usar `external_id` por versión: correctos.
- Recapturar una validación corregida únicamente con `protocoloIva = 1`: correcto, cerrando la carrera del punto 2.
- Delivery incompatible en ambos sentidos y comprobado atómicamente: correcto como condición obligatoria del plan 6.
- No encontré otro defecto de cálculo de IVA o total en las reglas mixtas descritas, manteniendo las condiciones de encendido.

**Lo que sobra:** quitaría el nuevo flujo de declaración de ausencia en dashboard y MCP. Añade una salida fiscal insegura que B+ no necesita. Quitar el re-sellado estuvo bien; conservar la entrada, sus versiones y el HTTP acotado que preserva errores sí tiene una razón concreta.

No modifiqué archivos, no consulté bases ni ejecuté pruebas.

La v3 corrige varios problemas, pero todavía puede generar dos facturas por una venta.  
B+ sigue siendo suficiente: faltan cerrar comprobaciones atómicas, no ampliar el producto.  
Para autorizar, necesito esos cierres en el plan y retirar la recaptura basada sólo en declaración y tiempo.
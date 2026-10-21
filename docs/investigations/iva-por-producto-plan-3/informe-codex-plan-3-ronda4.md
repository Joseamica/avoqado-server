**AUTORIZO el plan 3**, condicionado a corregir el P2 siguiente y alinear la prueba de rechazo. No encontré un P1 nuevo en los cierres revisados.

Revisé v4 (`1872755b`) contra los seis hallazgos de ronda 3.

- **Cierres 1 y 2: correctos.** B repite las exclusiones bajo bloqueo y su CAS comprueba “nunca enviado o rechazado”; quien pierde no timbra. [Plan:480](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/.claude/worktrees/iva-por-producto/docs/superpowers/plans/2026-09-26-iva-por-producto-plan-3-facturacion.md:480).
- **Cierre 3: correcto.** Los 60 minutos escalan a soporte sin liberar ni habilitar recaptura. [Plan:82](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/.claude/worktrees/iva-por-producto/docs/superpowers/plans/2026-09-26-iva-por-producto-plan-3-facturacion.md:82).
- **Cierre 4: correcto.** VIVA cubre otras emisiones y sustituciones bajo el bloqueo, sin vencimiento. [Plan:86](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/.claude/worktrees/iva-por-producto/docs/superpowers/plans/2026-09-26-iva-por-producto-plan-3-facturacion.md:86).
- **Cierre 5: correcto como contrato.** Lista acotada de códigos y únicamente primer envío; falta obtener la evidencia prevista en la sonda. [Plan:492](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/.claude/worktrees/iva-por-producto/docs/superpowers/plans/2026-09-26-iva-por-producto-plan-3-facturacion.md:492).
- **Cierre 6: corrige la degradación de estados finales**, pero abre este caso.

**P2 — Un rechazo confirmado tardío puede perderse y bloquear la venta indefinidamente.**  
Referencias: [plan:485](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/.claude/worktrees/iva-por-producto/docs/superpowers/plans/2026-09-26-iva-por-producto-plan-3-facturacion.md:485), [plan:531](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/.claude/worktrees/iva-por-producto/docs/superpowers/plans/2026-09-26-iva-por-producto-plan-3-facturacion.md:531).

**Escenario:** el barrido aplica `RESET` y deja `STAMP_FAILED`, misma versión, `falloDefinitivo = false`. Después se procesa el rechazo confirmado del **primer envío**. Su escritura exige `STAMPING`, así que no guarda el rechazo. Sin deduplicación, las búsquedas seguirán vacías y la venta continuará incierta: no puede recapturarse aunque llegó evidencia definitiva.

**Ajuste mínimo:** conservar ese rechazo tardío de la misma versión después de `RESET`, manteniendo protegidos `STAMPED` y `CANCELLED`. Añadir ese orden de eventos a las pruebas previstas.

**Lo que sobra:** la expectativa genérica «respuesta 422 ⇒ Rechazado» de [plan:502](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/.claude/worktrees/iva-por-producto/docs/superpowers/plans/2026-09-26-iva-por-producto-plan-3-facturacion.md:502). Contradice v4: debe especificar un código confirmado y primer envío.

Sólo lectura: no modifiqué archivos, consulté bases ni ejecuté pruebas.

Los cuatro riesgos de duplicación señalados en ronda 3 quedan cerrados en el plan.  
Puedes avanzar con B+ tras ajustar el rechazo tardío y esa prueba contradictoria.  
No necesito otra decisión tuya.
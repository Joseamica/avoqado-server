# Auditoría del PLAN 3 v4 — IVA por producto (ronda 4)

IMPORTANT: READ-ONLY. No edites, crees ni borres archivos. No te conectes a bases. No corras pruebas. Responde en ESPAÑOL.

**Sé franco y directo. Nada de sobre-ingeniería.** Un P1 exige un escenario concreto. Reporta lo que SOBRA. Si un cierre está bien, una
línea. Máximo ~5 hallazgos. Revisa SÓLO si los cierres de tu ronda 3 están bien y si abren algo nuevo; no re-auditar lo que ya
aprobaste en las rondas 2 y 3.

Tu informe de la ronda 3 (RECHAZO, 4 P1 + 2 P2): `docs/investigations/iva-por-producto-plan-3/informe-codex-plan-3-ronda3.md`.
Plan v4: `docs/superpowers/plans/2026-09-26-iva-por-producto-plan-3-facturacion.md` (diff contra v3: `git show HEAD~1 -- <plan>` si
HEAD es este encargo, o `git log -3` para ubicar el commit «plan 3 v4»). Resumen en el bloque «v4» al inicio del plan.

Cierres: (1) la Transacción B repite `excluirSiEstaEnGlobal` y el control de VIVA bajo el bloqueo; (2) el CAS de recaptura exige
`enviadoAt IS NULL OR falloDefinitivo = true` y quien pierde no llama al PAC; (3) quitada la declaración humana: un incierto a los 60 min
se escala a soporte sin cambiar la fila; (4) VIVA aplica también individual ↔ individual (`-nN`) e individual ↔ sustitución, dentro de
la transacción con la orden `FOR UPDATE`, sin caducar; (5) `RECHAZOS_CONFIRMADOS` = `invalid_request` + los `code` que la sonda confirme
sin documento, y sólo en el primer envío de la versión; (6) fallo, `pending`, `RESET` y finalizar exigen estado de origen.

Pregunta: ¿AUTORIZAS el plan 3? Formato: primera línea **AUTORIZO el plan 3** (con condiciones) o **RECHAZO** (lista mínima);
hallazgos con archivo:línea y escenario; «Lo que sobra»; cierre de 3 líneas en lenguaje llano para el founder.

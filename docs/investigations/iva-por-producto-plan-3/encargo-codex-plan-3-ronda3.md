# Auditoría del PLAN 3 v3 — IVA por producto (ronda 3)

IMPORTANT: READ-ONLY. No edites, crees ni borres archivos. No te conectes a bases. No corras pruebas. Responde en ESPAÑOL.

**Sé franco y directo. Nada de sobre-ingeniería.** Un P1 exige un escenario concreto (entradas → factura o dinero mal, dos
documentos, o algo perdido). Reporta también lo que SOBRA, incluido lo que agregué en esta v3. Si un cierre está bien, una línea.
Máximo ~6 hallazgos.

Tu informe de la ronda 2 (RECHAZO, 4 P1 + 2 P2 + 1 P3): `docs/investigations/iva-por-producto-plan-3/informe-codex-plan-3-ronda2.md`.
Plan v3: `docs/superpowers/plans/2026-09-26-iva-por-producto-plan-3-facturacion.md` (commit `HEAD`; diff contra v2: `git show HEAD`).

Cómo intenté cerrarlos (el bloque «v3» al inicio del plan y la tabla «Tres estados» de Global Constraints):
1. **Recaptura incierta** → se quita la ventana de 10 min. Tres estados: Nunca enviado / Rechazado (400 o 422) / Incierto. Un incierto
   NUNCA se recaptura; se resuelve por búsqueda, por reenvío IDÉNTICO con `idempotency_key` en el cuerpo sólo si la sonda de sandbox
   prueba que Facturapi deduplica, o por declaración humana con `cfdi:configure` tras 60 min. `external_id = <llave>#<attempts>`.
   La definición de factura VIVA para la exclusión global cuenta lo incierto como vivo.
2. **Rechazo definitivo** → el adaptador hace `invoices.create` por HTTP propio y conserva `status`/`code`; sólo 400/422 = Rechazado.
3. **`pending`** → guarda `facturapiId`, sigue `STAMPING`; sólo `valid` con UUID finaliza; el barrido completa la identidad.
4. **Delivery** → incompatibilidad en los dos sentidos (encender IVA con delivery / conectar o reanudar delivery con IVA), atómica.
5. **Validación corregida** → «nunca enviado» (`enviadoAt IS NULL`, sólo `protocoloIva = 1`) permite recapturar.
6. **Consultar invalidaba** → consultar no reclama ni sube `attempts`; sólo enviar una entrada NUEVA la sube.
7. **Re-sellado** → quitado.

Preguntas: (1) ¿Queda un escenario de IVA equivocado, importe distinto de lo cobrado, dos documentos o factura sin UUID?
(2) ¿400/422 como «rechazo antes de timbrar» es correcto para Facturapi, o hay que acotarlo a ciertos `code`? (3) ¿La declaración
humana a los 60 min es razonable o sobra? (4) ¿Algo de la v3 es más grande de lo necesario?

Formato: primera línea **AUTORIZO el plan 3** (con condiciones) o **RECHAZO** (lista mínima); hallazgos P1/P2/P3 con archivo:línea y
escenario; «Lo que sobra»; cierre de 3 líneas en lenguaje llano para el founder.

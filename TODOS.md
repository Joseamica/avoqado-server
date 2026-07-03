# TODOS

Deferred work items with full context. Formato: What / Why / Pros / Cons / Context / Depends on.

## 1. Guard de 0 cuentas para conexiones MERCHANT (zombie CONNECTED vacío)

- **What:** en `finishConnected`, una conexión MERCHANT cuyo provider devuelve `negocios: []` hoy queda `CONNECTED` con cero filas `FinancialAccount` — agregar un fail explícito con mensaje honesto.
- **Why:** el usuario ve "Conectado" y una card vacía sin saldo ni explicación; viola la regla de UX "design for the least technical user". El camino CLIENT ya quedó protegido (plan financial-connections-client-account-type, decisión C4); el merchant se dejó fuera para no tocar flujo productivo en ese plan.
- **Pros:** cierra el estado zombie para ambos tipos de cuenta; error accionable en el momento correcto del wizard.
- **Cons:** toca el flujo merchant que cobra dinero real; necesita test de regresión propio (¿hay cuentas merchant legítimas con 0 negocios? verificar antes).
- **Context:** `avoqado-server/src/services/financial-connections/financialConnection.service.ts:265-286` (`finishConnected`: `many=false` → `CONNECTED`). Detectado por la voz externa (Codex) en el eng review del 2026-07-02.
- **Depends on:** aterrizar primero el plan de client-account-type (para no chocar con sus cambios en el mismo archivo).

## 2. Exponer Financial Connections en el Avoqado MCP

- **What:** crear tools MCP para el módulo financial-connections (listar conexiones de un venue, saldo de cuenta conectada, movimientos) en `avoqado-server/scripts/mcp/`.
- **Why:** la regla 🔴 del workspace exige el MCP en lockstep con la plataforma; el módulo completo es invisible para agentes hoy (gap pre-existente, señalado en el eng review del 2026-07-02).
- **Pros:** agentes internos podrían responder "¿cuánto hay en mi cuenta conectada?" y auditar movimientos.
- **Cons:** exponer datos bancarios vía MCP requiere diseño de permisos cuidadoso (OWNER-only, ¿venue-scoped?); no es un tool trivial.
- **Context:** al construirlo, incluir `accountKind` (MERCHANT/CLIENT) y la etiqueta "Personal" desde el día 1 — el schema ya lo trae tras el plan client-account-type.
- **Depends on:** plan client-account-type aterrizado (para que el tool nazca con ambos tipos de cuenta).

## 3. Verificar si la presentación de ventas menciona tipos de cuenta bancaria conectable

- **What:** revisar `~/Documents/Programming/Avoqado-HQ/operations/marketing/platform-presentation/` (deck + one-pager): si detallan qué cuentas se pueden conectar, actualizar AMBOS deliverables + regenerar PDFs con la capability "cuenta personal"; si hablan de "conexiones bancarias" en genérico, marcar exento y cerrar.
- **Why:** la regla 🔴 del workspace exige deck+one-pager al día ante capabilities visibles al cliente; "conectar cuenta personal Moneygiver" probablemente está un nivel de granularidad debajo de lo que el deck afirma — verificar cuesta 10 min y evita tanto la violación como el trabajo especulativo.
- **Pros:** cumplimiento de la regla con decisión informada.
- **Cons:** ninguno real; 10 minutos.
- **Context:** surgió del eng review del plan financial-connections-client-account-type (2026-07-02, decisión D22).
- **Depends on:** feature desplegado (o al menos mergeado) para no anunciar algo que no existe.

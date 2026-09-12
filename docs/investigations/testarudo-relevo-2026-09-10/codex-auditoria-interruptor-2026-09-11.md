# Auditoría para Codex — el interruptor por venue del predicado estricto (11-sep-2026, noche)

Eres un auditor adversarial. NO implementes nada. Verifica cada afirmación contra el código real del
árbol de trabajo (sin commitear) y responde con hallazgos numerados por severidad (P1 = dinero o
terminal bloqueada sin salida; P2; P3), citando `archivo:línea`. Si una afirmación mía es falsa,
dilo explícitamente: prefiero un rechazo fundado a una aprobación cortés.

## Contexto mínimo

Circuito: una tablet (POS, `avoqado-android` / `avoqado-ios`) manda un cobro por el servidor
(`avoqado-server`) a una terminal física (`avoqado-tpv`: PAX/Blumon y Nexgo/AngelPay). La condición
de dinero que domina todo, fijada por el founder: **nunca un cobro doble ni uno perdido**. Un
timeout, un cancel, una desconexión o la ausencia de `Payment` **no prueban** que no se cobró.

Documentos (todos en `avoqado-server/docs/investigations/testarudo-relevo-2026-09-10/`):
- `RELEVO-2026-09-11-siguiente-sesion.md` — estado al retomar.
- `diseno-A-B-seccion8-2026-09-11.md` — diseño v3; **su sección I manda** sobre las anteriores.
- `auditoria-fable-diseno-A-B-s8-2026-09-11.md` — auditoría independiente previa.
- Regla del circuito: `avoqado-tpv/.claude/rules/cobro-remoto-pos-a-tpv.md`.

## Qué hay que auditar

El árbol trae la **lista blanca estricta** de desenlaces (§8 C.1): una solicitud retiene la ranura de
su terminal salvo que acredite un desenlace (`UNRESOLVED_FINANCIAL_OUTCOME` en
`src/services/terminal-payment.service.ts`). Desplegarla de golpe bloquearía las filas históricas de
producción, y la conciliación B —su única salida— no existe todavía. Por eso I.6 pide un
**interruptor por venue, apagado**, de modo que el despliegue no bloquee nada nuevo.

He implementado ese interruptor (sin commitear). Lo nuevo:

1. `Venue.terminalPaymentStrictSince DateTime?` (migración `20260911200000_venue_terminal_payment_strict_since`,
   aditiva e idempotente, aplicada sólo a las bases locales). `null` = apagado.
2. `predicadoDeBloqueo(estrictos)` y su función espejo `bloqueaLaRanura(row, estrictos)` en
   `src/services/terminal-payment.service.ts`.
3. `src/services/terminal-payment-strictness.ts`: caché en memoria (lectura síncrona, TTL 60 s,
   prime al arrancar en `src/server.ts`, refresco perezoso, y un fallo **conserva** el último mapa).
4. Los 6 puntos de bloqueo del servicio pasan por `predicadoDeBloqueo(getVenuesEstrictos())`.
5. Tool del MCP `set_terminal_payment_strict_mode` (dos pasos, `tpv:update`, `requireWriteScopeAlways`,
   `auditMcpWrite`) en `src/mcp/tools/terminals.ts`.
6. Prueba de equivalencia contra Postgres real en los DOS modos:
   `tests/integration/payments/terminalPaymentStrictFlag.integration.test.ts` (4 pruebas, en verde).

## El hallazgo que motiva esta auditoría (es lo que más quiero que verifiques)

Al cablear el interruptor, **12 pruebas de integración existentes se pusieron en rojo**
(`tests/integration/payments/terminalPaymentRecovery.integration.test.ts` y
`orderCancelRoutes.integration.test.ts`). No son pruebas obsoletas: son las que garantizan que una
fila histórica sin desenlace acreditado **no permita otra autorización**.

Mi lectura, que debes confirmar o refutar:

- El predicado gobierna **DOS candados distintos** con el mismo `where`:
  - **ranura física de la terminal** (`isTerminalBusy`, `getBusyTerminalIds`, el bloqueador de
    terminal de la admisión, `busyTrasChoqueDeRanura`) — evita encimar dos cobros en el mismo aparato;
  - **bloqueo por ORDEN** (`findChargeBlockingOrderCancel` / `hasChargeBlockingOrderCancel` y el
    bloqueador de orden de la admisión) — evita cobrar dos veces la MISMA venta.
- La prueba `historical $status without outcome evidence never permits another authorization`
  (`terminalPaymentRecovery.integration.test.ts:426`) manda el segundo cobro a **otra terminal**
  (`${fixture}-other`) sobre la **misma orden**, y exige `TerminalBusyError`. ⇒ lo que impide el
  cobro doble es el candado de ORDEN, no el de la ranura.
- La prueba `historical physical slot remains reserved for another sale` (`:310`) manda un cobro
  **sin `orderId`** a la **misma** terminal ⇒ ésa sí es puramente ranura física.

**Propuesta que quiero que audites (opción A):** que el interruptor relaje **sólo la ranura física**
y que el bloqueo por ORDEN se mantenga estricto **siempre**, en los dos modos. Razonamiento: el
riesgo que cubre la ranura (encimar dos cobros en el mismo aparato) **caduca** —las filas históricas
son de hace días o semanas, la terminal ya no está a media operación—, mientras que el riesgo de
haber cobrado ya **no caduca**.

**Medición en producción (11-sep, sólo lectura, `PGOPTIONS=-c default_transaction_read_only=on`):**

| Medida | Filas |
|---|---|
| Filas que el estricto bloquearía y el heredado no | **386** |
| De ésas, con `orderId` | **386** |
| De ésas, con la orden todavía abierta (no COMPLETED/CANCELLED/DELETED) | **29** (Testarudo 24 · Amaena 5, del 27-ago al 11-sep) |

## Preguntas concretas

1. ¿Es correcta la separación ranura-física / bloqueo-por-orden, o hay un camino que las cruza y que
   volvería insegura la opción A? Enumera **todos** los consumidores del predicado (incluidos
   `src/mcp/tools/terminals.ts` y `src/services/shared/orderCancelGuard.ts`) y clasifícalos.
2. ¿Se puede llegar a un cobro doble con la opción A? Construye el escenario concreto si existe.
3. ¿Y con la opción B (relajar ambos, que es lo que I.6 dice literalmente)? ¿Cuál es el escenario y
   cuántas de las 29 lo permiten?
4. `bloqueaLaRanura` vs `predicadoDeBloqueo`: ¿son equivalentes en los dos modos? Busca divergencias
   de NULL, de JSON y de fechas (`createdAt >= desde` en SQL contra `row.createdAt < desde` en JS).
   Recuerda que Prisma no acepta `NOT` alrededor de un filtro de ruta JSON y que un `NOT` sobre
   columna nullable excluye la fila.
5. La caché (`terminal-payment-strictness.ts`): ¿es correcto que el fail-safe sea el **permisivo**?
   Mi argumento: caer al permisivo equivale a producción hoy, mientras que caer al estricto
   bloquearía las históricas. ¿Hay una ventana (arranque, fallo de DB, TTL) en la que ese fail-safe
   permita un cobro doble que hoy no sea posible?
6. `SIN_DESENLACE_ACREDITADO` (la sonda) NO se parametrizó: sigue siendo el conjunto completo.
   ¿Conserva eso el invariante «todo lo que bloquea se puede sondear y cerrar»?
7. La tool del MCP: ¿`tpv:update` es el listón correcto, o debería exigir superadmin? ¿La vista
   previa (`SOLO_BLOQUEA_EN_ESTRICTO`) cuenta exactamente lo que va a pasar a bloquear?
8. ¿Qué le falta a esto para ser desplegable, además de B?

Responde en español.

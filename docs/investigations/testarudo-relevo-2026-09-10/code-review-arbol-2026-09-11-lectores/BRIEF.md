# Brief común para los lectores de la revisión (11-sep-2026)

Eres un LECTOR de sólo lectura. NO edites archivos, NO corras builds/tests/gradle/xcodebuild/tsc, NO hagas git add/commit/stash/checkout/reset. Sólo `git diff HEAD`, `git status`, `git show`, `cat/sed/grep`. El árbol de trabajo es compartido con otras sesiones: lo que veas modificado es WIP real y cuenta como "lo construido".

## Qué se está construyendo (contexto)
Circuito de cobro remoto: tablet POS (avoqado-android / avoqado-ios) → servidor (avoqado-server, `TerminalPaymentRequest`) → terminal (avoqado-tpv: PAX/Blumon y Nexgo/AngelPay). Condición del founder: **nunca un cobro doble ni uno perdido; timeout, cancel, desconexión o ausencia de Payment NO prueban ausencia de cargo.** La regla canónica vive en `<repo>/.claude/rules/cobro-remoto-pos-a-tpv.md` (léela primero). El diseño auditado: `avoqado-server/docs/investigations/testarudo-relevo-2026-09-10/diseno-A-B-seccion8-2026-09-11.md` (v3, su sección I manda) y mi auditoría `auditoria-fable-diseno-A-B-s8-2026-09-11.md` en la misma carpeta (lee al menos el veredicto y los P1).

Piezas clave ya construidas (sin commitear): procedencia de entrega (`deliveryProvenance`, plan D), sonda `terminal:payment_probe` con lápida `NOT_FOUND_ANSWERED` en la TPV, `outcomeEvidence` ∈ {PRE_AUTHORIZATION, PROCESSOR_DECLINED}, `cancelDisposition` ACCEPTED/ACTIVE/ALREADY_RESOLVED, C.6 (`assertOrderCancellableUnderLock` / `orderCancelGuard.ts`), lápida de admisión (H.5/H.6), T26 (Nexgo auth recovery), cancelación durable en Android/iOS, 409 TERMINAL_BUSY correlacionado en POS, libreta `PaymentAttemptLedger` en la TPV (`reserveTerminal`, `markAuthorizing`, `markKernelEntered`, `markDiscardedBeforeCharge`), `RemotePaymentInbox` (único escritor, DAO con @Insert + UPDATEs CAS).

Invariantes a verificar en TODO hunk que toque dinero:
1. La llave/fila durable se escribe ANTES de tocar la red o el SDK; encolar en el catch es tarde.
2. `FAILED`/"no se cobró" sólo con EVIDENCIA (PRE_AUTHORIZATION o PROCESSOR_DECLINED). Un cancel sin evidencia no libera la llave del POS.
3. Un desenlace final (COMPLETED/FAILED con evidencia) nunca se pisa después con UNKNOWN/CANCELLED; un UNKNOWN nunca se libera por reloj.
4. Idempotencia: el mismo requestId no puede producir dos cargos; reintentar con el mismo requestId tras un rechazo del banco tiene que ser seguro.
5. Compatibilidad: las apps publicadas (POS y TPV en la calle) sólo leen `status/inProgress/paymentId/cancelDisposition`; nada que quite o renombre campos; nada que bloquee filas históricas sin salida.
6. Concurrencia: escrituras CAS/updateMany condicionales; `void prisma.x()` sin await ni .then/.catch NO se ejecuta (Prisma es perezoso); Room: transacciones donde hay lectura-decisión-escritura.
7. Offline: qué ve el usuario sin red; qué se pierde si muere el proceso entre toque y POST; orden de replay; qué pasa cuando vuelve la red y el servidor cambió.
8. Tests: ¿la prueba guarda lo que dice? (mocks que devuelven lo mismo pase lo que pase, estados imposibles, aserciones que pasan también con el bug).

## Formato del informe (escríbelo en el archivo que se te indica y devuélvelo también como respuesta)
- **Inventario**: lista de hunks/archivos leídos, agrupados por ÁREA (circuito de cobro remoto · otras features de otras sesiones), con 1 línea de qué hace cada uno.
- **Hallazgos**: P1 (dinero/pérdida de datos/bloqueo sin salida) · P2 (defecto real sin dinero directo) · P3 (calidad). Cada uno con `archivo:línea` del ÁRBOL ACTUAL, el fragmento de código citado VERBATIM (3-10 líneas), el escenario concreto de fallo, y por qué la prueba existente no lo caza.
- **Lo que está BIEN** que valga la pena confirmar (máx 8 puntos, con archivo:línea).
- **Lo que NO pude verificar** y por qué.
- No inventes líneas: cada archivo:línea debe salir de `grep -n` o `sed -n` sobre el árbol actual.

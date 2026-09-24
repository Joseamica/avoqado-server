# RELEVO COMPLETO · «Ninguna terminal muerta» — 22-sep-2026

> Escrito para que **otra sesión (u otro modelo) pueda continuar sin leer nada más**. Autosuficiente.

**Instrucción del founder (22-sep):** *«no puede quedar ninguna terminal muerta»*, tras quedarse sin
poder cobrar en una Nexgo por **tercera** vez y tener que destrabarla escribiendo SQL en la base del
propio aparato.

**Spec:** `docs/superpowers/specs/2026-09-22-ninguna-terminal-muerta-cobro-local-design.md`
(su **Anexo** trae el diseño detallado de B, mapeado contra las 13 guardas del servicio real).
**Repos:** `avoqado-server` (A y B) · `avoqado-tpv` (C).

---

## 1. El problema, en una frase

**Toda la maquinaria de rescate de un cobro incierto cuelga de la SOLICITUD DEL POS; el dinero vive
en el INTENTO.** Un **Pago rápido** (cobro iniciado EN la terminal, sin POS) queda fuera de todo.

### La cadena de 5 eslabones, cada uno verificado en el código

1. `PaymentAttemptDao.findTerminalHold` (avoqado-tpv, ~:85-99) aparta **el APARATO ENTERO** si la fila
   es `INDETERMINADO` **sin `orderId`** — y un Pago rápido nunca tiene `orderId`: no hay venta que
   cercar, así que la cerca del 13-sep («cercar la venta, no el aparato») no puede aplicarse.
2. `AngelPayPaymentViewModel.esperarVeredictoDelServidor` (~:3228) exige `_socketRequestId`; sin él
   pinta «NO vuelvas a cobrar… pregúntale al supervisor», **sin reloj, sin botón y sin reintento**.
3. `consultarIntentoDeTerminal` (server) arrancaba con `findAttemptLink(attemptId)` y devolvía `null`
   (404) si no había vínculo.
4. `TerminalPaymentAttemptLink.requestId` es **obligatorio y con FK** ⇒ un cobro local **no puede**
   tener vínculo. **Ésta es la raíz.**
5. `resolveNoInstrument` exigía `requestId` en el cuerpo, bloqueaba la fila de la solicitud con
   `FOR UPDATE` y despertaba al POS: nada de eso existe en un cobro local.

**Cuánto ocurre (medido en la libreta Room de la N86):** **13 de 27 intentos (48 %)** son locales y
ninguno tiene `orderId`. No es un caso raro.

---

## 2. Estado exacto

| Pieza | Qué hace | Estado |
|---|---|---|
| **A** | La consulta S6 POR INTENTO contesta sin vínculo ni solicitud | 🟢 **HECHA · AUTORIZADA por Codex** |
| **B** | Declarar «no se presentó tarjeta» sobre un intento SIN solicitud | 🟡 **los 8 hallazgos de Codex CERRADOS** (22-sep) — falta su 4ª pasada |
| **C** | Que la pantalla de la TPV deje entrar al cobro local a la ventana | 🟡 **CONSTRUIDA** (22-sep) — falta QA en hardware (ver §11) |

🔴 **NADA COMMITEADO.** Todo vive en el árbol de trabajo compartido.

### Archivos tocados (SOLO estos)

| Archivo | Qué |
|---|---|
| `src/services/terminal-payment.service.ts` | A: tipo `TerminalAttemptStatus` + `consultarIntentoDeTerminal` + `findAttemptLink`; B: publica `attempt.resolution` |
| `src/services/tpv/no-instrument-resolution.service.ts` | B: `requestId` opcional, camino local, `autorizarDeclaracion` extraída |
| `prisma/schema.prisma` | B: modelo `TerminalAttemptResolution` |
| `prisma/migrations/20260922120000_terminal_attempt_resolution/migration.sql` | B: aditiva e idempotente |
| `scripts/generate-schema-map.ts` + `docs/SCHEMA_MAP.md` | B: el modelo nuevo en `MODEL_TO_DOMAIN` (372 modelos) |
| `tests/integration/payments/webhookPrimerConfirmador.terminal.integration.test.ts` | A: +10 pruebas, 1 actualizada |
| `tests/integration/payments/noInstrumentSinSolicitud.integration.test.ts` | B: **nuevo**, 8 pruebas |
| `tests/api-tests/tpv/terminal-payment-attempts.api.test.ts` | A: la prueba HTTP del 404 → 200 |
| `tests/integration/tpv/unchargedReconciliation.integration.test.ts` | arreglo suelto: `attemptId` duplicado (TS1117) |
| `docs/superpowers/specs/…-ninguna-terminal-muerta-…md` · este relevo | documentación |
| `../.claude/rules/proyectos-por-fases.md` (raíz del workspace) | entrada del proyecto |

### Verde medido

- **51/51** `webhookPrimerConfirmador.terminal` · **8/8** `noInstrumentSinSolicitud` · **6/6** HTTP
  `terminal-payment-attempts.api` · **43/43** unit `no-instrument-resolution` · **26/26**
  `unchargedReconciliation` · **195/195** las 6 suites de ventana+terminal juntas.
- `npm run typecheck` (el del CI, **incluye tests**) estaba en **0** antes de la pieza B.

🟢 **TYPECHECK DEL CI RECOGIDO Y EN VERDE (22-sep, tras la pieza B):** `npm run typecheck` —el que
**incluye `tests/`**— da **errores TS: 0**, local y Alienware **COINCIDEN** (424 s / 135 s). Los 5
errores ajenos del carril de planes que aparecieron a media tarde los cerró la otra sesión. Los 2
míos ya estaban arreglados (`findAttemptLink` sin `operatorResolution` en el select, y
`previousRequest` obligatorio en `OperatorResolution` → ahora opcional, porque un cobro local no
tiene estado previo que congelar).

⚠️ Vuelve a correrlo antes de commitear: el árbol es compartido y se mueve.

---

## 3. Qué se construyó, con el porqué

### Pieza A — la consulta contesta sin vínculo
`consultarIntentoDeTerminal` ya no exige vínculo ni solicitud. Sin ellos devuelve `requestId: null`,
`request: null`, `linkedAt: null` y el `attempt` calculado con lo que consta **de esa terminal**.
La atribución cae entonces en la rama por SERIAL que **ya existía** en el código.

### Pieza B — declarar sin solicitud
`requestId` pasa a **opcional** en el schema Zod. Ausente ⇒ camino LOCAL dentro de la misma
transacción y el mismo endpoint:
1. `candadoDeIntento` (igual que siempre).
2. Replay/conflicto leyendo `TerminalAttemptResolution`.
3. **`autorizarDeclaracion`** — extraída para que los dos caminos usen LA MISMA (sesión, o PIN de
   supervisor que eleva a un miembro válido sin permiso).
4. **Vetos de dinero:** `Payment` con `idempotencyKey = attemptId` en el venue, **o**
   `evidenciaQueVetaLaDeclaracion` (reutilizada tal cual). Si alguno existe ⇒ `POSITIVE_EVIDENCE_EXISTS`.
5. `create` en `TerminalAttemptResolution` (P2002 ⇒ `RESOLUTION_CONFLICT`) + `ActivityLog`.
6. Se SALTA `resolverEsperaDelPos`: no hay POS esperando.
7. Devuelve **la misma forma** que el camino con solicitud (proyección S6 + `resolution`), para que
   el cliente use un solo parser.

Y S6 publica la declaración en **`attempt.resolution`** (campo ADITIVO): con vínculo sale del
vínculo, sin vínculo de la tabla nueva. **Es la señal que destrabará al cliente**, porque la que se
lee hoy viaja dentro de `request.outcome` y aquí no hay `request`.

---

## 4. Auditorías de Codex (gpt-6-astra xhigh)

Carpeta: `/Users/amieva/.claude/jobs/e2ff49a9/tmp/auditoria/`
(`encargo.md` + `veredicto.txt` = 1ª pasada · `encargo-r2.md` + `veredicto-r2.txt` = 2ª)

- **1ª pasada: RECHAZO — 2 P1 + 1 P2.** Los tres cerrados:
  - **P1-1 · identidades cruzadas.** La atribución por terminal usaba un `OR` entre
    `processorData.deviceSerialNumber` (del JWT) y `Terminal.serialNumber` (del cuerpo). Un Payment
    con snapshot de A y relación de B era reclamado por **las dos**, y la que no cobró soltaba su
    retención. **Arreglo:** `identidadesDelPago` — al menos una identidad, y **todas** las presentes
    tienen que ser ésta (`.every`).
  - **P1-2 · evidencia sin serial.** Un serial ausente se vuelve `NULL` ⇒ no «contradice» ⇒ se
    publicaba como `APPROVED` propio a cualquier terminal del venue. **Arreglo:** columna SQL
    `conDueno = (hayVínculo OR serial IS NOT NULL)` en los dos `max()`.
  - **P2 ·** la prueba HTTP que seguía exigiendo 404.
- **2ª pasada: 🟢 AUTORIZO la pieza A. Sin P1 ni P2.** Verificó 263 casos de identidad y 180
  comparaciones del carril con solicitud: sin regresión. Dejó 2 P3 de cobertura, **los dos cerrados**
  (aserciones sin `??`, y el caso del Payment **sin ninguna identidad** — `[].every()` es `true`).
- **3ª pasada (pieza B, 22-sep): 🔴 RECHAZO — 4 P1 · 3 P2 · 1 P3.** Encargo `encargo-B.md`, veredicto
  `veredicto-B.txt`. Su cierre manda sobre el orden del trabajo: *«No la desplegaría ni usaría su señal
  para liberar en C hasta cerrar esos P1»*.

  | # | Hallazgo | Dónde |
  |---|---|---|
  | **P1-1** | El veto por `Payment` no ve dos casos: una `idempotencyKey` guardada **sin recortar** (`recordFastPayment` la admite con espacios) y un Payment de **otro venue** (el filtro local lo oculta; el camino con solicitud sí lo veta con su búsqueda global) | `no-instrument-resolution.service.ts:210` |
  | **P1-2** | **Ventana entre el veto y el `create`**: el candado de intento es CONSULTIVO — serializa a quien toma la misma llave, **no bloquea** escrituras en `Payment`/`ProviderEventLog`, y el fallback del webhook escribe sin tomarlo. Falta revalidar los vetos EN la escritura, como sí hace el CAS del camino con solicitud | `:230` |
  | **P1-3** | Una **aprobación tardía sin serial** queda fuera de la evidencia por la regla de pertenencia de A (correcta), pero B publica la declaración **sin señalar que existe evidencia que la contradice** ⇒ C recibiría una señal de liberación sin con qué vetarla | `terminal-payment.service.ts:6264` |
  | **P1-4** 🔴 | **El CAMINO se decide por el CUERPO, no por la base**: omitir `requestId` sobre un intento que SÍ tiene vínculo entra por el camino local y **se salta las guardas de su solicitud**. Reproducido: acepta una declaración que el camino normal vetaba, y produce **dos testimonios del mismo intento** (uno en cada tabla; los índices únicos no lo impiden) | `:198` |
  | **P2-5** | El **replay acepta una declaración ajena**: la lectura es global y compara sólo id/hash antes de validar pertenencia ⇒ otra terminal u otro venue recibe como respuesta la resolución de la primera | `:199` |
  | **P2-6** | Con PIN de supervisor **se pierde quién operó**: la declaración y el `ActivityLog` guardan al supervisor, no al cajero. El camino con solicitud sí conserva `sessionStaffId` | `:250` |
  | **P2-7** | El **mock de Prisma compartido no tiene `terminalAttemptResolution`** ⇒ la prueba HTTP del intento sin vínculo ejecuta `.findFirst` sobre `undefined` y el controlador lo vuelve **500**. Los 6/6 que reporté eran de ANTES de la pieza B | `tests/__helpers__/setup.ts:162` |
  | **P3-8** | OpenAPI sigue marcando `requestId` como `required` | `tpv.routes.ts:3537` |

  Sin regresión en la extracción de `autorizarDeclaracion` (comparó 72 combinaciones), en el hash
  (`undefined` y ausente dan el mismo), en la normalización de terminal, en la migración ni en el
  `ActivityLog`. ⚠️ Declarado por el propio auditor: **no pudo correr jest** (caché del entorno), así que
  sus reproducciones usan dobles en memoria, y no certificó mis 8/8 ni las restauraciones por hash.

🔑 **La lección de método, que vale más que los hallazgos:** mis 4 sabotajes pasaron —cada uno tumbó sólo
su prueba— y **ninguno cubría estos defectos**. Un sabotaje demuestra que la prueba vigila lo que dice
vigilar; nunca que estén todas las pruebas que hacen falta.

---

## 5. Lo que sigue, en orden

1. **Recoger el typecheck** (arriba) y confirmar que sólo quedan los 5 errores ajenos.
2. **Sabotear los arreglos de B** (no se hizo): romper el veto por `Payment`, el veto por evidencia,
   y el `create` idempotente; comprobar que cae **sólo** la prueba de cada uno.
3. **Auditar B con Codex.** Reusa el patrón de `encargo-r2.md`. Puntos a pedirle: ¿puede la
   declaración local liberar dinero real? ¿el replay/conflicto es correcto bajo carrera? ¿el camino
   con solicitud cambió al extraer `autorizarDeclaracion`? ¿falta un veto que sí existe con solicitud?
4. **Pieza C (avoqado-tpv)** — necesita el aparato:
   - `AngelPayPaymentViewModel.esperarVeredictoDelServidor` (~:3228): retirar el `requestId == null`
     que manda al callejón.
   - `LedgerServerRecovery.recoverOne` (~:115): dejar entrar intentos sin solicitud.
   - Leer `attempt.resolution` para soltar la fila (hoy sólo se mira `request.outcome`).
5. **QA en hardware.** Los dos aparatos estaban conectados: **D3** (`com.avoqado.pos` 2.18.4) y
   **N86** (`com.jaac.avoqado_tpv.sandbox` **2.10.0-nexgo**). 🔑 La N86 ya trae el arreglo del 21-sep
   (un cobro local SÍ entra a la recuperación por servidor), así que **A se puede probar sin APK
   nuevo**; C sí necesita compilar e instalar.
6. **MCP + guía de cliente**, si aplica (reglas del workspace).

---

## 6. Decisiones tomadas — NO re-litigar

- **Tabla propia**, no `requestId` nullable en el vínculo: de esa columna cuelgan una FK, el trigger
  `preserve_no_instrument_resolution`, un `count` de unicidad y `resolverEsperaDelPos`.
- **No se libera por reloj** (decisión del founder del 10-sep).
- **No se declara sin preguntarle al servidor** (produjo el cobro doble del 10-ago).
- **Nada de endpoints paralelos**: se entra por el núcleo existente. Duplicar el carril del dinero es
  lo que produjo defectos cada vez (`reconcileBankDeclined` copiado de `reconcileUncharged`, 21-sep).
- Una **aprobación tardía NO borra** la declaración: conviven y la contradicción se publica.

---

## 7. Trampas ya pagadas (no volver a tropezar)

1. 🔴 **`perl -0pi -e 's/…/…/gm'` tocó 32 sitios en vez de 2**, y el typecheck y los tests seguían
   **VERDES** (el cambio era redundante donde no hacía falta). Sólo se vio **mirando el diff**.
   Editar por número de línea o con contexto único, nunca con `/g` en un archivo compartido.
2. 🔴 **Backticks dentro de `` Prisma.sql`…` `` rompen el template literal** → `TS1005` señalando una
   línea de COMENTARIO SQL. Usar «comillas angulares».
3. 🔴 **`tsconfig.typecheck.json` NO revisa las pruebas**; el del CI (`npm run typecheck`) sí. Así
   apareció el `attemptId` duplicado (TS1117) que habría tumbado el CI.
4. **El permiso se evalúa por ROL** (`hasPermission` sobre `VenueRolePermission`), **no** por
   `StaffVenue.permissions` — escribir ahí no concede nada. Y `VenueRolePermission.modifiedBy` es
   obligatorio (FK a `Staff`).
5. **Lo que crea una suite y la fixture no conoce hay que limpiarlo**: una `VenueRolePermission` viva
   hace fallar el `destruir()` de la fixture al borrar el staff.
6. La base de pruebas debe casar con `exigirBaseDesechable`: patrón `avoqado_[a-z0-9]+_test_` — **un
   solo segmento**. `avoqado_terminal_muerta_test_…` NO pasa; `avoqado_terminalmuerta_test_…` sí.
7. 🔴 El índice de git tiene **~30 archivos de otras sesiones**. Commitear SIEMPRE con
   `git commit -- <rutas>` y comprobar después con `git show --stat`.
8. `codex exec` **sale 0 aunque falle**: el veredicto está en el CUERPO. Y en background se cuelga
   sin `< /dev/null`.

---

## 8. Entorno

- **Base de pruebas desechable:** `avoqado_terminalmuerta_test_20260922`, con TODAS las migraciones
  (incluida la de B). URL en `/Users/amieva/.claude/jobs/e2ff49a9/tmp/test-db-url`.
  🔴 `av-db-25` **NO se tocó** y la migración de B **no se le ha aplicado**.
- Correr las pruebas:
  ```bash
  cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server
  TEST_DATABASE_URL=$(cat /Users/amieva/.claude/jobs/e2ff49a9/tmp/test-db-url) \
    npx jest --selectProjects integration --testPathPattern "noInstrumentSinSolicitud|webhookPrimerConfirmador.terminal" --ci
  ```
- Typecheck (siempre por avq-verify, desde la RAÍZ del workspace):
  ```bash
  cd /Users/amieva/Documents/Programming/Avoqado
  ./scripts/avq-verify.sh avoqado-server npm run typecheck
  ```

---

## 9. 🔴 Lo del 22-sep por la tarde — léelo antes de tocar la pieza C

### 9.1 Typecheck del CI: RECOGIDO — 4 errores, **ninguno de este trabajo**

`npm run typecheck` por avq-verify (`run-avoqado-server.1HjFKn`): **4 errores, los cuatro en
`src/services/stripe.service.ts`** (1177, 1392, 1396, 1397), del carril de planes/suscripciones de otra
sesión. Local y Alienware **COINCIDEN** (103 s / 36 s). Ni `no-instrument-resolution.service.ts` ni
`terminal-payment.service.ts` aparecen. ⚠️ El script avisó `vigencia: otra sesión movió el árbol`:
vuelve a correrlo antes de commitear.

### 9.2 Los 4 sabotajes de la pieza B: HECHOS, cada uno tumbó SÓLO su prueba

Suite `noInstrumentSinSolicitud`: **8/8** en verde como control previo, y después, uno por uno (archivo
restaurado y verificado por hash tras cada pasada):

| Sabotaje | Qué cayó |
|---|---|
| veto por `Payment` del intento | sólo «VETO · con un Payment de ese intento» |
| veto por evidencia del procesador | sólo «VETO · con un APROBADO del banco» |
| lectura del replay (`yaDeclarado`) | sólo «replay idempotente» |
| autorización del camino local | sólo «sin permiso y sin PIN: 403» |

🔑 De paso quedó demostrado que el `catch` P2002 **es red real y no adorno**: con la lectura del replay
rota, la prueba de conflicto siguió verde por el índice único.

⚠️ **Trampa de entorno ya pagada:** el control previo falló con
`Foreign key constraint violated: VenueRolePermission_modifiedBy_fkey` y **no era el código** — eran **7
`VenueRolePermission` huérfanas** de corridas matadas en la base desechable (la trampa 5 de este mismo
relevo, ocurriendo de verdad). Se borran acotadas por `Staff.email LIKE '%-cajero@example.test'` y la
suite arranca. 🔴 **Corre siempre el control positivo ANTES de sabotear:** sin él, esas 8 fallas se leen
como «el código está roto».

### 9.3 🔴 La pieza C: hay DOS soluciones al mismo problema, de dos sesiones distintas

Al abrir `avoqado-tpv` para construir C apareció, **sin commitear y ya en el índice compartido**, una
solución completa de OTRA sesión al mismo hueco, por un camino distinto:

- `PaymentAttemptDao.declararSinCobroLocal` + `PaymentAttemptLedger.declararSinCobroLocal` — una
  declaración **puramente LOCAL**, con 5 candados dentro del UPDATE (`terminal_payment_request_id IS NULL`,
  estado que aparta, `host_approved` no verdadero, `server_processor_evidence IS NOT 'APPROVED'`,
  `server_checked_at IS NOT NULL` sin veredicto con dinero), con su suite Room de 9 pruebas
  (`DeclaracionLocalSinCobroRoomTest.kt`).
- 🔴 **Nadie la llama desde la UI**: el motor está, el botón no (`grep` en `app/src/main` fuera del
  DAO/Ledger: cero).

**Decisión del founder (22-sep), con el contraste enfrente: LOS DOS.** Con internet manda el SERVIDOR
(ve el cobro real; nunca cobra doble); si el servidor no contesta, queda la salida LOCAL como respaldo,
con sus cinco candados. La regla §6 («no se declara sin preguntarle al servidor») se conserva como el
camino normal; el respaldo es para cuando no hay a quién preguntar, y debe decirlo en pantalla.

### 9.4 Estado real de la pieza C: arrancada y PAUSADA

Hecho, en el árbol de `avoqado-tpv` (sin commitear):

| Archivo | Qué |
|---|---|
| `TerminalAttemptApiService.kt` | `TerminalAttemptResultDto.resolution` (aditivo) — el campo que publica la pieza B |
| `VeredictoDeIntento.kt` | `LiberacionDelServidor.requestId` pasa a `String?` |
| `PaymentAttemptLedger.kt` | `aplicarLiberacionDelServidor` con `requestId == null` ⇒ 0 (marcador de «sin implementar») |
| `LiberacionLocalDelServidorRoomTest.kt` | **NUEVO**, 9 pruebas · **ROJO medido: 2 fallan** (el camino feliz y la idempotencia), 7 pasan todavía por el motivo equivocado |

🔴 **PAUSADA a propósito, y no por falta de tiempo:** el auditor de la pieza B dijo *«no usaría su señal
para liberar en C hasta cerrar esos P1»*. C consume exactamente esa señal (`attempt.resolution`):
construirla encima sería apoyar una liberación de dinero en una señal que puede emitirse con un cobro
real detrás (P1-1 y P1-3).

### 9.5 El orden que sigue

1. **Cerrar los 4 P1 de B**, con TDD y prueba en rojo primero. El estructural es **P1-4**: el camino
   (local vs con solicitud) debe decidirse por la **pertenencia durable bajo candado** —¿existe vínculo
   en la base?—, nunca por si el cuerpo trae `requestId`. Ese mismo arreglo cierra buena parte del P2-5.
2. **P1-1:** normalizar la llave al comparar y tratar un `Payment` de otro venue como contradicción, sin
   divulgar sus datos. **P1-2:** revalidar los vetos DENTRO de la escritura (un `INSERT … WHERE NOT
   EXISTS`, hermano del CAS del camino con solicitud). **P1-3:** publicar aparte que existe evidencia que
   impide usar el testimonio para liberar.
3. **P2-7 primero si quieres verde rápido**: `terminalAttemptResolution` al mock de
   `tests/__helpers__/setup.ts` — hoy la suite HTTP da 500.
4. **Re-auditar B** (4ª pasada) y sólo entonces retomar C, con las dos salidas de §9.3.
5. Las pruebas que faltan, según el auditor: llave recortada, Payment en otro venue, intento vinculado
   sin `requestId`, doble declaración entre tablas, replay ajeno, fallback entre veto y escritura,
   aprobado tardío sin serial, y el PIN local con los DOS actores auditados.

---

## 10. Los 8 hallazgos de Codex: CERRADOS (22-sep, tarde)

TDD estricto: **las 6 pruebas nuevas se vieron en ROJO primero** (fallaban las 6, pasaban las 8 viejas), lo
que confirmó que los defectos eran reales y reproducibles aquí —no sólo con los dobles en memoria del
auditor— antes de escribir una línea de arreglo.

| # | Arreglo | Dónde |
|---|---|---|
| **P1-4** | 🔑 **El camino lo decide la BASE, no el cuerpo.** Se lee el vínculo bajo el candado ya tomado: con vínculo se aplican SIEMPRE las guardas de la solicitud (mande o no `requestId` quien llama) y el camino con solicitud usa el `requestId` del VÍNCULO; un `requestId` del cuerpo que lo contradiga es 404. Es la misma regla que ya regía la identidad en este archivo — lo que decide nunca viene del cliente | `no-instrument-resolution.service.ts:207-213` |
| **P1-1** | Veto por dinero **global y tolerante a la llave sin recortar** (`hayDineroConEstaLlave`, `= OR btrim(…) =`, sin filtro de venue). No devuelve ningún dato del pago ajeno | `:136-145` |
| **P1-2** | **Revalidación DESPUÉS de escribir**, dentro de la transacción: un `throw` revierte el testimonio. El candado de intento es consultivo y no bloquea `Payment`/`ProviderEventLog` | `:278-283` |
| **P1-3** | S6 publica **`attempt.unattributedEvidence`** (campo aditivo): hay evidencia del procesador que no se pudo atribuir a nadie —sin vínculo y sin serial—, así que no cambia el desenlace pero **prohíbe usar una `resolution` para liberar** | `terminal-payment.service.ts` (SQL `sinDueno` + tipo) |
| **P2-5** | El replay comprueba **pertenencia** (venue + terminal) antes de responder; una declaración ajena es 404 | `:200-205` |
| **P2-6** | El asiento conserva `sessionStaffId` (quién OPERÓ) además del autorizante, y el `resolutionId` | `:290-298` |
| **P2-7** | `terminalAttemptResolution` añadido al mock compartido de Prisma — la suite HTTP daba **500** | `tests/__helpers__/setup.ts` |
| **P3-8** | OpenAPI: `requestId` sale de `required` y documenta que omitirlo NO elige el camino | `tpv.routes.ts:3537` |

**Verde medido:** **16/16** `noInstrumentSinSolicitud` · **77/77** las dos suites vecinas (sin regresión en
el camino CON solicitud, que es el que está en producción) · **43/43** unit · **6/6** HTTP.

**6 sabotajes, cada uno tumbando SÓLO su prueba** y con los dos archivos verificados íntegros por `diff`
después de cada pasada.

🔑 **Y uno enseñó algo que ninguna prueba decía:** sabotear *sólo* el veto previo del P1-1b **no tumbó
nada** — porque la revalidación del P1-2 lo cubre. Hubo que romper **las dos capas** para que la prueba
cayera. Es defensa en profundidad REAL, demostrada, no supuesta.

⬜ **Declarado, sin cerrar:**
- El **P1-2 no tiene prueba propia** de la carrera (exige concurrencia real contra Postgres). Lo que sí
  consta es que la capa ACTÚA: es lo que reveló el sabotaje de arriba. Y queda su residual, idéntico al
  del camino con solicitud: algo confirmado entre la revalidación y el COMMIT no se ve.
- **La raíz del P1-1 sigue abierta:** `recordFastPayment` guarda la `idempotencyKey` **sin recortar**
  (`payment.tpv.service.ts:5006`, el esquema lo admite). Aquí se cerró en la LECTURA, que es lo que
  protege a las filas históricas; normalizar en la ESCRITURA es otro carril de dinero y va aparte.
- Falta la **4ª pasada de Codex** sobre estos arreglos, y después retomar la pieza C.

---

## 11. Pieza C — construida (22-sep), en `avoqado-tpv` (rama `main`, SIN commitear)

Decisión del founder de §9.3: **los dos caminos**, servidor primero. Esto es el camino del SERVIDOR, que
es el principal; el respaldo local queda declarado abajo.

| Archivo | Qué |
|---|---|
| `TerminalAttemptApiService.kt` | `TerminalAttemptResultDto.resolution` y `.unattributedEvidence` (aditivos) · `NoInstrumentResolutionRequest.requestId` pasa a `String?` — Gson **omite** los nulos, así que viaja AUSENTE, que es lo que el esquema del servidor espera (un `null` explícito lo rechazaría: misma familia que el `vieneAusente()` de los reembolsos) |
| `VeredictoDeIntento.kt` | `LiberacionDelServidor.requestId: String?` · `desdeConsultaS6` lee **`attempt.resolution`** cuando no hay `request` (cobro local) y exige `kind = NO_INSTRUMENT_PRESENTED` · `hayEvidenciaSinDueno` veta CUALQUIER liberación —la de S6 y la sintetizada del 2xx— mientras el servidor publique evidencia que no pudo atribuir |
| `PaymentAttemptDao.kt` | **`cerrarPorLiberacionLocalDelServidor`**: consulta APARTE con `terminal_payment_request_id IS NULL` y, palabra por palabra, las mismas guardas de su hermana (nunca sobre `host_approved`, ni con veredicto guardado, ni con evidencia durable) |
| `PaymentAttemptLedger.kt` | `aplicarLiberacionDelServidor` ramifica: sin `requestId` va al CAS local. Las dos consultas son **excluyentes por construcción** |
| `LedgerServerRecovery.kt` | `recoverOne` deja de descartar las filas sin solicitud (el barrido ya lo hacía desde el 21-sep; faltaba la consulta interactiva) |
| `AngelPayPaymentViewModel.kt` | La ventana de confirmación **acepta el cobro local** (antes: callejón sin reloj ni botón) y `declararSinTarjeta` ya no exige `_socketRequestId` |
| `LiberacionLocalDelServidorRoomTest.kt` | **NUEVO**, 9 pruebas (vistas en rojo antes de implementar) |
| `AngelPayPaymentViewModelTest.kt` | La prueba que fijaba el callejón se **invierte**: ahora fija que el cobro local entra a la ventana, consulta al servidor y manda el POST con `requestId == null` |

⬜ **Lo que falta de la decisión del founder:** el **respaldo LOCAL** (la segunda mitad). Su motor ya
existe —`declararSinCobroLocal`, de otra sesión, con 5 candados y 9 pruebas— y lo único que le falta es
el botón: ofrecerlo cuando la ventana se agota sin respuesta del servidor, diciendo en pantalla que es la
salida sin conexión. Se hace viendo la pantalla en el aparato.

⬜ **Y el cierre que pidió el founder:** instalar en la **Nexgo N86** (`avoqado-tpv`) y en la **Sunmi D3**
(`D40625C1J0816`, `avoqado-android`) por depuración inalámbrica, y correr **`/full-testing`**.

---

## 12. 4ª pasada de Codex: RECHAZO otra vez (3 P1 · 2 P2 · 1 P3) — los seis CERRADOS

Encargo `encargo-B-r2.md`, veredicto `veredicto-B-r2.txt`. Confirmó cerrados P2-5, P2-6, P2-7 y P3-8 de
la ronda anterior, y P1-4 «con vínculo preexistente, abierto con vínculo posterior».

| # | Hallazgo | Arreglo |
|---|---|---|
| **r4-1** 🔴 | **Vínculo POSTERIOR**: declarar en local y DESPUÉS vincular ese intento dejaba **dos testimonios**, uno en cada tabla. Secuencia serial, sin carrera; los índices únicos no pueden impedirlo por estar en tablas distintas | La regla pasa a ser del **TESTIMONIO**, no del camino: antes de entrar al carril con solicitud se lee `TerminalAttemptResolution`; si ya hay uno, ÉSE manda (replay si coincide, conflicto si no, 404 si es de otra terminal) |
| **r4-2** 🔴 | **`btrim` ≠ `String.trim()`**: `btrim` sólo quita el espacio ASCII. Una `idempotencyKey` guardada con tabulador o salto de línea —que el esquema admite— se escapaba de **las dos capas** y dejaba declarar con el dinero registrado | `regexp_replace(…, PATRON_SQL_TRIM_COMO_JS, '', 'g')`, **la regla que este repo ya tenía escrita** en `utils/terminalSerial.ts` para el serial de la terminal, por exactamente el mismo motivo |
| **r4-3** 🔴 | **S6 veía menos que el POST**: buscaba por venue propio y llave exacta, así que un pago tardío con llave sucia o de otro negocio se publicaba como «declaración limpia» y el cliente la usaba para liberar | S6 gana `dineroNoAtribuible` (misma búsqueda global y normalizada del POST) y enciende `paymentContradiction`, **sin publicar ningún dato del pago ajeno**. Y en el cliente (`VeredictoDeIntento.kt`) la liberación conserva **los cuatro vetos**, no sólo el dinero propio |
| **r4-4** | `unattributedEvidence` contaba **cualquier** estado: un rechazo huérfano lo dejaba encendido para siempre ⇒ la declaración se aceptaba y luego no se podía usar | `estado IS DISTINCT FROM 'RECHAZADO'`: sólo veta lo que podría ser dinero. Aceptar y poder usar vuelven a decir lo mismo |
| **r4-5** | La prueba HTTP del POST exigía **exactamente 14** propiedades de `attempt` y ahora hay 16 ⇒ regresión que el 6/6 del GET no cubría | Los dos campos nuevos listados a propósito: si alguno desapareciera, la prueba lo caza |
| **r4-6** | El OpenAPI de la **respuesta** sólo describía el caso con solicitud | Documenta los nulos del cobro local, `resolution`, `unattributedEvidence` y que los tres vetos impiden liberar |

**Verde medido:** **21/21** la suite de B · **98/98** las tres suites de integración · **43/43** unit ·
**61/61** HTTP (3 suites) · **`errores TS: 0`**, local y Alienware COINCIDEN.
**10 sabotajes** en total (6 + 4), cada uno tumbando sólo su prueba, archivos verificados por `diff`.

⬜ **Declarado, abierto:**
- **La ventana residual bajo READ COMMITTED no se cierra**, sólo se estrecha (lo dice el auditor y es
  cierto): una escritura confirmada entre la última comprobación y el COMMIT no se ve. El camino con
  solicitud tiene la misma clase de residual tras su CAS, pero **no son equivalentes**: sus predicados
  y mecanismos posteriores difieren. Cerrarla del todo pediría SERIALIZABLE o una restricción, y es
  decisión aparte.
- **Ningún sabotaje prueba la CARRERA** — con el pago preexistente, cualquiera de las dos capas basta.
  Demostrar el valor temporal de la segunda exige insertar y confirmar evidencia ENTRE ambas.
- **La raíz sigue en la ESCRITURA**: `recordFastPayment` guarda la llave sin normalizar. Aquí se cerró
  en la lectura (que es lo que protege a las filas históricas); normalizar al escribir es otro carril.
- **Coste no medido**: el predicado funcional no usa índice cuando la llave está sucia, y se ejecuta dos
  veces. Falta un plan con volumen representativo.

---

## 13. 🔴 5ª pasada: RECHAZO otra vez (4 P1 · 3 P2 · 1 P3) — y aquí se PARA de parchar

Encargo `encargo-B-r3.md`, veredicto `veredicto-B-r3.txt`. Cerró r4-4, r4-5 y r4-6; los demás «parcial».

**Los cuatro P1 son la MISMA familia, y ése es el punto:**

| # | Hallazgo |
|---|---|
| **1** | La normalización canónica **sólo se aplicó al camino LOCAL**. El camino CON solicitud (su búsqueda inicial y su CAS, vía `evidenciaPositivaSql`) sigue comparando la llave EXACTA ⇒ un pago con llave sucia deja escribir `FAILED / OPERATOR_RECONCILED_NO_CHARGE` y el POS puede recibir «no se cobró» |
| **2** | S6 filtra la evidencia por `venueId = input.venueId` **antes** de calcular cualquier aviso ⇒ un `approved` recibido por el merchant de OTRO venue (que el POST sí veta) deja la declaración con los tres avisos apagados. También la evidencia con `venueId = NULL` |
| **3** | Un `Payment` propio **PENDING/PROCESSING** sin `reconciliation.kind` sale como `paymentContradiction=false` y el cliente —que no mira `paymentId` ni `paymentStatus` en `acreditaDinero`— libera. El POST habría vetado ese mismo pago. Y `!candidato` suprime la búsqueda global aunque exista otro pago normalizado contradictorio |
| **4** | En el cliente, **sólo el dinero propio tiene veto DURABLE** (`server_processor_evidence`). Los tres avisos nuevos viven en RAM: con respuestas fuera de orden —hay tres consumidores concurrentes reales— una respuesta limpia ATRASADA pasa el CAS y libera después de que otra ya había traído la contradicción |

Más: **P2-5** mi propio r4-1 evita el segundo testimonio pero **esconde el primero** (con vínculo, S6 deja de consultar la tabla local ⇒ declaración inaccesible) · **P2-6** el POST acepta declaraciones que S6 inutiliza al instante (evento `status:null` ⇒ `INVALIDO` cuenta en `sinDueno`) · **P2-7** la búsqueda funcional global **no tiene índice** y ahora corre en el sondeo interactivo **cada 5 s**, no sólo al declarar · **P3-8** `\s` en Postgres depende del locale (bajo ICU incluye U+0085, que JS no recorta): para prometer equivalencia exacta hay que listar los ASCII explícitos.

### 🔴 El diagnóstico de fondo, que es lo único que importa de esta ronda

**Hay DOS definiciones de «¿existe dinero de este intento?» —la del POST y la de S6— y no se comparten.**
Cada arreglo acerca una a la otra en un punto y deja abierto el siguiente: r4-3 alineó el Payment global y
quedó la evidencia de otro venue (P1-2) y el pago PENDING (P1-3); r4-2 alineó la llave en el camino local
y quedó el camino con solicitud (P1-1); r4-1 cerró el segundo testimonio y abrió la inaccesibilidad del
primero (P2-5). **No es mala suerte: es que se está parchando un problema de diseño.**

Y en el cliente, la simétrica: de los cuatro vetos, **sólo uno es durable**.

### Lo que el propio auditor propone como raíz (no es un parche)

1. **Una sola regla de «hay dinero», compartida** por el POST y por S6, con atribución y veto SEPARADOS:
   no publicar un evento ajeno como dinero propio, pero sí publicar que existe algo que contradice —sin
   revelar identificadores, importes ni el negocio ajeno.
2. **Una exclusión común por intento** que respeten TODOS los escritores relevantes, **incluido el
   fallback del webhook**, con la comprobación final bajo esa exclusión (un `UNIQUE` por tabla no impone
   exclusión ENTRE tablas). Para no bloquear el ingreso durable del webhook, separar su recepción de su
   incorporación al estado del intento. Respetando el orden de candados solicitud → intento.
3. **Un índice funcional** (o una llave canónica indexada) para que la búsqueda normalizada no recorra el
   historial completo en cada sondeo.
4. En el cliente, **persistir los cuatro vetos** y comprobarlos dentro del CAS, no sólo el dinero propio.

### 🔴 Por qué se para aquí, y no es cansancio

Es **el mismo patrón que el founder ya resolvió una vez** — `.claude/rules/proyectos-por-fases.md`, carril
de planes y suscripciones (20-sep): *«parar aquí y subir lo arreglado — el módulo se escribió entero sin
control de concurrencia y seguir parchándolo da defectos nuevos cada vez»*. Tres rondas de auditoría, cada
una cerrando hallazgos y abriendo otros **en la misma costura**. Lo que falta no son parches: es la regla
común y la exclusión común de los puntos 1 y 2, y eso es una decisión del founder, no una ronda más.

**Lo que SÍ queda ganado y verificado** (no se tira): 14 hallazgos cerrados con prueba en rojo primero y
**10 sabotajes**; 21/21 · 98/98 · 43/43 · 61/61 · typecheck 0; y la pieza C construida, con la terminal
saliendo del callejón —que es el objetivo que pidió el founder.


---

## 14. QA en hardware (22-sep): 5 comprobaciones OK, 1 no ejercitable, **1 hallazgo nuevo de severidad alta**

Reporte completo: `/tmp/full-testing-20260922-141335/report.md`. Entorno: N86 con la TPV nueva
conectada al servidor local del árbol principal (**puerto 3010**), D3 con `com.avoqado.pos.dev`
2.18.4-dev, base `av-db-25` con la tabla nueva creada. Run de **sólo lectura**: counts finales
idénticos al baseline.

**Verificado en el aparato:** conexión al servidor · turno sincronizado · **un cobro pendiente NO
impide vender** (los tiles quedan habilitados) · el aviso se TOCA y lleva al historial · log del
backend **limpio** (`error: 0`, `warn: 0`).

⬜ **NO ejercitado y declarado: el happy path de la pieza C.** La libreta de la N86 no tiene ninguna
fila viva que aparte el aparato (las 8 están `DESCARTADA`), y sin retención viva la pantalla no entra
a la ventana; lo confirma que la terminal **no llamó ni una vez** a `/terminal-payment/attempts/:id`
en todo el run. Provocar una exige tarjeta y un fallo real — el SDK 1.0.19 acredita a propósito casi
todos los negativos.

### 🔴 Hallazgo nuevo [ALTA] — un aviso que el servidor YA resolvió y nadie puede quitar

| Dónde | Qué dice del cobro de $50 |
|---|---|
| Servidor (`TerminalPaymentRequest ad5fb00b-…`) | `FAILED` / **`OPERATOR_RECONCILED_NO_CHARGE`** (resuelto el 21-sep) |
| Bandeja de la terminal (`remote_payment_requests`) | **`PROCESSING`** |
| Libreta (`payment_attempts`) | **0 intentos** de esa solicitud |

El servidor lo cerró hace 25 h y la terminal nunca se enteró: el cajero ve un aviso permanente, con
el contador subiendo, sobre dinero ya conciliado, y **sin forma de quitarlo** («Revisar» sólo lleva
al historial). Es el defecto que la regla del repo ya describe (*fila PROCESSING sin intento
correlacionado*) **con su efecto visible medido por primera vez**.

🔑 **Y toca la pieza C:** la recuperación consulta **por INTENTO**, y esta fila **no tiene intento** —
ninguna de las piezas construidas hoy la alcanza. Es el hueco hermano, por la puerta de la BANDEJA en
vez de la de la libreta.

### Dos trampas de entorno, resueltas (no volver a pagarlas)

1. La app permite HTTP en claro sólo a una **lista fija de IPs**; el Mac cambió a `.253` y Android
   bloqueaba **en silencio** («sin conexión al servidor» con ping e internet funcionando). Añadida la
   IP a `app/src/debug/res/xml/network_security_config_debug.xml` — **sólo DEBUG**.
2. **`adb reverse` no funciona con depuración inalámbrica**: adb lo acepta y lo lista, pero desde el
   aparato el puerto sale CERRADO. Sólo por cable.

---

## 16. 🔴 6ª pasada de Codex (22-sep, 15:14): RECHAZO — 4 P1 · 7 P2 · 1 P3. Los cuatro P1, CERRADOS

Veredicto textual: *«La regla todavía **no es única**: los dos POST comparten `hayDineroConEstaLlave`, pero el
CAS y S6 siguen usando definiciones distintas. El veto durable tampoco está integrado en todos los consumidores
y caminos de salida.»* Codex retiró por su cuenta su observación inicial sobre la pieza D («ya está conectada al
worker»), y reprodujo tres de sus hallazgos con consultas reales en SQLite.

🔑 **La familia entera se resume en una frase: el veto se ESCRIBÍA en una entrada y se RESPETABA en dos de tres
salidas.** Eso es lo que hay que conservar al leer los cuatro arreglos.

| # | Hallazgo | Arreglo | Dónde |
|---|---|---|---|
| **P1-1** | El CAS **con solicitud** no revalidaba la regla GLOBAL del POST: su `NOT EXISTS` cuelga de la SOLICITUD (venue propio · `send_transaction` · COMPLETED), así que un cobro del mismo intento con la llave sin recortar, bajo otro negocio o en PENDING se le escapaba — y escribía `FAILED / OPERATOR_RECONCILED_NO_CHARGE`, que el POS lee como «no se cobró» | Fragmento **único** `dineroConEstaLlaveSql` en `evidenciaPositivaSql.ts`, con sus dos envolturas (`hayDineroConEstaLlaveSql` para la LECTURA, `sinDineroConEstaLlaveSql` para la ESCRITURA). `hayDineroConEstaLlave` del servicio ya no tiene SQL propio: llama al fragmento. Y el `WHERE` del UPDATE lo lleva dentro ⇒ **entre la comprobación y la escritura no cabe nadie** | server |
| **P1-2** | `recover()` (la pasada del **worker**) no pasa por `recoverOne()` y no guardaba el veto: el worker recibía `paymentContradiction`, conservaba la fila y dejaba `server_veto` en NULL; la respuesta LIMPIA y ATRASADA de otro de los tres consumidores liberaba la venta. **Sin reiniciar el proceso** | Los tres avisos se hacen durables también ahí, ANTES de procesar ninguna liberación (mismas 3 líneas que `recoverOne`), con contador `vetos=` en el log de la pasada | tpv |
| **P1-3** | `declararSinCobroLocal` y su selector `retencionLocalDeclarable` **no miraban `server_veto`** — y es la salida a la que llega el respaldo `declararSinRed()`. Reproducido en SQLite: misma fila consultada con `PAYMENT_CONTRADICTION`, el CAS del servidor devuelve **0** y el local **1** | `AND server_veto IS NULL` en el CAS y `fila.serverVeto == null` en la oferta. Que el veto valiera para la liberación del servidor y no para el testimonio de una persona era al revés de lo que pesa cada evidencia | tpv |
| **P1-4** | Un veto guardado **después** de una liberación no la invalidaba: la fila seguía diciendo «se puede volver a cobrar» y quedaba fuera del aviso y de la protección contra la poda (`aplicarLoQueDigaLaLibreta`, la restauración y `SQL_CONTRADICCION` no leían `serverVeto`) | `server_veto IS NOT NULL AND state NOT IN ('REGISTRADO','CERRADA')` entra en `SQL_CONTRADICCION`, y la pantalla lo lee ANTES de los dos `mostrarLiberada`. 🔴 **La fila NO se reabre a propósito** — ver el punto siguiente | tpv |

### 🔴 Por qué el P1-4 no reabre la fila (decisión, no descuido)

Reabrir una fila liberada al llegar un veto la devuelve a INDETERMINADO, y una fila INDETERMINADO **sin
`orderId`** —que es lo que es un Pago rápido— **aparta el aparato entero** (`findTerminalHold`, líneas 89-93).
Como el veto de hoy **no tiene salida acreditada** (el propio P2-5 de esta pasada), eso produciría exactamente
la terminal muerta que este trabajo existe para eliminar. Así que el veto posterior se hace **visible** y
**conservador** (entra al aviso, sobrevive a la poda, la pantalla deja de invitar a cobrar) sin cambiar la
retención que ya había.

### ⬜ P2-5, declarado y abierto: el veto puede sobrevivir a su motivo

Medido y confirmado: un `unattributedEvidence` que después se vuelve atribuible deja de publicarse, pero el
`server_veto` guardado persiste — y con él la fila INDETERMINADO **sigue apartando el aparato**, porque ninguna
salida puede liberarla. Hoy sólo sale por que el servidor **registre el dinero** (la fila pasa a REGISTRADO y
deja de retener).

Lo que falta es una **resolución explícita del veto**, y no se improvisó a propósito: una respuesta limpia
cualquiera no puede borrarlo (podría ser vieja — es justo el defecto r5-4), así que hace falta que el SERVIDOR
declare que ya no contradice, con algo más fuerte que una bandera. Es diseño de dinero y va con decisión del
founder, no un parche de 7ª ronda.

### Los P2/P3 de la 6ª pasada: SIETE cerrados (22-sep, tarde), UNO abierto (P2-5)

| # | Hallazgo | Cierre |
|---|---|---|
| **P2-6** | Una declaración LOCAL previa se ocultaba si el vínculo aparecía DESPUÉS: S6, al ver vínculo, omitía la tabla local y leía sólo `link.operatorResolution` ⇒ `resolution:null`. El POST sí la encontraba y prohibía otra, pero el cliente perdía la declaración recuperable por consulta | La tabla local se lee SIEMPRE; manda la del vínculo si existe y si no la local, que es igual de acreditada. 1 prueba |
| **P2-7** | La pieza D podía decir `resuelta=true` con una aprobación durable pendiente de conciliar: `UNRESOLVED_FINANCIAL_OUTCOME` clasifica la FILA de solicitud, no mira Payments ni eventos ⇒ la terminal apagaba su último aviso sobre dinero que S6 sí veía | `resuelta` exige además que no conste evidencia positiva, con las MISMAS dos preguntas del CAS de la liberación (`hayAprobadoVinculadoSql` / `hayPagoLigadoSql`). 1 prueba con control positivo |
| **P2-8** | La pieza D comprobaba la orfandad al SELECCIONAR y no al CERRAR (Codex lo reprodujo: UPDATE = 1 con un intento correlacionado insertado en medio) | El MISMO `NOT EXISTS` del selector va dentro del UPDATE. 1 prueba |
| **P2-9** | El JSON que guardaba la pieza D no era reproducible: sin `requestId` y con vocabulario propio (`FAILED`), el servidor lo rechazaba en reentregas y sondas. Y dejarlo NULL era **peor**: la reentrega contesta `Reject` y la sonda contesta **ACTIVE** ⇒ la ranura seguiría apartada por algo YA cerrado | JSON reproducible con `requestId` y el vocabulario del servidor (`failed`/`cancelled`). 🔴 **Y `COMPLETED` ya NO se conciliesa**: hay DINERO y eso lo resuelve la libreta por INTENTO — emitir `success` sin `paymentId` haría que el servidor lo degradara a `timeout` y volviera a retener. 2 pruebas |
| **P2-10** | El índice funcional traía los caracteres Unicode REALES y la app manda las secuencias LITERALES: regex equivalentes, **constantes distintas**, y PostgreSQL compara la expresión ESTRUCTURALMENTE ⇒ el índice existía y la consulta no lo usaba | Migración regenerada **desde la constante** (153 bytes, idénticos). Y la consulta quedó en **UNA sola rama** sobre el recorte de la llave: la rama `llave = X` **no tenía índice que la sirviera** (el único con la llave es `(venueId, idempotencyKey)` y empieza por `venueId`) y además sobraba — si la llave ES el intento, su recorte también. Un primer intento con `UNION` de dos ramas dejaba justo esa rama en `Filter`; lo destapó medirlo en vez de fiarse del comentario que lo afirmaba. **Medido: un solo `Index Cond`**. 3 pruebas: el texto de la migración contra la constante, el plan del FRAGMENTO real (no de una consulta escrita a mano) y que un cobro con la llave limpia y otro con espacios se sigan viendo. 2 sabotajes: meter la rama exacta de vuelta tumba sólo la del plan |
| **P2-11** | Sin cursor: las 20 huérfanas más viejas salían siempre y la 21 no se consultaba nunca (reproducido en SQLite) | Rotación por `updated_at` + `estamparConsultaHuerfana` manda al final de la fila a la consultada que no se pudo cerrar. La ANTIGÜEDAD del aviso sigue saliendo de `created_at`. 2 pruebas |
| **P3-12** | La prueba r5-3 pasaba por el motivo equivocado: su Payment PENDING no era atribuible, así que encendía `paymentContradiction` y la aserción con `OR` salía verde aunque el veto por `paymentId` no existiera | El pago lleva la TERMINAL del fixture (dinero PROPIO) y la aserción es concreta (`paymentId` + `paymentStatus`). **Sabotaje verificado**: dejar de proyectar el pago tumba la prueba |

⚠️ **Y una trampa de MEDICIÓN que costó varios ciclos, anotada en la memoria
[[el-shell-se-come-los-escapes-al-medir-un-explain]]:** medir el `EXPLAIN` pasando el SQL por el
heredoc del shell convierte `\u00a0` en el carácter real (53 bytes contra 153) ⇒ se mide una consulta
que NO es la de la aplicación y sale `Filter`. Se mide escribiendo el SQL con node a un archivo y
`psql -f`. Y `SET LOCAL enable_seqscan = off` sólo vale DENTRO de una transacción.

### Una CUARTA salida que se revisó y se dejó IGUAL a propósito

Cerrando el P1-3 se barrieron todas las consultas que pasan una fila a `DESCARTADA`, por la clase de
defecto «una regla copiada en N sitios». La que merece explicación es **`marcarSinAutorizacion`** (el
«no salió al banco» del SDK 1.0.19): tampoco mira `server_veto`, y **se deja así**.

- Su evidencia es más FUERTE que un veto: el propio SDK acredita que ese intento no se envió al host
  (`authorizationAttempted = false`, NUESTRA referencia, código de catálogo).
- Ya exige `host_approved IS NULL`, `server_payment_id IS NULL`, `server_outcome IS NULL` y
  `server_processor_evidence IS NULL` — más estricto que las dos liberaciones, y cubre todo el dinero
  que el servidor puede acreditar.
- Y bloquearla tiene un costo en la dirección contraria: es justo el camino que evita que un U101 o un
  «Cancelar» dejen la terminal apartada. Con el veto delante, un cobro que el SDK dice que nunca salió
  quedaría `AUTORIZANDO` apartando el aparato — la terminal muerta otra vez.

Las otras (`casTransition` genérica, `discardStalePreparing` desde PREPARANDO, `reabrirSinAutorizacion`
que va en la dirección conservadora, `guardarVeredictoDelServidor` que no libera) no son salidas de
liberación. Codex tampoco las señaló.

### Verificación de la TPV tras la 6ª pasada (22-sep, tarde)

- **Corrida conjunta** (`core.remotepayment.*` + `ledger.*` + el ViewModel de AngelPay): **424 pruebas, 2 fallos**,
  ambos en el ViewModel. Una corrida anterior había dado **18**: el predicado del veto se escribió primero como
  `serverVeto != null`, y **un `mockk(relaxed = true)` devuelve `""` para un `String?`**, así que la rama se encendía
  en toda prueba con mock relajado. Corregido a `!isNullOrBlank()` — que es también lo correcto en producción: un
  motivo vacío no es un veto (memoria [[mockk-relajado-devuelve-cadena-vacia-no-null]]).
- **Los 2 que quedan NO son de este trabajo, y está medido, no supuesto:** la clase del ViewModel **sola** da
  **168/168**; mis cuatro clases nuevas corriendo ANTES del ViewModel dan **218/218**. Los dos fallos sólo aparecen
  con las otras **19 clases que ya existían** en el conjunto: una de ellas deja viva una corrutina en `Dispatchers.IO`
  que toca `Dispatchers.Main` después de que su prueba lo restauró (`UncaughtExceptionsBeforeTest`, «Dispatchers.Main
  was accessed when… the test dispatcher was unset»). Ninguna de mis clases toca Main ni un ViewModel. No se
  identificó cuál de las 19 — es trabajo aparte, no de esta tanda.
- **Sabotajes, ronda A** (un sabotaje por clase de prueba, para que cada caída se atribuya): 46 pruebas, **exactamente
  3 caídas** — P1-3a (el CAS de la declaración sin el candado del veto), P1-2 (el worker deja de guardar el veto) y
  P2-8 (el UPDATE de la bandeja sin revalidar la orfandad). Controles en verde.
- **Ronda B**: 27 pruebas, **3 caídas** — P1-4 (el veto sale de `SQL_CONTRADICCION`), P2-9b (un `COMPLETED` vuelve a
  conciliarse) y **también P1-4b**, que yo había previsto como control. No era control: P1-4b comprueba primero que el
  veto CONVIERTE la fila en contradicción (y luego que REGISTRADO la saca), así que quitar la cláusula entera la tumba
  en su PRIMERA aserción. Por eso la ronda C le puso su propio sabotaje con el control verdadero al lado.
- **Ronda C**: 27 pruebas, **exactamente 3 caídas**, cada una en la aserción que la nombra — P2-11 (*«expected to
  contain r20, but was [r0…r19]»*: sin rotación la 21ª nunca se consulta), P1-3b (el botón se ofrece con veto) y P1-4b
  (*«expected to be false»* en su SEGUNDA aserción: un REGISTRADO ya no sale de la contradicción). **El control P1-4
  siguió verde** (su fila es DESCARTADA, no REGISTRADO). Evidencia: `run-avoqado-tpv.mX1IYo`.
  ⚠️ Dos intentos previos de la ronda C no dicen nada del código: uno murió con `OutOfMemoryError: Java heap space` en
  el daemon de Kotlin (builds de otras sesiones encima), otro con «Type T not present» por correr con Java 24. El que
  cuenta se lanzó con Java 17 y `-Pkotlin.compiler.execution.strategy=in-process`.
- 🔑 **Cómo se sabotea sin exponer el árbol compartido:** se aplica el sabotaje, se lanza `avq-verify`, y el árbol real
  se restaura en cuanto aparece `out-local.txt` de la corrida nueva — ahí la copia ya está congelada. Ojo: `avq-verify`
  congela DESPUÉS de tomar la fila (`tomar_fila` en la línea 844, `congelar` en la 847), así que sólo se sabotea con la
  fila libre; con la fila ocupada el código roto se quedaría expuesto mientras espera. Medido: 54-66 s de exposición.
  🔴 **Y hoy la fila ni siquiera espera** (medido esta tarde, chip «Arreglar la fila de avq-verify»): en macOS `ln -s`
  sobre el symlink `heavy` se mete DENTRO del directorio del dueño y sale 0, así que todos «toman» la fila. Consecuencia
  para sabotear: otra sesión que lance avq-verify **del mismo repo** en esa ventana congelaría TU código roto. Se
  comprobó en `~/.claude/avq-verify/log.jsonl` que las 8 corridas de avoqado-tpv desde las 15:00 fueron de esta sesión.
  Exposición de la ronda C: 44 s.

### 🔴 El botón del respaldo SIN RED no existía — cableado el 22-sep (tarde)

La decisión del founder fue «**los dos**: con internet decide el servidor; si no contesta, el aparato». El motor
(`retencionLocalDeclarable` + `declararSinCobroLocal`, cinco candados dentro del UPDATE) y la mitad del ViewModel
(`puedeDeclararSinRed`, `declararSinRed()`) existían, pero **`ResultadoInciertoContent` nunca pintaba el botón**: la
decisión era código muerto. Lo destapó revisar «¿quién llama a esto?» antes del reporte final, no una prueba.

Al cablearlo aparecieron **dos candados que faltaban**, y los dos eran de las que ven los ojos de un cajero:

| # | Hueco | Arreglo |
|---|---|---|
| 1 | El respaldo se ofrecía **aunque el servidor contestara** (sin veredicto), con el texto «El servidor no contesta» — falso. Y con el servidor vivo, era una forma de declarar sin la regla de gerencia | `LecturaDelIntento.servidorContesto` (2xx; sin red, tope, 5xx o 401 NO cuentan: la declaración por el servidor tampoco pasaría). El respaldo exige que el servidor NO haya contestado en TODA la ventana |
| 2 | **Sin ningún permiso**: cualquier cajero podía cerrar el cobro en el aparato, mientras el camino por servidor exige `payments:resolve-no-instrument` (decisión de gerencia) o PIN de supervisor. Apagar el WiFi era la forma de saltarse el PIN | El MISMO permiso, leído de la sesión guardada (`authRepository.hasPermission`, sin red) al OFRECER y otra vez al TOCAR. Sin él no se ofrece y la pantalla dice que sólo un gerente puede cerrarlo |

Y dos detalles de honestidad: el botón **sustituye** al que declara por el servidor (que fallaría) en vez de sumarse, y
el texto al cerrarlo ya no dice «no se confirmó en 30 s» — no fue la ventana del servidor, fue el cajero.

⚠️ **Lo que el respaldo NO hace, declarado:** exige `server_checked_at IS NOT NULL` (diseño de la otra sesión: «el
testimonio de una persona nunca va por delante de la evidencia»). Un aparato que perdió la red ANTES de que el
servidor contestara una sola vez no ofrece nada, y el cobro queda apartando la terminal hasta que vuelva la red. Sin
red tampoco se puede cobrar con tarjeta (AngelPay necesita al banco), así que el respaldo sirve sobre todo cuando el
que falla es **el servidor de Avoqado** y no la red.

**Verificado (22-sep, noche), con la Mac en carga 60-320 por otras sesiones:**

- **ROJO primero: 8 de 30 cayeron, exactamente las previstas** — 3 de la pantalla (no había bloque del botón ni
  cableado), 1 de `servidorContesto` (el campo no se llenaba) y 4 del ViewModel (servidor vivo · sin permiso · el
  permiso al tocar · el texto honesto). Las otras 3 del ViewModel ya pasaban: describen lo que YA estaba bien
  (se ofrece cuando debe, un cobro del POS no, un CAS rechazado nunca dice «liberado») y quedan como red.
- **VERDE: 210 pruebas, 0 fallas** (`run-avoqado-tpv.b6ZgcG`): la clase COMPLETA del ViewModel (168 + 7), la
  recuperación por servidor (20), la declaración local (8) y las dos pruebas estáticas de la pantalla (4 + 3).
- **Sabotajes: las 7 guardas nuevas, cada una tumba SÓLO su prueba.** Ronda X (`run-avoqado-tpv.zn3k6H`, 198
  pruebas, 4 caídas): un 5xx cuenta como «contestó» · la pantalla sin cablear · sin el permiso al tocar · sin el
  candado de «el servidor contestó». Ronda Y (`run-avoqado-tpv.uRjTbq`, 198 pruebas, 3 caídas): sin el permiso en
  la oferta · el texto que vuelve a decir «30 s» · un cobro del POS que también lo ofrece.
- ⚠️ Dos corridas previas no dicen nada del código: una murió por `OutOfMemoryError` del daemon de Kotlin y otra
  con «Type T not present» por correr con Java 24. Las buenas usan Java 17 y
  `-Pkotlin.compiler.execution.strategy=in-process`.
- ⬜ **Sin QA en hardware del botón**: provocarlo exige un cobro local INCIERTO (el SDK 1.0.19 acredita casi todos
  los negativos solo), con el servidor caído DESPUÉS de haber contestado una vez. Necesita al founder con tarjeta.

### Los dos que quedan ABIERTOS

- **P2-5** (arriba, con su razonamiento): un veto puede sobrevivir a su motivo.
- **La suite COMPLETA de la TPV** sigue sin correr: la corrida acotada cubre bandeja, libreta y el ViewModel de AngelPay.
  Va antes de commitear, con la Mac libre: `./scripts/avq-verify.sh avoqado-tpv ./gradlew testSandboxDebugUnitTest`
  (con `JAVA_HOME` de zulu-17: el java por defecto de esta Mac es 24 y Gradle revienta con «Type T not present»).

(El P2-10 que estaba en esta lista quedó CERRADO — ver su fila en la tabla de arriba.)

### Qué se verificó de esta pasada

- **Servidor, al cierre de los P2/P3:** `noInstrumentSinSolicitud` **36/36** (eran 31 al cerrar los P1) · las suites
  vecinas del carril (`ventanaConfirmacion`, `webhookPrimerConfirmador`, `unchargedReconciliation`) **8 suites / 371
  pruebas** · unitarias del área **20 suites / 478 pruebas** · el typecheck del CI (`npm run typecheck`, con pruebas)
  **`errores TS: 0`, local y Alienware COINCIDEN** (`run-avoqado-server.pmunMp`). Los dos sabotajes del P1-1 tumban **exactamente** su prueba (sacar la condición
  del CAS ⇒ cae la estructural; quitar la rama insensible a espacios ⇒ cae la de comportamiento), con el control
  positivo en verde.
- De paso: la suite del MCP (`tests/unit/mcp/terminalPaymentRequests.test.ts`) fallaba **entera** (15 de 22)
  porque el mock de Prisma no tenía `terminalAttemptResolution`; arreglado y con 2 pruebas nuevas de la
  capacidad (`localResolutions`).
- **TPV:** ver «Verificación de la TPV tras la 6ª pasada», arriba (corrida conjunta, aislamiento y las rondas de
  sabotajes).

### ⚠️ Lo que Codex NO pudo certificar, y hay que tenerlo en cuenta

*«No pude reconfirmar 28/28, 133/133, TS=0 ni el EXPLAIN de la consulta real. Jest terminó antes de ejecutar
pruebas por `EPERM` al escribir su caché.»* O sea: sus **reproducciones en SQLite sí valen como evidencia**,
pero su pasada **no trae veredicto de pruebas**.

### ⚠️ Otra sesión commiteó este trabajo (y se llevó WIP de una tercera)

`fe1b1499` («feat(terminal-payment): implementa manejo de cobros locales y consulta por solicitud», 15:19:50)
metió en `develop` los archivos del servidor de las piezas A/B/D **más** WIP ajeno de las suscripciones
(`planState.service.ts`, `planActivation.service.ts`, `stripe.service.ts` y sus pruebas). No se revierte, por la
regla del árbol compartido. Efecto colateral: al escribirse el archivo de pruebas desde una copia anterior,
**se perdieron 3 pruebas del árbol** y hubo que reponerlas — de ahí que ahora haya copia de seguridad de cada
archivo tocado en el scratchpad de la sesión.

---

## 17. ⏸️ PAUSA por decisión del founder (22-sep, 19:40) — el estado exacto para retomar

**1. La 7ª pasada de Codex: RECHAZO, 4 P1 · 11 P2.** Veredicto completo (final del archivo):
`/Users/amieva/.claude/jobs/e2ff49a9/tmp/auditoria/veredicto-B-r5.txt` · encargo: `encargo-B-r5.md` (misma carpeta).
- **P1-1** la respuesta del POST de la declaración trae los tres avisos (`paymentContradiction`/`evidenceContradiction`/
  `unattributedEvidence`) y el ViewModel NO guarda `server_veto` ni enciende el veto en memoria (`AngelPayPaymentViewModel.kt:~3617`).
- **P1-2** un veto tardío sobre una fila DESCARTADA no cerca SU VENTA: reserva y autorización de otro intento de la misma
  orden pasan (`PaymentAttemptDao.kt:~220` y `~375`; reproducido por Codex con el SQL real). Mantener DESCARTADA sí, pero
  el veto tiene que seguir cercando la orden identificable.
- **P1-3** el CAS del servidor revalida menos evidencia bancaria que el POST: `sinEvidenciaPositivaSql` exige venue propio
  y `type='send_transaction'`, y el fallback del webhook puede persistir un aprobado de otro venue entre la comprobación y el CAS.
- **P1-4** la pieza D cierra una huérfana con un intento en `PREPARANDO` o `KERNEL_ACTIVO` (el `NOT EXISTS` los omite) y no
  escribe `final_emitted_at`, que es lo que mira la barrera de reserva.
- P2 principales: el permiso del botón lee los permisos CRUDOS del login y no el efectivo (un MANAGER por defecto quedaría
  fuera — **mi candado nuevo es demasiado estricto**) · D dice `resuelta` con un `Payment PENDING` · S6 no usa todavía el
  fragmento indexado · un veto nuevo sobre una liberación vieja nace con el aviso vencido · la poda de 7 días borra una
  declaración local sin conciliar · el respaldo no existe si Avoqado nunca contestó · tras reiniciar, un Pago rápido
  trabado no tiene botón · la ventana de «45 s» puede durar 5 min 45 s · sobre P2-5 **Codex propone una salida segura**
  (resolución explícita del servidor con revisión creciente del intento + CAS que rechace evidencia posterior).

**2. 🔴 El QA en la N86 encontró un P1 que Codex NO vio: la terminal revienta al leer `null`.**
`JsonSyntaxException: Expected a com.google.gson.JsonObject but was JsonNull; at path $.attempt.resolution`. El servidor
de hoy contesta `"resolution": null` y `"request": null` para un cobro local, y los TRES campos tipados `JsonObject?`
(`TerminalAttemptStatusResponse.request`, `TerminalAttemptResultDto.resolution`, `TerminalRequestStatusResponse.request`,
en `TerminalAttemptApiService.kt`) no aceptan un `null` de JSON ⇒ **toda** consulta S6 sin declaración cuenta como «sin
respuesta» y la recuperación por servidor queda muda. Ninguna prueba lo veía porque arman las respuestas como objetos
Kotlin, nunca desde el JSON real. **Arreglo decidido, sin aplicar:** un `@JsonAdapter` en esos 3 campos que lea `null`
como «no hay» (sin cambiar tipos ni usos). **Prueba en rojo lista:** la respuesta REAL capturada del aparato,
`/Users/amieva/.claude/jobs/e2ff49a9/tmp/auditoria/s6-real-intento-local-20260922.json`, parseada con `Gson()` (el
mismo que usa `GsonConverterFactory.create()`).

**3. Lo que SÍ se vio funcionando en la N86 (19:12–19:32):** el APK nuevo arrancó sin crash; la base del aparato
**migró de 36 a 37** con `server_veto` y conservó sus datos; conectó al servidor; «Pago rápido» y «Cobrar» habilitados
con el aviso puesto; y **la pieza D apagó sola el aviso fantasma de $50 de hace 30 h** (`consultadas=1 conciliadas=1`,
la solicitud `ad5fb00b…` quedó RESOLVED).

**4. Trampas de entorno medidas hoy:**
- 🔴 **El servidor del puerto 3010 es un huérfano con código del 20-sep** (su `tsx watch` murió; el proceso sigue
  escuchando): el QA de la tarde mandó el REST ahí, a código viejo, mientras el socket iba por ngrok al 3000. **Usar el
  3000** (`tsx watch` vivo del árbol principal).
- La N86 estaba en LTE con el WiFi apagado y no se asocia a ninguna red guardada. Se le encendió el WiFi y se instaló el
  APK apuntando a `127.0.0.1:3000` con `adb reverse tcp:3000 tcp:3000` **por cable**: desconectada del USB, dirá «sin
  conexión».

**5. Qué sigue, en este orden:** (a) el arreglo del `null` con su prueba en rojo; (b) decisión del founder sobre la ronda 8
(los 4 P1 de Codex) o acotar alcance; (c) el P2 del permiso efectivo antes de cualquier QA del botón.

## 18. ▶️ Ronda 8 (22-sep, noche): el `null` de la N86 y los 4 P1 de la 7ª pasada — cerrados, verificación en curso

**Lo cerrado (sin commitear, nada desplegado):**

| # | Qué | Dónde | Prueba (vista en rojo o por sabotaje) |
|---|---|---|---|
| N86 | un `null` de JSON en `resolution`/`request` tumbaba la consulta ENTERA | TPV `TerminalAttemptApiService.kt` (`@JsonAdapter(ObjetoJsonONulo)` en los 3 campos) | `RespuestasRealesDelServidorTest` — JSON REAL del logcat |
| P1-1 | la respuesta de la declaración perdía el veto | TPV VM `declararSinTarjeta` (veto RAM + `marcarVetoDelServidor` antes de leer la fila) | VM `r7 P1-1` ×3 avisos + control — **ROJO real visto** (corrida `ZFdNh6`) |
| P1-2 | un veto sobre una liberada no cercaba SU venta | TPV DAO: guarda 2, `retencionDeLaVenta`, `casTransition`, `findUnresolvedForRequest` | `EvidenciaDurable…` r7 P1-2 ×4 (con control sin identidad) |
| P1-3 | el CAS con solicitud revalidaba menos eventos que el POST | server: `eventoQueVetaSql` ÚNICO en `evidenciaPositivaSql.ts`, dentro del CAS | integración INTERCALADA de verdad (Proxy sobre la tx) + control; sabotaje cae |
| P1-4 | D cerraba con un cobro vivo y sin cerca | TPV `RemotePaymentRequestDao` (NOT EXISTS de CUALQUIER intento + `final_emitted_at` + `execution_started_at IS NULL`) | `BandejaHuerfana…` r7 P1-4 ×2 |
| P2-1 | el botón sin red leía permisos CRUDOS (error mío) | TPV `PermissionsRepository.enLaUltimaListaEfectiva` + server `/tpv/auth/permissions` con `resolveStaffVenuePermissions` | VM r7 P2-1 ×2; los crudos dicen SIEMPRE lo contrario en las pruebas del botón |
| P2-2 | D decía «resuelta» con un Payment PENDING / llave sucia / colisión | server `hayDineroDeSusIntentosSql` + `hayEvidenciaDeConciliacionSql` en D | integración r7 P2-2 y P2-2b; sabotajes caen |
| P2-3 | S6 con su propia copia de la regla de dinero (sin índice, sin REFUND) | server S6 usa `hayDineroConEstaLlaveSql` | integración r7 P2-3; sabotaje cae |
| P2-4 | un veto nuevo sobre una liberación vieja nacía vencido | TPV aviso: con veto manda la fecha MÁS RECIENTE | `EvidenciaDurable…` r7 P2-4 |
| P2-5 | la poda borraba una declaración sin red sin conciliar | TPV poda: se queda hasta 7 días de vigilancia DESPUÉS | `DeclaracionLocal…` r7 P2-5 + control |
| P2-7 | tras reiniciar, un Pago rápido pendiente sin salida | TPV VM `adoptarCobroLocalQueAparta` (sólo local, INDETERMINADO) | VM r7 P2-7 + 2 controles |
| P2-8 | la ventana de 45 s podía durar 345 s | TPV VM: `withTimeoutOrNull` de la ventana entera | VM r7 P2-8 |
| P2-9 | la rotación de D se atoraba con excepciones | TPV `BandejaServerRecovery` estampa también en el `catch` | `BandejaHuerfana…` r7 P2-9 (pasa por el recuperador de verdad) |

🔴 **Un defecto MÍO que las pruebas viejas cazaron en la primera corrida:** la exclusión de la poda (P2-5) usaba
`last_error LIKE …` dentro de `AND NOT (…)`; con `last_error` NULL la poda dejó de podar TODO (3 pruebas de la poda en
rojo). Arreglado con `IFNULL`. Es la segunda vez en este módulo — memoria `predicado-not-en-sql-con-columnas-null-excluye-en-silencio`.

⚠️ **Entorno:** a la base desechable le faltaban 3 migraciones aditivas de OTRAS sesiones (`cfdi_sustitucion`,
`uber_kds_fase1`, y la del índice registrada) — 12 pruebas cayeron por `Order.customerPhonePin` inexistente. Se aplicaron
con `migrate deploy` contra `avoqado_terminalmuerta_test_20260922` (URL impresa y comprobada antes).

**Abiertos y declarados (decisión del founder o diseño aparte):** P2-6 (el respaldo exige que al servidor se le haya
PREGUNTADO con éxito una vez — si Avoqado nunca contestó, no hay botón), P2-10 (una huérfana COMPLETED sin intento no tiene
quién la cierre), P2-11 (el veto no tiene salida; Codex propone resolución explícita con revisión creciente + CAS), la
ventana de carrera residual del P1-3 (un evento que entra DESPUÉS de la sentencia del CAS por el camino del candado vencido
— mismo residuo que ya declara la ventana), y el índice en producción (`CONCURRENTLY`).

**Servidor verificado:** `noInstrumentSinSolicitud` **41/41** contra la base desechable; 4 sabotajes (P1-3, P2-2, P2-2b,
P2-3), cada uno tumba SÓLO su prueba, con restauración por hash. Vecinas del carril (12 suites: ventana, webhook, uncharged)
**507/507** (`run-avoqado-server.s6BkvL` dio 506/507 y el único fallo era del ARNÉS, no del código: el `interceptarSiguienteTx`
de `terminalPaymentWindow` buscaba el marcador sólo en la plantilla, y la consulta del veto ahora viaja como `Prisma.Sql`
anidado — sin inyección, la declaración pasaba. Arreglado para mirar también los anidados; la suite completa **77/77**).

**TPV verificada:** los tres paquetes (`ledger`, `remotepayment`, `angelpay`) **555/555**, 33 clases (`run-avoqado-tpv.Ld29OS`,
copia idéntica al árbol en los 7 archivos tocados). La primera corrida (`ZFdNh6`) dio 552/4: el ROJO real del P1-1 (el
arreglo no estaba escrito — se me olvidó entre tantos) y 3 pruebas VIEJAS de la poda que cazaron el `NULL LIKE`.

**Typecheck del CI** (`npm run typecheck`, con pruebas): **`errores TS: 0`, local y Alienware COINCIDEN**
(`run-avoqado-server.B86CU6`; la copia es idéntica al árbol en los 6 archivos tocados).

**18 sabotajes de la TPV, en 3 rondas, TODOS cazados por exactamente su prueba** (5 clases, 229 pruebas por ronda; árbol
restaurado por hash tras cada una; exposición 52-59 s, lanzadas sólo con la fila VACÍA; 0 commits en el repo durante las rondas):

| Ronda | Sabotaje | Cae |
|---|---|---|
| X · `LedbDO` | S1a sin adaptador en `resolution` · S3 guarda 2 sin veto · S7 D con la lista vieja · S9 permisos crudos · S12 aviso sin fecha del veto · S14 sin adopción | S6 real · veto tardío · P1-4 PREPARANDO/KERNEL · P2-1 ×2 + 5 del respaldo (usan el permiso) · P2-4 · P2-7 — 12 |
| Y · `5XyKvg` | S1b sin adaptador (D) · S4 `retencionDeLaVenta` sin veto · S8 D sin cerca · S10 ventana sin plazo · S13 poda sin excepción · S15 adopta AUTORIZANDO | D con null · veto tardío (2ª aserción) · la cerca · P2-8 · P2-5 · control AUTORIZANDO — 6 |
| Z · `XKd9VV` | S1c sin adaptador (S6 `request`) · S5 CAS sin veto · S6 restauración sin veto · S2 declaración sin veto · S11 D sin estampa en el catch · S16 adopta del POS | S6 real + regresión de la declaración · carrera · restauración · P1-1 · P2-9 · control del POS — 7 |

**Codex r8** corriendo (encargo `encargo-B-r8.md`, veredicto `veredicto-B-r8.txt`, misma carpeta). **Pendiente además:** el APK
nuevo en la N86 (desconectada del USB al cierre de esta ronda).

## 19. ⏸️ Ronda 9 (22-sep, noche) — PAUSA del founder a media verificación. Estado exacto para retomar

**8ª pasada de Codex: RECHAZO, 3 P1 · 3 P2** (`/Users/amieva/.claude/jobs/e2ff49a9/tmp/auditoria/veredicto-B-r8.txt`, final
del archivo). Todo lo de abajo está **aplicado en el árbol, sin commitear**; las pruebas están escritas.

| # | Hallazgo | Arreglo (aplicado) | Prueba |
|---|---|---|---|
| P1-1 | el veto que dejó el WORKER no frenaba el «no se cobró» del SDK ni el negativo/cancel de la bandeja | DAO `marcarSinAutorizacion` + `server_veto IS NULL` · VM `hayDineroEnLaFila` cuenta el veto · bandeja `contarIntentosBloqueadores` + `SQL_CONTRADICCION` | `SinAutorizacionYBarreraRoomTest` r8 P1-1 ×2 + control · `AngelPaySdk119ViewModelTest` r8 P1-1 (local y POS) |
| P1-2 | si guardar el veto fallaba, la pantalla leía la liberación VIEJA | `LecturaDelIntento.vetoDelServidor` (del CUERPO, no de la escritura) → VM enciende el veto en RAM | `LedgerServerRecoveryRoomTest` r8 P1-2 + control · VM r8 P1-2 |
| P1-3 | la lista de permisos no tenía dueño: el cajero B usaba la del gerente A | `PermissionsRepository`: dueño `venueId|staffId` (el que devuelve el servidor), rechazado si no es la sesión; sin dueño = no vale | `PermissionsRepositoryTest` (nuevo, 5) · VM r8 P1-3 |
| P2-4 | `server_checked_at` = «le pregunté», también tras 401/403/404/5xx | **Room 38**: columna `server_answered_at` (MIGRATION_37_38) = «CONTESTÓ 2xx»; candado 5, oferta del botón y poda la leen; se estampa en `recover()`/`recoverOne()` (con o sin `estampar`) y en `guardarVeredictoDelServidor` | `DeclaracionLocalSinCobroRoomTest` r8 P2-4 ×4 (pasan por la recuperación REAL con 503/401/403/404/2xx) · `MigracionV38RoomTest` (nuevo) |
| P2-5 | `/tpv/auth/permissions` usaba el rol del TOKEN | server `tpv.routes.ts`: rol VIGENTE de `StaffVenue`; baja ⇒ lista vacía; sin membresía ⇒ 403 | `tests/unit/routes/tpv.authPermissions.routes.test.ts` (nuevo): **5 vistos en ROJO, 6/6 en verde** |
| P2-6 | la adopción registraba el cobro de A con la cuenta M2 elegida para B | VM `cuentaParaRegistrar()`: la cuenta del intento restaurado de su fila; se limpia en `resetPayment()` y al abrir un intento nuevo | VM r8 P2-6 |
| test | «r6 P1-1» probaba un SELECT, no el UPDATE | prueba INTERCALADA: un Payment entra DESPUÉS de la última comprobación (marcador `LINK_TERMINAL_MISMATCH`) | `noInstrumentSinSolicitud` r8 — **verde de entrada** (el CAS ya lo tenía): falta verificarla por SABOTAJE |

🔴 **Dos defectos míos encontrados de paso, ya arreglados:** (a) `MigracionV36RoomTest` estaba en ROJO desde la r5-4 (esperaba
`version = 36`; nadie corría `core.data.local`) — ahora compara contra la versión de la primera apertura; (b) el parche en
Python pasó `PermissionsRepository.kt` de CRLF a LF (diff de 400 líneas) — restaurados los fines de línea de HEAD (39+/5-).
Memoria `python-reescribe-crlf-a-lf-en-silencio`.

**ROJO COMPLETO** en `run-avoqado-tpv.fQVkcz` (copia congelada ANTES de aplicar los arreglos): **577 pruebas, 15 fallan, y
son EXACTAMENTE las 15 nuevas de la r8** (P1-1 ×3, P1-2 ×2, P1-3 ×5, P2-4 ×4, P2-6 ×1); las otras 562 en verde. Los arreglos
se aplicaron al árbol DESPUÉS de que la copia quedara congelada.

**Al retomar, en este orden:**
1. ✅ Hecho al pausar: typecheck del CI del server (`npm run typecheck`, con pruebas) **`errores TS: 0`, local y Alienware
   COINCIDEN** (`run-avoqado-server.xwWqOd`, conservada). Avisó «otra sesión movió el árbol»: repetirlo antes de commitear.
2. VERDE de la TPV: `…/scratchpad/tpv-r9.sh` (ledger, remotepayment, angelpay, permissions, `Migracion*`).
3. Server: `noInstrumentSinSolicitud` entero + vecinas (ventana, webhook, uncharged) contra la base desechable.
4. Sabotajes, uno por guarda nueva, con la fila VACÍA y restauración por hash.
5. CHANGELOG de la TPV, tabla de fases, y la 9ª pasada de Codex.

**Decisión del founder que sigue abierta (P2-6 de la r7, ahora EXACTA):** el respaldo sin red exige que Avoqado haya
CONTESTADO (2xx) alguna vez por ese cobro. Si Avoqado nunca contestó, no hay botón y el aparato espera a que vuelva la red.
¿Se acepta, o el aparato puede cerrar aunque Avoqado nunca haya contestado?

### 19.b ▶️ Retomado (22-sep, 22:35) — verificación de la ronda 9 COMPLETA

- **VERDE TPV:** 578/578 en las 38 clases del carril (`run-avoqado-tpv.HC0KTJ`). La primera corrida en verde dio 21 fallos y los
  21 eran MÍOS: 18 por `lectura?.vetoDelServidor != null` (el `mockk(relaxed = true)` devuelve "" ⇒ veto siempre encendido;
  ahora `isNullOrBlank`) y 2 porque `LiberacionLocalDelServidorRoomTest` usaba `server_checked_at` como «contestó» — la de `r6 P1-3`
  pasaba por el MOTIVO EQUIVOCADO (el candado 5 la rechazaba antes que el veto); ahora también pone `serverAnsweredAt`.
- **Suite COMPLETA de la TPV:** **2 192 pruebas / 174 clases, 0 fallos** (`run-avoqado-tpv.awEX0c`, ejecutada, no de caché).
- **Servidor:** 13 suites / **549** de integración contra la base desechable (`run-avoqado-server.NWWlmX`) · ruta 6/6 · typecheck
  del CI 0 (local = Alienware).
- **17 sabotajes, TODOS cazados sólo por su prueba**, árbol restaurado por hash: servidor 4 (corridos DENTRO de una verificación, con
  el candado de la fila tomado, para que ninguna sesión congelara una copia saboteada) · TPV ronda A 5 (9 caídas) · B 5 · C 3
  (exposición 50-54 s cada una; `run-avoqado-tpv.c3ZUQ3`, `.dvjkVi`, `.BVpPZw`).
- **Cambios de diseño en la verificación** (ya en el encargo): la cuenta del intento restaurado va atada al NÚMERO de intento, no a
  una bandera (un reintento abre intento nuevo sin `resetPayment()`); y se quitó `server_answered_at` de
  `guardarVeredictoDelServidor` (redundante con las estampas de S6 y sin prueba).
- **El acceso maestro de la terminal** (`MASTER_ADMIN`, sin `StaffVenue`) queda SIN lista de permisos con el cambio del P2-5: el
  servidor ya le negaba todo en `checkPermission`. Declarado a Codex.
- **Aparatos:** la D3 (`D40625BRJ0469`) actualizada con el APK dev del árbol actual de avoqado-android (2.18.4-dev, 23:38); arranca
  sin caídas en «Cobrar» con la sesión de Main Owner. **La Nexgo NO aparece por USB** (ni en `adb`, ni en `system_profiler`, ni por
  mDNS): el QA en hardware de esta ronda queda pendiente de que se reconecte.
- **9ª pasada de Codex lanzada** 23:1x: encargo `encargo-B-r9.md`, veredicto `veredicto-B-r9.txt` (misma carpeta de auditoría).

### 19.c 🔴 9ª pasada de Codex (23-sep, madrugada): RECHAZO — 4 P1 · 4 P2. Ronda 10 en curso

Veredicto completo: `/Users/amieva/.claude/jobs/e2ff49a9/tmp/auditoria/veredicto-B-r9.txt` (líneas 16261-16345). Dos de ellos
los reprodujo con el SQL real de los DAO en SQLite.

| # | Hallazgo | Dónde |
|---|---|---|
| P1-1 | El rechazo bancario NORMAL (`markHostResponded(false)` → `casHostResponded`) cierra un intento que ya tenía `server_veto` del worker ⇒ DESCARTADA + «Reintentar». Mismo en el callback app-to-app | `PaymentAttemptDao.kt:400`, VM `:2801` y `:2521` |
| P1-2 | `recoverOne()` estampa `server_answered_at` ANTES de sacar el veto del cuerpo: si esa escritura lanza, el `catch` devuelve lectura sin veto. Y un `RECORDED` cuyo `aplicarVeredictoDelServidor` falla no devuelve la evidencia positiva | `LedgerServerRecovery.kt:143, :170` |
| P1-3 | La poda puede borrar una declaración entre estampar la respuesta y guardar el veto/APPROVED que esa respuesta trae (reproducido: 0 → 1 → poda 1 → veto 0) | `LedgerServerRecovery.kt:66`, `PaymentAttemptDao.kt:590` |
| P1-4 | Borrar la membresía ⇒ 403, pero el repositorio lo trata como fallo de red y devuelve la lista vieja (dueño aún coincide) | `tpv.routes.ts:2804`, `PermissionsRepository.kt:130` |
| P2-5 | La restauración app-to-app adopta sólo el `attemptId`; registra con la cuenta actual | VM `:2418` |
| P2-6 | `/auth/permissions` da 403 a SUPERADMIN acreditado en otro venue y al OWNER de la organización (sí autorizados por `checkPermission`); `MASTER_ADMIN` pierde Ajustes y modo kiosco local | `tpv.routes.ts:2804`, `checkPermission.middleware.ts:221,294`, `WelcomeScreen.kt:1142` |
| P2-7 | Un 200 atrasado de la sesión A se devuelve TAL CUAL aunque ya se cambió a B | `PermissionsRepository.kt:116` |
| P2-8 | Lista, fecha y dueño se escriben con editores separados: morir entre ellos deja lista de B con dueño A | `PermissionsRepository.kt:211`, `SecureStorage.kt:1015` |

Además pidió sabotear `cuentaParaRegistrar()` con la secuencia real que encontró: adoptar A → rechazo confirmado →
`retryAfterError()` → B (sin `resetPayment()`).

### 19.d ▶️ Ronda 10 (23-sep, madrugada): los 8 hallazgos de la 9ª pasada, construidos con TDD

**ROJO visto antes de cada arreglo:** TPV `run-avoqado-tpv.zjZ6Ti` — 595 pruebas, **13 fallos, los 13 nuevos** (+1 de armado: la
prueba de la secuencia de Codex no alineaba la sesión del SDK con la cuenta elegida y el cobro B se bloqueaba antes de la
barrera; corregida, esa prueba es de sabotaje y pasa desde el principio) · servidor `run-avoqado-server.jy5U72` — 3 fallos, los 3
nuevos, controles en verde, **local = Alienware**.

| # | Arreglo | Dónde |
|---|---|---|
| P1-1 | El CAS del RECHAZO exige `server_veto IS NULL` (una aprobación aterriza igual; con `APPROVED` el rechazo se anota como siempre porque esa DESCARTADA ya aparta la terminal — exigirlo también rompía `fix5 D5 sumidero app-to-app`, que documenta ese comportamiento); los dos callbacks releen la fila tras el rechazo (`rechazoDesmentidoPorLaFila`) ⇒ contradicción, sin «Reintentar» | `PaymentAttemptDao.casHostResponded`, VM |
| P1-2 | `recoverOne` decide veto, evidencia y veredicto por el CUERPO antes de escribir; las marcas (respuesta, turno) pasan por `anotar`, que no tumba la lectura; un veredicto que no se pudo guardar vuelve como `evidenciaPositivaSinRegistro` | `LedgerServerRecovery` |
| P1-3 | «Contestó» (`server_answered_at`) se anota DESPUÉS de dejar durable lo que trae la respuesta, y NO se anota si una escritura falló — en el worker y en el sondeo | `LedgerServerRecovery` |
| P1-4 | Un 403 de `/tpv/auth/permissions` invalida la lista guardada (aunque borrarla falle, no se reusa) | `PermissionsRepository` |
| P2-5 | La adopción app a app restaura el contexto de la fila (cuenta, venta, importe); sin fila, ninguna cuenta | VM |
| P2-6 | Sin membresía: acceso maestro ⇒ SUPERADMIN, SUPERADMIN acreditado en cualquier `StaffVenue` (salvo suplantando) y OWNER activo de la organización reciben la lista de su rol **sin** `payments:resolve-no-instrument` | `tpv.routes.ts` (`rolAutorizadoSinMembresia`) |
| P2-7 | Un 200 que llega con otra sesión (o calculado para otra persona) no se devuelve ni se guarda | `PermissionsRepository` |
| P2-8 | Lista y dueño en UN valor (`venueId|staffId` + salto de línea + lista): o quedan los dos o ninguno | `PermissionsRepository` |

Y la prueba que Codex pidió para sabotear `cuentaParaRegistrar()`: adoptar A local → rechazo confirmado → `retryAfterError()` → B.

⚠️ **Tropiezo en la 1ª corrida verde (`run-avoqado-tpv.ammTSZ`, 1 507 s, 35 fallos):** mi prueba nueva de la poda
intercalada se colgó 60 s (`UncompletedCoroutinesError`) y a partir de ahí el JVM de pruebas se quedó sin memoria
(`OutOfMemoryError` ×33 en clases que no toqué). La prueba reusaba el mismo intento en dos vueltas y lo borraba con
`db.openHelper.writableDatabase.execSQL` entre llamadas suspendidas de Room. Reescrita con un intento por vuelta y sin
borrar: el paquete `ledger` completo pasa **159/159** (`run-avoqado-tpv.MUoOOe`, ejecutado, no de caché). La causa exacta
del cuelgue no quedó demostrada (otras pruebas usan `execSQL` sin problema); lo que sí quedó demostrado es que sin ese
patrón no ocurre.

🔴 **Causa real del cuelgue (corregida):** no era el `execSQL` sino **`spyk` + `callOriginal()` de mockk sobre una función
suspendida que salta a `Dispatchers.IO`** — devuelve `COROUTINE_SUSPENDED` y la prueba se cuelga (el repo ya lo advertía en
`AngelPayPaymentReviewRoomTest.kt` ~528). Intermitente: pasó en la corrida de `ledger` y volvió a colgarse en la completa
(`run-avoqado-tpv.LUWhpl`, 46 min con la fila tomada; detuve sólo su JVM de pruebas, comprobando con `lsof` que era la copia
de la TPV). Las 5 pruebas nuevas que usaban espías sobre la libreta o el DAO pasan ahora por un **DAO decorador**
(`object : PaymentAttemptDao by dao`). Tres pruebas VIEJAS se ajustaron por motivos legítimos: `fix5 D5 callback VACIO`
(stub de 5 comodines que fijaba `affiliation = null`), mi prueba app a app de P1-1 (usaba un número de intento que no era el
de la pantalla) y la guarda del CAS de rechazo, que se ACOTÓ al veto — con `APPROVED` el rechazo se anota como siempre porque
esa DESCARTADA ya aparta el aparato (`fix5 D5 sumidero app-to-app` lo documenta y volvía a colgar 15 s esperando la fila).
Memoria: `spyk-calloriginal-en-suspend-cuelga-el-jvm-de-pruebas`.

**Verificación de la ronda 10, COMPLETA (23-sep, madrugada):**
- **VERDE:** TPV **595/595** en 38 clases (`run-avoqado-tpv.qwwtRr`) · servidor: ruta de permisos **11/11** local = Alienware ·
  `npm run typecheck` del CI **0**, local = Alienware.
- **17 sabotajes, todos cazados, cada uno por su prueba**: TPV A (6, `run-avoqado-tpv.QNCk23`) · B (4, `.ESycBb`) · C (3,
  `.gKckyL`) — exposición 46-53 s con la fila vacía, restaurado por hash — y servidor 4 (1 · 1 · 3 · 3 caídas, con la fila tomada).
  Incluye el sabotaje que Codex pidió de `cuentaParaRegistrar()` (C2, por la secuencia adoptar → rechazo → reintentar → B).
- **10ª pasada de Codex lanzada**: encargo `encargo-B-r10.md`, veredicto `veredicto-B-r10.txt` (misma carpeta de auditoría).

### 19.e 🔴 10ª pasada de Codex (23-sep, madrugada): RECHAZO — 2 P1 · 2 P2. Ronda 11 en curso

Veredicto: `veredicto-B-r10.txt` (líneas 17752-17813). Confirmó rojo 595/14 y servidor 3/11 → 11/11 en ambos equipos, y que el
cambio «evidencia → contestó» cierra la intercalación de r9.

| # | Hallazgo | Dónde |
|---|---|---|
| P1-1 | Un 200 ATRASADO de la MISMA sesión restaura el permiso que un 403 posterior revocó (dos consultas concurrentes: `WelcomeScreen.kt:612` y `:629`). Igual con un 200 autoritativo vacío | `PermissionsRepository.kt:134` |
| P1-2 | Un veredicto `RECHAZADO_PERTENENCIA` (el `RECORDED` es de OTRA solicitud) no escribe nada, pero la libreta lo envuelve en `Result.success` ⇒ la recuperación anota «contestó», devuelve sin evidencia y la pantalla re-anuncia una liberación vieja | `LedgerServerRecovery.kt:182` y `:101`, `PaymentAttemptDao.kt:762` |
| P2-3 | Un 403 ATRASADO de A borra la lista válida de B (esa rama no mira `sesionAlPedir`) | `PermissionsRepository.kt:153` |
| P2-4 | Si el borrado del 403 falla, la lista sigue en disco y la SIGUIENTE llamada (el lector estático de la declaración) la acepta | `PermissionsRepository.kt:154`, `clearCache:204` |

Notas (no hallazgos): Blumon SÍ puede recibir veto por `LedgerRecoveryTrigger → recoverOne` (el CAS corregido lo respeta, medido en
SQLite; faltan pruebas de sus callbacks) · el acceso maestro recibe botones locales que `checkPermission` no le avala en endpoints
(no es escalada) · la afiliación restaurada SÍ decide un `Cobrado` en `AngelPayChargeVerifier.kt:97` (falta prueba con el
verificador real) · no pudo certificar desde el log el 595/38 exacto ni los hashes de los sabotajes.

### 19.f ▶️ Ronda 11 (23-sep, madrugada): los 4 de la 10ª pasada, construidos con TDD

| # | Arreglo | Dónde |
|---|---|---|
| P1-1 · P2-3 | Cada descarga de permisos toma un número al salir (`emitidas`); sólo se aplica la más nueva (`aplicarSiEsLaMasNueva`, en `synchronized`). El 403 además exige que la sesión no haya cambiado | `PermissionsRepository` |
| P2-4 | `revocadas` (por `SecureStorage`, débil): el 403 marca al dueño ANTES de borrar; `listaGuardada` lo ignora; sólo lo levanta una descarga nueva exitosa. Residuo declarado: memoria del proceso | `PermissionsRepository` |
| P1-2 | `quedoGuardado()`: `RECHAZADO_PERTENENCIA`, `FUERA_DE_ALCANCE` y `SIN_FILA` NO cuentan; vuelven como evidencia, dejan la marca `APPROVED` sin atribuir el Payment y no anotan «contestó» (el worker gasta el turno) | `LedgerServerRecovery` |

- **ROJO** `run-avoqado-tpv.cySuOg`: 4 fallan, las 4 nuevas, cada una en su aserción · **VERDE** 600/600 (`.DAkQ0d`) + las dos clases
  tras agregar las pruebas que AÍSLAN cada defensa del P2-3 y dividir la del P1-2: 29 + 14 (`.FRHJAl`).
- **7 sabotajes, todos cazados** (`.L1uipI`, `.px7fpB`). La P2-3 original no cae con uno solo porque tiene dos defensas: por eso
  existen P2-3b (sólo sesión) y P1-1b (sólo orden).
- **11ª pasada de Codex lanzada** (`encargo-B-r11.md` → `veredicto-B-r11.txt`).

### 19.g 🔴 11ª pasada de Codex (23-sep): RECHAZO — 1 P1 · 3 P2. Ronda 12 en curso

Veredicto: `veredicto-B-r11.txt` (línea 17071 en adelante). Confirmó que las pruebas aisladas NO pasan por el motivo equivocado, que
`quedoGuardado` clasifica bien y que el servidor no cambió (diffs r10/r11 idénticos byte a byte).

| # | Hallazgo | Dónde |
|---|---|---|
| P1-1 | El orden de EMISIÓN no es el orden de LECTURA del servidor: la consulta 2 se lee antes de revocar y llega después de la 1 (ya revocada) ⇒ `2 > ultimaAplicada` rehabilita el permiso. Solución: serializar la descarga COMPLETA (petición + aplicación) | `PermissionsRepository.kt:128` |
| P2-2 | Un 200 autoritativo SIN el permiso cuya escritura falla cae al `catch` de red y devuelve la caché vieja (y el lector estático la acepta) | `PermissionsRepository.kt:205` |
| P2-3 | `revocadas` guarda UN dueño: el 403 de B (borrado fallido) sustituye la revocación de A y la lista de A vuelve a valer | `PermissionsRepository.kt:76` |
| P2-4 | La respuesta de la DECLARACIÓN con `RECORDED` cuya aplicación falla (o es `RECHAZADO_PERTENENCIA`, que `.isSuccess` cuenta como guardado) no deja `APPROVED`; y el worker descarta el `Result.failure` antes del respaldo y sin pedir reintento | `AngelPayPaymentViewModel.kt:3670`, `LedgerServerRecovery.kt:101` |

Pruebas que pidió: invertir el orden de LECTURA · lista reducida con fallo al guardar · dos 403 de personas distintas con borrado
fallido · POST con veredicto no guardado · worker con fallo sólo al aplicar · y comprobar que la rama rechazada GASTA el turno.

### 19.h ▶️ Ronda 12 (23-sep): los 4 de la 11ª pasada, construidos con TDD

| # | Arreglo | Dónde |
|---|---|---|
| P1-1 | **Una descarga de permisos a la vez, completa** (petición + aplicación): `Mutex` `unaDescargaALaVez`; dentro, `descargar` vuelve a mirar la caché. La segunda petición no SALE hasta que la primera se aplicó ⇒ el servidor la lee después. Se retiraron `emitidas`/`ultimaAplicada` de la r11 | `PermissionsRepository` |
| P2-2 | El guardado de una lista autoritativa va en su propio `try`: si falla, se revoca al dueño y se devuelve la lista NUEVA (no cae al «sin red») | `PermissionsRepository` |
| P2-3 | `revocadas` es un CONJUNTO por `SecureStorage`: el 403 de B ya no borra la revocación de A | `PermissionsRepository` |
| P2-4 | `ResultadoDelVeredicto.quedoEnLaFila`, regla única. La respuesta de la declaración (VM) y el worker ante una transacción caída dejan la marca durable `APPROVED`; el worker además cuenta `sinRespuesta` | `VeredictoDeIntento`, `LedgerServerRecovery`, `AngelPayPaymentViewModel` |

- **ROJO** `run-avoqado-tpv.qZNSGN` (copia congelada ANTES del parche): 235 pruebas, **5 fallan — las 5 nuevas —** cada una en su
  aserción (P1-1 `llamadas == 1`; P2-2 el valor devuelto; P2-3 el lector estático tras volver A; P2-4 VM `marcarEvidencia…` no
  llamado; P2-4 worker `APPROVED` nulo).
- **VERDE** `run-avoqado-tpv.7z1sv9`: TPV **606/606** en 38 clases (XML de la copia).
- Borde declarado, no programado: un 200 sin `venueId`/`staffId` cuyo `remove` falla no revoca a nadie; hoy el servidor siempre
  los manda.
- **SABOTAJES: 7, todos cazados** (restaurado por hash, 48–50 s de exposición con la fila vacía):
  - Ronda A (`.HCYm4d`): F1 sin `Mutex` → r11 P1-1 · F2 el worker no marca al fallar aplicar → r11 P2-4 worker · F3 la
    declaración no marca → r11 P2-4 VM · **F7 la rama rechazada no gasta el turno → r10 P1-2 worker en `serverCheckedAt`**
    (el sabotaje que Codex dijo que faltaba).
  - Ronda B (`.eWZr8m`): F4 pertenencia cuenta como guardada → las dos r10 P1-2 + el caso pertenencia de r11 P2-4 VM · F5 una
    sola revocación → r11 P2-3 · F6 guardar falla sin revocar → r11 P2-2 (lector sin red).
- **12ª pasada de Codex lanzada** (`encargo-B-r12.md` → `veredicto-B-r12.txt`). El diff del servidor es idéntico byte a byte al
  de la r11 (la prueba `tpv.authPermissions.routes.test.ts` es un archivo sin seguimiento: no aparece en `git diff HEAD`).

### 19.i 🟡 12ª pasada de Codex (23-sep): RECHAZO sin P1 — 2 P2 · 2 P3. Ronda 13 construida y verificada

Veredicto: `veredicto-B-r12.txt` (línea 18111). **Sin P1**; los arreglos de permisos, cerrados («no encontré otro defecto
bloqueante»). Y cazó un error mío: generé el diff completo del encargo MIENTRAS la ronda B de sabotajes estaba aplicada (llevaba
F4/F5/F6); el disco y el delta estaban bien. Lección en la memoria `sabotear-en-el-arbol-compartido-se-commitea-solo`.

| # | Hallazgo | Arreglo |
|---|---|---|
| P2-1 | Cancelar la pantalla o el worker mientras Room aplica el veredicto se lleva la marca: el REGRESO de «aplicar» a un contexto cancelado lanza y «marcar» nunca corre | `aplicarConRespaldo` (recovery) y el mismo tramo en la VM: `withContext(NonCancellable) { aplicar; marcar si no quedó }` |
| P2-2 | El worker gasta el turno aunque la marca de respaldo falle (y la rama sin veredicto también) | `sinRespuesta++` sin turno ni «contestó» si nada quedó durable; `recoverOne` con `estampar` tampoco gasta el turno |
| P3-3 | La prueba del `Mutex` no probaba que cubriera el GUARDADO | Prueba con hilos reales y barrera en `putString`; cancelación del dueño y del que espera; dos llamadas no forzadas comparten la caché |
| P3-4 | La prueba del worker no comprobaba que el fallo conservara el turno | `serverCheckedAt == null` y `serverCheckCount == 0` |

- **ROJO** `.RqePs1`: 244 pruebas, **6 fallos = las 6 nuevas de comportamiento**, cada una en su aserción. Las del candado y P3-4
  pasan desde el inicio (cobertura).
- **VERDE** `.19p7iL`: TPV **615/615** en 38 clases.
- **SABOTAJES: 9, todos cazados** (`.SpKTfo`, `.zEyytq`, `.qBKs7D`). G4 tumbó además `r9 P1-3`, correcto: al reordenar, la guarda
  de «contestó» quedó detrás del mismo `if`.
- **13ª pasada de Codex lanzada** (`encargo-B-r13.md` → `veredicto-B-r13.txt`); diffs generados con el árbol = respaldo.

### 19.j 🔴 13ª pasada de Codex (23-sep): RECHAZO — 1 P1 · 3 P2 · 1 P3. Ronda 14 construida

Veredicto: `veredicto-B-r13.txt` (línea 15968). 🔴 **El P1 desmintió algo que YO declaré inocuo en el encargo**: «el veto solo ya
bloquea». Codex lo midió con el SQL real del DAO: para un Pago rápido sin orden, con SÓLO el veto la reserva de otro cobro ENTRA; con
veto + `APPROVED`, no. La reserva del aparato mira `APPROVED`; el veto sólo cerca la VENTA. Lección: una afirmación de seguridad
sobre el candado se comprueba contra la consulta del candado, no contra la intuición de qué «debería» bloquear.

| # | Hallazgo | Arreglo |
|---|---|---|
| P1 | Veto y aprobación de UNA respuesta en escrituras separadas: cancelar entre ambas deja entrar otro cobro | `guardarLoDelCuerpo` (worker y sondeo) y la VM escribe el veto DENTRO del tramo de lo demás de esa respuesta |
| P2-2 | `withContext(NonCancellable)` con el mismo dispatcher no comprueba la cancelación al regresar | `ensureActive()` al salir de cada tramo |
| P2-3 | S5 sin pantalla no dejaba la marca de respaldo | tramo `aplicar + marcar` en el listener |
| P2-4 | 25 filas atoradas por escritura tapan a la 26 para siempre | la consulta acepta `excluir`/`limite`; el worker pagina sólo si la página entera quedó atorada por ESCRITURA (sin red no), tope 4 |
| P3 | La prueba de hilos reales podía dar verde falso por planificación | `CoroutineStart.UNDISPATCHED` + barrera en `finally` |

- NO se metió el veto al candado del aparato: un veto hoy no tiene salida (P2-11) y apartaría la terminal sin escape.
- **ROJO** `.cKQKSA`: 284 pruebas, **7 fallos = las 7 de comportamiento**, cada una en su aserción; los controles pasan.
- **VERDE** `.hlFEF9`: TPV **686/686** en 41 clases (se sumaron socket y workers: cambió la firma de la consulta y el S5).
- **SABOTAJES: 10, todos cazados** (`.0ZAHkJ`, `.B9dQ6i`). Paginar sin red dio 100 consultas (4 × 25): el tope actúa.
- **14ª pasada de Codex lanzada** (`encargo-B-r14.md` → `veredicto-B-r14.txt`).

### 19.k 🔴 14ª pasada de Codex (23-sep): RECHAZO — 2 P1 · 2 P2 · 1 P3. Ronda 15 construida

Veredicto: `veredicto-B-r14.txt` (línea 16831). Los dos P1 son de la protección del APARATO, y los midió con el SQL real:

| # | Hallazgo | Arreglo |
|---|---|---|
| P1-1 | «No cancelable» no es «atómico»: entre el commit del veto y el de la aprobación otra pantalla reserva y autoriza | La marca que aparta el aparato va SIEMPRE PRIMERO (worker, sondeo, pantalla, S5); el veto al final. Sin transacción nueva: el orden elimina el estado intermedio |
| P1-2 | Aprobación CON Payment (colisión, o `RECORDED` sobre DESCARTADA): el veredicto se guarda sin promover y sin marca; la reserva no mira el Payment | Todo veredicto deja la marca, antes de aplicarse |
| P2-3 | El tope de páginas movía la inanición a la candidata 101 | `atoradasDeLaPasadaAnterior` (en memoria, `@Singleton`): la pasada siguiente las salta; se alternan |
| P2-4 | Un fallo al estampar tras un 2xx contaba como «sin red» | `contesto` por fila: tras recibir HTTP, un fallo es atasco |
| P3 | El control del S5 dependía de un reloj | Espera el evento final; el control «APLICADO no marca» se retiró (afirmaba lo que cambió) |

- **ROJO** `.v3DBZh`: 295 pruebas, **11 fallos = las 11 nuevas**, cada una en su aserción (reserva 2 en vez de -1, B autorizado 1,
  sana sin atender, orden invertido).
- **VERDE** `.EjlqMw` dio 2 fallos que eran de ANDAMIAJE: las pruebas de cancelación de la pantalla (r12, r13) limpiaban el registro
  DESPUÉS de detenerse y la marca ahora ocurre ANTES. Se verifican en el punto de parada. **VERDE** `.HC2dkB`: **697/697** en 41 clases.
- **SABOTAJES: 9, todos cazados** (`.jB6auD`, `.lvgJK1`, `.rlz3qM`).
- **15ª pasada de Codex lanzada** (`encargo-B-r15.md` → `veredicto-B-r15.txt`).

### 19.l 🟡 15ª pasada de Codex (23-sep): RECHAZO — 1 P1 · 1 P2 (los órdenes, dados por buenos). Ronda 16 construida

Veredicto: `veredicto-B-r15.txt` (línea 16439). Distinguió «llamar primero» de «conseguir persistir primero».

| # | Hallazgo | Arreglo |
|---|---|---|
| P1 | Si la marca falla pero el veredicto sí se guarda, la fila sale de toda recuperación: el DAO gasta el turno al guardar, `RECORDED` la saca de las candidatas y una DESCARTADA no se reaplica ⇒ otro cobro entra para siempre | **Sin marca no se aplica el veredicto** (worker, sondeo, pantalla, S5): la fila queda candidata |
| P2 | La rotación alternaba dos grupos: con 200 atoradas la 201 nunca tenía turno | **Rueda**: cada pasada da turno a ≤25 atoradas desde `ultimaEnTurno`, excluye al resto; salen las que avanzan o dejan de ser candidatas |

- **ROJO** `.7LzWPT`: 282 pruebas, 5 fallos = las 5 nuevas. La del S5 caía por el motivo EQUIVOCADO (un mock sin programar tumbaba el
  listener antes de emitir); se programó «aplicar» y se repitió (`.3rNDlX`) hasta verla caer en «should not be called».
- **VERDE** `.E3NtE2`: 702 pruebas con 2 fallos que eran aserciones MÍAS mal planteadas (esperaban `serverOutcome` nulo y la fila venía
  de una liberación: `OPERATOR_NO_INSTRUMENT`). Corregidas a «no cambió y sin Payment»; la clase del recovery **52/52** (`.zqzZSE`).
- **SABOTAJES**: K1 (aplica aunque falle la marca), K2 (pantalla), K3 (S5) cazados en `.EIQsYS`; K5 (puntero congelado) cazado AISLADO
  en `.nSIbuc` justo en `at-030`. 🔴 K4 (la rueda no excluye) NO quedó aislado en la tanda A — K1 también desactiva la detección de
  atascos — y se repitió SOLO (`.lc36g5`): cazado, tumba justo las dos de rotación. **5/5 sabotajes.**
- **16ª pasada de Codex lanzada** (`encargo-B-r16.md` → `veredicto-B-r16.txt`).

### 19.m 🟡 16ª pasada de Codex (23-sep): RECHAZO — 1 P1 · 1 P2. Ronda 17 construida

Veredicto: `veredicto-B-r16.txt`. Reprodujo los dos con SQLite en memoria y el SELECT real del DAO.

| # | Hallazgo | Arreglo |
|---|---|---|
| P1 | El respaldo de S5 de la pantalla (`dejarDuraderoElAvisoS5`) guardaba el veredicto SIN la marca: DESCARTADA + RECORDED sin `APPROVED` ⇒ el CAS de B a AUTORIZANDO devolvía 1 | **La marca va DENTRO de `aplicarVeredictoDelServidor`** (su `@Transaction`), justo tras leer la fila: ningún llamador la salta y no hay ventana |
| P2 | La rueda excluía con `NOT IN (:excluir)`: con 1.000 atoradas pasaba de 999 variables (SQLite < 3.32, API 27) y el fallo de LECTURA se leía como «ya no hay más» (sacaba el turno de la rueda) | **Cursor por la clave del orden** (variables fijas), las excluidas se saltan en memoria, tope de **100 filas atendidas** (no 4 páginas), y un fallo de lectura pide reintento sin tocar la rueda |

- Por qué la marca va SIEMPRE y no sólo sobre una DESCARTADA: el rechazo del host (`casHostResponded`, AUTORIZANDO → DESCARTADA) no mira
  el veredicto guardado y confía en la marca para apartar el aparato. Efecto declarado (existe desde r13 en S5): con el webhook primero y
  el SDK dentro, la fila es «contradicción» unos segundos hasta quedar REGISTRADO.
- **ROJO** `.zmKIXt`: 56 del recovery, 4 fallos = las 4 nuevas, cada una en su aserción.
- **VERDE** `.16gKG5`: 41 clases, **706 pruebas, 0 fallos**.
- **SABOTAJES: 5/5 cazados** — A `.Uge45x` (L1 sin marca, L2 sin salto), B `.21fser` (L3 lectura sin reintento), C `.0Zhud6` (L4 la
  lectura saca de la rueda, L5 sin el tope de una página que avanza).
- **17ª pasada de Codex lanzada** (`encargo-B-r17.md` → `veredicto-B-r17.txt`).

### 19.n 🟡 17ª pasada de Codex (23-sep): RECHAZO — 1 P1 · 1 P2 · 2 P3. Ronda 18 construida

Veredicto: `veredicto-B-r17.txt`. La marca dentro de la transacción la dio por buena; lo que quedaba era lo VIEJO.

| # | Hallazgo | Arreglo |
|---|---|---|
| P1 | Al actualizar, una fila que la versión anterior guardó con dinero y SIN marca no vuelve a pasar por la transacción (E2 no reaplica DESCARTADA, E3 no consulta RECORDED): reservar y autorizar otro cobro devolvían 1 (lo midió con el esquema v36 real) | **Migración de Room 38 → 39**, sólo datos e idempotente: marca AngelPay · SALE · no heredada · con outcome de dinero · fuera de REGISTRADO/CERRADA, fechada desde el veredicto |
| P2 | Los topes se revisaban entre páginas: 1 atorada + 24 sin red ⇒ 49 sin respuesta; una excluida desalineaba hasta 124 atendidas | El tope se revisa **antes de cada fila**; alcanzarlo no es «ya no hay más» |
| P3 | Cada página de 25 reordenaba el venue: cuadrático con la rueda llena | `limite = 25 + min(saltar, 475)`: ≤ 6 lecturas con 1.000 atoradas (antes 41) |
| P3 | Las pruebas no fijaban la transacción ni todas las claves del cursor | Prueba del rollback (trigger que aborta tras marcar) y del cursor con tres turnos, fechas empatadas e ids al revés |

- **ROJO** `.xJlewG`: 62 pruebas, 5 fallos = las 5 nuevas en su aserción (las de cobertura, verdes a propósito).
- **VERDE** `.0mh9Ni`: 42 clases, **712 pruebas, 0 fallos** — XML conservados en `…/auditoria/evidencia-r18/verde-0mh9Ni/`.
- **SABOTAJES: 8/8 cazados** (A `.FYICIe`: M1, B1, T1 · B `.SDhGP2`: M2, R1, C1 · C `.4oUjgV`: B2, M3).
- **Nexgo real** (copia de su base v38): la migración no alcanzaría ninguna fila.
- 🔴 **Pregunta de diseño abierta, para el founder**: una DESCARTADA con dinero y marca, SIN orden, aparta el aparato sin fecha de
  salida — ninguna barrera mira si el servidor ya registró ese Payment, y `registrarPorVeredicto` no admite DESCARTADA. Riesgo de
  terminal muerta (p. ej. el caso del 16-sep: el SDK dijo «cancelado» y el banco aprobó). Se le preguntó a Codex en la 18ª pasada.
- **18ª pasada de Codex lanzada** (`encargo-B-r18.md` → `veredicto-B-r18.txt`).

### 19.o 🟡 18ª pasada de Codex (23-sep): confirmó que faltaba la SALIDA → decisión del founder «A · corrige y avisa». Ronda 19 construida

Veredicto: `veredicto-B-r18.txt`. Confirmó con archivo:línea lo que se le preguntó: una DESCARTADA con dinero y marca, sin orden,
apartaba el aparato **para siempre** (ninguna transición la sacaba). El founder eligió **A · corrige y avisa**: la terminal dice
«ese cobro de $X SÍ pasó, no lo vuelvas a cobrar», el cajero toca **Entendido**, la fila pasa a REGISTRADO y queda quién y cuándo.

- **Regla única** `SQL_COBRO_POR_RECONOCER` (sólo el caso LIMPIO): AngelPay · SALE · no heredada · DESCARTADA/INDETERMINADO ·
  `server_outcome = RECORDED` con su Payment · mismos importes · sin veto · sin reconocer · y, con solicitud, ganador de ella.
  Va DENTRO del UPDATE de `reconocerCobroRegistrado`; lo demás sigue apartado como contradicción.
- **Room 40** (aditiva, idempotente): `acknowledged_at`, `acknowledged_by`. `SQL_CONTRADICCION` deja de contar un rechazo del host
  ya reconocido; el aviso de contradicción (familia 3) excluye lo que ya ofrece el Entendido; la barrera nombra el Entendido.
- **ROJO** `.OvFu9f`: 30 pruebas, 9 fallos = las nuevas, cada una en su aserción (stubs).
- **VERDE**: 727 pruebas, 0 fallos. 🔴 La primera corrida destapó una prueba vieja (`AngelPayPaymentReviewRoomTest`, S5 sin
  persistir) que esperaba «contradicción» donde ahora, por la decisión A, sale el Entendido: se actualizó (y además fija que el
  aparato SIGUE apartado hasta confirmar).
- Prueba nueva con base real del cableado de la barrera (antes sólo se probaba con las banderas puestas a mano).

### 19.p ▶️ Ronda 20 (23-sep): «no debería trabarse nunca y todo es por webhook» — la terminal se libera SOLA a los 10 s

Origen: QA en la N86 con el APK r18 — matar la app a media venta dejó la fila AUTORIZANDO y la terminal sin cobrar 10 min. El
founder: *«no debería de trabarse nunca y todo es por webhook»* y *«no debería ni de tardar 3 segundos»*. Medido en producción
(7 días): aviso del banco p50 1.6 s · p99 3.4 s · máx 4.5 s; 790 de 812 cobros Nexgo con aviso — los 22 sin aviso, TODOS de
ESTOCOLMO (Doña Simona), cuyo webhook nunca se configuró. Extra medido: la latencia del host (el `transactionId` lleva la hora de
la terminal) varía ≤ 7 s sobre su mediana en 1 710 eventos de 30 días (p99 2.5 s). Decisión del founder: **10 segundos**.

**Servidor** (`no-instrument-resolution.service.ts`): nuevo testimonio `NO_BANK_TRACE_AFTER_WINDOW`, de la TERMINAL:
sólo en un Pago rápido (con vínculo ⇒ `ATTEMPT_NOT_ELIGIBLE`), sin PIN, sin pedir el permiso de declarar (la sesión sí tiene que
ser miembro), el MISMO veto de dinero (antes que todo lo demás) y sólo si el aviso del banco de los comercios AngelPay de ESA
terminal está **comprobado**: cada uno recibió aviso y ningún cobro con tarjeta completado suyo es posterior al último aviso +60 s
(todos tienen que cumplir). Si no ⇒ `409 WEBHOOK_NOT_CONFIRMED`. Bitácora `TERMINAL_PAYMENT_AUTO_RELEASED_NO_BANK_TRACE`; MCP
(`localResolutions`) la distingue por `kind` y `authorizedBy: AUTOMATIC`. ROJO 11/13 · VERDE 56/56 · **8/8 sabotajes** cazados.
De paso: una prueba unitaria vieja del veto por evento pasaba en vacío desde la ronda 7 (el fragmento del veto viaja anidado y el
mock sólo miraba el texto exterior): corregida y verificada con sabotaje.

**Terminal**: (1) la libreta guarda en memoria qué abrió ESTE proceso; al arrancar (y en cada pasada del worker) lo que dejó un
proceso muerto pasa AL INSTANTE a INDETERMINADO `proceso_terminado` (el SDK vive en el proceso: su manifiesto no declara
`android:process`), un PREPARANDO huérfano se descarta, y con orden sólo cerca su venta; (2) la ventana de un Pago rápido baja de
45 s a **10 s** y al final pide la liberación sola (id fijo por intento, así pantalla y worker piden la misma); (3) el worker libera
en segundo plano las dudas locales quietas ≥ 10 s, con espera de 10 min tras un «no» del servidor; se agenda a los 12 s de arrancar.
Una duda por RELOJ de este proceso (su lector puede seguir dentro) nunca se libera sola. Sin aviso comprobado, queda el botón.

### 19.q 🔴 19ª pasada de Codex (23-sep): RECHAZO — 3 P1 · 2 P2 · 1 P3. Ronda 21 construida

Veredicto: `veredicto-B-r19.txt`. Los seis, confirmados en el código y cerrados:

- **P1-1 · «Entendido» sobre un cobro que el servidor contradice** (terminal). Una respuesta puede traer a la vez un Payment
  RECORDED y `evidenceContradiction`/`unattributedEvidence` (el servidor los calcula por separado). Con veredicto, los tres
  consumidores aplicaban el veredicto y NO el veto ⇒ fila limpia ⇒ «Entendido» ⇒ volver a cobrar. Ahora el veto viaja DENTRO del
  veredicto (`VeredictoDeIntento.veto`) y se escribe en la MISMA transacción (`aplicarVeredictoDelServidor`), así que los tres lo
  guardan por un solo camino; la pantalla lo recibe también con veredicto.
- **P1-2 · la regla del aviso comprobado aceptaba un webhook roto** (servidor). «Ningún cobro posterior al último aviso + 60 s» se
  dejaba engañar por un cobro sin aviso a < 60 s del último, y un aviso POSTERIOR de otra terminal del mismo comercio lo tapaba.
  Nueva regla: **cada uno de los últimos 10 cobros con tarjeta** del comercio (de hace > 60 s) tiene SU aviso, ligado al pago o
  al intento por la llave recortada.
- **P1-3 · se medía el comercio asignado HOY, no el del cobro** (servidor + terminal). La terminal manda `merchantAccountId` del
  contexto que la libreta guardó al abrir el cobro; el servidor exige que sea AngelPay y de ESTE negocio (`AngelPayUserAccount`),
  y mide sólo ése. Sin comercio en el contexto: no se pide (decide el cajero).
- **P2-1 · un salto de la hora adelantaba la liberación** (terminal). La espera se mide con el reloj MONOTÓNICO del proceso
  (`faltaParaLiberarSola`); la consulta ya no filtra por `updated_at` — que además, con la hora corrida hacia atrás, dejaba la
  duda apartada tanto como se moviera la hora.
- **P2-2 · la liberación de arranque podía esperar minutos detrás de la cadena de WorkManager** (terminal). Ahora corre EN EL
  PROCESO (`liberarTrasArrancar`: pide ya, espera lo que falte, vuelve a pedir); WorkManager queda de respaldo. El worker agenda
  la pasada siguiente a tiempo si deja una duda sin cumplir su espera.
- **P3-1**: la prueba «sólo cerca SU venta» comprueba la MISMA venta antes de reservar otra.

**Verificación:** servidor ROJO 13/18 del bloque (los 5 que «pasaron» lo hacían por el esquema estricto: motivo equivocado, fijado después
por sabotaje) · VERDE 62/62 · 13 suites / **569** integraciones vecinas · `npm run typecheck` 0 errores, local = Alienware ·
**8 sabotajes, 7 cazados**; S5 (quitar la exigencia explícita del comercio) no cae: sin comercio la consulta devuelve `null` ⇒
no elegible igual — defensa en profundidad, verificada. Terminal ROJO 14 de 230 (contra esqueletos) · VERDE **761/0** (45 clases)
+ control 232/0 con las 2 pruebas añadidas para que K6 y K10 tuvieran quién los cazara · **14 de 14 sabotajes cazados**. Encargo de
la 20ª pasada: `encargo-B-r20.md`.

**QA en la N86 real (23-sep, APK r21 contra el servidor local de la ronda 21 por `adb reverse`; sin tarjeta — nunca hubo cobro):**
- QA-1 · comercio SIN sus avisos (el de prueba, 0 de 10): al arrancar la app pidió la liberación EN EL PROCESO a los ~11 s y el
  servidor contestó 409 `WEBHOOK_NOT_CONFIRMED` con el comercio del cobro; la fila se queda en duda (decide el cajero).
- QA-2 · con los 10 avisos sembrados (base local, revertido después): arranque 13:45:41 → **liberado solo 13:45:52**; testimonio
  `NO_BANK_TRACE_AFTER_WINDOW` firmado `AUTOMATIC` y bitácora con el comercio.
- QA-3 · **el caso original**: app muerta con el lector esperando tarjeta (fila `AUTORIZANDO`) a las 13:47:35, reabierta 13:47:38,
  la app terminó de arrancar 13:47:53 y la fila quedó **liberada sola 13:48:04**; inicio limpio, 0 Payments de ese intento. Antes de
  las rondas 20-21: 10 minutos trabada y después seguía apartada.
- 🔴 Trampa de QA: el build de depuración sólo permite HTTP a `localhost` (`network_security_config_debug.xml`); con la IP de la
  Mac en `devBaseUrl` todo falla con `CLEARTEXT … not permitted`. Receta: `adb reverse tcp:3010 tcp:3010` +
  `-Pavoqado.devBaseUrl=http://127.0.0.1:3010/api/v1/`.

### 19.r 🔴 20ª pasada de Codex (23-sep): RECHAZO — 3 P1 · 2 P2 · 1 P3. Ronda 22 construida

Veredicto: `veredicto-B-r20.txt`. Los seis, confirmados y cerrados:

- **P1-1 · el veto quedaba guardado pero la promoción a REGISTRADO lo volvía inofensivo** (terminal). Codex lo reprodujo con el
  SQL real: RECORDED + veto ⇒ REGISTRADO, contradicción 0, sin retención, otro cobro reservado, y la pantalla «cobrado». Ahora
  `registrarPorVeredictoDelServidor` y el lote de reaplicación exigen `server_veto IS NULL`. ⚠️ **Esto AMPLÍA el P2-6 abierto**
  (decisión del founder): una fila con veto ya no tiene la salida «el servidor registró el dinero» — era justo esa salida la que
  volvía el veto inofensivo.
- **P1-2 · un cobro con `Payment.merchantAccountId` vacío desaparecía de la medición** (servidor). El registrador lo deja en null
  cuando la cuenta está inactiva y conserva la identidad en `processorData.merchantAccountIdFromApk`. Ahora el cobro cuenta para el
  comercio con el que cobró la terminal (`COALESCE(FromApk, columna)`), dentro del negocio; y un comercio desactivado no sostiene
  el silencio. Medido en producción (sólo lectura): Testarudo, 36 214 pagos, **1.6 ms**, índice `venueId, createdAt`.
- **P1-3 · tras un 409 se ignoraba lo que traía la consulta** (terminal): si `recoverOne` trae evidencia o veto (aunque no se hayan
  podido guardar), CON_EVIDENCIA antes de leer la fila.
- **P2-1 · las primeras 100 dudas tapaban a la 101**: paginación con cursor; las que esperan su reintento se saltan en memoria sin
  gastar el cupo (hasta 2 000 filas por pasada).
- **P2-2 · el reintento de 10 min con reloj de pared**: ahora monotónico, y lo que le falta cuenta para el seguimiento. Con el cupo
  lleno y dudas por pedir, `proximaEnMs = 0`.
- **P3 · `instalar()` y `doWork()` probados de verdad** (no sólo sus funciones auxiliares).

🔴 **Dos defectos que cazaron NUESTRAS pruebas antes de Codex:** (1) mío — `(sinAvisoHasta[id] ?: Long.MIN_VALUE) − reloj`
DESBORDA a un positivo enorme ⇒ toda duda parecía «esperando reintento» y ninguna se liberaba (8 pruebas en rojo); (2) la prueba
nueva del P1-3 fallaba en ROJO por el motivo equivocado: su `coAnswers` suspendía en Room y `runTest` adelantaba el reloj virtual
hasta el tope ⇒ SIN_RESPUESTA (memoria `runtest-adelanta-el-reloj-mientras-room-trabaja`).

**Verificación:** servidor ROJO 3/3 · VERDE 65/65 · 572 integraciones vecinas · typecheck 0 local = Alienware · **3/3 sabotajes**.
Terminal ROJO 6/240 · VERDE **772/0** (45 clases) · control 241/0 · tandas U/V/W de sabotaje (9 guardas) en la fila. Codex 21ª
pasada lanzada (`encargo-B-r21.md`).

### 19.s 🔴 21ª pasada de Codex (23-sep): RECHAZO — 3 P1 · 1 P2 (sin P3). Ronda 23 construida

Veredicto: `veredicto-B-r21.txt`. Los cuatro, confirmados y cerrados:

- **P1-1 · registro limpio PRIMERO, veto DESPUÉS** (terminal): la ronda 22 impedía promover con veto, pero una consulta S6 en vuelo
  podía traer el veto sobre una fila YA registrada, y la contradicción excluía REGISTRADO/CERRADA ⇒ el veto desaparecía. Ahora el
  veto cuenta en cualquier estado: la fila sale en el **aviso de Inicio** y queda fuera de la poda. **No aparta el aparato a
  propósito** (el cobro está registrado; apartarlo sin salida sería la terminal muerta). La pantalla ya no dice «cobrado» sobre una
  registrada con veto. 🔑 Esto contradecía una prueba de la r6 (P1-4b, «REGISTRADO no queda como contradicción para siempre»): se
  reescribió a la regla nueva y se le preguntará a Codex si «aviso sin retención» basta.
- **P1-2 · el propio 409 POSITIVE_EVIDENCE_EXISTS** (terminal): veta desde que llega — marca durable (aparta el aparato y veta el
  cierre sin red), en la liberación sola y en la declaración del cajero, sin depender de la consulta siguiente (que igual se hace,
  para guardar el Payment).
- **P1-3 · un aviso ajeno ligado por referencia acreditaba al comercio** (servidor): sólo cuenta el aviso PROPIO (su intento es el
  del pago o no trae intento, y su motivo no es de la familia que contradice su atribución). Probado por el webhook real con dos
  intentos, dos comercios, misma referencia e importe, y una prueba por cada condición.
- **P2 · 25 dudas con 503 persistente acaparaban el cupo**: una espera corta propia (30 s, monotónica) y la 26 recibe su turno.

🔴 **Tres pruebas VIEJAS que chocaron y por qué:** (1) «el dinero manda con 409» — mi primer arreglo vetaba SIN consultar y dejaba de
guardar el Payment: corregido en el código (marca y además consulta); (2) la r6 P1-4b, reescrita (ver arriba); (3) la de «409 genérico
reconsulta» usaba justo POSITIVE_EVIDENCE_EXISTS: pasa a RESOLUTION_CONFLICT, su propósito intacto.
🔴 **Y una prueba no determinista destapada, no causada por el cambio:** `r5-3` elegía la terminal con `findFirst({ venueId })`;
otras pruebas del archivo crean una segunda terminal en el mismo negocio y, según el orden físico de la tabla, le tocaba ésa. Falló una
vez en la corrida de 13 suites; forzando la terminal ajena se reproduce idéntico (`Received: null`). Ahora la toma por el serial.

**Verificación:** servidor 68/68 del archivo · typecheck: **12 errores, todos en `tests/unit/middlewares/mcp-request-guard.test.ts`,
un archivo SIN versionar de otra sesión** (ninguno en lo tocado aquí) · **2/2 sabotajes** (cada condición del aviso propio).
Terminal ROJO 5/246 (cada uno por su motivo) · VERDE **777/0** (45 clases) · tandas X/Y (9 guardas, incluidas L5/L9 que la tanda W
de la ronda 22 no alcanzó a correr por la fila) en curso.

### 19.t 🔴 22ª pasada de Codex (23-sep): RECHAZO — 2 P1 · 2 P2 · 1 P3. Ronda 24 construida · y CAMBIO DE CADENCIA

Veredicto: `veredicto-B-r22.txt`. Los cinco, confirmados y cerrados:

- **P1-1 · un aviso recibido por M2 acreditaba a M1** (servidor): excluir motivos no alcanzaba. Un evento de M2 con la llave de un
  pago de M1 contaba ANTES de clasificarse (PENDING, sin motivo), y el backfill lo ligaba sin `MERCHANT_MISMATCH` cuando la columna
  del pago quedó vacía. Ahora el aviso cuenta sólo si lo RECIBIÓ ese comercio:
  `payload->'_avoqado'->>'receivedByMerchantAccountId' = m.id` (el receptor lo estampa al insertar, `angelpay-webhook.service.ts:895`).
  Un evento sin la estampa ya no cuenta (conservador: sólo reduce liberaciones automáticas).
- **P1-2 · el 409 «hay evidencia» se perdía si fallaba la escritura de su marca** (terminal): queda en memoria
  (`evidenciaSinGuardar`, intento → venue) hasta que se escribe; mientras, las TRES salidas negativas lo rechazan (cierre sin red,
  botón, liberación sola) y cada pasada lo reintenta primero. Residual declarado: si además muere el proceso, se pierde la memoria,
  pero la fila sigue INDETERMINADO y el servidor vuelve a vetar en la consulta siguiente.
- **P2 · el backoff de 30 s del worker devolvía a las mismas 25 dudas** y **P2 · la duda 2 001**: la pasada de dudas locales empieza
  donde terminó la anterior (cursor en rueda, por negocio, en memoria).
- **P3 · dos asertos del 409 pasaban por otra guarda**: las pruebas parten ahora de una fila DECLARABLE (con respuesta previa del
  servidor) y rompen la escritura de la marca con un trigger de SQLite.

🔴 **El compilador cazó un defecto MÍO que ninguna prueba habría visto a tiempo:** `x in evidenciaSinGuardar` sobre un
`ConcurrentHashMap` en Kotlin llama `contains(value)` = `containsValue` — buscaba el INTENTO entre los VENUES. Kotlin lo marca como
error (KT-18053), así que no llegó a correr; el ROJO previo había compilado contra el código viejo. Ahora `containsKey`. Además un
`return` dentro de una función de expresión. Y de paso una trampa de proceso: la cadena de sabotajes que esperaba turno había
RESPALDADO el árbol antes del arreglo — al restaurar lo habría borrado. Se detuvo, se verificó el árbol (sólo difería el arreglo) y
se relanzó con un respaldo nuevo.
Prueba nueva `r22 P1-2 d` (la liberación sola no vuelve a pedir con la marca sin escribir, aunque el servidor la aceptara) y su
sabotaje N6: la guarda de `puedeLiberarseSola` no tenía uno.

**Verificación:** servidor `noInstrumentSinSolicitud` 71/71 · 13 suites de integración **578/578** · typecheck **0 local y 0
Alienware** (la otra sesión ya arregló su archivo) · sabotaje X3 cazado. Terminal VERDE **783/0 (45 clases)** con el arreglo del
compilador; tandas de sabotaje A-D (15 guardas, incluida N6) en la fila — ver `scratchpad/sab-tpv-r24/tandas.out`.

🔑 **Cambio de cadencia (23-sep, noche; propuesta del founder, recomendada por mí; la regla de parada es mía y se la declaré): se
acaba el ciclo «una pasada de Codex por arreglo».** Van 22 pasadas desde el 22-sep en la
mañana (13 sólo el 23, de más de una hora cada una) y los P1 recientes son fallos DOBLES en el mismo instante. Nuevo orden:
(1) termino lo pendiente; (2) pruebas completas en la N86 y la D3, incluidas sin red; (3) las de tarjeta física, con el founder;
(4) Codex UNA pasada completa sobre todo el diff. Regla de parada: lo que pueda mover o perder dinero se arregla y Codex revisa SÓLO
eso; lo menor va a la lista; si tras 2 pasadas sigue habiendo P1, se para y se revisa el diseño con el founder. El encargo de la 23ª
pasada (sólo delta) quedó preparado y NO se lanzó: `encargo-B-r23-cabecera.md`.

### 19.u 🧪 QA en la N86 real con el APK de la ronda 24 (23-sep, noche) · y ronda 25: la cadena de WorkManager atorada

APK `nexgoDebug` compilado del MISMO árbol que el verde 783/0 (huella `eb5ca83f…`), servidor local en 3010 reiniciado con el
código de la ronda 24, túnel `adb reverse tcp:3010`. Sin tarjeta: nunca hubo cobro.

| # | Escenario | Resultado |
|---|---|---|
| QA-1 | Pago rápido $5, app muerta con el lector abierto, comercio SIN avisos | 🟢 fila «en duda» al arrancar; 11 s después, liberación sola → **409 `WEBHOOK_NOT_CONFIRMED`**; aviso verde honesto en Inicio |
| QA-1b | Intentar cobrar $7 con esa duda | 🟢 la barrera ADOPTA el cobro pendiente («NO se inició el cobro nuevo») y ofrece «El cliente no presentó tarjeta»; al tocarlo: POST 200 en 0.34 s, libreta DESCARTADA `OPERATOR_RECONCILED`, testimonio `SESSION` con el staff, bitácora, **0 pagos**. El intento de $7 no dejó fila huérfana |
| QA-2b | 10 avisos sembrados pero RECIBIDOS POR OTRO COMERCIO (P1-1 de la r22) | 🟢 **409 `WEBHOOK_NOT_CONFIRMED`** — la regla de la ronda 24, en el aparato |
| QA-2 | Los mismos avisos, receptor corregido | 🟢 **liberada SOLA 11 s después de arrancar**; testimonio `AUTOMATIC`/`NO_BANK_TRACE_AFTER_WINDOW`, bitácora con el comercio, 0 pagos |
| QA-3 | «El dinero manda» (409 `POSITIVE_EVIDENCE_EXISTS`) | ⬜ **no ejecutada a propósito**: simularla deja la terminal apartada sin salida limpia de QA. Va con la tarjeta física del founder |
| QA-4 | Cobro atorado + arranque SIN servidor + vuelve la red sin reiniciar | 🔴 **FALLÓ**: sin servidor, «liberación sola sin respuesta» (correcto: no libera a ciegas); **con la red de vuelta, 3 minutos sin liberarse** |

🔴 **La causa de QA-4, medida en la base de WorkManager del aparato:** la cabeza de la cadena `ledger_server_recovery` llevaba
**9 reintentos** (`run_attempt_count = 9`) y detrás **10 pasadas BLOQUEADAS**. Cada pasada con una consulta sin respuesta
devolvía `retry()`; WorkManager duplica la espera en cada reintento (30 s … hasta 5 h), y como todo va en una sola cadena
`APPEND_OR_REPLACE`, el «corre ya» de la reconexión quedaba detrás. Es el P2-3 de Codex r22, **peor de lo que él describió**: no
sólo la duda 26, TODA la recuperación. Un local con WiFi que se cae un rato quedaba con la terminal apartada horas.

**Ronda 25 (TDD):** la pasada sin respuesta termina en `success()` y agenda su PROPIO seguimiento a 31 s; el seguimiento tiene
tope de 31 s (era la cabeza que bloqueaba: con una duda sin aviso llegaba a 10 min); y la fila estrena nombre
(`ledger_server_recovery_v2`) cancelando la vieja, para que un aparato ya atorado se destrabe al actualizar. Rojo 5/11, cada una
por su motivo (Retry en vez de Success ×3, 601 s en vez de 31, la vieja sin cancelar). 🔴 Choca a propósito con la prueba de
Codex P2-1 («sin respuesta ⇒ `retry()`»): su intención —que la pasada se repita— se conserva con el seguimiento explícito.

🟢 **QA-4 REPETIDO con el APK de la ronda 25 (19:18–19:19): pasa.** Al primer uso, la cadena vieja quedó CANCELADA (14 pasadas, incluida la cabeza con 9 reintentos: estado 5 en `WorkSpec`) y nació `ledger_server_recovery_v2`. Sin servidor, la pasada terminó en `success` con «otra pasada en 29 s» (no más espera que se duplica). **Red de vuelta a las 19:19:07 → cobro de $4 liberado SOLO a las 19:19:14 (7 s).** Verde de la terminal 788/792: los 4 rojos son pruebas NUEVAS de la sesión del «Sin turno de caja», en rojo mientras termina su arreglo; las mías, todas verdes.
⚠️ **Declarado para Codex (trade-off, no arreglado):** una consulta S6 sin respuesta no gasta su turno (a propósito, Codex P2-1); antes la espaciaba el backoff de WorkManager, ahora se repite con el seguimiento de 31 s. Con la red caída o el servidor caído falla al instante y no llega a nadie; con 5xx sí gasta el turno. Sólo un servidor tan lento que no contesta en 30 s recibe una consulta continua por terminal. Remedio listo si hace falta: espera propia por consulta en memoria, como `sinAvisoHasta`.
🔴 **Trampa de QA:** la siembra de avisos falsos da «aviso comprobado» a un comercio cuyos avisos REALES no llegan a esta Mac. Con ella puesta, matar la app tras una aprobación REAL liberaría un cobro que sí pasó. Se retiró al terminar (`limpiar.sql`), y la prueba del «dinero manda» sólo tiene sentido contra un servidor que reciba los webhooks de AngelPay.

Otros hallazgos del QA, a la lista (no de dinero):
- 🔴 **Arranque sin red: «Sin turno de caja» falso** que bloquea Pago rápido y Cobrar (hasta efectivo) aunque la caja esté abierta.
  Defecto previo, fuera de este proyecto: tarea aparte creada.
- 🟡 El «Revisar» del aviso verde lleva a Pagos, donde un cobro local en duda **no aparece** (no es un pago); la salida real es
  intentar cobrar otra vez (la barrera lo adopta). Falta un camino directo desde el aviso.
- 🟡 Al adoptar la duda, dos POST automáticos en 2 s (los dos 409): uno de la barrera y otro del worker. Sin daño (idempotente),
  pero sobra uno.
- ⚠️ De paso, el servidor local tenía 11 migraciones sin aplicar en `av-db-25` (Uber KDS, planes, campañas): cualquier lectura de
  `Order` o `VenueFeature` tronaba. Aplicadas con OK del founder y respaldo previo (memoria
  `migracion-sin-aplicar-rompe-todas-las-lecturas-del-modelo`).

### 19.v 🔴 Pasada FINAL de Codex (23-sep, noche): RECHAZO — 3 P1 · 5 P2 · 1 P3. Ronda 26: los tres P1 cerrados

Primera pasada con la cadencia nueva: UNA revisión completa, después del QA en la N86 (§19.u) y de las pruebas con tarjeta física
del founder (cobro de $10 aprobado y registrado con el serial de la terminal; $5.05 rechazado y la terminal libre al instante).
Encargo `encargo-B-final.md`, veredicto `veredicto-B-final.txt`. Codex: «Los tres P1 permiten volver a cobrar pese a dinero ya
movido» y «la siguiente revisión puede limitarse a esos tres arreglos y sus pruebas adversariales».

| # | Hallazgo | Arreglo |
|---|---|---|
| **P1-1** (terminal) | `evidenciaSinGuardar` protegía el botón, la declaración y el inicio de la automática, **no** la liberación del servidor, el rechazo del SDK ni la reserva del cobro siguiente; y una salida que ya la había mirado (vacía) cerraba igual. Reproducido por Codex con esquema 40 + `marca_rota`, sin muerte del proceso | Un `Mutex` (`candadoDeEvidencia`) para la escritura de la evidencia, TODA salida «no se cobró» (`salidaNegativa`: liberación del servidor, rechazo del host, sin autorización, kernel, descarte, declaración) y la reserva; cada una mira la memoria DENTRO del candado. La pantalla relee también la memoria (`tieneEvidenciaSinGuardar`) |
| **P1-2** (servidor) | El controlador del webhook contestaba **200** cuando el INSERT del aviso fallaba: sin evento, sin worker que lo recupere, y el silencio del intento parecía «no se cobró» | 503 si no se guardó (y si la base falla ya al buscar el comercio); lo que falla DESPUÉS del ingreso contesta `PROCESSING_ERROR` con su evento (lo retoma el worker). `avisosNoGuardados.ts` (memoria a propósito): aprobación no guardada = dinero de su llave (automática, cajero y — extensión mía — la ventana de 30 s del POS vía `aprobacionBancariaConocida`); y el canal del comercio sin comprobar 30 min |
| **P1-3** (servidor) | Un aviso SIN llave de otra terminal del mismo comercio (misma referencia `yyMMddHHmmss`) se ligaba al cobro A y contaba como su aviso propio: la salud volvía a comprobarse | Sin llave, el aviso sólo es propio si trae el serial de la terminal que cobró. Medido en producción: mismo veredicto que la regla vieja en los 22 comercios (1 533 avisos ligados, todos con serial coincidente) |

🔴 **Una extensión que no pidió Codex, del mismo defecto:** la ventana de 30 s del servidor (cobros que manda el POS, en producción
desde el 17-sep) también libera por silencio. Con la marca en `aprobacionBancariaConocida`, la aprobación no guardada de un intento
vinculado RETIENE (`HELD_BY_BANK_EVIDENCE`, `eventLogId: null`) en vez de liberar; el cierre de la terminal degrada igual.

⚠️ **Commits ajenos (no se revierten, regla del workspace):** `9fb1de73` (servidor, ya en origin/develop, «feat(mcp): request guard»)
se llevó el trabajo de esta función hasta la ronda 24, incluido este relevo; `d56fd08` (terminal, ya en origin/main, «turnos abiertos
y recuperación del servidor») se llevó la ronda 25. Nada está desplegado.

**Lista para después (P2/P3 de la pasada final, no bloquean):** backoff de WorkManager por interrupción con 21 candidatas · la espera
de 2 min de la incertidumbre delante del «corre ya» · la bandeja puede terminar sin agendar la recuperación que necesita · la
adopción deja fuera una orden local retenida · `LIMIT 10` sin índice del comercio efectivo · la muestra de 10 sin desempate por `id`.
Míos: mientras la evidencia no se escribe, la barrera de la reserva usa el texto genérico; `discardStalePreparing` sin candado
(PREPARANDO de AngelPay nunca tiene dinero del servidor); el CHANGELOG de la terminal pesa 233 KB (la regla pide rotar a 50 KB).

🔴 **Un hueco MÍO, cerrado antes de mandar la revisión:** el P1-2 marcaba el canal del comercio también cuando la base fallaba
AL BUSCARLO, con el id tal como viene en la URL. Medido en el servidor local: `POST /api/v1/webhooks/angelpay/abc%00def` hace
reventar esa búsqueda en Postgres (`22021 invalid byte sequence`) — la rama «la base falló» era alcanzable SIN caída y por
cualquiera, y cada request basura metía una llave en un mapa sin tope. Arreglo: el id se valida contra `^[A-Za-z0-9_-]{1,64}$`
ANTES de la base (404, igual que un comercio desconocido; los 34 `MerchantAccount` de producción son cuid) y el mapa del canal
lleva tope (`TOPE_DE_COMERCIOS` = 10 000, se olvida la falla más vieja, 🚨 si aún era vigente). Rojo visto en las dos pruebas
nuevas; verde 18/18.

🔴 **Y el reingreso propio (otro hueco MÍO, cerrado antes de Codex):** con el P1-2 tal como lo pidió Codex, si AngelPay no
reintentaba el 503 la terminal quedaba apartada SIN SALIDA — el servidor contesta `409 POSITIVE_EVIDENCE_EXISTS` por la marca en
memoria, la terminal lo guarda DURABLE (`LedgerServerRecovery.kt:538`, `AngelPayPaymentViewModel.kt:3827`) y nadie registra ese
cobro porque el aviso no existe en la base. Que AngelPay reintente ante un 5xx NO está documentado. Ahora el servidor vuelve a
procesar él mismo la misma entrada (`procesarAviso`, sin `req`/`res`) a los 5 s, 15 s y cada minuto hasta guardarla; deduplicado
por `merchantAccountId:eventId`, tope de 1 000 pendientes y de 16 KB por cuerpo. Residual: un reinicio con la base AÚN caída y sin
reintento de AngelPay pierde el reingreso — cae en la familia del P2-6 (evidencia sin Payment, decisión del founder pendiente).
Verificado: rojo en 7 unitarias + la de punta a punta (el disparador deja de romper el INSERT: 0 → 1 evento), sabotajes R1–R7, V1
y C1 cazados (R4 sólo tras corregir la prueba: con un reintento que salía bien a la primera, el temporizador duplicado no dejaba
rastro), unitarias del área 98/98, `noInstrumentSinSolicitud` 79/79, `webhook/angelpay-webhook` 6/6.

**Verificación:** terminal (3 clases, 303 pruebas, sabotajes DENTRO de la copia de avq-verify): VERDE 303/303 · G0 (rojo) 10
caen = las 9 nuevas + `r22 P1-2 a` · T1 caen b, c, d, e, f + las 2 de pantalla del rechazo · T2 caen a, e, f + la de pantalla de «sin autorización». Servidor: P1-3 rojo → verde,
P3a–c cazados · P1-2 unitarias 131/131 (+18/18 tras el hueco del byte nulo), `noInstrumentSinSolicitud` 78/78 con el disparador que
rompe el INSERT, `terminalPaymentWindow` 79/79, P2a–P2i cazados, arquitectura 55/55, terminal-payment 222/222 · typecheck del CI
0 local y Alienware antes del reingreso (`run-avoqado-server.xmgPjz`); con el reingreso, 0 en el Alienware y 191 locales, TODOS de la merma de otra sesión contra el cliente de Prisma viejo de esta Mac (falso positivo documentado, `run-avoqado-server.lTUuzM`) · 14 suites de integración **14/14 suites, 593/593** (evidencia `run-avoqado-server.o5szJJ`, con el arreglo del byte nulo dentro).

**Revisión acotada de Codex (gpt-6-astra xhigh, 21:26): RECHAZO — 3 P1, los tres verificados por mí en el código.** Todos de la
MISMA familia: la evidencia que quedó sólo EN MEMORIA porque la base falló, y un lector que no la consulta.
1. **Terminal:** `markAuthorizing` (y por la misma razón `markKernelEntered`) no mira `evidenciaSinGuardar`. B reservó ANTES de que
   llegara la evidencia de A y autoriza DESPUÉS (la espera del vínculo N1 está en medio). Codex, con el SQL real y esquema 40:
   autorización = 1 con la evidencia en memoria, 0 con la misma evidencia escrita. Puede volver a cobrar la venta.
2. **Servidor:** la consulta S6 de la terminal (`terminal-payment.service.ts` ~6401) no consulta `hayDineroNoGuardado`: una
   liberación aceptada ANTES del aviso aprobado (que luego no se guardó) se sigue publicando limpia, y la terminal la acepta.
3. **Servidor, el reingreso:** el tope de 1 000 comparte cola entre avisos VERIFICADOS y los de la búsqueda caída (sin verificar):
   1 000 entradas con firma falsa durante la caída expulsan el reingreso del aviso auténtico y su veto queda vivo ⇒ terminal
   retenida sin recuperación aunque la base ya volvió.
Codex confirmó: el P1-3 cerrado, el cambio de expectativa de R6-2 correcto, sin cobros/resoluciones duplicados por el reingreso,
y ninguna otra salida «no se cobró» fuera de `salidaNegativa` (la excepción de PREPARANDO se sostiene).
🔴 **Parada por la regla de la cadencia** (2 pasadas con P1 ⇒ se revisa el DISEÑO con el founder, no se sigue parchando).

### 19.w 🔴 Decisión del founder tras la parada: LA PUERTA — «primero se guarda la nota, después se decide» (23-sep, noche)

Con la analogía de la nota adhesiva (la memoria) y el cuaderno (la base) se le presentaron tres caminos: parchar los 3 lectores,
salir así y apuntarlo, o una sola puerta. Eligió **una sola puerta**, con una pregunta: «¿no se traba la terminal?». Respuesta
(y hay prueba de ella, `final-2 d`): la puerta sólo espera mientras la base está rota —y con la base rota nada decide igual—; en
cuanto vuelve, lo pendiente se escribe en el acto y la terminal sigue. Además CIERRA el único caso que sí la trababa para siempre
(el hueco 3). Excepción declarada: un aviso auténtico que la base rechazara SIEMPRE (dañado) retiene sólo esa venta/terminal, con 🚨.

**Terminal:** `puertaBajoCandado()` (bajo `candadoDeEvidencia`) escribe la evidencia pendiente y devuelve si quedó alguna; la
llaman la reserva, `markAuthorizing`, `markKernelEntered` (cuyo CAS ni siquiera lleva la cerca de la venta) y `salidaNegativa`.
**Servidor:** `puertaDelDinero(attemptId)` es la única lectora de la nota (prueba de arquitectura), despierta los reingresos
auténticos (a lo más cada 5 s) y la consultan la declaración y la liberación automática (tres caminos), la ventana de 30 s y el
cierre, y **S6**, que con dinero sin guardar publica `processorEvidence: 'APPROVED'`. El reingreso son dos listas con topes aparte
(auténticos 10 000 · sin verificar 1 000) y un pendiente sin verificar que resulta auténtico se promueve.

**Verificación:** terminal (3 clases, sabotajes DENTRO de la copia de avq-verify): VERDE 307/307 · T3 (reserva, autorización y salidas vuelven a su código de antes) caen a, b, c y d · T4 (el lector de antes) cae a — T3 ∪ T4 es el código previo: el rojo. Servidor: rojo en las 10 pruebas nuevas; unitarias del área 36/36; sabotajes D1–D8 (D4 sólo cae junto con D4b: dos capas, cada una suficiente; D8 sólo lo caza la integración de la ventana); integración 14/14 suites, 595/595 (`run-avoqado-server.DFZLiO`); typecheck del CI 0 en el Alienware (`run-avoqado-server.FaiKUd`) — la corrida anterior destapó un error de tipos MÍO que ts-jest no ve (`programar(…, 0)` contra la unión literal del `as const`), corregido. ⚠️ De paso: los nombres de prueba de Kotlin no admiten «:» (ya estaba en memoria y no lo miré): una tanda no compiló.

**Revisión acotada #2 de Codex (la puerta):** 🔴 RECHAZO, 2 P1 de la misma familia — arreglos en §19.x.

### 19.x Revisión acotada #2 → 2 P1 cerrados, más un hermano hallado ANTES de mandárselo (23-sep, noche)

1. **Terminal — el lector sin la cerca de la venta.** Al volver la base la puerta escribía la evidencia de A, pero el CAS de
   `KERNEL_ACTIVO` sólo llevaba la cerca para `AUTORIZANDO`: B (misma venta, reservada antes) entraba al lector, que en la PAX
   puede aprobar SOLO (contactless offline) sin pasar por autorización. Arreglo: la MISMA cerca también para `KERNEL_ACTIVO`. Sólo
   la usa la PAX (cobro y reembolso contactless; AngelPay nunca entra por ahí), y no crea bloqueos nuevos: vuelve a preguntar en el
   lector lo que la reserva ya exige, justo antes de entrar. Pruebas: `final-2 e` (la reproducción de Codex) y `final-2 d` reforzada
   (tras volver la base, OTRA venta reserva, entra al lector y autoriza — la terminal no se traba).
2. **Servidor — la promoción se quedaba con el reintento del falso.** Un cuerpo con firma falsa encolado con la búsqueda caída y
   después el auténtico con la misma clave: la promoción conservaba el reintento del falso (401 ⇒ «terminado») y el auténtico nunca
   se reingresaba. Arreglo: la promoción toma el reintento del auténtico, y una corrida vieja que termina después no da por guardado
   al promovido (corre el auténtico en el acto).
3. **Servidor — el hermano:** el falso y el auténtico llegando LOS DOS con la búsqueda caída. Ninguno se puede verificar sin la base;
   el primero (el falso) se quedaba la clave y el auténtico se descartaba (visto en rojo: 0 procesados). Arreglo: la clave del
   reingreso es la de ESA entrega, `comercio:eventId:sha256(firma + cuerpo)`; dos entregas idénticas (el reintento de AngelPay)
   siguen compartiendo clave. Con esto la promoción sólo ocurre para la MISMA entrega; el reemplazo del reintento queda como defensa
   del módulo.

**Verificación:** terminal VERDE 386/386 (8 clases, `run-avoqado-tpv.4cKFOp`) · Q5 (la cerca de antes) cae sólo `final-2 e`.
Servidor: rojo de `final-4` visto; unitarias 40/40; sabotajes F1 (cae en las 2 del módulo), F2 (1) y H1 (sólo `final-4`), árbol
restaurado y HEAD sin mover en cada uno; integración contra la base desechable `noInstrumentSinSolicitud` 80/80 y webhook 68/68;
typecheck Alienware 0 con el (2) — la corrida con la huella quedó en la fila.

**Residuales declarados a Codex** (no arreglados): (1) el GET de la solicitud, `resolverEsperaDelPos` y crear una solicitud NUEVA de
la misma venta no pasan por la puerta — Codex ya lo había clasificado como misma familia, no P1 independiente; (2) una inundación de
≥1 000 cuerpos falsos durante la caída puede expulsar un auténtico que llegó SIN verificar — queda la marca del canal (30 min);
cerrarlo del todo pediría guardar en memoria los secretos ya vistos; (3) el aviso dañado también frena la liberación automática del
resto de su comercio (la declaración del cajero sigue).

**Revisión acotada #3 de Codex (segunda sobre la puerta):** 🟢 **AUTORIZO, sin P1 nuevo** (`veredicto-B-final-4.txt`). Contrastó
la cerca del lector con SQL real y el esquema 40: 2 640 combinaciones, ningún rechazo del lector que una reserva nueva permitiera.
Typecheck con la huella: Alienware 0 (`run-avoqado-server.quAKRW`; local 191, todos de la merma). Dos notas suyas que quedan:
- **Corrección a mi encargo:** dije que el reembolso lleva la cerca por venta igual que el cobro. Es falso: el reembolso serializa
  `originalOrderId` y la reserva y el CAS leen `orderId`, así que para un reembolso ninguno de los dos reconoce la venta. Es previo y
  no lo introduce este cambio (los dos pasos coinciden); no es un bloqueo nuevo.
- **El residual (2) sigue teniendo riesgo de DINERO** bajo su combinación (caída de la base + inundación dirigida + AngelPay sin
  reintentar): la marca de 30 min frena la liberación automática pero no recupera el aviso expulsado. Decisión del founder: guardar
  en memoria los secretos ya vistos para verificar sin la base, o aceptarlo.

### 19.y 🧪 QA en la N86 con el código FINAL (puerta + cerca del lector + pasada final) — 23-sep, 22:58–23:21

APK `nexgoDebug` del árbol con todo lo de esta noche (comprobado en el dex: la puerta, el rechazo del lector y la cerca de
`KERNEL_ACTIVO`), servidor local en 3010 reiniciado con el código actual, túnel `adb reverse`. Sin tarjeta: nunca hubo cobro.

| # | Escenario | Resultado |
|---|---|---|
| P1 | Pago rápido $5, app muerta con el lector abierto, comercio SIN aviso comprobado | 🟢 fila «en duda»; liberación sola → 409 `WEBHOOK_NOT_CONFIRMED`; aviso honesto en Inicio |
| P1b | Cobrar $7 encima | 🟢 la barrera ADOPTA el pendiente («NO se inició el cobro nuevo»), sin fila huérfana; «El cliente no presentó tarjeta» → POST 200 en 0.16 s, testimonio `SESSION`/`NO_INSTRUMENT_PRESENTED`, bitácora, **0 pagos** |
| P1c | Otra venta ($6) tras liberar | 🟢 llega al lector (AUTORIZANDO: la puerta y el candado nuevos no traban ni frenan); Cancelar ⇒ U100, «No se cobró» |
| P2 | Pago rápido $9, app muerta con el lector abierto, arranque SIN servidor | 🟢 «4 consultas sin respuesta — otra pasada en 31 s» (el arreglo de la ronda 25 sigue) |
| P2b | Vuelve el servidor, avisos del comercio comprobados | 🟢 **liberado SOLO 11 s después de arrancar**: testimonio `AUTOMATIC`/`NO_BANK_TRACE_AFTER_WINDOW`, bitácora, **0 pagos** |
| P2c | Otra venta ($4) tras la liberación sola | 🟢 llega al lector; cierra con U101 («nadie acercó una tarjeta») |

Log del servidor en toda la prueba: 0 errores, 0 5xx; los únicos 4xx, los tres 409 esperados. Siembra y marca del comercio
restauradas (`qa-puerta/limpiar.sql`: 0 avisos de prueba, `angelpayWebhookLastReceivedAt` otra vez NULL).

🔑 **Dos cosas de la receta que ya no son como en la ronda 24** (memoria `qa-liberacion-sola-siembra-y-espera`):
- La siembra de avisos tiene que traer `payload.payload.terminalSerial` del pago: desde la pasada final, un aviso SIN llave sólo
  cuenta con el serial de la terminal que cobró. La siembra vieja dio 409 — y era lo correcto: los avisos reales lo traen.
- Tras un 409 `WEBHOOK_NOT_CONFIRMED` la terminal no vuelve a pedir la liberación en 10 min (`REINTENTO_SIN_AVISO_MS`, en memoria;
  el botón del cajero sigue disponible). Para reintentar en QA, reiniciar la app.

No cubierto en el aparato: los caminos con la BASE rota de la puerta (sólo con inyección de fallas: los cubren las pruebas de Room
con `marca_rota`), la cerca del lector (sólo la PAX la usa) y «el dinero manda» con tarjeta real.

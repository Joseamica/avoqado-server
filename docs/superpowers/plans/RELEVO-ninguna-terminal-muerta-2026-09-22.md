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

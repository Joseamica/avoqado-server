# Corte del rollout de tokens legacy

**Spec de origen:** `docs/superpowers/specs/2026-08-27-sesion-de-aparato-y-cambio-de-usuario-design.md` §4.5 y §10 (workspace root).
**Plan:** `docs/superpowers/plans/2026-08-27-parte-a-sesiones-revocables.md`, Task 15.
**Código:** `src/middlewares/authenticateToken.middleware.ts` (`faseDelRolloutLegacy`, `requireVersionedSession`).
**Este documento se escribió, y el estado de abajo se verificó leyendo el código, el 2026-08-28.**

## 1. Qué es un token "legacy"

Desde la Parte A, un token de acceso/refresco puede traer dos claims nuevos y opcionales:

- `sid` — el id de una fila `Session`, que es lo que hace que la sesión se pueda **revocar** (cerrar sesión en un aparato específico,
  matar todas las sesiones al cambiar la contraseña, etc.) contra una caché que falla cerrado.
- `v` — versión del formato del token. `v: 1` significa "trae `sid`". Ausente = **legacy**.

Un token **legacy** es válido (firma correcta, no vencido) pero **no revocable individualmente**: es un bearer token puro, igual que
todos los tokens de Avoqado antes de esta Parte A. Ese es exactamente el problema que Task 15 cierra: mientras existan, hay sesiones que
nadie puede revocar desde el dashboard ni desde ningún panel de seguridad.

## 2. Las 4 fases (spec §4.5)

| # | Fase | Qué significa |
|---|------|----------------|
| 1 | El backend acepta legacy **y** puede emitir `sid` | Ya construido (Tasks 1-14): el modelo `Session`, la caché, el middleware, la rotación de refresh. Un token sin `sid` sigue pasando en todas las rutas normales. |
| 2 | Los clientes migran al refrescar o al entrar | Cada login nuevo (o, donde esté implementado, cada refresh) empieza a traer `sid`. Es un proceso **gradual y por cliente** — no un interruptor único. |
| 3 | Lo nuevo sólo acepta sesiones versionadas | Cualquier endpoint nuevo (empezando por `switch-user`, Parte C) exige `sid` desde el día que se publica, sin esperar a que termine la migración. Esto **ya está construido** en esta misma tarea — ver §6. |
| 4 | Corte: legacy se rechaza en TODAS partes | Pasada la fecha de corte (o forzado a mano), un token sin `sid` deja de aceptarse incluso en las rutas de siempre. Aquí termina la deuda transitoria de la fase 1. |

Las fases 1-3 **no son ramas de código distintas** en el middleware: para `authenticateTokenMiddleware`, legacy pasa en fases 1-3 y se
rechaza sólo en fase 4. Lo que sí es código desde el día 1, sin importar la fase, es el candado de "lo nuevo" (fase 3, §6).

## 3. Estado real, verificado en el código (2026-08-28)

🔴 **Esta es la parte que no estaba en la narrativa del spec y que sí importa para calcular el corte: dos de los cuatro clientes
NI SIQUIERA PUEDEN emitir `sid` hoy.** No es que no lo hayan hecho todavía por prioridad — el código que los emite no existe.

| Cliente | Emite `sid` hoy | Dónde se verificó |
|---|---|---|
| **Android / iOS** (POS móvil) | ✅ Sí, en login — `loginWithEmail` y `verifyPasskeyAssertion` crean una `Session` y pasan `{ sid: session.id }` a `generateAccessToken`/`generateRefreshToken` | `src/services/mobile/auth.mobile.service.ts:257,268` y `:639,650` |
| **Android / iOS** (refresh) | ⚠️ Sólo si el refresh token que se está canjeando YA traía `sid`. Un refresh de un grant legacy **sigue emitiendo legacy** — no crea una `Session` retroactiva | `src/services/mobile/auth.mobile.service.ts:810` (`session = await prisma.session.findUnique({ where: { id: payload.sid } })`) y `:904` (`sidOpts = session ? { sid: session.id } : undefined`) |
| **Dashboard web** (login, `loginStaff`) | ❌ No. Usa el mismo firmante compatible con `sid` (`jwt.service.ts`) pero **nunca le pasa `opts`** | `src/services/dashboard/auth.service.ts:437,439` |
| **Dashboard web** (`switchVenueForStaff`) | ❌ No, mismo motivo | `src/services/dashboard/auth.service.ts:630,631` |
| **TPV / PAX** (login y refresh) | ❌ No, y no es sólo "falta pasar `opts`": usa un firmante **estructuralmente distinto** (`src/security.ts`, no `src/jwt.service.ts`) cuyo `TokenPayload`/`generateAccessToken` no tiene ningún parámetro para `sid` | `src/services/tpv/auth.tpv.service.ts:4` (importa `generateAccessToken` de `../../security`, no de `../../jwt.service`), `src/security.ts:337-364` |

**Consecuencia directa para este documento:** la fase 2 ("los clientes migran") está **en progreso sólo para Android/iOS**, y sólo para
sesiones que nacen de un login nuevo — no para las que sólo se refrescan. Dashboard web y TPV todavía no arrancaron su fase 2; eso es
trabajo de otra tarea (dashboard es un cambio chico — el firmante ya soporta `opts.sid`, sólo falta crear la `Session` y pasarla; TPV es
más grande, porque necesita cambiar de firmante, y probablemente conviene resolverlo junto con la Parte B — identidad de aparato — que ya
toca el carril de auth del POS de tarjeta).

## 4. 🔴 Por qué la fecha de corte NO se fija en este documento

El middleware es **uno solo**, compartido por los cuatro clientes. No hay forma de que reconozca "este token sin `sid` es de Android,
ese otro es de TPV" — un token legacy es indistinguible de otro sólo por la ausencia del claim. Eso significa que **activar la fase 4
hoy, o en cualquier fecha antes de que dashboard y TPV terminen su propia fase 2, tira abajo el login web completo y las terminales PAX
completas** — no una sesión vieja aislada, sino la ÚNICA forma que esos dos clientes tienen de autenticarse, porque no existe todavía un
código que les dé un token con `sid`.

Por eso `AUTH_LEGACY_TOKEN_CUTOFF_AT` (§7) se deja **sin definir** en este cambio. Fijar una fecha sin haber cerrado la fase 2 de
dashboard y TPV no sería "adelantarse" — sería programar una interrupción total de esos dos clientes para dentro de 90 días, sin que
nadie se dé cuenta hasta que ocurra.

**Precondición dura antes de poder calcular una fecha real:** dashboard web (login + `switchVenueForStaff`) y TPV/PAX (login + refresh)
tienen que emitir `sid` en producción. Hasta entonces, la fase efectiva se queda en 1 (el default), y eso es correcto — no un
descuido.

## 5. La aritmética: por qué son 90 días y no 30

La vigencia máxima de CUALQUIER token vivo hoy, entre los cuatro clientes, es la que hay que cubrir — no la típica.

| Token | Vigencia máxima | Fuente |
|---|---|---|
| Access, dashboard/móvil, con "recordarme" | 30 días (2,592,000 s) | `src/jwt.service.ts:100` |
| **Refresh, dashboard/móvil, con "recordarme"** | **90 días (7,776,000 s)** | `src/jwt.service.ts:189` |
| Access, TPV/PAX | 30 días (2,592,000 s) | `src/services/tpv/auth.tpv.service.ts:13` |
| Refresh, TPV/PAX (firmante legacy, sin "recordarme") | 7 días fijos (604,800 s) | `src/security.ts:374` |

El access de 30 días parece el número "grande" porque es el que más se repite en el código, pero **no es el que hay que cubrir**: un
access vencido obliga a refrescar, y mientras el REFRESH siga siendo válido, el cliente sigue consiguiendo accesos nuevos sin volver a
loguearse. El refresh con "recordarme" es el que de verdad mide cuánto puede durar una sesión sin que la persona vuelva a escribir su
contraseña — y ese es **90 días**, no 30.

🔴 **Consecuencia de usar 30 en vez de 90:** alguien que activó "recordarme" en su celular hace 60 días, con un refresh perfectamente
válido por 30 días más, se encontraría con la sesión muerta de golpe — sin haber hecho nada mal, sin aviso, y sin poder distinguir "se
cerró mi sesión" de "cambié mi contraseña" (los dos mensajes que ya existen en `passwordChangeGuard.ts`). El corte tiene que esperar la
vigencia máxima completa del token MÁS LARGO que el sistema pudo haber emitido el último día que emitió uno legacy.

**La fórmula:**

```
fecha_de_corte = día_en_que_TODOS_los_clientes_dejaron_de_emitir_legacy + 90 días
```

No 30. El access de 30 días es el que MÁS se ve en el código, pero el refresh de 90 con "recordarme" es el que manda.

## 6. El candado permanente de "lo nuevo" — ya construido, no espera a la fecha

`requireVersionedSession` (mismo archivo que el middleware principal) implementa la fase 3 **sin condicionarla a ninguna fecha ni a la
bandera de fase**: un token sin `sid` se rechaza ahí desde el primer despliegue de esta tarea, con `403 Forbidden` y
`code: 'LEGACY_TOKEN_NOT_ALLOWED'`.

La Parte C monta `switch-user` sobre este guard:

```ts
router.post(
  '/switch-user',
  authenticateTokenMiddleware, // autenticación normal (incluye el corte de fase 4 si ya aplica)
  requireVersionedSession, // además: exige sid, siempre, sin importar la fase
  switchUserController,
)
```

No hace falta tocar este archivo cuando `switch-user` se construya — sólo importar `requireVersionedSession` y montarlo en la cadena.
Cualquier otro endpoint "nuevo" que quiera nacer con la misma exigencia hace lo mismo.

## 7. El mecanismo: dos variables de entorno

Ninguna es obligatoria. Ausentes = fase 1 (el estado de hoy), que es el lado que nunca echa a nadie de más.

| Variable | Formato | Default | Qué hace |
|---|---|---|---|
| `AUTH_LEGACY_TOKEN_PHASE` | `1` \| `2` \| `3` \| `4` | `1` | Bandera **manual**. `4` fuerza el rechazo de legacy en todas partes de inmediato, sin esperar la fecha. Cualquier valor que no sea `2`, `3` o `4` (vacío, texto, `0`, negativo) se trata como `1` — nunca escala la fase por un error de tipeo. |
| `AUTH_LEGACY_TOKEN_CUTOFF_AT` | fecha ISO 8601 (`2027-01-15T00:00:00.000Z`) | *(sin definir)* | Fecha de corte **ya calculada** con la fórmula de §5. En cuanto `Date.now() >= cutoff`, el middleware se comporta como fase 4 — sola, sin que nadie tenga que tocar `AUTH_LEGACY_TOKEN_PHASE` ese día. Un valor no parseable se ignora (se trata como si no estuviera definida). |

`faseDelRolloutLegacy()` (exportada) combina las dos: si cualquiera de las dos apunta a fase 4, el resultado es 4. Es deliberado que
sean dos palancas independientes — la bandera es para una decisión humana explícita ("ya verificamos que todo migró, corta ahora"); la
fecha es la red de seguridad que **no depende de que un humano se acuerde de nada**. Un aparato dormido —una tablet PAX apagada tres
semanas— nunca va a aparecer en ninguna métrica ni telemetría; el reloj de la fecha de corte sigue corriendo igual, y eso es justo lo que
hace que el corte sea calculado y no observado.

## 8. Quién mueve la bandera, y cuándo

| Cuándo | Quién | Qué hace |
|---|---|---|
| **Hoy** | Nadie. Ninguna variable está definida en ningún `.env` — el sistema vive en fase 1 por default. | — |
| **Cuando dashboard web emita `sid` en login y `switchVenueForStaff`** | Quien despliegue ese cambio | Verifica en el log de producción que los logins nuevos del dashboard traen `sid` (grep `sid:` en el payload decodificado, o consulta `Session` por `staffId` reciente). No mueve ninguna bandera todavía — dashboard es sólo UNO de los dos clientes que faltan. |
| **Cuando TPV/PAX emita `sid` en login y refresh** | Quien despliegue ese cambio (probablemente junto con la Parte B, identidad de aparato) | Mismo tipo de verificación. Con esto, los CUATRO clientes ya pueden emitir `sid` — se cumple la precondición de §4. |
| **El día en que el ÚLTIMO cliente (normalmente TPV) despliega su emisión de `sid` en producción** | Quien hace ese despliegue | Calcula `fecha_de_corte = hoy + 90 días` con la fórmula de §5, actualiza la tabla de §3 (los cuatro "✅"), y **escribe la fecha resultante en este documento** (nueva fila en §9) junto con la fecha en que la calculó. Puede dejar `AUTH_LEGACY_TOKEN_CUTOFF_AT` sin poner todavía si prefiere esperar a estar seguro — no hay apuro: cada día que pasa sin ponerla es un día más de margen, nunca un riesgo. |
| **Al llegar la fecha calculada, o cuando el founder decida cortar antes** | El founder, o quien opere el rollout con su visto bueno | Pone `AUTH_LEGACY_TOKEN_CUTOFF_AT` (o `AUTH_LEGACY_TOKEN_PHASE=4` para un corte inmediato) en el entorno de producción. Esto es IRREVERSIBLE para cualquier sesión que en ese momento sólo tenga un token legacy: no hay forma de que un token legacy "consiga" un `sid` retroactivamente — la persona tiene que volver a iniciar sesión. Avisar a soporte antes de mover esta bandera en producción. |

## 9. Fecha de corte calculada

*(vacío — ver §4. Se llena el día en que los cuatro clientes ya emitan `sid` en producción, siguiendo la fórmula de §5.)*

| Fecha del cálculo | Día en que el último cliente dejó de emitir legacy | Fecha de corte (+ 90 días) | Quién la calculó |
|---|---|---|---|
| — | — | — | — |

## 10. Deuda declarada (spec §10, sigue vigente)

- **Hasta el corte, los tokens legacy siguen siendo bearer no revocables.** Cerrar sesión en un aparato específico, o matar todas las
  sesiones al cambiar la contraseña, no tiene efecto sobre un token legacy que todavía no venció por sí solo — sólo sobre tokens con
  `sid`. `passwordChangeGuard.ts` sigue siendo la única defensa contra un token legacy robado o de un empleado dado de baja (compara
  `iat` contra la fecha del cambio de contraseña, cubre TODOS los tokens, con o sin `sid`).
- **La "migración al refrescar" no es automática para grants ya-legacy en móvil** (§3): sin un cambio adicional (fuera de esta tarea),
  alguien que nunca vuelve a hacer login completo —sólo refresca— puede quedarse en legacy indefinidamente, renovando su refresh cada
  vez que esté por vencer. Esto es exactamente lo que la fase 4 cierra: ese token, aunque nunca "vence" por sí solo, sí deja de aceptarse
  el día del corte.
- **Sin candado de plan ni de módulo.** El corte es infraestructura de seguridad transversal, no una feature de producto — no aplica el
  árbol de decisión de `.claude/rules/feature-gating.md`.

## 11. Verificación

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server
npx jest --selectProjects unit --testPathPattern "legacy-cutoff|authenticateToken" --ci
```

`tests/unit/middlewares/legacy-cutoff.test.ts` cubre las cuatro pruebas del spec (fase 1 acepta en rutas normales, fase 1 rechaza en
`switch-user`, corte por fecha rechaza en todas partes, un token con `sid` sigue vivo aunque ya haya pasado la fecha) más tres de
regresión: la bandera manual en `4` corta igual sin esperar la fecha, una fecha futura no corta todavía, y un valor inválido de la
bandera no escala la fase por accidente.

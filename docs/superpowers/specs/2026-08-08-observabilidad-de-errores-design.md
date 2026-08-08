# Observabilidad de errores: trazabilidad de punta a punta + error tracking agregado (5 repos)

**Fecha:** 2026-08-08 · **Estado:** spec cerrado, listo para plan de ejecución

**Raíces de repo** (todas hermanas dentro del workspace Avoqado):

| Alias en este documento | Ruta | Stack |
|---|---|---|
| `server` | `avoqado-server/` | Express + TypeScript |
| `dashboard` | `avoqado-web-dashboard/` | React 18 + Vite |
| `tpv` | `avoqado-tpv/` | Kotlin, Android (PAX) |
| `android` | `avoqado-android/` | Kotlin, Android (POS) |
| `ios` | `avoqado-ios/` | SwiftUI, iOS 15+ |

Rutas sin prefijo de alias son relativas a `server/`.

---

## Context

Cuando algo truena en producción hoy, el rastro que queda depende de la suerte. El backend escribe una línea de log con stack trace pero sin decir a **qué venue ni a qué usuario** le pasó; el `correlationId` que se genera por request muere en el middleware y no llega a los servicios; no existe agrupación por huella, así que nadie sabe si un error ocurrió una vez o trescientas ni desde qué deploy empezó; y las tres apps de cliente más importantes (dashboard web, POS Android, POS iOS) no reportan absolutamente nada.

El costo es medible y actual: las investigaciones de producción de las últimas semanas (terminales fantasma, comisiones duplicadas sobre una misma orden, alertas del watchdog de dinero) arrancaron todas con un `grep` desde cero sobre un log stream sin identidad de tenant. Cada una consumió horas que un error agrupado y atribuido habría resuelto en minutos.

Este cambio hace dos cosas: le da al backend un **hilo de contexto** que sobrevive toda la cadena de llamadas, y pone **error tracking agregado** en los cinco repos con la huella, el conteo y el release ligados a cada error.

---

## Current State (verificado 2026-08-08)

| Repo | Reporte de errores | Contexto de tenant | Simbolicación |
|---|---|---|---|
| server | Winston JSON → Better Stack (source `1720702`) | `correlationId` solo en entrada/salida del request; el error handler NO estampa `venueId`/`userId` | `tsc` sin `sourceMap`; traces apuntan a `dist/` |
| dashboard | **Ninguno.** `ErrorBoundary` hace `console.error` | n/a | Vite minifica, `sourcemap` desactivado |
| tpv | Firebase Crashlytics (76 `recordException`) | n/a | R8 ofusca (`isMinifyEnabled = true`) |
| android | **Ninguno.** Ni Crashlytics ni Firebase | n/a | R8 ofusca (`isMinifyEnabled = true`) |
| ios | **Ninguno.** Firebase por SPM sin Crashlytics | n/a | Release sin dSYM |

Hechos concretos que condicionan el diseño:

1. **El `correlationId` no se propaga.** `src/middlewares/requestLogger.ts:15` lo genera y lo mete en `req`, pero no hay `AsyncLocalStorage`. Los 622 usos de `correlationId` en `src/` son pases manuales. Cualquier `logger.error` dentro de un servicio sale sin él.
2. **El error handler global pierde el tenant.** `src/app.ts:346` loguea `method`, `url` e `ip`, pero no `venueId`/`userId`, aunque `authContext` ya está en el request.
3. **El server ya acepta un `X-Correlation-ID` entrante** (`src/middlewares/requestLogger.ts:15`: `req.headers['x-correlation-id'] || uuidv4()`) y lo devuelve en la respuesta (`:17`). La traza cruzada cliente↔servidor es casi gratis: falta que los clientes lo generen y lo etiqueten.
4. **Cero aplicaciones de error tracking en Better Stack** (verificado por MCP: `applications` devuelve vacío), pese a que el producto está incluido y es compatible con el SDK de Sentry.
5. **`RENDER_GIT_COMMIT`** está disponible en runtime en Render sin trabajo extra → sirve como `release` sin tocar el pipeline.
6. **`src/config/env.ts` es Zod fail-fast**: la app no arranca si falta una variable requerida. El DSN debe entrar como `.optional()`.
7. **No hay envoltorio central de jobs.** Los 41 jobs se importan uno por uno en `src/server.ts:20-60` y cada quien se auto-agenda con `new CronJob(...)` o `cron.schedule(...)`.
8. **Los 20 handlers de Socket.IO están en un solo archivo**, `src/communication/sockets/managers/socketManager.ts`. Un único punto de intervención cubre el contexto de sockets por completo.
9. **El dashboard tiene un interceptor de RESPUESTA de axios** en `dashboard/src/api.ts:71`, y **ninguno de request** (verificado). Sirve para leer el `X-Correlation-ID` que devuelve el server, pero para *originarlo* hay que agregar el de request.

---

## Decisiones cerradas (no re-litigar)

| # | Decisión | Elegido |
|---|---|---|
| D1 | SDK | **El SDK de Sentry en los 5 repos.** Better Stack ingiere el mismo protocolo, así que el proveedor es un DSN, no una reescritura |
| D2 | Alcance | Los **5** repos |
| D3 | Datos sensibles | **Allowlist estricta**: nunca cuerpos de request ni headers crudos |
| D4 | Contextos con trazabilidad | HTTP + cron jobs + RabbitMQ + Socket.IO |
| D5 | Simbolicación | **Híbrido** por necesidad de mapeo (ver abajo) |
| D6 | Dónde cae el dashboard | **Sentry**, junto a los clientes. Cierra la que era OPEN-1 |

**El criterio de reparto, en una línea: quien despliega ofuscado o minificado necesita un proveedor que acepte archivos de mapeo.**

| | Va a | Por qué |
|---|---|---|
| **server** | **Better Stack Errors** | `tsc` no minifica y Node resuelve el stack **en proceso** antes de enviarlo. No depende del proveedor para simbolicar, así que se queda en la consola que ya pagas, junto a su log stream |
| **dashboard, tpv, android, ios** | **Sentry SaaS** | Los cuatro se despliegan minificados u ofuscados (Vite, R8, dSYM ausente). Better Stack documenta que **aún no acepta subida de símbolos**, así que ahí sus traces llegarían como `a.b.c(SourceFile:1)`. Sentry los sube automáticamente desde el build |

Consecuencias buenas de que el corte quede así: el volumen alto (backend) se queda en el proveedor barato; el rollback es **el mismo gesto en los cuatro clientes** (deshabilitar la client key); y el SDK es Sentry en los cinco casos, así que consolidar en un solo proveedor el día que Better Stack acepte símbolos es cambiar DSNs, no reescribir.

Lo que se pierde, dicho claro: errores de front y logs de server viven en consolas distintas. Pesa poco, porque el dashboard no produce logs de servidor: la correlación que importa es error de dashboard → log del server por `correlationId`, y esa es una búsqueda por identificador compartido que funciona igual cruzando consolas.

**Reglas de plataforma que este cambio NO dispara**, verificadas para que nadie las marque en revisión:
- **Tier gating:** infraestructura interna, no expone capacidad al cliente. No entra al catálogo FREE/PRO/PREMIUM/ENTERPRISE.
- **ActivityLog:** no hay mutación de dominio. No aplica.
- **MCP de cliente:** no agrega capacidad de producto; el MCP de Better Stack ya expone `errors` y `releases`. No se crea tool nueva.
- **Presentación de ventas:** sin impacto visible al cliente. Exenta.
- **Android + iOS se tocan juntos:** se cumple, ambos están en el alcance con paridad obligatoria de tags y puntos de captura.

---

## Prerequisitos (antes de la primera línea de código)

Provisiona el founder; sin esto nada de lo demás se puede verificar.

| # | Qué | Dónde | Nombre | Dónde vive el DSN |
|---|---|---|---|---|
| P1 | App de Better Stack Errors | Errors → Applications | `avoqado-server` | `SENTRY_DSN` en Render (prod y staging) y en `.env` local |
| P2 | Proyecto de Sentry (platform: React) | sentry.io | `avoqado-dashboard` | `VITE_SENTRY_DSN` en el build |
| P3 | Proyecto de Sentry (Android) | sentry.io | `avoqado-tpv` | `sentry.properties`; el auth token en `local.properties`, **no commiteado** |
| P4 | Proyecto de Sentry (Android) | sentry.io | `avoqado-android` | igual que P3 |
| P5 | Proyecto de Sentry (Apple) | sentry.io | `avoqado-ios` | `sentry.properties` para `sentry-cli` en la fase de build |
| P6 | Auth token de Sentry | sentry.io → Auth Tokens, scope `project:releases` | — | Secreto de CI y `~/.sentryclirc` local. **Nunca en el repo** |

Notas:
- **Un proyecto de Sentry por app**, no uno compartido: la agrupación por huella no debe mezclar stacks de navegador con stacks de Kotlin ni de Swift, y las cuotas y alertas se leen por app.
- **El repo `avoqado-server` es público** (verificado 2026-08-08). Ningún DSN, token ni `sentry.properties` con credenciales entra al control de versiones en **ningún** repo de este cambio. El DSN de un frontend es inevitablemente visible en el bundle publicado y eso es normal y esperado por diseño de Sentry; el **auth token** de subida de símbolos no lo es y nunca debe salir de CI.

---

## Proposed Change

### Parte A — Servidor: hilo de contexto con AsyncLocalStorage

Archivo nuevo `src/observability/executionContext.ts`:

```typescript
import { AsyncLocalStorage } from 'node:async_hooks'

export type ContextSource = 'http' | 'job' | 'rabbit' | 'socket'

export interface ExecutionContext {
  correlationId: string
  source: ContextSource
  entrypoint: string        // 'POST /api/v1/tpv/orders' | 'money-integrity-watchdog' | 'socket:join-venue'
  venueId?: string
  userId?: string
  role?: string
  terminalSerial?: string
}

const storage = new AsyncLocalStorage<ExecutionContext>()

export function runWithContext<T>(ctx: ExecutionContext, fn: () => T): T {
  return storage.run(ctx, fn)
}

export function getContext(): ExecutionContext | undefined {
  return storage.getStore()
}

/** Enriquece el contexto YA activo. Muta el objeto del store a propósito:
 *  la autenticación corre DESPUÉS del requestLogger y necesita añadir el tenant. */
export function enrichContext(patch: Partial<ExecutionContext>): void {
  const store = storage.getStore()
  if (store) Object.assign(store, patch)
}
```

**Los cinco puntos de arranque:**

| # | Contexto | Archivo | Cambio |
|---|---|---|---|
| A1 | HTTP | `src/middlewares/requestLogger.ts:89` | Envolver `next()`: `runWithContext({ correlationId, source: 'http', entrypoint: \`${method} ${url}\` }, () => next())` |
| A2 | Auth | `src/middlewares/authenticateToken.middleware.ts` | Tras construir `authContext`, llamar `enrichContext({ venueId, userId, role, terminalSerial })` |
| A3 | Jobs | `src/observability/jobContext.ts` (nuevo) + los 41 `src/jobs/*.job.ts` | Helper `runInJobContext(name, fn)` que genera un `correlationId` nuevo por tick; envolver el callback de cada tick |
| A4 | RabbitMQ | `src/communication/rabbitmq/{consumer,commandListener,gcal-pull-consumer,gcal-push-consumer,publisher,commandRetryService}.ts` | Ver contrato de header abajo |
| A5 | Sockets | `src/communication/sockets/managers/socketManager.ts` | Envolver los 20 `socket.on(...)` con un wrapper común; `entrypoint = \`socket:${eventName}\`` |

**Contrato del wrapper (aplica a A3 y A5), obligatorio.** El wrapper es transparente o no sirve:

```typescript
// Preserva argumentos, valor de retorno y asincronía. NO atrapa errores.
function wrap<A extends unknown[], R>(ctx: ExecutionContext, fn: (...a: A) => R) {
  return (...args: A): R => runWithContext(ctx, () => fn(...args))
}
```

- **Nunca hace `try/catch`.** Un wrapper que se traga un error convierte este cambio en la causa del próximo bug invisible. Los errores se propagan tal cual al manejador de siempre.
- `AsyncLocalStorage.run` devuelve lo que devuelva el callback, así que una función `async` sigue siendo `async` y su promesa se propaga. El contexto sobrevive los `await` internos: eso es justo lo que ALS garantiza.
- Firma idéntica a la original. Si un handler recibe `(payload, ack)`, el envuelto recibe `(payload, ack)`.

**Contrato del header de RabbitMQ (A4).** Nombre exacto: **`x-correlation-id`**, dentro de `properties.headers` del mensaje AMQP, valor **string** UUID v4.
- `publisher.ts` lo estampa leyendo `getContext()?.correlationId`; si no hay contexto activo, genera uno nuevo.
- Cada consumidor lo lee y arranca su contexto con él.
- **Validación defensiva:** los headers de AMQP pueden llegar como `Buffer`, número u objeto según quién publique. El consumidor normaliza: si el valor no es un string que valide como UUID v4 tras `String(v).trim()`, lo descarta y genera uno nuevo. Nunca lanza por un header mal formado.
- **Compatibilidad hacia atrás obligatoria:** los mensajes ya encolados al momento del deploy no traen el header. Un consumidor que falle o rechace por header ausente rompe la cola. La ausencia es un caso normal, no una excepción.
- **Reintentos y republicación:** `commandRetryService.ts` republica mensajes. Debe **conservar el `x-correlation-id` original**, no generar uno nuevo, para que los 3 intentos de un mismo comando queden bajo el mismo hilo. Este es el punto donde se pierde la traza si se olvida.

**Inyección automática en los logs** — `src/config/logger.ts:13`: agregar un `winston.format` que lea `getContext()` y mezcle `correlationId`, `venueId`, `userId`, `source` y `entrypoint` en **todo** registro. Cero cambios en los sitios de llamada: los 622 pases manuales siguen funcionando y cada `logger.*` restante gana contexto gratis.

**Error handler** — `src/app.ts:346`: añadir `venueId`, `userId`, `role` (desde `authContext`, que ya está en `req`) al metadata de los tres caminos de log.

### Parte B — Servidor: error tracking

- `@sentry/node` ≥8. Archivo `src/observability/sentry.ts` que llama `Sentry.init(...)` **en el cuerpo del módulo**, no exportando una función que alguien tenga que acordarse de invocar.
- **Orden de inicialización, punto delicado.** Sentry debe inicializarse antes que cualquier módulo instrumentado (Express, Prisma, http). El proyecto compila TypeScript a CommonJS y arranca con `node dist/src/server.js`, donde los `require` se ejecutan **en orden de aparición**, así que basta poner `import './observability/sentry'` como **primera línea** de `src/server.ts`, antes del import de `./app`. Dos condiciones que hay que respetar o el efecto se pierde en silencio: el import no puede tener llaves (un import con efecto de lado, no de valor, para que el linter no lo reordene ni lo borre por no usarse), y **si algún día el build migra a ESM nativo** el hoisting cambia y habría que pasar a `--import ./dist/src/observability/sentry.js` en el arranque. Dejarlo anotado en el archivo.
- `SENTRY_DSN: z.string().url().optional()` en `src/config/env.ts`. Si falta, el SDK queda inerte (dev y tests no cambian de comportamiento).
- `release: process.env.RENDER_GIT_COMMIT`, `environment: NODE_ENV`.
- **Activar source maps del backend**: `"sourceMap": true` en `tsconfig.json` y `node --enable-source-maps` en el script `start` de `package.json`. Node resuelve el trace en proceso; no depende del proveedor.
- **Qué se captura, sin ambigüedad.** El repo ya tiene la distinción: `AppError.isOperational`. La regla, aplicada en el único lugar donde se decide (`src/app.ts:346`):

  | Caso | ¿Se captura? |
  |---|---|
  | No es `instanceof AppError` | **Sí.** Es un fallo del backend que nadie previó |
  | `AppError` con `statusCode >= 500` | **Sí** |
  | `AppError` operacional con `statusCode` 4xx | **No.** Es error del cliente y ahogaría la consola |
  | Error de parseo de JSON del body | **No.** Ya se maneja con 400 |
  | `uncaughtException` / `unhandledRejection` | **Sí**, en los handlers que ya son propiedad de `src/server.ts` |

- **Sin capturas duplicadas, y quién captura en cada camino.** El wrapper de contexto (A3/A5) **nunca** captura ni atrapa: solo abre contexto. La captura vive en un lugar distinto por camino, y en uno solo:

  | Camino | Único punto de captura | Por qué ahí |
  |---|---|---|
  | HTTP | `src/app.ts:346` | Todo error de request llega ahí vía `express-async-errors`. Ningún controlador ni servicio agrega `captureException` |
  | Jobs | El `try/catch` alrededor del tick | Presente en los 6 jobs muestreados de 41 (money-integrity-watchdog, commission-aggregation, blumon-payment-audit, settlement-detection, batch-expiration, tpv-order-expiry); ya loguean, solo se les añade la captura. **La fase de plan verifica los 41 y añade el `catch` donde falte** — un job sin él ya está perdiendo su error hoy |
  | RabbitMQ | El `catch` del consumidor que decide `ack`/`nack` | Es donde se decide el destino del mensaje; capturar en otro lado duplicaría por cada reintento |
  | Socket.IO | Un `catch` en el wrapper de `socketManager.ts`, que **re-lanza tras capturar** | Socket.IO no tiene un manejador central de errores equivalente al de Express. Este es el único caso donde el wrapper toca el error, y aun así lo re-lanza: captura y propaga, nunca traga |

  La distinción importa: **abrir contexto y capturar errores son dos responsabilidades separadas.** Mezclarlas es lo que produce wrappers que se tragan errores.
- **Puente ALS → Sentry:** en `beforeSend`, leer `getContext()` y poner `tags: { venueId, correlationId, source, entrypoint }` más `user: { id: userId }`.

**Scrubbing (D3), allowlist estricta.** Ilustrativo; `pick` es un helper local a `sentry.ts` (`(obj, keys) => Object.fromEntries(keys.filter(k => k in obj).map(k => [k, obj[k]]))`) y `ctx` es `getContext()` leído dentro del callback:

```typescript
sendDefaultPii: false,
beforeSend(event) {
  const ctx = getContext()
  // Nada de cuerpos, cookies ni query strings
  if (event.request) {
    delete event.request.data
    delete event.request.cookies
    delete event.request.query_string
    event.request.headers = pick(event.request.headers ?? {}, [
      'user-agent', 'x-app-version-code', 'x-correlation-id',
    ])
  }
  event.user = ctx?.userId ? { id: ctx.userId } : undefined  // sin email, sin IP
  event.extra = pick(event.extra ?? {}, ALLOWED_EXTRA_KEYS)
  return event
},
beforeBreadcrumb(crumb) {
  if (crumb.category === 'http') delete crumb.data?.body
  return crumb
},
```

`ALLOWED_EXTRA_KEYS` arranca en: `venueId`, `userId`, `role`, `correlationId`, `source`, `entrypoint`, `terminalSerial`, `orderId`, `paymentId`, `jobName`. Se amplía campo por campo cuando un bug real lo exija, nunca de forma preventiva.

**La allowlist estructural no basta: hay superficies donde el dato sensible viaja embebido en texto libre.** Un segundo pase recursivo, aplicado sobre el evento completo ya armado, justo antes de retornarlo:

| Superficie | Riesgo concreto | Tratamiento |
|---|---|---|
| URLs (en `request.url`, breadcrumbs y frames) | `?email=...`, `?rfc=...`, un id en la ruta | Se elimina todo el query string; los segmentos de ruta que parezcan id (cuid, uuid, numérico largo) se sustituyen por `:id` — eso además **mejora la agrupación**, porque hoy cada id genera su propia huella |
| Mensaje de la excepción (`exception.values[].value`) | Prisma y Zod incrustan valores del registro en el texto del error | Pase de expresiones regulares sobre el string |
| Breadcrumbs de log y de `console` | Alguien logueó un objeto entero | Mismo pase de regex sobre el mensaje y sobre `data` |
| `extra` y `contexts` anidados | Un objeto permitido que trae dentro un campo sensible | El recorrido es **recursivo con tope de profundidad 5**; una clave permitida no vuelve confiable a sus descendientes |

Patrones del pase de regex, redactados a `[REDACTED:<tipo>]`: RFC mexicano, CLABE de 18 dígitos, tarjeta (Luhn de 13 a 19 dígitos), email, teléfono E.164 o de 10 dígitos, y token portador o valor tipo JWT. La lista de patrones se **replica dentro del repo** en `src/observability/redactPatterns.ts`. No se importa del escáner de redacción del workspace (`~/.claude/skills/gstack/lib/redact-patterns.ts`): esa herramienta es del entorno del desarrollador, no una dependencia del runtime de producción. Se copia la lista y se cita el origen en un comentario, para que quien la actualice sepa contra qué comparar.

El test del criterio 6 siembra cada tipo en **cada una de las cuatro superficies** de la tabla, no solo en el cuerpo del request.

### Parte C — Dashboard web (Sentry, por D6)

- `@sentry/react` + **`@sentry/vite-plugin`**. El plugin sube los source maps en cada build y luego los borra del artefacto publicado, así que el bundle sigue minificado de cara al usuario y los traces llegan simbolicados a `.tsx`. Requiere `build.sourcemap: 'hidden'` en `dashboard/vite.config.ts:40` (genera los mapas sin dejar el comentario `sourceMappingURL` en el bundle) y el auth token de P6 en CI.
- `release`: el mismo identificador que use el plugin al subir (el hash del build), y `environment` desde el modo de Vite.
- Reemplazar el comentario `// Example: Sentry.captureException(...)` de `dashboard/src/components/ErrorBoundary.tsx:61` por la captura real, **conservando** el filtro existente de `failed to fetch dynamically imported module` (`:41`) — eso es un chunk viejo tras deploy, no un bug.
- **Dos interceptores en `dashboard/src/api.ts`, y uno de ellos no existe todavía.** Verificado: el archivo tiene **únicamente** `interceptors.response` (`:71`). Para que el hilo cruzado de la Parte E funcione hay que **agregar un `interceptors.request`** que genere un UUID v4 por llamada, lo mande en el header `X-Correlation-ID` y lo deje en `config.metadata` para que el de respuesta lo recupere. Sin ese interceptor de request el cliente no origina el id y solo puede leer el que devuelva el server, lo cual falla justo cuando más importa: cuando el request no llegó.

  Con eso en su lugar, dos mecanismos distintos porque son dos situaciones distintas:

  1. **Error del propio request** (el `catch` del interceptor): se captura ahí mismo con el `correlationId` de **ese** request como tag. Exacto y sin ambigüedad.
  2. **Error de render que ocurre después** (lo que ve el `ErrorBoundary`): no puede "heredar" el id de un request anterior, porque no hay forma honesta de saber cuál de los requests en vuelo lo causó. En vez de inventar esa atribución, **cada respuesta —exitosa o fallida— deja un breadcrumb** con `método`, `ruta`, `status`, `duración` y su `correlationId`. Cuando el `ErrorBoundary` captura, el evento lleva los últimos ~20 breadcrumbs, así que el que investiga ve la secuencia real de llamadas que precedió al crash y salta al log del server desde cualquiera de ellas.

  **Nunca se escribe el `correlationId` en un scope compartido.** Con requests concurrentes el último ganaría y atribuiría el error al request equivocado, que es peor que no atribuirlo.
- Identidad de tenant: `setUser({ id: staffId })` y `setTag('venueId', ...)` al iniciar sesión y **al cambiar de venue**. Limpieza explícita (`setUser(null)`, borrar tags) en logout y en cambio de venue, antes de escribir los nuevos valores.
- **PostHog se queda como está.** No se activa session replay ahí. Dos grabadores de sesión sobre el mismo DOM es desperdicio y riesgo de PII duplicado.

### Parte D — Las tres apps móviles (Sentry SaaS)

**Contrato común obligatorio a las tres**, para que la consola sea comparable entre plataformas:

Tags: `venueId`, `staffId`, `appVersionCode` (el mismo que ya viaja en `X-App-Version-Code`), `correlationId` (del request que falló), y `terminalSerial` solo en tpv y android.

Puntos de captura, idénticos en las tres:
1. Crash / excepción no atrapada.
2. Fallo de request a la API con status ≥500 o error de red **que no sea encolado offline** (un intent encolado es estado normal, no error — regla de `offline-first-y-hub-lan.md`).
3. Rechazo permanente de un intent offline (`REJECTED` → cuarentena). `RETRY` **no** se captura: es transitorio por diseño.
4. Fallo de pago con código de error del SDK del proveedor, como dato estructurado.
5. Fallo de impresión tras agotar reintentos.

Breadcrumbs: navegación de pantalla, request a la API (método, ruta, status, duración; **sin cuerpo**), y transición de estado de conexión.

**Anclas conocidas hoy** (de las reglas de repo, verificadas en documentación interna, no en el código de cada app):

| Punto | tpv | android / ios |
|---|---|---|
| Fallo de pago | `AngelPayPaymentViewModel.handleRecordFailure` y el `PaymentViewModel` de Blumon | n/a (no procesan tarjeta) |
| Intent offline rechazado | reducer de sync, estado `REJECTED` | mismo contrato de `SyncIntentType` |
| Impresión agotada | motor de impresión ESC/POS | mismo |

**La enumeración exhaustiva de archivos y símbolos por app es trabajo de la fase de plan**, un plan por repo, porque exige leer tres bases de código que este spec no abrió. El spec fija el **contrato** (qué cinco cosas se capturan, con qué tags y qué breadcrumbs); el plan fija los `archivo:línea`. Un plan de móvil que no liste los cinco puntos con su ancla concreta está incompleto y no debe ejecutarse.

**Regla que no se puede violar al instrumentar móvil:** un fallo de red que se convierte en intent encolado **no es un error** y no se reporta. Reportarlo llenaría la consola de ruido y, peor, empujaría a alguien a "arreglar" el comportamiento offline que está bien. Solo el rechazo permanente (`REJECTED`) se captura; `RETRY` no.

- **tpv:** `io.sentry:sentry-android` + plugin de Gradle de Sentry (sube el mapping de R8 automáticamente en cada build de release). **Convive con Crashlytics**: Crashlytics conserva crashes nativos y ANR; Sentry aporta los errores manejados, que hoy se tragan en silencio. No se quita Crashlytics en este cambio.
- **android:** mismo SDK y plugin. Aquí Sentry es el único reporte, porque hoy no hay ninguno.
- **ios:** `sentry-cocoa` por SPM (ya usan SPM para firebase-ios-sdk y GRDB) + fase de build con `sentry-cli` para subir dSYM.
- **Paridad android ↔ iOS:** el conjunto de tags, los cinco puntos de captura y los breadcrumbs deben ser equivalentes en ambas. Si algo no se puede portar en el momento, va explícito en el reporte, nunca en silencio.

### Parte E — El hilo que cruza los repos

El server ya honra un `X-Correlation-ID` entrante. Los **cuatro clientes** (dashboard, tpv, android, ios) generan un UUID por request, lo mandan en ese header y lo etiquetan en su propio evento. Resultado: un error de TPV y el 500 del backend que lo produjo comparten un identificador, y se salta de una consola a la otra buscando el mismo valor. Es la pieza de mayor retorno de todo el cambio y cuesta casi nada porque el lado del servidor ya está hecho.

---

## Acceptance Criteria

1. Un `logger.error` disparado desde cualquier servicio, tres capas por debajo de un controlador, emite `correlationId`, `venueId` y `userId` **sin que el sitio de llamada los pase**.
2. Lo mismo aplica dentro de un tick de cron job, un consumidor de RabbitMQ y un handler de Socket.IO, cada uno con su `source` correcto (`job` / `rabbit` / `socket`).
3. Dos requests HTTP concurrentes de venues distintos nunca se cruzan el contexto. Verificable: test que dispara 50 requests en paralelo con 2 tokens de venues distintos y afirma que cada línea de log lleva el `venueId` de su propio token, 0 cruces.
4. Un error 500 en producción aparece en la app `avoqado-server` de Better Stack agrupado, con `release` igual a `RENDER_GIT_COMMIT` y tags `venueId`, `correlationId`, `source`, `entrypoint`.
5. Un `AppError` operacional 4xx **no** genera evento.
6. Ningún evento enviado contiene cuerpo de request, cookies, query string, RFC, CLABE, tarjeta, email, teléfono, JWT ni header `Authorization`. Verificado por un test unitario que siembra cada tipo en las **cuatro** superficies (URL, mensaje de excepción, breadcrumb, `extra` anidado a profundidad 3) y comprueba que `beforeSend` los redacta en todas.
7. Un stack trace del backend apunta a `src/**/*.ts` con la línea correcta, no a `dist/**/*.js`. Verificable: lanzar un error desde una línea conocida de un archivo sembrado y afirmar que el frame superior reporta esa ruta `.ts` y ese número de línea exacto.
8. Un error lanzado en el dashboard aparece en **Sentry**, simbolicado a `.tsx`. Si el error nace del propio request (interceptor de axios), lleva el `correlationId` de ese request como tag. Si nace del render (`ErrorBoundary`), lleva en sus breadcrumbs las últimas llamadas a la API con su `correlationId` cada una. En ambos casos, tomar uno de esos valores y buscarlo en el source `1720702` de Better Stack devuelve el log del server correspondiente.
9. Un crash de **release** de android y uno de ios aparecen en Sentry con nombres reales de clase, método y línea, no `a.b.c(SourceFile:1)` ni direcciones hexadecimales. Verificable con un crash sembrado en un build de release firmado.
10. **Reparto tpv sin solapamiento.** No hay deduplicación entre las dos herramientas ni la va a haber: se separan **por punto de llamada**, que es un contrato verificable por lectura de código.
    - Los 76 `recordException` existentes de Crashlytics **se quedan como están y no se les agrega Sentry.**
    - Los cinco puntos de captura nuevos de la Parte D llaman **solo** a Sentry.
    - Los crashes no atrapados y los ANR siguen siendo de Crashlytics; el SDK de Sentry en tpv se inicializa con la captura automática de crashes **desactivada** (`enableUncaughtExceptionHandler = false`), que es lo que hace imposible el evento duplicado.

    Verificable de dos formas: una guardia estática que falla si un mismo bloque `catch` contiene ambas llamadas, y una prueba manual disparando un error sembrado de cada clase y contando en ambas consolas a los 5 minutos (esperado: manejado → 1 Sentry / 0 Crashlytics; crash → 0 Sentry / 1 Crashlytics).
11. Con `SENTRY_DSN` ausente, el server arranca normal, `npm test` pasa y no se emite ningún evento.
12. Sin regresión de latencia. Método: `autocannon` contra `GET /api/v1/dashboard/venues` en staging, 30 s a 50 conexiones, tres corridas antes y tres después, comparando la mediana de los p95. Umbral: **+5 ms absolutos o +3%, lo que sea mayor**. Se documentan ambos números en el PR.
13. Sin regresiones funcionales: `npm run pre-deploy` pasa en `server`; `npm run build` pasa en `dashboard`; `./gradlew assembleRelease` pasa en tpv y android; el build de release pasa en ios.

---

## Testing Plan

| Capa | Qué | Cantidad |
|---|---|---|
| Unit | `executionContext`: aislamiento entre contextos concurrentes, `enrichContext` sobre store activo, `getContext()` fuera de contexto devuelve `undefined` | +6 |
| Unit | `beforeSend`: elimina los 8 tipos de dato sensible; conserva la allowlist; 4xx operacional no captura | +5 |
| Unit | Formato de Winston: inyecta contexto cuando existe, no rompe cuando no | +3 |
| Unit | Consumidor de Rabbit sin header `x-correlation-id` procesa normal y genera uno nuevo | +2 |
| Unit | **Guardia estática**: todo archivo en `src/jobs/*.job.ts` envuelve su tick en `runInJobContext`. Esto hace exhaustiva la cobertura de los 41 jobs por construcción y bloquea al job 42. Mismo patrón que la guardia de paginación ya existente en el repo | +1 |
| Integración | Request real end-to-end: el `venueId` del log de un servicio coincide con el del token | +2 |
| Integración | 50 requests concurrentes de 2 venues, cero cruce de contexto (criterio 3) | +1 |
| Manual | Error sembrado en cada uno de los 5 repos, verificado en la consola correspondiente | 5 |

---

## Rollback Plan

**Server:** borrar `SENTRY_DSN` del entorno de Render y reiniciar. Apaga el envío sin desplegar código.

**Los 4 clientes (dashboard, tpv, android, ios):** el mismo gesto, y es la ventaja de que D6 dejara el corte parejo. `VITE_SENTRY_DSN` **no sirve** como interruptor en el dashboard porque Vite hornea las variables al compilar, y en móvil un cambio de código tarda días en llegar. El interruptor real es del lado del servidor: **deshabilitar la client key (DSN) del proyecto** en Sentry → Settings → Client Keys. La key deja de aceptar ingesta de inmediato, sin redesplegar el dashboard ni esperar un release de APK o de App Store, y se revierte con un clic. Un rate limit al 0% **no** sirve (los límites se configuran por ventana de tiempo, no admiten cero, y el SDK sigue intentando). El plan debe **probar el apagado en staging antes de declarar listo el rollback**: deshabilitar la key, disparar un error sembrado y confirmar que no llega nada.

**ALS e inyección en Winston:** no tienen interruptor porque no tienen efecto externo, solo enriquecen logs. Revertirlos es un revert limpio de `src/observability/` más los cinco puntos de arranque.

Riesgo real a vigilar: `AsyncLocalStorage` tiene un costo pequeño pero medible en Node. Lo cubre el criterio 12; si se pasa del umbral, se acota a los caminos que importan en vez de revertir todo.

---

## Effort Estimate

| Parte | Trabajo | Humano | CC |
|---|---|---|---|
| A | ALS + 5 puntos de arranque + formato de Winston | ~1.5 días | ~2 h |
| A3 | Envolver los 41 jobs (mecánico) + guardia estática | ~0.5 día | ~40 min |
| B | Sentry en server + scrubbing + source maps | ~1 día | ~1.5 h |
| C | Dashboard: SDK, plugin de Vite, interceptor | ~0.75 día | ~1 h |
| D | Tres apps móviles + simbolicación | ~2 días | ~3 h |
| E | Header cruzado en los 4 clientes | ~0.5 día | ~45 min |
| | Tests | ~1 día | ~1.5 h |

---

## Files Reference

| Archivo | Cambio |
|---|---|
| `src/observability/executionContext.ts` | **Nuevo.** ALS y API de contexto |
| `src/observability/jobContext.ts` | **Nuevo.** `runInJobContext` |
| `src/observability/sentry.ts` | **Nuevo.** Init, `beforeSend`, allowlist |
| `src/observability/redactPatterns.ts` | **Nuevo.** Patrones de redacción (RFC, CLABE, tarjeta, email, teléfono, JWT) |
| `src/middlewares/requestLogger.ts:89` | Envolver `next()` |
| `src/middlewares/authenticateToken.middleware.ts` | `enrichContext` tras armar authContext |
| `src/config/logger.ts:13` | Formato que inyecta contexto |
| `src/config/env.ts` | `SENTRY_DSN` opcional |
| `src/app.ts:346` | `venueId`/`userId`/`role` en el metadata + captura |
| `src/server.ts` | Init de Sentry antes de `app`; captura en los handlers de proceso |
| `tsconfig.json`, `package.json` | `sourceMap: true` + `--enable-source-maps` en `start` |
| `src/jobs/*.job.ts` (41, exhaustivo por la guardia estática) | Envolver el tick |
| `src/communication/rabbitmq/{consumer,publisher,commandListener,gcal-pull-consumer,gcal-push-consumer}.ts` | Header `x-correlation-id`: estampar al publicar, leer y normalizar al consumir |
| `src/communication/rabbitmq/commandRetryService.ts` | **Conservar** el `x-correlation-id` original al republicar, no generar uno nuevo |
| `src/communication/sockets/managers/socketManager.ts` | Wrapper sobre los 20 `socket.on` |
| `dashboard/src/components/ErrorBoundary.tsx:61` | Captura real |
| `dashboard/src/api.ts` | **Agregar** `interceptors.request` (genera y envía `X-Correlation-ID`); extender el de respuesta (`:71`) con breadcrumb y captura |
| `dashboard/vite.config.ts:40` | `build.sourcemap: 'hidden'` + `@sentry/vite-plugin` |
| `tpv/app/build.gradle.kts:377` | SDK + plugin de Sentry en el bloque `release` |
| `android/app/build.gradle.kts:88` | SDK + plugin de Sentry en el bloque `release` |
| `ios/avoqado-ios.xcodeproj` | SPM sentry-cocoa + fase de build para dSYM |

---

## Seguimiento post-lanzamiento (no bloquea)

**S-1 — Volumen y costo de Sentry.** No bloquea el arranque; es una medición a los 7 días de tener datos reales. El tier gratis ronda los 5,000 eventos de error al mes **compartidos entre los cuatro proyectos** (dashboard, tpv, android, ios). Con D6 el dashboard entra a esa cuota, y probablemente sea el que más genere de los cuatro: es el único que corre en navegadores con extensiones, versiones y redes fuera de tu control. No está medido.

Procedimiento, no una intención vaga:
1. Arrancar con `sampleRate = 1.0` y `tracesSampleRate = 0` (cero transacciones: no estamos midiendo rendimiento y son el grueso de la cuota).
2. **A los 7 días naturales**, leer el consumo real en Sentry → Stats, sumando los cuatro proyectos, y proyectar a 30 días: `eventos_7d × 30 / 7`.
3. Regla de decisión sobre la proyección mensual:
   - **< 4,000** → no se toca nada.
   - **4,000 a 5,000** → activar `beforeSend` de deduplicación por huella en el cliente y volver a medir a los 7 días.
   - **> 5,000** → primero investigar: un volumen así casi siempre es **un** error ruidoso, no volumen legítimo. Silenciarlo en la consola y remedir. Solo si sigue arriba tras eso, bajar `sampleRate` a `5000 / proyección` redondeado hacia abajo a un decimal, o subir de plan.
4. Bajar `sampleRate` es la última opción a propósito: descartar eventos al azar sesga los conteos y hace mentir a la agrupación. Antes de perder fidelidad, se arregla el ruido.

Nota técnica: en Sentry `sampleRate` sí controla los eventos de error; `tracesSampleRate` controla las transacciones de rendimiento. Son opciones distintas.

---

## Out of Scope

- **Tracing distribuido completo con OpenTelemetry.** El `correlationId` cruzado da el 80% del beneficio; los spans con waterfall de tiempos son un cambio aparte.
- **Los otros 7 repos del ecosistema** (superadmin, consumer-app, booking-widget, checkout, landing, desktop, windows-service). Nota honesta: **checkout y booking-widget procesan dinero y también están ciegos**; merecen su propio spec pronto.
- **Quitar Crashlytics de tpv.** Conviven en este cambio; consolidar es una decisión posterior con datos.
- **Session replay.** Disponible en Better Stack, apagado por ahora: implica PII en pantallas con datos fiscales y necesita su propia decisión de enmascarado.
- **Alertas y escalamiento a on-call.** Primero se acumulan datos y se ve qué es ruido; configurar umbrales sin línea base produce fatiga de alertas.
- **Explicabilidad de cálculos** (guardar el porqué de una comisión o un descuento FIFO, no solo el resultado). Es el hueco de observabilidad de dominio que quedó identificado en la conversación que originó este spec, y merece el suyo.

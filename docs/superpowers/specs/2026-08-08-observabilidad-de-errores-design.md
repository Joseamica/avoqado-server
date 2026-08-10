# Observabilidad de errores: trazabilidad de punta a punta + error tracking agregado (5 repos)

**Fecha:** 2026-08-08 · **Estado:** spec corregido; los cuatro planes deben sincronizarse con esta versión antes de ejecutarse

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
| dashboard | **Ninguno.** `ErrorBoundary` hace `console.error`; existen dos clientes Axios (`api` y `publicApi`) | n/a | Vite minifica, `sourcemap` desactivado |
| tpv | Firebase Crashlytics mediante llamadas directas, `CrashReportingTree` y `ObservabilityManager` | `CrashlyticsContext` ya mantiene contexto de app, sesión y pago | R8 ofusca (`isMinifyEnabled = true`) |
| android | **Ninguno.** Ni Crashlytics ni Firebase | n/a | R8 ofusca (`isMinifyEnabled = true`) |
| ios | **Ninguno.** Firebase por SPM sin Crashlytics | n/a | Release sin dSYM |

Hechos concretos que condicionan el diseño:

1. **El `correlationId` no se propaga.** `src/middlewares/requestLogger.ts:15` lo genera y lo mete en `req`, pero no hay `AsyncLocalStorage`. Los 622 usos de `correlationId` en `src/` son pases manuales. Cualquier `logger.error` dentro de un servicio sale sin él.
2. **El error handler global pierde el tenant.** `src/app.ts:346` loguea `method`, `url` e `ip`, pero no `venueId`/`userId`, aunque `authContext` ya está en el request.
3. **El server ya acepta un `X-Correlation-ID` entrante** (`src/middlewares/requestLogger.ts:15`: `req.headers['x-correlation-id'] || uuidv4()`) y lo devuelve en la respuesta (`:17`). La traza cruzada cliente↔servidor es casi gratis: falta que los clientes lo generen y lo etiqueten.
4. **Cero aplicaciones de error tracking en Better Stack** (verificado por MCP: `applications` devuelve vacío), pese a que el producto está incluido y es compatible con el SDK de Sentry.
5. **`RENDER_GIT_COMMIT`** está disponible en runtime en Render sin trabajo extra → sirve como `release` sin tocar el pipeline.
6. **`src/config/env.ts` es Zod fail-fast**: la app no arranca si falta una variable requerida. El DSN debe entrar como `.optional()`.
7. **No hay envoltorio central de jobs.** Hay **43 registros de scheduler repartidos en 42 archivos** (verificado 2026-08-08: `grep -c 'new CronJob\|cron.schedule' src/jobs/*.ts`). No es 1:1 — `blumon-payment-audit.job.ts` registra **dos** ticks, así que una guardia por archivo lo daría por cubierto dejando uno sin envolver. La cobertura se verifica por registro de scheduler, no por mera presencia de un helper dentro del archivo.
8. **Los 20 handlers de Socket.IO están en un solo archivo**, `src/communication/sockets/managers/socketManager.ts`. Un único punto de intervención cubre el contexto de sockets por completo.
9. **El dashboard tiene dos instancias de Axios**, `api` y `publicApi`, pero solo `api` tiene interceptor de respuesta. Instrumentar una sola deja fuera los cinco flujos públicos de booking.
10. **RabbitMQ tiene tres consumidores y tres publishers efectivos.** Además de `consumer.ts`/`publisher.ts`, Google Calendar consume en `gcal-pull-consumer.ts` y `gcal-push-consumer.ts`, y publica directamente desde `gcal-push-consumer.ts` y `services/google-calendar/pull.service.ts`. No existe un bus central que los cubra por transitividad.
11. **Los handlers de Socket.IO ya contienen `try/catch` que consumen el error** y responden por callback. Un wrapper exterior no puede observar lo que esos bloques no relanzan; los catches terminales deben capturar explícitamente antes de responder.
12. **El TPV ya reporta los errores de `ObservabilityManager.logError` a Crashlytics.** Primero llama `Timber.e`, que en release entra a `CrashReportingTree.recordException`, y después vuelve a llamar `FirebaseCrashlytics.recordException` desde la propia fachada. Por tanto, añadir Sentry detrás de todos los `logError`/`logCritical` contradice el reparto sin solapamiento y puede triplicar un evento manejado.
13. **Los clientes nativos tienen transportes HTTP fuera del cliente principal.** Android crea un `OkHttpClient` separado para refresh de token; iOS usa `URLSession` directamente en repositorios y servicios además de `APIClient`. “Cada request” exige cubrir esos transportes o declarar explícitamente una allowlist de excepciones.

---

## Decisiones cerradas (no re-litigar)

| # | Decisión | Elegido |
|---|---|---|
| D1 | SDK | **El SDK de Sentry en los 5 repos.** Better Stack ingiere el mismo protocolo, así que el proveedor es un DSN, no una reescritura |
| D2 | Alcance | Los **5** repos |
| D3 | Datos sensibles | **Allowlist estricta**: nunca cuerpos de request ni headers crudos |
| D4 | Contextos con trazabilidad | HTTP + cron jobs + RabbitMQ + Socket.IO |
| D5 | Simbolicación | **Híbrido** por necesidad de mapeo (ver abajo) |
| D6 | Dónde cae el dashboard | **Sentry**, junto a los clientes |
| D7 | Dueño de cada captura | **Un solo punto de llamada por error.** Abrir contexto, registrar logs y enviar un evento son responsabilidades distintas |
| D8 | Cobertura HTTP cliente | **Todo request a la API de Avoqado**, sin importar qué instancia de Axios, OkHttp o URLSession lo origine; health checks externos quedan fuera mediante allowlist explícita |
| D9 | Contrato de privacidad | **Mismo corpus dorado en los 5 repos.** Ciclos o profundidad agotada se reemplazan por marcador seguro; nunca se devuelve el subtree original |

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
| P3 | Proyecto de Sentry (Android) | sentry.io | `avoqado-tpv` | DSN vía `BuildConfig` desde variable de entorno o lectura explícita de configuración local ignorada; nunca asumir que `providers.gradleProperty` lee `local.properties` |
| P4 | Proyecto de Sentry (Android) | sentry.io | `avoqado-android` | Igual que P3 |
| P5 | Proyecto de Sentry (Apple) | sentry.io | `avoqado-ios` | DSN mediante build setting → `Info.plist`; auth token solo en CI/entorno de build |
| P6 | Auth token de Sentry | sentry.io → Auth Tokens, scope mínimo para releases | — | `SENTRY_AUTH_TOKEN` en CI o configuración local ignorada soportada por `sentry-cli`. **Nunca en el repo** |
| P7 | Matriz de versiones | Los cinco repos | — | Versiones exactas y compatibles de SDK/plugin/CLI, fijadas antes de generar lockfiles; no rangos abiertos como `≥8` |
| P8 | Corpus dorado de privacidad | Fixture JSON sin datos reales | `observability-redaction-cases.json` | Misma lista de entradas y resultados esperados copiada o generada en los cinco repos y consumida por tests |
| P9 | Presupuesto de ingesta | Sentry billing/usage | `Q` | Cuota mensual vigente y responsable de revisar consumo a 7 días; no se hardcodean precios o límites comerciales en el spec |

Notas:
- **Un proyecto de Sentry por app**, no uno compartido: la agrupación por huella no debe mezclar stacks de navegador con stacks de Kotlin ni de Swift, y las cuotas y alertas se leen por app.
- **El repo `avoqado-server` es público** (verificado 2026-08-08). Ningún DSN, token ni `sentry.properties` con credenciales entra al control de versiones en **ningún** repo de este cambio. El DSN de un frontend es inevitablemente visible en el bundle publicado y eso es normal y esperado por diseño de Sentry; el **auth token** de subida de símbolos no lo es y nunca debe salir de CI.
- **Task 0 es un gate, no documentación opcional.** La implementación puede compilar sin credenciales, pero no se declara verificable hasta demostrar ingesta, release y simbolicación en staging con P1–P9 satisfechos.

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

**Los cinco puntos de intervención:**

| # | Contexto | Archivo | Cambio |
|---|---|---|---|
| A1 | HTTP | `src/middlewares/requestLogger.ts` | Envolver el cuerpo completo del middleware, incluidos el registro de `res.on('finish')`/`res.on('close')` y `next()`, para que el log de cierre conserve contexto |
| A2 | Auth | `src/middlewares/authenticateToken.middleware.ts` | Tras construir `authContext`, llamar `enrichContext({ venueId, userId, role, terminalSerial })` |
| A3 | Jobs | `src/observability/jobContext.ts` (nuevo) + los 43 registros de scheduler en `src/jobs/` | Helper `runInJobContext(name, fn)` que genera un `correlationId` nuevo por tick; envolver cada callback registrado, no solo una vez por archivo |
| A4 | RabbitMQ | `src/communication/rabbitmq/{consumer,gcal-pull-consumer,gcal-push-consumer,publisher,commandListener}.ts` + `src/services/google-calendar/pull.service.ts` | Los tres consumidores abren contexto y las tres rutas de publicación estampan el header; ver contrato abajo |
| A5 | Sockets | `src/communication/sockets/managers/socketManager.ts` | Envolver los 20 `socket.on(...)` con un wrapper común que recibe también el socket; `entrypoint = \`socket:${eventName}\`` y tenant desde `socket.authContext` |

**Contrato del wrapper de contexto (aplica a A3 y A5), obligatorio.** El contexto se construye por invocación —no al registrar el callback— para que cada tick/evento tenga su propio UUID. El wrapper preserva argumentos, retorno y asincronía:

```typescript
function wrap<A extends unknown[], R>(makeContext: () => ExecutionContext, fn: (...a: A) => R) {
  return (...args: A): R => runWithContext(makeContext(), () => fn(...args))
}
```

- **El wrapper de contexto nunca traga ni transforma un error.** La captura se describe en Parte B. Un error no consumido debe seguir rechazando/lanzando exactamente como antes.
- `AsyncLocalStorage.run` devuelve lo que devuelva el callback, así que una función `async` sigue siendo `async` y su promesa se propaga. El contexto sobrevive los `await` internos: eso es justo lo que ALS garantiza.
- Firma idéntica a la original. Si un handler recibe `(payload, ack)`, el envuelto recibe `(payload, ack)`.
- En sockets, `makeContext` lee `socket.authContext` en cada evento y copia `venueId`, `userId`, `role` y `terminalSerial` cuando existan. El contexto no se limita a `source`/`entrypoint`.

**Contrato HTTP entrante.** `X-Correlation-ID` se honra solo si es un UUID v4 válido y mide como máximo 36 caracteres. Un valor ausente o malformado genera un UUID nuevo. Nunca se usa texto arbitrario del cliente como tag o campo de log de alta cardinalidad.

El `entrypoint` HTTP usa método más route template de Express cuando esté disponible, o path normalizado sin query ni segmentos identificadores; nunca `req.originalUrl` crudo. Rabbit aplica la misma regla a routing keys con ids variables.

**Contrato del header de RabbitMQ (A4).** Nombre exacto: **`x-correlation-id`**, dentro de `properties.headers` del mensaje AMQP, valor **string** UUID v4.
- `publisher.ts`, `gcal-push-consumer.ts` y `services/google-calendar/pull.service.ts` lo estampan leyendo `getContext()?.correlationId`; si no hay contexto activo, generan uno nuevo.
- `consumer.ts`, `gcal-pull-consumer.ts` y `gcal-push-consumer.ts` lo leen y arrancan su contexto con él.
- **Validación defensiva:** solo se aceptan `string` o `Buffer` que, tras trim, validen como UUID v4. Número, objeto, header excesivo o valor mal formado se descartan y producen un UUID nuevo. Nunca se lanza por un header.
- **Compatibilidad hacia atrás obligatoria:** los mensajes ya encolados al momento del deploy no traen el header. Un consumidor que falle o rechace por header ausente rompe la cola. La ausencia es un caso normal, no una excepción.
- **Reintentos de `PosCommand`:** `commandRetryService.ts` no publica en AMQP; cambia `FAILED → PENDING` y el `commandListener` vuelve a publicar después. Cada intento de transporte puede tener un `correlationId` nuevo; la operación estable entre intentos se busca por `commandId`/`PosCommand.id`. El plan no debe inventar preservación de un header que no está persistido.

**Inyección automática en los logs** — `src/config/logger.ts:13`: agregar un `winston.format` que lea `getContext()` y mezcle `correlationId`, `venueId`, `userId`, `role`, `terminalSerial`, `source` y `entrypoint` en **todo** registro. Cero cambios en los sitios de llamada: los pases manuales existentes siguen funcionando y cada `logger.*` restante gana contexto gratis.

**Error handler** — `src/app.ts:346`: añadir `venueId`, `userId`, `role` (desde `authContext`, que ya está en `req`) al metadata de los tres caminos de log.

### Parte B — Servidor: error tracking

- Versión exacta de `@sentry/node` fijada por P7. Archivo `src/observability/sentry.ts` que llama `Sentry.init(...)` **en el cuerpo del módulo**, no exportando una función que alguien tenga que acordarse de invocar.
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

  Si `res.headersSent` ya es `true`, el error se captura **antes** de delegar al error handler por defecto de Express; una respuesta parcialmente enviada no vuelve invisible la excepción.

- **Sin capturas duplicadas, y quién captura en cada camino.** El wrapper de contexto (A3/A5) **nunca** captura ni atrapa: solo abre contexto. En Socket.IO puede componerse con un adaptador separado de seguridad que captura throws/rejections no consumidos y los vuelve a propagar. La captura vive en un lugar terminal por error:

  | Camino | Único punto de captura | Por qué ahí |
  |---|---|---|
  | HTTP | `src/app.ts:346` | Todo error de request llega ahí vía `express-async-errors`. Ningún controlador ni servicio agrega `captureException` |
  | Jobs | El `catch` terminal de cada callback registrado | La fase de plan enumera los 43 registros de scheduler, no solo archivos. Si el job ya consume el error, captura ahí; si deja rechazar, un adaptador común captura y relanza |
  | RabbitMQ | El `catch` terminal de cada uno de los tres consumidores | Captura una vez antes de la decisión `ack`/`nack`; publishers solo propagan y no vuelven a capturar el mismo fallo |
  | Socket.IO | El `catch` que efectivamente consume cada error | Los handlers actuales suelen responder `{ success: false }` y no relanzan: esos catches capturan antes del callback. El adaptador de seguridad separado captura y relanza únicamente errores síncronos/promesas rechazadas que ningún catch interno consumió |

  La distinción importa: **abrir contexto y decidir dónde termina un error son dos responsabilidades separadas.** El adaptador de seguridad no reemplaza los catches terminales existentes ni convierte un error en éxito.
- **Puente ALS → Sentry:** en `beforeSend`, leer `getContext()` y poner `tags: { venueId, correlationId, source, entrypoint }` más `user: { id: userId }`.
- **Shutdown fatal:** `Sentry.flush(timeout)` se espera (`await`) antes de permitir que `gracefulShutdown` termine el proceso. Lanzar `void Sentry.flush(...)` no ofrece margen real y no cumple el contrato.

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
  event.extra = redactDeep(pick(event.extra ?? {}, ALLOWED_EXTRA_KEYS))
  event.contexts = redactDeep(pick(event.contexts ?? {}, ALLOWED_CONTEXT_KEYS))
  event.breadcrumbs = redactDeep(event.breadcrumbs ?? [])
  event.exception = redactDeep(event.exception)
  return redactEventText(event)
},
beforeBreadcrumb(crumb) {
  if (crumb.data) delete crumb.data.body
  return redactDeep(crumb)
},
```

`ALLOWED_EXTRA_KEYS` arranca en: `venueId`, `userId`, `role`, `correlationId`, `source`, `entrypoint`, `terminalSerial`, `orderId`, `paymentId`, `jobName`. Se amplía campo por campo cuando un bug real lo exija, nunca de forma preventiva.

`ALLOWED_CONTEXT_KEYS` contiene únicamente contextos técnicos revisados (`runtime`, `os`, `device`, `trace`) y cada uno vuelve a pasar por redacción recursiva. No se conserva `event.contexts` crudo por venir del SDK.

**La allowlist estructural no basta: hay superficies donde el dato sensible viaja embebido en texto libre.** Un segundo pase recursivo, aplicado sobre el evento completo ya armado, justo antes de retornarlo:

| Superficie | Riesgo concreto | Tratamiento |
|---|---|---|
| URLs (en `request.url`, breadcrumbs y frames) | `?email=...`, `?rfc=...`, un id en la ruta | Se elimina todo el query string; los segmentos de ruta que parezcan id (cuid, uuid, numérico largo) se sustituyen por `:id` — eso además **mejora la agrupación**, porque hoy cada id genera su propia huella |
| Mensaje de la excepción (`exception.values[].value`) | Prisma y Zod incrustan valores del registro en el texto del error | Pase de expresiones regulares sobre el string |
| Breadcrumbs de log y de `console` | Alguien logueó un objeto entero | Mismo pase de regex sobre el mensaje y sobre `data` |
| `extra` y `contexts` anidados | Un objeto permitido que trae dentro un campo sensible | Recorrido recursivo con tope de profundidad 5; una clave permitida no vuelve confiable a sus descendientes |

Patrones del pase de regex, redactados a `[REDACTED:<tipo>]`: RFC mexicano, CLABE de 18 dígitos, tarjeta (Luhn de 13 a 19 dígitos), email, teléfono E.164 o de 10 dígitos, y token portador o valor tipo JWT. La lista de patrones se **replica dentro del repo** en `src/observability/redactPatterns.ts`. No se importa del escáner de redacción del workspace (`~/.claude/skills/gstack/lib/redact-patterns.ts`): esa herramienta es del entorno del desarrollador, no una dependencia del runtime de producción. Se copia la lista y se cita el origen en un comentario, para que quien la actualice sepa contra qué comparar.

**Regla de terminación segura:** cuando el recorrido alcanza profundidad 5 devuelve `[TRUNCATED]`; cuando encuentra una referencia ya visitada devuelve `[CIRCULAR]`. Nunca devuelve el objeto o subtree original, porque eso reintroduciría exactamente el dato que la función no pudo inspeccionar y podría conservar un ciclo no serializable.

El test del criterio 6 consume P8 y siembra cada tipo en **URL, excepción, breadcrumb, `extra` y `contexts`**, además de probar profundidad 6 y referencia circular. El mismo corpus se ejecuta en dashboard, TPV, Android e iOS con las APIs equivalentes de cada SDK.

### Parte C — Dashboard web (Sentry, por D6)

- Versiones exactas de `@sentry/react` y **`@sentry/vite-plugin`** fijadas por P7. El plugin sube los source maps en cada build y luego los borra del artefacto publicado, así que el bundle sigue minificado de cara al usuario y los traces llegan simbolicados a `.tsx`. Requiere `build.sourcemap: 'hidden'` en `dashboard/vite.config.ts:40` y el auth token de P6 en CI.
- `release`: el mismo identificador que use el plugin al subir (el hash del build), y `environment` desde el modo de Vite.
- La verificación de build compara el release/debug ID del evento con el artefacto subido; “el plugin terminó sin error” no prueba simbolicación.
- Reemplazar el comentario `// Example: Sentry.captureException(...)` de `dashboard/src/components/ErrorBoundary.tsx:61` por la captura real, **conservando** el filtro existente de `failed to fetch dynamically imported module` (`:41`) — eso es un chunk viejo tras deploy, no un bug.
- **Instrumentar las dos instancias, `api` y `publicApi`.** Un helper común instala los interceptores en ambas para que booking público no quede fuera. El interceptor de request genera UUID v4, lo manda en `X-Correlation-ID`, guarda `correlationId` y `attemptStartedAt` en metadata y reutiliza el mismo id si Axios reintenta con el mismo config. Cada intento renueva solo `attemptStartedAt`, de modo que el breadcrumb tenga duración real sin romper la operación lógica.

  Con eso en su lugar, dos mecanismos distintos porque son dos situaciones distintas:

  1. **Error del propio request** (el `catch` del interceptor): se captura ahí mismo con el `correlationId` de **ese** request como tag cuando es 5xx. Los errores de conectividad del navegador se dejan como breadcrumb/estado de conexión y no como evento, salvo que una regla posterior demuestre que son accionables.
  2. **Error de render que ocurre después** (lo que ve el `ErrorBoundary`): no puede "heredar" el id de un request anterior, porque no hay forma honesta de saber cuál de los requests en vuelo lo causó. En vez de inventar esa atribución, **cada respuesta —exitosa o fallida— deja un breadcrumb** con `método`, `ruta`, `status`, `duración` y su `correlationId`. Cuando el `ErrorBoundary` captura, el evento lleva los últimos ~20 breadcrumbs, así que el que investiga ve la secuencia real de llamadas que precedió al crash y salta al log del server desde cualquiera de ellas.

  **Nunca se escribe el `correlationId` en un scope compartido.** Con requests concurrentes el último ganaría y atribuiría el error al request equivocado, que es peor que no atribuirlo.
- Identidad de tenant: `setUser({ id: staffId })` y `setTag('venueId', ...)` al iniciar sesión y **al cambiar de venue**. Limpieza explícita (`setUser(null)`, borrar tags) en logout y en cambio de venue, antes de escribir los nuevos valores.
- Borrar un tag significa usar la API de eliminación del scope (`removeTag` o equivalente de la versión fijada), no `setTag(key, undefined)` sin verificar el scope resultante. Los tests inspeccionan el scope real, no solo que un mock recibió una llamada.
- El `beforeSend` del dashboard implementa el mismo contrato D3/D9: elimina request/response bodies, cookies, query, headers fuera de allowlist y limpia URL, excepción, breadcrumbs, `extra` y `contexts` con P8. Un `AxiosError` puede llevar `config.data` y headers de autenticación; capturarlo crudo está prohibido.
- **PostHog se queda como está.** No se activa session replay ahí. Dos grabadores de sesión sobre el mismo DOM es desperdicio y riesgo de PII duplicado.

### Parte D — Las tres apps móviles (Sentry SaaS)

**Contrato común obligatorio**, para que los eventos sean comparables aunque el dueño del crash no sea el mismo en TPV:

- Tags de sesión: `venueId`, `staffId`, `appVersionCode`, `release` y `environment`.
- Tags por request: `correlationId`, `httpStatus` y ruta normalizada.
- Solo TPV/Android: `terminalId`, `terminalSerial` y `terminalSerialSource` (`activation`, `device-fallback` o `unknown`). El valor preferido es el persistido por activación/backend; un serial vivo o Android ID es fallback observable, no identidad silenciosamente autoritativa.
- Solo dimensiones de cardinalidad acotada van como tags (`processor`, `errorCode`, `intentType`, `printerRole`). Montos, mensajes del servidor, payloads e ids de cliente no se convierten masivamente a tags.

El contexto estático (`appVersionCode`, release, environment y terminal) se configura al iniciar. Sesión (`venueId`, `staffId`, user) se configura en login/cambio de venue y se elimina realmente en logout. Los tests leen el scope resultante para demostrar que no queda identidad del empleado o venue anterior; contar llamadas gemelas contra otro proveedor no demuestra limpieza.

**Privacidad móvil:** los tres SDK implementan `beforeSend`/callback equivalente con D3/D9 y P8. `sendDefaultPii = false` es defensa adicional, no sustituto de la allowlist. Está prohibido convertir un `metadata: Map` arbitrario completo en tags o extras sin filtrarlo campo por campo.

**Matriz de captura:**

| Punto | TPV | Android POS | iOS POS |
|---|---|---|---|
| Crash / excepción no atrapada | **Solo Crashlytics**; handlers automáticos de Sentry apagados | Sentry | Sentry |
| API 5xx | Sentry, con `correlationId` | Sentry, con `correlationId` | Sentry, con `correlationId` |
| Error de red | Solo si termina como fallo y **no** fue convertido en operación offline normal | Igual | Igual |
| Intent offline `REJECTED` | Sentry | Sentry | Sentry |
| Intent offline `RETRY` o encolado exitoso | **Nunca** | **Nunca** | **Nunca** |
| Fallo de pago | Sentry en el punto terminal del proveedor | n/a: no procesan tarjeta | n/a: no procesan tarjeta |
| Impresión | Sentry solo al agotarse reintentos o en el catch terminal que abandona la comanda | Igual | Igual |

**El interceptor móvil no decide por sí solo si un 5xx/error de red es evento.** Siempre genera correlación y breadcrumb, pero una mutación con fallback offline se captura únicamente en el nivel que conoce el resultado final (`queued = false` o fallo al encolar). Las lecturas y operaciones declaradas no-encolables pueden capturarse al terminar el request. Health checks y probes de conectividad nunca generan evento. Esto evita reportar primero un 500 y descubrir después que la operación quedó correctamente encolada.

Cuando no existe `Throwable` —por ejemplo un `REJECTED` de negocio— se usa una API explícita como `captureMessage` o una excepción sintética estable. No se pasa `null` a una función que solo captura dentro de `throwable?.let`.

Breadcrumbs obligatorios en las tres: navegación de pantalla; request a la API con método, ruta normalizada, status, duración y `correlationId` (**sin cuerpo ni query**); y transición de estado de conexión. El breadcrumb de red se emite también cuando `chain.proceed`/`URLSession` falla, con status ausente y clasificación de transporte segura.

**Cobertura de transporte:** “cada request” significa toda llamada a la API de Avoqado. En dashboard incluye `api` y `publicApi`; en TPV/Android incluye el cliente compartido y cualquier cliente separado de refresh; en iOS incluye `APIClient`, `AuthRepository.urlSession` y los `URLSession.shared` de repositorios. Un retry conserva el mismo `correlationId` de la operación lógica y registra un breadcrumb por intento.

**Anclas verificadas que los planes deben desarrollar, no volver a descubrir vagamente:**

| Punto | TPV | Android POS | iOS POS |
|---|---|---|---|
| Pago | `AngelPayPaymentViewModel.handleRecordFailure`; el plan enumera además el camino terminal real de Blumon si existe en la revisión actual | n/a | n/a |
| `REJECTED` | `features/tables/data/sync/SyncOutbox.kt`, al persistir `STATUS_REJECTED` | `core/data/sync/SyncOutbox.kt`, al resolver el ack como `STATUS_REJECTED` | `Services/SyncOutbox.swift`, al persistir el ack `REJECTED` |
| Impresión | `core/printer/PrinterManager.kt`, catches terminales de las funciones de impresión aplicables | `printing/data/ComandaPrinter.kt` y, cuando el retry vive abajo, `PrinterService.kt` | `Printing/Services/ComandaPrinter.swift` y, cuando el retry vive abajo, `PrinterService.swift` |

Antes de ejecutar un plan móvil, este enumera para cada repo: inicio, login, logout, cambio de venue, todos los transportes API, captura 5xx, `REJECTED`, pago aplicable, impresión terminal, navegación y conexión. “Buscar equivalente”, “leer primero” o apuntar a un mapper puro no satisface este gate.

**Reparto TPV sin solapamiento:**

- Sentry **no** se agrega detrás de `ObservabilityManager.logError` ni `logCritical`: esas rutas ya llegan a Crashlytics mediante `Timber.e`/`CrashReportingTree` y mediante la propia fachada.
- Los nuevos puntos de la matriz llaman directamente a un `SentrySink` aislado. En el mismo camino terminal no llaman `ObservabilityManager.logError`, `logCritical`, `Timber.e` ni `Crashlytics.recordException`, porque cualquiera de ellos volvería a entregar el evento a Crashlytics. Si hace falta rastro local, se usa breadcrumb o un nivel que `CrashReportingTree` no convierta en non-fatal.
- `logCritical` delega a `logError`; nunca se instrumentan ambos con la misma captura.
- Una guardia estática falla si el mismo bloque terminal combina Sentry con `recordException`, `ObservabilityManager.logError`, `logCritical` o `Timber.e`, o si la fachada adquiere una ruta global a Sentry.
- `SentrySink` desactiva uncaught exceptions y ANR en TPV. Crashlytics conserva esos dos caminos.

- **tpv:** versión exacta de `sentry-android` y plugin Gradle fijada por P7; Sentry solo para los puntos manejados nuevos de la matriz.
- **android:** mismo SDK/plugin, con Sentry como único proveedor de crashes y errores manejados.
- **ios:** versión exacta de `sentry-cocoa` por SPM y `sentry-cli` versionado en la fase de build para subir dSYM.
- **Paridad Android ↔ iOS:** tags, captura aplicable, breadcrumbs, privacidad y pruebas equivalentes. Una excepción de plataforma queda explícita en el plan y en el reporte.

### Parte E — El hilo que cruza los repos

El server honra un `X-Correlation-ID` entrante **válido**. Los cuatro clientes (dashboard, TPV, Android, iOS) generan un UUID v4 por operación HTTP, lo mandan en ese header y lo conservan durante retries internos de la misma operación. El server lo devuelve en la respuesta y lo inyecta en logs y eventos.

Un error del propio request lleva ese id como tag. Un crash posterior de UI no inventa causalidad: conserva los breadcrumbs de las llamadas precedentes, cada una con su id. Resultado: un error del cliente y el 500/log backend que lo produjo se encuentran cruzando consolas por el mismo valor.

Para trabajos internos con reintentos persistidos, `correlationId` identifica el intento de ejecución; el identificador estable de dominio (`commandId`, `jobName` más timestamp, `outboxId`) identifica la operación entre intentos. No se promete preservar un correlation ID que nunca fue persistido.

---

## Acceptance Criteria

1. Un `logger.error` disparado desde cualquier servicio, tres capas por debajo de un controlador, emite `correlationId`, `venueId` y `userId` **sin que el sitio de llamada los pase**.
2. Lo mismo aplica en los 43 callbacks registrados de jobs, los tres consumidores RabbitMQ y los 20 handlers de Socket.IO, cada uno con `source` correcto. En sockets también se heredan `venueId`, `userId`, `role` y terminal desde `socket.authContext` cuando existe.
3. Dos requests HTTP concurrentes de venues distintos nunca cruzan contexto. Un test de integración dispara 50 requests HTTP reales con dos tokens y captura los registros reales de Winston; cada línea lleva el `venueId` de su propio token y hay 0 cruces. Una simulación que llama `enrichContext` directamente no satisface este criterio.
4. Un error 500 en producción aparece en la app `avoqado-server` de Better Stack agrupado, con `release` igual a `RENDER_GIT_COMMIT` y tags `venueId`, `correlationId`, `source`, `entrypoint`.
5. Un `AppError` operacional 4xx **no** genera evento.
6. Ningún evento enviado por ninguno de los cinco repos contiene cuerpos, cookies, query string, RFC, CLABE, tarjeta, email, teléfono, JWT ni `Authorization`. P8 siembra cada tipo en URL, excepción, breadcrumb, `extra` y `contexts`, más profundidad 6 y ciclo; todas las implementaciones producen el resultado esperado y nunca conservan el subtree original.
7. Un stack trace del backend apunta a `src/**/*.ts` con la línea correcta, no a `dist/**/*.js`. Verificable: lanzar un error desde una línea conocida de un archivo sembrado y afirmar que el frame superior reporta esa ruta `.ts` y ese número de línea exacto.
8. `api` y `publicApi` del dashboard envían `X-Correlation-ID`. Cada intento deja breadcrumb con método, ruta, status, duración e id; un retry conserva el mismo id. Un error de request lleva el id como tag y un error de render lleva la secuencia de breadcrumbs. El evento está simbolicado a `.tsx` y su release/debug ID coincide con el artefacto subido.
9. Un error manejado sembrado en TPV y un crash sembrado en Android/iOS, todos en build **release firmado**, aparecen simbolicados con clase, método y línea reales. TPV no envía su crash/ANR sembrado a Sentry; Android/iOS sí.
10. **Reparto tpv sin solapamiento.** No hay deduplicación entre las dos herramientas ni la va a haber: se separan **por punto de llamada**, que es un contrato verificable por lectura de código.
    - Las rutas existentes de Crashlytics se quedan como están y no reciben Sentry mediante `ObservabilityManager`.
    - Los puntos de captura nuevos aplicables de la Parte D llaman directamente y **solo** a Sentry.
    - Los crashes no atrapados y los ANR siguen siendo de Crashlytics; el SDK de Sentry en tpv se inicializa con la captura automática de crashes **desactivada** (`enableUncaughtExceptionHandler = false`), que es lo que hace imposible el evento duplicado.

    Verificable con guardia estática y dos pruebas release: manejado nuevo → 1 Sentry / 0 Crashlytics; crash → 0 Sentry / 1 Crashlytics. También falla si `logError` o `logCritical` adquieren una llamada global a Sentry.
11. Con DSN ausente, cada aplicación inicia/compila normalmente y no emite eventos. En server, además, `npm test` pasa con `SENTRY_DSN` ausente.
12. Sin regresión de latencia. Método: `autocannon` contra `GET /api/v1/dashboard/venues` en staging, 30 s a 50 conexiones, tres corridas antes y tres después, comparando la mediana de los p95. Umbral: **+5 ms absolutos o +3%, lo que sea mayor**. Se documentan ambos números en el PR.
13. Sin regresiones funcionales: `npm run pre-deploy` pasa en `server`; `npm run build` pasa en `dashboard`; `./gradlew assembleRelease` pasa en tpv y android; el build de release pasa en ios.
14. Las tres rutas de publicación RabbitMQ estampan header y los tres consumidores lo heredan. Header ausente/malformado genera UUID nuevo sin detener la cola. `commandRetryService` no se documenta ni prueba como publisher.
15. Un handler Socket.IO que rechaza una promesa sin catch se captura una vez y conserva el rechazo. Un handler con catch interno que responde callback de error también se captura una vez. Ningún camino se transforma en éxito silencioso.
16. Todo request a la API de Avoqado desde los cuatro clientes lleva UUID v4. Incluye booking público, refresh de token y llamadas directas de URLSession. Los health checks externos excluidos aparecen en una allowlist probada.
17. TPV, Android e iOS dejan breadcrumbs equivalentes para navegación, API y conexión. Los eventos de red no contienen cuerpo/query y un fallo de transporte también deja breadcrumb.
18. `terminalId`/`terminalSerial` de TPV y Android provienen preferentemente de activación persistida; cuando se usa fallback el evento lleva `terminalSerialSource != activation`, de modo que la atribución dudosa es visible.
19. P1–P9, kill switch y simbolicación se prueban en staging antes del rollout. Producción avanza por canary: server, dashboard preview, un TPV sandbox, un Android y un iOS; después se amplía.

---

## Testing Plan

| Capa | Qué | Gate |
|---|---|---|
| Unit server | `executionContext`, enriquecimiento, retorno sync/async, contexto dentro de `finish`/`close`, validación UUID HTTP | Obligatorio |
| Unit server | Winston inyecta contexto; `beforeSend` usa P8; 4xx operacional no captura; flush fatal es esperado | Obligatorio |
| Guardia jobs | Inspecciona cada `new CronJob`/`cron.schedule` y prueba que sus 43 callbacks abren contexto; no basta buscar una cadena por archivo | Obligatorio |
| Unit Rabbit | Tres publishers, tres consumers, UUID válido/ausente/Buffer/malformado y cola backward-compatible | Obligatorio |
| Unit Socket | Contexto con tenant, throw sync, rejection async, catch terminal con callback y exactamente una captura | Obligatorio |
| Unit dashboard | `api` + `publicApi`, retry con mismo id, duración por intento, scope realmente limpio y P8 sobre `AxiosError` | Obligatorio |
| Unit TPV | Sink sin DSN, handlers automáticos apagados, `captureMessage` sin throwable, allowlist de metadata y paridad de contexto | Obligatorio |
| Guardia TPV | Ningún bloque nuevo combina Sentry con `recordException`, `logError`, `logCritical` o `Timber.e`; la fachada no enruta globalmente a Sentry | Obligatorio |
| Unit Android/iOS | Correlación en todos los transportes, retry conserva id, 5xx terminal sí, 5xx/red encolado no, `RETRY` no, `REJECTED` sí, impresión terminal sí | Obligatorio |
| Integración server | Request real con token atribuye log del servicio y log de cierre; 50 requests concurrentes con cero cruces | Obligatorio |
| Contrato privacidad | P8 ejecutado en los cinco repos con resultados equivalentes | Obligatorio |
| Release | Backend `.ts`, dashboard `.tsx`, TPV mapping R8, Android mapping R8 e iOS dSYM verificados por archivo/línea sembrada | Obligatorio |
| Rendimiento | Baseline y después con `autocannon`; dashboard documenta delta de bundle del SDK | Obligatorio antes de producción |
| Operación | Kill switch, canary y búsqueda cruzada por `correlationId` en staging | Obligatorio antes de producción |

---

## Rollback Plan

**Server:** borrar `SENTRY_DSN` del entorno de Render y reiniciar. Apaga el envío sin desplegar código.

**Los 4 clientes (dashboard, tpv, android, ios):** el mismo gesto, y es la ventaja de que D6 dejara el corte parejo. `VITE_SENTRY_DSN` **no sirve** como interruptor en el dashboard porque Vite hornea las variables al compilar, y en móvil un cambio de código tarda días en llegar. El interruptor real es del lado del servidor: **deshabilitar la client key (DSN) del proyecto** en Sentry → Settings → Client Keys. La key deja de aceptar ingesta de inmediato, sin redesplegar el dashboard ni esperar un release de APK o de App Store, y se revierte con un clic. Un rate limit al 0% **no** sirve (los límites se configuran por ventana de tiempo, no admiten cero, y el SDK sigue intentando). El plan debe **probar el apagado en staging antes de declarar listo el rollback**: deshabilitar la key, disparar un error sembrado y confirmar que no llega nada.

**ALS e inyección en Winston:** no tienen interruptor porque no tienen efecto externo, solo enriquecen logs. Revertirlos es un revert limpio de `src/observability/` más los cinco puntos de intervención.

Riesgo real a vigilar: `AsyncLocalStorage` tiene un costo pequeño pero medible en Node. Lo cubre el criterio 12; si se pasa del umbral, se acota a los caminos que importan en vez de revertir todo.

---

## Rollout Plan

1. **Task 0:** cerrar P1–P9, fijar versiones y obtener baseline de latencia/bundle antes de modificar producción.
2. **Server staging:** ALS, logs, Rabbit, jobs, sockets, scrubbing, source maps y kill switch. No desplegar clientes hasta que el server acepte/valide/eco el header y la prueba de 50 requests sea verde.
3. **Dashboard preview:** `api` y `publicApi`, source maps y búsqueda cruzada contra Better Stack.
4. **Canary móvil:** un TPV sandbox, un dispositivo Android y uno iOS con builds release firmados. Verificar mapping/dSYM, privacidad, identidad y offline sin falsos positivos.
5. **Producción gradual:** server → dashboard → TPV limitado → Android/iOS. Cada etapa observa 24 horas o el volumen mínimo acordado antes de ampliar.
6. **Abortar etapa:** cualquier PII, duplicación TPV, pérdida de offline, simbolicación rota o atribución de tenant incorrecta activa el rollback de esa aplicación; no se continúa por calendario.

Las implementaciones de dashboard, TPV y Android/iOS pueden avanzar en paralelo después de fijar P7/P8, pero la validación E2E y el rollout dependen del server staging.

---

## Effort Estimate

| Parte | Trabajo | Humano | CC |
|---|---|---|---|
| Task 0 | Provisioning, matriz de versiones, secretos, corpus P8 y baseline | ~0.75 día | ~1 h |
| A | ALS + 5 tipos de arranque + formato de Winston | ~1.5 días | ~2 h |
| A3 | Envolver los 43 registros de scheduler + guardia estructural | ~0.75 día | ~1 h |
| B | Sentry en server + scrubbing + source maps | ~1 día | ~1.5 h |
| C | Dashboard: SDK, plugin, dos clientes Axios, identidad y privacidad | ~1 día | ~1.5 h |
| D | Tres apps móviles, transportes exhaustivos, sinks y simbolicación | ~3 días | ~4 h |
| E | Correlación cruzada y retries en los 4 clientes | ~1 día | ~1.5 h |
| | Tests, release seeds, rendimiento y canary | ~2 días | ~3 h |

---

## Files Reference

| Archivo | Cambio |
|---|---|
| `src/observability/executionContext.ts` | **Nuevo.** ALS y API de contexto |
| `src/observability/jobContext.ts` | **Nuevo.** `runInJobContext` |
| `src/observability/sentry.ts` | **Nuevo.** Init, `beforeSend`, allowlist |
| `src/observability/redactPatterns.ts` | **Nuevo.** Patrones de redacción (RFC, CLABE, tarjeta, email, teléfono, JWT) |
| Fixture P8 en los 5 repos | Corpus dorado de redacción, profundidad y ciclos |
| `src/middlewares/requestLogger.ts` | Validar UUID y envolver cuerpo completo, listeners y `next()` |
| `src/middlewares/authenticateToken.middleware.ts` | `enrichContext` tras armar authContext |
| `src/config/logger.ts:13` | Formato que inyecta contexto |
| `src/config/env.ts` | `SENTRY_DSN` opcional |
| `src/app.ts:346` | `venueId`/`userId`/`role` en el metadata + captura |
| `src/server.ts` | Init de Sentry antes de `app`; captura en los handlers de proceso |
| `tsconfig.json`, `package.json` | `sourceMap: true` + `--enable-source-maps` en `start` |
| `src/jobs/` (43 registros, exhaustivo por guardia estructural) | Envolver cada callback de scheduler y capturar en su catch terminal |
| `src/communication/rabbitmq/{consumer,publisher,commandListener,gcal-pull-consumer,gcal-push-consumer}.ts` | Header `x-correlation-id`, contexto y captura terminal |
| `src/services/google-calendar/pull.service.ts` | Estampar header en publicación directa |
| `src/communication/rabbitmq/commandRetryService.ts` | Solo contexto de job/log; **no** se trata como publisher |
| `src/communication/sockets/managers/socketManager.ts` | Contexto con `socket.authContext`, red de seguridad async y captura en catches terminales |
| `dashboard/src/components/ErrorBoundary.tsx:61` | Captura real |
| `dashboard/src/api.ts` | Instalar request/response interceptors compartidos en `api` y `publicApi`; retry, duración, breadcrumb y captura |
| `dashboard/src/lib/sentry.ts` | Init, identidad, eliminación real de tags y D3/D9 |
| `dashboard/vite.config.ts:40` | `build.sourcemap: 'hidden'` + `@sentry/vite-plugin` |
| `tpv/core/observability/SentrySink.kt` y puntos de matriz | SDK aislado; captura directa sin enrutar `ObservabilityManager` a Sentry |
| `tpv/app/build.gradle.kts` | SDK, plugin, BuildConfig DSN y mapping con versiones P7 |
| `android/core/observability/Telemetry.kt`, todos sus transportes y puntos de matriz | Sentry, contexto, correlación y privacidad |
| `android/app/build.gradle.kts` | SDK/plugin y mapping con versiones P7 |
| `ios/Services/Telemetry.swift`, `APIClient` y URLSessions directas | Sentry, contexto, correlación y privacidad |
| `ios/avoqado-ios.xcodeproj`, build settings e `Info.plist` | SPM, DSN por configuración y fase versionada para dSYM |

---

## Seguimiento post-lanzamiento (no bloquea)

**S-1 — Volumen y costo de Sentry.** P9 registra como `Q` la cuota mensual de eventos vigente en la cuenta al momento del rollout; no se hardcodea una cifra comercial que puede cambiar. La primera decisión se toma a los 7 días de datos reales sumando dashboard, TPV, Android e iOS.

Procedimiento, no una intención vaga:
1. Arrancar con `sampleRate = 1.0` y `tracesSampleRate = 0` (cero transacciones: no estamos midiendo rendimiento y son el grueso de la cuota).
2. **A los 7 días naturales**, leer el consumo real en Sentry → Stats, sumando los cuatro proyectos, y proyectar a 30 días: `eventos_7d × 30 / 7`.
3. Regla de decisión sobre la proyección mensual:
   - **< 0.8 × Q** → no se toca nada.
   - **0.8 × Q a Q** → identificar huellas ruidosas, corregir/filtros específicos y volver a medir a los 7 días.
   - **> Q** → primero investigar: suele ser una huella repetitiva, no volumen legítimo. Silenciar solo el ruido demostrado y remedir. Si sigue arriba, bajar `sampleRate` a `Q / proyección` redondeado hacia abajo a un decimal, o cambiar capacidad contratada.
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

# Freno del MCP de clientes — una llamada a la vez, tope de tiempo y registro al empezar

**Fecha:** 2026-09-23 · **Autor:** Claude (Opus) · **Decisión del founder:** «Si ok» a la opción A (freno hoy).
**Incidente que lo motiva:** 23-sep 07:33:54–07:37:15Z. Memoria `mcp-congela-prod-23sep`; el diagnóstico completo
está en la conversación y lo resume esta sección.

## Qué pasó (medido, no supuesto)

- Adrián Palme (OWNER de PlayTelecom, 57 tiendas) usó Claude con el conector del MCP a las 01:33 CDMX.
- Su refresh token rotó a las 07:33:54.03. El primer `POST /mcp` llegó a las 07:33:54.59 y el hilo quedó ocupado
  40.5 s seguidos, en ~20 tramos de 0.2–4.9 s separados por esperas cortas (consultas).
- Llegaron 3 POST más (07:34:58, 07:35:07, 07:35:15) y quedaron 3 en paralelo. La CPU se pegó al 100 %.
- `/health` dejó de contestar. Render marcó la instancia en 0 y la mató en seco a las 07:36:54 (Postgres registró
  `Connection reset` en todas las conexiones; el SIGTERM no corrió porque el hilo estaba tapado).
- No fue memoria (551 MB de 2 GB), ni la base (CPU 4 %), ni un deploy.
- No sabemos QUÉ herramienta fue: `/mcp` se monta antes del request logger (sin contexto) y `instrument.ts`
  registra la herramienta sólo al TERMINAR; nada terminó.
- Descartado con mediciones: armar el catálogo de herramientas (0.1 s para 283) y resolver el alcance
  (≈20 ms por tienda, ≈1 s para 57).
- Historial de `mcp_tool_calls` (955 llamadas desde el 26-jul): p50 0.24 s, p99 2.1 s, máximo 8.2 s,
  **0 llamadas de más de 10 s**.

## Decisiones cerradas (no re-litigar)

1. **Una llamada de herramienta a la vez por persona** (`tools/call` por `staffId`). Decisión del founder.
2. **Tope de tiempo por petición.** Pasado el tope, el trabajo se detiene donde sea seguro.
3. **Registrar al EMPEZAR** el método, la herramienta, la persona y el venue.
4. Separar el MCP en su propio servicio (opción B) queda para después. No entra aquí.

## Límite honesto (lo que este freno NO puede hacer)

JavaScript no se puede interrumpir a media ejecución síncrona. Si una herramienta quema 40 s de CPU **sin tocar la
base**, este freno no la corta: sólo el aislamiento en otro proceso (opción B) lo resolvería. Lo que sí hace:

- Impide el amontonamiento (el 2º, 3º y 4º intento ya no corren en paralelo), y el cupo sigue tomado mientras el
  trabajo siga vivo, aunque el cliente ya se haya ido (así un reintento nunca corre encima del trabajo viejo).
- Corta el trabajo en la **siguiente lectura** a la base una vez vencido el tope o cuando el cliente se fue — salvo
  que ya haya escrito: una secuencia de escrituras nunca se deja a medias.

## Diseño (v7 — tras seis auditorías de Codex: v1 RECHAZADA 3 P1 · 4 P2 · 1 P3; v2 RECHAZADA 2 P1 · 2 P2 · 2 P3; v3 RECHAZADA 1 P1 · 4 P2 · 2 P3; v4 RECHAZADA 1 P1 · 2 P2 · 1 P3; v5 RECHAZADA 1 P1 · 3 P2; v6 AUTORIZADA CON CAMBIOS 1 P2 · 1 P3)

### 1. Cancelación cooperativa por contexto (`src/utils/requestCancellation.ts`)

`ExecutionContext.cancellation?: RequestCancellation` (`executionContext.ts`), nunca logueado:

| Campo | Qué hace |
|---|---|
| `signal` / `cancel` | se aborta al vencer el tope, al irse el cliente o al responder la herramienta |
| `hasWritten` | se prende con la primera escritura: desde ahí nada se corta (no se dejan escrituras a medias) |
| `refused` | se prende con la primera lectura cortada: desde ahí TODO se rechaza, escrituras incluidas |
| `activeWork` / `onIdle` | trabajo vivo: el manejador, cada herramienta y **cada consulta en vuelo** |
| `lastActivityAt` | último inicio o fin de cualquier trabajo (la guardia espera calma antes de soltar el cupo) |
| `onBusy` | vuelve a haber trabajo tras la calma: el cupo deja de estar «calmándose» (ronda 4) |
| `attached` / `reattach` | `false` cuando la unidad ya soltó el cupo; toda operación suya **recupera el cupo primero** y nunca sigue sin él (rondas 4-5) |
| `prismaBatch` (en el contexto) | marca ESTÁTICA que sólo lleva un lote `$transaction([…])` mientras Prisma lo prepara y corre: el lote es el trabajo contado y sus operaciones no se cuentan aparte (ronda 6) |

Regla de `checkCancellation`: (1) `refused` ⇒ todo se rechaza; (2) escritura ⇒ pasa y marca `hasWritten`;
(3) lectura con el signal abortado y sin escrituras ⇒ se rechaza y envenena.

**Qué es lectura:** ORM por nombre (`findUnique`, `findFirst`, `findMany`, `count`, `aggregate`, `groupBy`…) y SQL
crudo **sólo si `src/utils/readOnlySql.ts` lo demuestra** — un tokenizador (cadenas, `E'…'`, `$tag$…$tag$`,
identificadores entre comillas, comentarios anidados) que acepta UNA sentencia SELECT/WITH sin palabras de
escritura, sin candados de fila (`FOR UPDATE/SHARE`) y **sin funciones fuera de una lista permitida de funciones
puras**. Lo desconocido es escritura. (La v2 usaba expresiones regulares y Codex la engañó tres veces.) Barrido de
las **186 consultas crudas del repo**: las lecturas puras salen lectura; todos los `FOR UPDATE/SHARE` y candados
`pg_advisory*` salen escritura.

Ayudantes: `refuseNewWork` (antes de empezar una herramienta), `pendingCancellation` (antes de devolver: si una
lectura se cortó, el resultado puede ser parcial), `runWithoutCancellation` (la bitácora, arrancando adentro la
consulta perezosa de Prisma), `endOfWriteUnit` (entre tiendas de `getSaldosForOrg`), `beginWork`, y **`settleTool`**:
al responder la herramienta, la unidad se cancela con motivo `tool-finished`; como sólo corta LECTURAS de unidades
que no escribieron, una rama de `Promise.all` que sobrevivió al rechazo muere en su siguiente lectura, y una
escritura posterior legítima (en una herramienta que ya escribió) termina.

**Ronda 7 del clasificador** (Codex ronda 6): la lista de columnas de un CTE se reconocía mirando sólo los tokens de
alrededor (`, nombre (cols) AS (` o `AS MATERIALIZED`), y eso también aceptaba `SELECT 0, pg_try_advisory_lock(1) AS
materialized` y `ROWS FROM (…, f() AS (r integer))`. Ahora se RECORRE la lista del WITH (`withListGrammar`): sólo un
WITH al inicio de la sentencia o tras «(» abre una lista, cada CTE exige `nombre [(nombres)] AS [[NOT] MATERIALIZED] (…)`
con su cuerpo cerrado, y únicamente esas posiciones —el nombre con lista y el MATERIALIZED— dejan de leerse como llamada.
Barrido del repo: 383 fragmentos, 212 lecturas, **0 cambios de veredicto**.

**Ronda 6 del clasificador** (Codex ronda 5): PostgreSQL une `U&"pg_advisory_lock" UESCAPE '!'` en UN identificador
(su filtro léxico, `parser.c`), así que el nombre de la función quedaba a dos tokens de su «(». Los identificadores y
cadenas con escapes Unicode (`U&"…"`, `U&'…'`, sin espacios, como `scan.l`) y la palabra `UESCAPE` ya no son lectura
demostrable. Ninguna lectura cruda del repo los usa.

**Ronda 5 del clasificador** (Codex ronda 4): dos cadenas seguidas nunca son lectura demostrable (Postgres continúa la
primera **conservando su modo de escapes**: `E''` + `'\' -- '` en la línea siguiente escondía un `pg_advisory_lock`);
minúsculas sólo en A-Z como `downcase_identifier` (la K de Kelvin hace que `ranK` no sea `rank`); y `JOIN (` deja de
aceptarse: su regla dependía de una lista de «dónde empieza una expresión» que nunca es completa (`AT TIME ZONE join()`).
Medido: ninguna lectura cruda del repo usa `JOIN (`; el barrido sigue en 0 cambios de veredicto.

**Ronda 4 del clasificador** (Codex ronda 3 + dos hermanos que encontré): copia las clases de caracteres de
`scan.l` — `\r` también cierra un comentario de línea; cualquier carácter ≥ 0x80 es de identificador (`€count` es UNA
función) y de etiqueta de dólares (`$ñ$…$ñ$`) —; un nombre **calificado** nunca es palabra clave (`public.exists(1)`
llama a una función propia); y de las palabras clave que preceden a «(» sólo se aceptan siempre las que Postgres
**no admite como nombre de función** (RESERVED y COL_NAME de `kwlist.h`). `FILTER`/`OVER` valen sólo tras «)», `BY`
sólo tras ORDER/GROUP/PARTITION, `JOIN (` sólo tras un elemento de FROM. `ROLLUP`, `CUBE`, `GROUPING SETS`,
`MATERIALIZED`, `IS (`, `LIKE (` ya no se aceptan: medido el 23-sep, ninguna consulta del repo los usa. Barrido de
**383** fragmentos SELECT/WITH del repo con el compilador de TypeScript: **0 cambian de veredicto** entre ronda 3 y 4.

La extensión (`$allOperations`, encadenada en `prismaClient.ts`) cuenta cada operación en vuelo como trabajo.
Verificado con el cliente real: lecturas, `$queryRaw`, `$transaction` interactiva y **por lote**, `omit` global y la
guardia de `findMany` siguen funcionando; fuera de una petición del MCP devuelve `query(args)` tal cual.

**Rondas 5-6: CADA transacción es un trabajo, de principio a fin** (Codex rondas 4 y 5). Una tercera extensión de
cliente (`extensionCancellableTransactions`, API oficial de Prisma: sobrescribe `$transaction` y llama al original por
`$parent`) envuelve toda transacción en `runCancellableTransaction`:
- fuera de una petición del MCP devuelve **la misma promesa de Prisma** (el resto de la plataforma no cambia; probado
  con las suites de integración de pagos y TPV contra una base propia);
- **cada** `$transaction` cuenta como un trabajo durante TODA su vida — también la que se abre dentro del callback de
  otra: compartir el contexto no es compartir la transacción de PostgreSQL, y la de adentro puede sobrevivir a la de
  afuera (el P1 de la ronda 5 las dejaba pasar sin contar);
- una unidad desprendida **recupera el cupo ANTES del BEGIN**. Como toda transacción viva de la unidad está contada,
  una unidad sin cupo no tiene ninguna abierta: esperar nunca retiene un candado ni una conexión;
- las operaciones del callback de una transacción **interactiva** se cuentan una por una, como cualquier otra (sean de
  `tx` o del cliente raíz): lo que el callback deje corriendo sigue siendo trabajo de la unidad;
- las operaciones de un **lote** (`$transaction([…])`) no se cuentan aparte ni piden cupo: Prisma puede dejar una
  esperando para siempre en su barrera cuando otra falla. El lote corre con la marca estática `prismaBatch`, que no se
  apaga al terminar (un item que Prisma prepara tarde sigue siendo del lote). En ese contexto sólo corre la maquinaria
  de Prisma: un lote no tiene callback y cada elemento se valida antes;
- dentro de una petición del MCP, un lote con un elemento que no es consulta de Prisma **o con un hueco** se rechaza
  **entero antes de preparar nada**, revisando posición por posición (`Array.every`, como el `map` de Prisma, se salta
  los huecos), con el mismo mensaje de Prisma.
Sin `__internalParams` (el P3 de la ronda 4). Prueba permanente con el cliente real:
`tests/integration/mcp/freno-transacciones.integration.test.ts` (CI, Node 20).

### 2. Guardia de petición (`src/middlewares/mcp-request-guard.middleware.ts`)

```
requireBearerAuth → mcpRateLimitMiddleware → express.json() → mcpRequestGuardMiddleware → handleMcpRequest
```

1. **Lotes JSON-RPC ⇒ 400** (`-32600`). MCP 2025-06-18 y 2025-11-25 exigen un mensaje por POST; el SDK corría las
   llamadas del lote en paralelo y un `notifications/cancelled` dentro dejaba el stream abierto (Codex ronda 2).
2. **Notificaciones ⇒ 202 sin armar nada**, sólo si `Accept`, `Content-Type` y la versión de protocolo pasarían
   la validación del SDK; si no, van al SDK para que conteste su 406/415/400.
3. **Cupo por persona** (en memoria; con 2+ instancias va a Redis — `una-sola-instancia.md`): **1 herramienta** y
   **2 peticiones** a la vez.
   - `tools/call` con la anterior **corriendo** ⇒ rechazo inmediato (HTTP 200 + `isError`, el modelo lee el motivo).
   - `tools/call` cuando la anterior ya respondió y sólo le falta calmarse ⇒ **espera** (≤ 3 s) y corre.
   - Petición de control sin lugar ⇒ **espera su turno** (≤ 30 s: más que una consulta completa; máx. 4 en espera) y
     si no, 429 + `Retry-After`.
   - **El saludo (`initialize`, `ping`) no toma cupo** (ronda 4): el cliente real del SDK no reintenta un 429 en
     `connect()`, y con los dos cupos ocupados fallaba. `handleMcpRequest` lo contesta con un servidor ligero (una
     consulta: ¿es superadmin?) que anuncia EXACTAMENTE lo mismo que el completo (prueba con ~250 herramientas).
   - Si el cliente se va **justo** cuando le toca el turno, el cupo se devuelve y no se llega al MCP (ronda 4).
4. **El cupo sigue al trabajo:** se libera cuando la respuesta terminó, no queda trabajo vivo (manejador,
   herramienta, consultas en vuelo) y hubo **300 ms de calma**. Nunca se le quita a un trabajo vivo: a los 2 min
   alerta con **su propio temporizador** (`mcp.cupo retenido demasiado tiempo`, una vez). Cada liberación sólo suelta
   su propio cupo.
   **Al soltarlo (ronda 4):** la unidad queda cancelada (`tool-finished`: sus lecturas sobrantes se cortan) y
   **desprendida**. Si ya escribió, cada operación suya recupera el cupo primero, **con prioridad** sobre peticiones
   nuevas, y **nunca sigue sin él** (ronda 5): a los 30 s avisa una vez (`mcp.rama desatada sigue esperando cupo`) y
   sigue esperando. No puede trabarse: sólo espera FUERA de una transacción (sin candados de fila); el repo no tiene
   candados en memoria, y su único candado de sesión en la base es un intento que no bloquea. Cuando recupera el cupo
   lo registra (`mcp.rama desatada retoma el cupo`, con la herramienta): una herramienta que deja trabajo corriendo es
   un defecto. Una conexión que ya estaba cerrada no se forma en la fila.
5. **Tope de 25 s** (3× el máximo histórico; bajo el corte de Cloudflare, 125 s por defecto). **Nunca se apaga
   antes**: una rama sobrante se corta igual al vencer.
6. **Registro**: `mcp.request inicio` dentro del contexto (mismo `correlationId` que el resto); `mcp.request fin`
   cuando termina el trabajo, con `ms`, `respuestaMs` y `outcome` (`ok` | `cancelada` | `cliente-se-fue`).

### 3. Donde se traga el error

- `instrument.ts`: `refuseNewWork`, `pendingCancellation`, `settleTool` en el `finally`, cada herramienta cuenta
  como trabajo, la cancelación se registra `warn` + `McpToolCall` `cancelada:<motivo>`, y `recordCancelledToolCall`
  para los intentos cortados antes de correr.
- `scope.ts`: el `catch` por tienda relanza la cancelación.
- `server.ts`: chequeo de `pendingCancellation` antes de entregar el servidor; el manejador cuenta como trabajo;
  una cancelación se contesta con `respondMcpCancelled` y deja su fila en la bitácora.
- `cash-out.org.service.ts`: `endOfWriteUnit()` entre tiendas (latente: cash-out tiene 0 filas en producción).
- `terminal-payment-strictness.ts` (ronda 4, hallazgo propio): su refresco GLOBAL nace dentro de quien consulte la
  lista, y las herramientas de terminales del MCP la consultan. Corre con `runWithoutCancellation`: cortarlo gritaba
  un 🚨 falso en Better Stack y, con el desprendimiento, habría esperado el cupo de una persona.

## Auditoría de Codex, ronda 1 (gpt-6-astra xhigh): RECHAZA — los 8 aceptados

| # | Hallazgo | Cómo quedó |
|---|---|---|
| P1-1 | Los lotes evaden el cupo | lotes rechazados (ronda 3) |
| P1-2 | Cerrar la conexión no termina la herramienta | el cupo sigue al trabajo |
| P1-3 | Registrar la cancelación apagaba la cancelación | bitácora fuera del freno + envenenamiento |
| P2-4 | `catch` del catálogo/acceso entregan un armado parcial | chequeo final del armado |
| P2-5 | `$queryRaw` también muta | tokenizador + lista permitida (ronda 3) |
| P2-6 | `cash_out_org_saldos` pierde el freno tras escribir | unidad de escritura por tienda |
| P2-7 | Los métodos de control no son baratos | notificaciones 202 + tope de 2 con espera |
| P3 | Cloudflare | corregido |

## Auditoría de Codex, ronda 2: RECHAZA (5 cerrados, 3 parciales) — adjudicación

| # | Hallazgo | Veredicto | Cómo quedó |
|---|---|---|---|
| P1 | Una rama de `Promise.all` sobrevive al rechazo: el cupo se libera y el reloj se apaga | ✅ aceptado | `settleTool` + consultas en vuelo como trabajo + calma + el reloj nunca se apaga antes |
| P1 | El techo de 10 min reemplaza un cupo vivo | ✅ aceptado | nunca se reemplaza; sólo alerta |
| P2 | El clasificador de SQL se engaña | ✅ aceptado | tokenizador + lista permitida |
| P2 | Lote mixto con `notifications/cancelled` deja el cupo tomado | ✅ aceptado | lotes rechazados |
| P3 | Cloudflare 125 s | ✅ aceptado | corregido |
| P3 | El atajo 202 no validaba la versión | ✅ aceptado | valida como el SDK |
| (f) | 429 en `connect()` con 2 peticiones ocupadas | ✅ aceptado | las peticiones de control esperan turno |

## Auditoría de Codex, ronda 3: RECHAZA (1 P1 · 4 P2 · 2 P3) — adjudicación

Todos verificados contra el código antes de tocar nada; los dos del lote y del SQL, también contra Prisma 6.19.3 y el
`kwlist.h` de Postgres 16.

| # | Hallazgo | Veredicto | Cómo quedó |
|---|---|---|---|
| P1 | Tras escribir, una rama sobrante sigue leyendo con el cupo ya suelto: corre junto a la consulta nueva | ✅ aceptado | desprendimiento + `reattach` (su lectura espera a que termine la consulta nueva: medido, **303 ms después**) |
| P2 | Un error de validación en `$transaction([…])` deja una promesa colgada para siempre | ✅ aceptado | la primera falla del lote termina el trabajo de todas |
| P2 | El clasificador: `\r` y `public.filter()` | ✅ aceptado | clases de `scan.l` + calificado primero + palabras clave por categoría; más dos hermanos propios (etiqueta `$ñ$`, `€count`) |
| P2 | El cliente se va justo al recibir turno: el cupo nunca se libera | ✅ aceptado | se revisa el cierre también DESPUÉS de obtener turno |
| P2 | `connect()` del SDK falla con dos cupos ocupados > 15 s | ✅ aceptado | el saludo no toma cupo + espera de control de 30 s |
| P3 | El atajo 202 acepta cuerpos que el SDK rechaza | ✅ aceptado | `isJSONRPCNotification` del propio SDK |
| P3 | La alarma de cupo viejo sólo suena si alguien consulta | ✅ aceptado | temporizador propio, creado fuera de toda petición |
| (a) | `settleTool` rechazaría una lectura diferida legítima | declarado | Codex no halló una herramienta actual que lo haga |

## Auditoría de Codex, ronda 4: RECHAZA (1 P1 · 2 P2 · 1 P3) — adjudicación

Cerrados por Codex de la ronda 3: la desconexión al recibir turno, `connect()` con dos cupos ocupados, el atajo 202 y
la alarma. Lo que quedaba, verificado contra el código:

| # | Hallazgo | Veredicto | Cómo quedó |
|---|---|---|---|
| P1 | Dos salidas sin cupo: a los 30 s la rama seguía sin cupo (y ya no volvía a esperar), y la excepción de la `itx` eximía también una transacción NUEVA | ✅ aceptado | la espera no tiene salida sin cupo (avisa a los 30 s); la transacción recupera el cupo antes del BEGIN y cuenta como un trabajo — ya no hay excepción de `itx` |
| P2 | Un lote con un elemento que no es consulta de Prisma deja el primero colgado (el error ocurre FUERA de la extensión) | ✅ aceptado | la transacción es el trabajo contado; y el lote se valida entero antes de preparar nada |
| P2 | Clasificador: `E''` que continúa en otra línea, K de Kelvin, `AT TIME ZONE join()` | ✅ aceptado | cadenas seguidas ⇒ no demostrable; minúsculas A-Z; `JOIN (` fuera |
| P3 | Dependencia de `__internalParams` sin prueba permanente | ✅ aceptado | la dependencia desaparece; prueba de integración permanente con el cliente real |
| (g) | Una conexión ya cerrada se formaba en la fila | ✅ aceptado | no se forma |

## Auditoría de Codex, ronda 8 (acotada a la prueba de arquitectura): AUTORIZA CON CAMBIOS (3 P3) — adjudicación

Sin cambios de código de producción desde la ronda 7. Las dos burlas anteriores quedaron cerradas; Codex encontró otras
formas NORMALES de reorganizar el código que dejaban la guardia en verde (una extensión importada de otro módulo,
compuesta con `Object.assign` o un spread, tres llamadas sobre receptores distintos, `import = require`, el constructor
con alias o por espacio de nombres, `$extends.bind`, el freno importando un servicio) y un falso positivo con `import type`.
✅ Aceptados los tres, con una decisión de fondo: **una guardia sintáctica nunca es completa**, así que la protección real
pasa a ser de COMPORTAMIENTO — `freno-transacciones.integration.test.ts` comprueba con el cliente y la cadena reales que,
en un lote de N elementos, el freno ve exactamente N operaciones (saboteada: una extensión que consulta por su cuenta da
4 de 3). La guardia estática queda como aviso temprano en revisión: verifica que el cliente sea UNA cadena sobre
`prismaBase`, el módulo de origen de cada extensión, que cada una sea un objeto literal sin composición y que nadie la
toque fuera de su declaración y de la cadena, ningún acceso a `$extends` fuera de `prismaClient.ts`, las dependencias en
EJECUCIÓN exactas de los cuatro módulos del freno (los `import type` no cuentan) y la construcción de clientes por
nombre, alias o espacio de nombres. 28 pruebas; los 8 sabotajes de la ronda 8 sobre los archivos reales se cazan, y el
`import type` pasa.

## Auditoría de Codex, ronda 7 (acotada al arreglo): AUTORIZA CON CAMBIOS (1 P3) — adjudicación

El P2 del clasificador quedó **cerrado** (216 combinaciones extra de anidamiento, nombres y materialización sin un
escape). El P3 quedó parcial: la prueba de arquitectura se burlaba con una extensión escrita en línea
(`.$extends({ … })`, la expresión regular sólo contaba identificadores) y con una importación en varias líneas.
✅ Aceptado: la guardia lee el código como árbol del compilador de TypeScript — todas las llamadas a `$extends` (también
`x['$extends']`), cada una con un solo identificador; toda carga de módulo (importación, re-exportación, `require`,
`import()`) de la guardia de resultados y del freno; y `new PrismaClient`. Las dos burlas de Codex y cinco más son
casos que deben fallar, y los cuatro sabotajes sobre los archivos reales se cazan.

## Auditoría de Codex, ronda 6: AUTORIZA CON CAMBIOS (1 P2 · 1 P3) — adjudicación

Cerrados por Codex los cuatro de la ronda 5 (transacción hija, huecos, `UESCAPE`, bitácora de cash-out). Sin P1 nuevo;
no encontró cómo repetir tres herramientas simultáneas de la misma persona.

| # | Hallazgo | Veredicto | Cómo quedó |
|---|---|---|---|
| P2 | La excepción de la lista de columnas de un CTE aceptaba `, f(…) AS materialized` y `ROWS FROM (…, f() AS (r integer))` | ✅ aceptado | se recorre la lista del WITH (arriba); 9 pruebas nuevas y 5 sabotajes |
| P3 | La marca del lote depende de que ninguna extensión lance consultas propias: fijarlo | ✅ aceptado | `tests/unit/architecture/prismaExtensionChainGuard.test.ts` (reforzada en la ronda 7, abajo) |
| P2 (previo) | `cash_out_org_saldos` carga una tienda entera en memoria sin tope | declarado | ya estaba en los límites; `PromoterCommissionEntry` tiene 0 filas en prod |
| nota | El candado de sesión de Google Calendar puede quedar tomado tras retornar | aclarado | lo relevante es que el MCP no lo alcanza (comentario corregido) |

## Auditoría de Codex, ronda 5: RECHAZA (1 P1 · 3 P2) — adjudicación

Cerrados por Codex de la ronda 4: la espera sin salida sin cupo, la conexión ya cerrada en la fila y la dependencia de
`__internalParams`. Lo nuevo, verificado contra el código:

| # | Hallazgo | Veredicto | Cómo quedó |
|---|---|---|---|
| P1 | Una `$transaction` independiente abierta en el callback de otra heredaba `transaction.open` y no se contaba; tampoco las consultas del cliente raíz del callback | ✅ aceptado | se eliminó `transaction.open`; CADA transacción se cuenta toda su vida, y lo del callback de una `itx` se cuenta por operación |
| P2 | Un lote con HUECOS pasaba la validación (`Array.every`) y dejaba `activeWork=1` para siempre | ✅ aceptado | revisión por índice; y la marca estática del lote exime a sus items aunque Prisma los prepare tarde |
| P2 | `U&"pg_advisory_lock" UESCAPE '!' (1)` salía lectura | ✅ aceptado | `U&` y `UESCAPE` ⇒ no demostrable |
| P2 | La bitácora del clawback (`void logAction`) volvía a poner `hasWritten=true` tras `endOfWriteUnit()` | ✅ aceptado | corre con `runWithoutCancellation`; `endOfWriteUnit` documenta la regla |

## Evidencia (rondas 5 y 6)

| Qué | Resultado |
|---|---|
| Unitarias del cambio | `requestCancellation` 84 · guardia 60 · `readOnlySql` 86 · libro de cash-out 11 · arquitectura 28 |
| Suite unitaria del área (local = Alienware) | **218 suites / 2 149 pruebas** |
| Integración con el cliente real contra PostgreSQL (`freno-transacciones`) | **15/15** — huecos en los dos órdenes, transacción hija que sobrevive a la exterior, consulta raíz que sobrevive a la `itx`, y una operación por elemento de lote |
| Punta a punta, SDK y Prisma reales | **46/46** — incluye las reproducciones de Codex por HTTP: con la hija viva (o la consulta raíz), la persona NO puede empezar otra |
| `/full-testing` contra el `app` real | **14/14** normal · **4/4** con tope de 30 ms, sin errores en el log |
| Sabotajes (copia aislada) | **83/83 cazados** (rondas 3 a 7) + 8 de la guardia de arquitectura (ronda 8) + la extensión que consulta por su cuenta (integración) |
| Suites de integración de pagos y TPV (base propia) | 961/962 — el fallo es un plan de consulta de otra sesión (`noInstrumentSinSolicitud`), ajeno al freno |
| Typecheck del CI (ronda 6, local = Alienware) | 0 errores |

## Evidencia (ronda 4)

| Qué | Resultado |
|---|---|
| Unitarias del cambio | guardia 57 · `requestCancellation` 72 · `readOnlySql` 60 · saludo ligero 6 · lista estricta 11 |
| Punta a punta, SDK y Prisma reales | **36/36** — incluye las dos reproducciones exactas de Codex (P1 y P2-2) y el dato interno de Prisma (`itx` no pide cupo; lote y suelta sí) |
| `/full-testing` contra el `app` real | **14/14** normal (con los dos cupos ocupados, el cliente real del SDK conecta en 91 ms y su `tools/list` corre al liberarse uno; `initialize` bajó de 516 ms a 45 ms) · **4/4** con tope de 30 ms |
| Barrido del SQL crudo del repo | 383 fragmentos, 0 cambios de veredicto |

## Evidencia (ronda 3)

| Qué | Resultado |
|---|---|
| Unitarias del cambio | `requestCancellation` 63 · `readOnlySql` 37 · guardia 40 · instrumentador 36 · manejador 8 · alcance 14 · cash-out 5 |
| Sabotajes (copia aislada del repo) | **31/31 cazados**, cada uno tumba sólo su prueba |
| Punta a punta con SDK y Prisma reales (`scripts/temp-freno-mcp-e2e-dcf09769.ts`) | **31/31** — incluye transacción por lote, consulta en vuelo como trabajo, rama zombi de un error ordinario detenida tras 1 lectura, y llamadas seguidas que esperan la calma (302 ms) |
| `/full-testing` contra el `app` real (`scripts/temp-freno-mcp-fulltest-dcf09769.ts`) | **10/10** normal y **4/4** con tope de 30 ms; de 5 simultáneas de una persona, 1 rechazada y 4 corrieron **una tras otra** |
| Suites del área (ronda 2, local = Alienware) | 204 suites / 1 916 pruebas en verde |
| Typecheck del CI (ronda 2, local = Alienware) | 0 errores |

## Límites declarados (no resueltos aquí)

- CPU síncrona sin consultas no se corta (sólo la opción B lo resuelve). El cupo evita que se amontone.
- Una rama zombi que ya escribió sigue hasta terminar (nunca se corta una escritura), pero **cada operación suya
  recupera el cupo primero** (ronda 4) y sus transacciones lo recuperan antes del BEGIN (ronda 5). Su residuo: el tramo
  de CPU entre que despierta y su siguiente consulta (la misma clase que «CPU síncrona sin consultas»).
- El clasificador razona sobre el TEXTO del SQL. Un `SELECT` sólo podría esconder un efecto por el esquema (vista,
  regla, operador o conversión propia). Medido el 23-sep: 0 vistas, 0 reglas, 0 conversiones, 0 operadores propios
  (los 22 de `public` son de `pg_trgm` y `btree_gist`); las 27 funciones propias son de disparadores y validaciones de
  catálogo. Crear cualquiera de esos objetos es una migración: que su revisión lo mire.
- La marca `prismaBatch` supone que en el contexto de un lote sólo corre la maquinaria de Prisma. Una extensión de
  consulta futura que hiciera trabajo de base de datos correría ahí y quedaría sin contar: la de hoy
  (`query-result-guard`) sólo registra.
- El único candado de sesión del repo (`pg_try_advisory_lock` en `google-calendar/pull.service.ts`) no se alcanza
  desde el MCP: no puede trabar la espera del cupo. (No espera al tomarlo, pero sí puede quedar tomado tras retornar.)
- La marca `prismaBatch` depende de la cadena de extensiones: la fija `prismaExtensionChainGuard.test.ts`.
- La envoltura de `$transaction` usa la API pública de extensiones de cliente de Prisma (sobrescribir `$transaction` y
  llegar al original por `$parent`); la fija la prueba de integración con el cliente real, en CI.
- Cada petición de control vuelve a armar el alcance (sin caché: una caché retrasaría cambios de permisos —
  decisión aparte). Acotado a 2 simultáneas por persona.
- `cash_out_org_saldos` lee ventas y entradas sin tope por tienda: trabajo de capacidad aparte, antes de encender
  cash-out.
- Un cupo cuya promesa nunca termina bloquea a esa persona hasta el reinicio (alerta a los 2 min). Es el precio de
  no reemplazar nunca un cupo vivo (Codex ronda 2).
- Sin tope global entre personas (el tope es por persona).
- No sabemos qué herramienta causó el incidente; con el registro al empezar, la próxima vez sí.

## Despliegue

Hotfix: rama desde `main`, sólo estos archivos, PR a `main` y merge de vuelta a `develop`. De los archivos tocados,
sólo `app.ts` y `server.ts` difieren entre `main` y `develop` (por herramientas de otras sesiones, en otras líneas).
**Commit, push y deploy SÓLO con permiso explícito del founder.**

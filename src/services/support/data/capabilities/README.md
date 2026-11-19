# Capacidades de la B (datos por WhatsApp)

Aquí vive cada capacidad de la B, un archivo por dato (`DataCapability<P, R>`: renglón de catálogo, `params`, `read` y `render`), y nada
más.

El contrato lo vigila `tests/unit/architecture/supportDataCapabilitiesNoDb.test.ts` (T-B41, rehecha en T-B42 sobre el compilador de
TypeScript; T-B43 y T-B44 le sumaron las negativas y las escrituras). **Las reglas completas, lo que no ve y por qué están en la cabecera de
esa guardia**; aquí va lo que hay que saber para escribir una capacidad.

## Qué puede importar una capacidad (lista cerrada)

Con valor, sólo de:

- **Servicios del panel:** `src/services/dashboard/**`, `src/services/shared/**` y `src/services/legacy/**`, menos `legacy/legacyPool.ts`.
- **Los módulos de la B sin base:** `src/services/support/data/{catalog,check,format,params,paymentText,readRefusal,sanitize,texts}.ts`.
  `paymentText.ts` (los textos de un cobro que comparten C2 y C7) lo creó C2.
- **`DataReadRefusal` se importa de `readRefusal.ts`, no del catálogo** (C6 r1): el catálogo registra las capacidades al cargar, así que
  una capacidad que importara un VALOR suyo cerraría un ciclo y, cargada primero, tronaría al registrarse.
- **Dos utils:** `src/utils/datetime.ts` y `src/utils/venueDateKeys.ts`. Otro util entra a la lista con nombre y razón, en la guardia.
- **Paquetes:** `date-fns` y `date-fns-tz`. De `@prisma/client`, sólo tipos, sus enums (`PaymentMethod.CASH`, `$Enums`) y `Prisma.Decimal`;
  nunca `PrismaClient`, su default ni `import * as`.

Lo demás falla. La guardia también revisa:

- **A dónde lleva de verdad cada nombre:** algo que un archivo de la lista re-exporta desde fuera de ella también falla.
- **Lo que importan los módulos de la B y los utils, y lo que eso importa:** nada de ahí llega a la base.

Los tipos (`import type`) se importan desde cualquier lado.

**Una capacidad nunca importa valores de otra capacidad**, sólo tipos, y no re-exporta nada. Lo que dos capacidades comparten va en un
módulo de la B (como `paymentText.ts`).

## El contrato

1. **Una capacidad no toca la base.** Ni el cliente de Prisma, ni `legacyPool`, ni `$queryRaw`/`$executeRaw`/`$transaction`, ni
   `prisma.`/`tx.`. Lee SÓLO llamando un servicio del panel. Si el dato necesita una consulta que el panel no tiene, esa consulta va en un
   servicio del panel, no aquí. Tampoco lee la configuración (`@/config`, `process.env`): sus topes le llegan en el alcance (T-B41c).
2. **Sin código dinámico:** nada de `import()`, `require`, `eval`, `Function`, `globalThis`, `module` ni `process`, ni corchetes sobre algo
   importado (`servicio['metodo']`). Los globales del lenguaje también van por lista cerrada (`GLOBALS` en la guardia): `Math`, `Number`,
   `String`, `Date`, `JSON`, `Map`, `Set`, `Promise`… enteros, y de `Object` y `Array` sólo `keys`/`values`/`entries`/ `fromEntries` e
   `isArray`/`from`/`of`. `Object.assign`, `Object.defineProperty`, `Reflect`, `Proxy`, `.prototype` y lo del navegador (`fetch`, `console`,
   `setTimeout`) fallan (T-B44). Otro global entra a la lista con su razón.
3. **Un servicio del panel sólo se llama**, directo o como `Servicio.metodo(…)`, y el compilador tiene que poder ver cuál función es (si no
   la ve, falla). No se guarda en otra variable ni se pasa a `map`, a `.call` o a otra función. Pasarlo como valor sólo vale para las
   funciones de la lista `PANEL_NO_DATA` de la guardia (`available: cashDrawerIndexesReady`).
4. **Toda llamada al panel lleva la sucursal del alcance a la vista (T-B42b).** Una de dos:

   - `scope.venueId` en su parámetro `venueId`: `getSalesSummary(scope.venueId, { … })`; en las demás opciones no hace falta;
   - un objeto literal que TERMINA con `venueId: scope.venueId`: `byFilter({ ...opciones, day, venueId: scope.venueId })` (T-B42d). Antes de
     esa llave puede ir cualquier cosa, porque la última escritura gana. Después, sólo `venueIds: [scope.venueId]` (o `scope.venueIds`): ni
     spread, ni llave calculada, ni otra propiedad. `venueIds` sola nunca protege el objeto (T-B42c). Un getter o setter `venueId` y un
     `__proto__` fallan en cualquier lugar del objeto.

   Si no, falla, digan lo que digan los tipos: opciones en una variable, un argumento opcional que se omite, una función sin parámetro de
   sucursal. Las funciones del panel que no leen datos de un negocio (hoy `venueWeekBounds` y `cashDrawerIndexesReady`) van por nombre en
   `PANEL_NO_DATA`, con su razón. Además:

   - la sucursal se escribe siempre `scope.venueId`, en todo argumento y en toda llave `venueId` (desestructurada o abreviada,
     `{ venueId }`, ya no cuenta);
   - un parámetro `DataScope` sólo recibe el alcance de verdad;
   - ningún texto con forma de id;
   - los parámetros que entiende la IA nunca traen ids.

5. **La organización, nunca (T-B41b).** La B contesta con datos de UNA sucursal: una capacidad no usa `scope.organizationId`, no pone una
   llave `organizationId`/`orgId`, no le da valor a un parámetro con ese nombre y no le pasa a un servicio del panel el alcance entero
   (`scope` o `{ ...scope }`). Si un dato necesita la organización, el servicio del panel la saca de la sucursal.
6. **Cada servicio NUEVO del panel que agregue una capacidad trae su prueba de aislamiento:** un renglón de otra sucursal (de la misma
   organización y de otra), en la misma ventana y con el mismo valor buscado (mismo monto, misma hora), nunca sale. Si saca la organización
   de la sucursal, esa prueba muestra que las sucursales hermanas nunca salen. Los servicios del panel que se reusan tal cual ya cuidan su
   aislamiento para el panel.
7. **Una negativa es un texto fijo, nunca un dato (T-B43).** El worker guarda las negativas como ayuda, sin cifrar, y llegan tal cual al
   historial del modelo: si una trajera el nombre de la sucursal (o algo leído de la base), se saltaría el cifrado, la marca del historial,
   la regla de salida y las revisiones de la entrega. Por eso una capacidad nunca escribe el texto de una negativa: elige una **llave**
   (`DataRefusalKey`) de `SUPPORT_DATA_REFUSALS`, en `src/services/support/data/texts.ts`.

   - `notOffered: scope => (sumsLegacyQrPayments(scope.venueId) ? 'MI_LLAVE' : null)`: devuelve una llave o `null`. La condición puede ser
     cualquier cosa; lo que devuelve, sólo llaves literales, `null` o un ternario de ésas. Se escribe ahí mismo (flecha, función o método),
     nunca como una función de otro lado.
   - `params`: `{ ok: false, refusal: 'PARAM_AMOUNT' }`. El candado de plan: `gate: { …, refusal: 'PLAN_RESERVATIONS' }`.
     `throw new DataReadRefusal('OVER_CAP', 'MI_LLAVE')`.
   - ¿Tu capacidad necesita un texto que no está? Agrégalo a `SUPPORT_DATA_REFUSALS` con su llave: un texto fijo, sin plantilla, sin `${…}`
     y sin nada del alcance (ni la sucursal, ni la persona, ni la organización). Una plantilla, una concatenación, una variable, una llamada
     o una llave que no existe fallan en la guardia.
   - `key`, `label`, `object` y `aiHint` son textos literales en el archivo de la capacidad: van en la lista de lo que sí puede, en «no
     puedo mostrarte …», en la marca del historial, en los renglones que ve la IA y en los avisos.
   - Si algo se cuela (un `as`), el orquestador no lo contesta: da la genérica `NOT_AVAILABLE`.

8. **Lo fijo no se cambia en ejecución (T-B44).** `as const` sólo lo cuida el compilador: un `Object.assign(SUPPORT_DATA_REFUSALS, …)` o un
   `sample.label = scope.venueName` dentro de `notOffered` metían el nombre de la sucursal en las negativas, en la lista de «fuera del
   catálogo» y en la marca del historial. Ahora:

   - **Una capacidad sólo escribe sus variables locales**, declaradas en la misma función: `const filas = []; filas.push(x)` y
     `let n = 0; n++` dentro de `read`, sí. Nada de `x.y =`, `x[y] =`, `+=`/`-=`/`++`/`--` sobre algo que no sea local, ni `delete`. Una
     variable de la función escrita desde un callback también falla (`filas.forEach(f => { total += f.monto })`): usa `for…of` o `reduce`.
   - **Un método que cambia lo que recibe** (`push`, `splice`, `set`, `sort`, `reverse`…, y todo `set…` de `Date`: `setHours`, `setTime`,
     `setUTCDate`…) **sólo sobre una variable declarada en la misma función**. Nunca sobre un parámetro (`scope.now.setHours(0, 0, 0, 0)`,
     `result.rows.sort()`), sobre algo que no es una variable (lo que devuelve una llamada, `lista().push(x)`, o un arreglo armado ahí,
     `[...filas].sort()`), algo importado, del módulo o `this`. Para el día: `dayBounds` (hoy hasta `scope.now`), `wholeDayBounds` (el día
     calendario entero) o `lastDaysStart` (los últimos N días calendario, hoy incluido; lo creó C3), de `params.ts`, que escriben el día de
     la sucursal como texto. Nunca `setHours(0, 0, 0, 0)` (usa la zona del proceso) ni `venueStartOfDay`/`venueEndOfDay` (D19: en casos
     raros dependen de la zona del proceso); si el servicio del panel pide los bordes en ISO, pásale `.toISOString()` de lo que dio el
     ayudante. Para ordenar: `const orden = [...result.rows]; orden.sort(…)`.
   - **Ni `.call`, `.apply` ni `.bind`**: cambian a quién y con qué se llama una función sin que se vea en la llamada.
   - **Cada llamada recibe su propio alcance**, con su propia copia de `scope.now`: aunque algo moviera la hora, no se mueve la del sobre
     (`preparedAt`) ni la que ven las demás llamadas.
   - **Una capacidad es un objeto literal** (`export const salesToday: DataCapability<P, R> = { … }`): nada de `class`, ni algo que devuelve
     una llamada (T-B45). **Y nada de `this`** (T-B46): lo que hace una capacidad no depende de cómo se le llama. Una bandera se lee de una
     constante del archivo o del alcance, nunca con `this.cerrado`. Las dos copias que hacía el catálogo se comieron una negativa por esto:
     `{ ...c }` perdía un método de clase (Codex b2-r3) y la copia por nombre, la bandera que el método leía por `this` (Codex b2-r4).
   - **Se registra con `dataCatalog(...)`** en `catalog.ts`, en su lugar del orden: `DATA_CAPABILITIES = dataCatalog(salesToday, …)`. Un
     catálogo escrito a mano no compila (`DataCatalog` sólo sale de ahí). Al registrarla, el catálogo revisa su forma (cada miembro del
     contrato, un valor del tipo que pide: si falta uno obligatorio, no es de su tipo o es un getter, no se registra y lanza al cargar), la
     congela a fondo EN SU LUGAR y guarda ese mismo objeto: sin copia (T-B46). Todo lo que imprime la B sale de la capacidad congelada. Una
     escritura que se cuele lanza `TypeError`, y el orquestador falla cerrado («No pude leer ese dato ahorita»).
   - **Las pruebas** registran su catálogo igual (`dataCatalog(fake)`); para espiar `read` o `render`, la registran otra vez con los dos
     envueltos en `jest.fn`.

9. **El barrido de conducta** (`tests/integration/support/data/sweeps.integration.test.ts`) es una segunda red. No enumera todas las formas
   de consulta, y ese residual está aceptado: la garantía son 1 a 8. Su barrido T-B43 recorre cada negativa con el veneno en los nombres, y
   el de T-B44 las dos sondas de Codex b2-r2 y su secuencia (DATA con el permiso, la negativa sin él).

# El POS Android no puede reembolsar — `null` de JSON leído como valor inválido

**Reportado por:** Dany (Testarudo), 2026-09-11 — *«No me deja borrar un cargo q hice de prueba…
no está saliendo el dato de la devolución en efectivo ni en el ticket impreso ni en la pantalla
del POS.»*
**Estado:** 🟢 **servidor ARREGLADO y verificado en hardware** · 🟢 **Android: UI + truncamiento
ARREGLADOS y verificados en la Sunmi** · ⬜ **nada commiteado ni desplegado** · ⬜ iOS sin portar
**Repos:** avoqado-server · avoqado-android · avoqado-ios (pendiente de portar el layout)

---

## 1 · Qué veía el cajero

Dos pestañas de «Emitir reembolso», dos errores distintos, los dos del **servidor**:

| Pestaña | Mensaje en rojo |
|---|---|
| Reembolsar artículos | `amount debe ser un entero seguro positivo expresado en centavos` |
| Reembolsos por importe | `tipRefundCents debe ser un entero seguro no negativo expresado en centavos` |

El pago era **efectivo $65.00 + $9.75 de propina = $74.75**, un CAPUCCINO, cobrado a las
21:40:14 UTC; el primer intento de devolución, un minuto después.

## 2 · Causa raíz (probada, no supuesta)

🔴 **En JSON no existe `undefined`.** El POS Android serializa con kotlinx.serialization y
`encodeDefaults = true` (`RefundRepository.kt:123`), así que un campo opcional que **no aplica**
viaja como `"amount": null` en vez de omitirse. El dashboard web y iOS **omiten la llave**.

El commit **`56f78c18` (2026-09-04)** añadió guards con esta forma en los tres carriles:

```ts
if (amount !== undefined && !esCantidadPositivaEnCentavos(amount)) → 400
```

`null !== undefined` es **true**, y `esCantidadPositivaEnCentavos(null)` es **false** ⇒ 400.
Las dos capturas son el mismo defecto, un campo cada una.

🔑 **Lo que lo vuelve un defecto y no una decisión:** el MISMO controlador, cinco líneas más
abajo, ya trataba el nulo como ausente al llamar al servicio
(`typeof amount === 'number' ? amount : undefined`). El guard era **más estricto que el código
al que protege**.

**Por qué no se vio antes:** el contrato en centavos es del 20-abr, pero el guard es del 4-sep y
llegó a producción con el deploy del **5-sep**. Las devoluciones desde la app del **1 y 2 de sep
funcionaron** (verificado en producción) porque el candado todavía no existía. Es una regresión
del servidor contra un cliente que no cambió: las líneas de Android que arman el body no se tocan
desde el 22-abr.

## 3 · Alcance medido en producción (sólo lectura)

- **18 respuestas 400** el 11-sep entre **21:40:46 y 21:50:49 UTC**, venue Testarudo Cafe,
  `okhttp/4.12.0`, todas sobre el pago `cmtxhcf9n05wio82am24woz9c`. Cero reembolsos móviles
  exitosos en la ventana retenida.
- 🟢 **El dinero NO está dañado.** Las 18 devoluciones de los últimos 120 días cuadran contra su
  cobro original (razón 1.0 o parciales plausibles). **No hay ni un reembolso encogido 100×.**
- ⚠️ **Seis peticiones en 1.1 s** (21:41:14.13 → 15.25). ✅ **NO es un candado ausente** —
  comprobado en el código: `enabled = canSubmit` y `canSubmit` incluye `!submitting`. La ráfaga
  ocurrió porque **cada petición fallaba en ~10 ms**, así que el botón se rehabilitaba al instante y
  el cajero pudo seguir tocando. Con un reembolso que sí funciona (~400 ms) no se reproduce. Se
  registra aquí porque la primera lectura fue la contraria y es la que no hay que repetir.

## 4 · Lo que ya está hecho (servidor) — en el árbol, SIN commitear

| Archivo | Cambio |
|---|---|
| `src/services/shared/devueltoDeUnCobro.ts` | predicado nuevo `vieneAusente(v)` = `undefined \|\| null`, con el porqué escrito |
| `src/controllers/mobile/refund.mobile.controller.ts` | los dos guards de `issueAssociatedRefund` usan `vieneAusente` |
| `src/controllers/dashboard/refund.dashboard.controller.ts` | idem (defensa: hoy el web omite, mañana quizá no) |
| `src/controllers/tpv/refund.tpv.controller.ts` | idem + **se restaura** `typeof … === 'number' ? … : undefined`, que `56f78c18` había quitado. Sin eso, un `null` que ahora pasa el candado llegaría al servicio como no-número |

**Prueba nueva:** `tests/unit/controllers/refundNuloEsAusente.controller.test.ts` (17 casos).

**Evidencia:**

| Verificación | Resultado |
|---|---|
| La prueba **en rojo** antes del arreglo | 4 fallan / 13 pasan — fallan exactamente los 4 casos del nulo |
| La prueba **en verde** después | 17 / 17 |
| Suites de reembolso por `avq-verify` | **27 suites · 326 pruebas**, local y Alienware **COINCIDEN** (`run-avoqado-server.2xWffF`) |
| Typecheck por `avq-verify` | **0 errores**, local y Alienware **COINCIDEN** (`run-avoqado-server.J8GHGL`) |
| **Sabotaje S1** (el helper vuelve a mirar sólo `undefined`) | caen **4 de 17**, justo las que guardan el arreglo |
| **Sabotaje S2** (el helper declara todo ausente) | caen **8 de 17**, todas las «rechaza…» ⇒ el candado no se aflojó |
| Control sin sabotaje | 17 / 17 |

Los sabotajes corrieron en un **worktree aislado** (`git worktree add --detach` + rsync del WIP +
`node_modules` por symlink), nunca en el árbol compartido; el worktree se eliminó y se comprobó
que el principal conserva el arreglo. Receta: memoria `sabotaje-tpv-en-worktree-aislado`.

🔴 **Ojo con la vigencia:** las dos corridas avisan *«otra sesión movió el árbol»*. Hay que
repetirlas antes de commitear.

## 5 · Android — HECHO el 2026-09-11 por la tarde (sin commitear)

El founder pidió arreglar la UI («la vi horrible, tapaba los montos»). Al recorrerla en la Sunmi
salieron tres cosas distintas, y de paso el truncamiento que ya estaba declarado.

| Qué | Archivo | Evidencia |
|---|---|---|
| El **hueco enorme** entre la lista y el motivo: la banda del medio usaba `weight(1f, fill = true)`, que la estira a todo el alto sobrante aunque el contenido sea corto | `IssueRefundSheet.kt` | visto antes y después en la tablet |
| **Con 3 artículos se veían 2** y nada decía que hubiera más. Ahora el subtítulo dice «**3 artículos** · Máximo reembolsable: $413.90» (el degradado del borde es transparente→blanco sobre una lista blanca: **no se ve**, por eso el conteo) | idem | captura `lista.png` |
| La casilla **«Incluir propina» desaparecía con el teclado abierto** — decide si se devuelve la propina del mesero, o sea que es DINERO confirmándose a ciegas. Ahora vive en el **pie fijo** (`FilaIncluirPropina`), junto al campo de importe, que también se movió ahí | idem | con el teclado abierto se ven los dos |
| 🔴 El importe **se truncaba**: `(pesos*100).toInt()`. Medido: **1 145 de 20 000** importes entre $0.01 y $200 se devolvían un centavo cortos ($0.29→28, $4.35→434). Ahora `centavosDelImporte()` redondea, como el dashboard e iOS | `RefundSubmitRules.kt` (nuevo) | RED 2/6 → GREEN 6/6 |

| 🔴 **Un modificador sin nombre tumbaba la venta ENTERA.** El servidor responde 200 con `"modifiers":[{"name":null}]` y el decodificador declaraba `name` no anulable ⇒ el detalle no abría y el cajero se quedaba en «Selecciona una transacción», **sin poder llegar al botón de reembolsar**. En kotlinx un default `= ""` sólo cubre que la llave FALTE, no un null explícito. Producción limpia hoy (0 de 4 006), pero bloqueaba la verificación del caso de Dany (efectivo) en la base local | `TransactionModels.kt` + 2 sitios que lo pintan | logcat de la Sunmi; 3 pruebas de decodificación |

**Pruebas:** `RefundSubmitRulesTest` (6, incluido un barrido de los 20 000 importes) y
`RefundSheetLayoutGuardTest` (4 guards de fuente, la técnica de la casa porque el módulo no tiene
Robolectric). **43 pruebas en las 7 clases de reembolso, 0 fallos**, APK compilado e instalado en la
Sunmi y recorrido a mano.

🔑 **El RED fue el sabotaje:** con `.toInt()` cayeron exactamente las 2 pruebas del redondeo
(`run-avoqado-android.67ax6y`); con `roundToInt()` pasan las 6. Para la regla de la propina **no se
corrió un sabotaje aparte** — es una función pura de 3 líneas con aserciones directas sobre sus dos
únicos valores posibles; se declara.

⬜ **Lo que NO se tocó y por qué:**
- `explicitNulls = false` en `RefundRepository.kt`: ya no hace falta (el servidor acepta los nulos) y
  cambiarlo invalidaría la verificación en hardware que sí se hizo con el formato actual del cable.
- **iOS no se portó.** La regla del workspace pide cambiar las dos apps juntas; aquí se declara como
  pendiente en vez de saltarlo en silencio. iOS ya redondea (`Int(round(...))`) y omite los nulos, así
  que sólo le faltaría la parte de layout — y su hoja usa otro motor, así que hay que mirarla antes de
  suponer que tiene el mismo defecto.

## 5-bis · Lo que sigue faltando de Android

✅ **Nada urgente.** De las tres declaradas por la mañana, dos quedaron hechas (arriba) y la tercera
—el botón que «dispara seis veces»— **resultó no ser un defecto**: ver §3, el botón ya está bloqueado
mientras el envío está en vuelo.

### Lo que NO hay que «arreglar»

- ⚠️ **«No sale el dato de la devolución en el ticket ni en la pantalla»**: en este flujo la app
  **no imprime nada y no escribe en el cajón, a propósito** (comentarios en
  `IssueRefundSheet.kt:89-93` y `:603-624`). El `PAY_OUT` del cajón lo escribe el SERVIDOR desde
  el 2026-08-16, justo porque la app lo duplicaba. Lo que Dany no vio es consecuencia de que el
  reembolso **nunca ocurrió** (18 × 400). Hay que volver a mirarlo **después** de desplegar, y
  sólo entonces decidir si falta un ticket de devolución — eso sería producto, no un defecto.
- `createUnassociatedRefund` (`RefundRepository.kt:197-254`) es **código muerto**: su sheet no
  tiene call site y su botón está comentado (`TransactionsScreen.kt:288-305`).

## 5-ter · Barrida del repo por las dos clases que ya se demostraron reales

Tras arreglar la hoja, se barrió **todo `avoqado-android`** buscando más de lo mismo.

### Truncamiento de dinero — 9 sitios más, todos arreglados

`(pesos * 100).toInt()` sin redondear, ahora todos por el helper compartido
**`Double.aCentavos()`** (`core/util/Money.kt`):

| Archivo | Qué convertía |
|---|---|
| `SplitPaymentSheet.kt:466` · `TableOrderScreen.kt:2452` · `TransactionsViewModel.kt:373` | 🔴 importes que **teclea el cajero** — cualquier valor es posible, es donde de verdad muerde |
| `Product.kt:69` y `:172` | el precio del producto ⇒ **es el `unitPrice` del carrito** (`CartViewModel.kt:716/748/779`) y el de mesas |
| `UpsellRule.kt:84` · `CartViewModel.kt:821` · `Discount.kt:96` · `PaymentMethodSelectionScreen.kt:909` | precios de sugerencia, paquetes de crédito, descuento fijo y sugerencias de billete |

⚠️ **Medido en producción el mismo día: 0 de 205 precios de producto activos caen en el caso malo**,
porque un menú real usa precios redondos. Era **mina latente, no incendio** — salvo en los importes
tecleados.

🔑 **Lo que confirma el arreglo:** la suite tenía una prueba llamada literalmente
*«P1 ResolvedModifier priceInCents TRUNCA en vez de redondear — el server difiere en centavos feos»*
que **fijaba el defecto** con la tabla medida ($8.20→819 cuando el servidor dice 820, $4.35→434 vs
435, $0.29→28 vs 29). Alguien ya lo había encontrado y lo documentó en vez de arreglarlo. Se
actualizó a los valores del SERVIDOR — era correcta cuando se escribió.

Guard nuevo `ACentavosTest` (4 pruebas): barrido de los 20 000 importes + un guard de fuente que
recorre `app/src/main/java` y falla si alguien vuelve a escribir la conversión truncando.

### Nulos del servidor que matan una pantalla

Además de hacer `TransactionItemModifier.name` anulable, `TransactionRepository` pasó a
`coerceInputValues = true` — el mismo patrón que ya usaban `UpsellRepository` y
`TpvSettingsRepository`, con su porqué escrito. Sin él, **un `null` explícito en cualquier campo no
anulable se lleva la decodificación de la venta entera**, no sólo ese campo.

### Verificación

**Suite completa de Android: 217 clases · 2 261 pruebas · 0 fallos** antes de que otra sesión metiera
WIP de «la carrera del Cancelar» en el árbol. Después de eso, corrida forzada de las áreas tocadas:
**15 clases · 125 pruebas · 0 fallos**.

⚠️ **20 fallos AJENOS declarados** en `TerminalPaymentServiceHttpTest`: esos archivos aparecen
modificados por otra sesión (`git status`) junto con un `TerminalPaymentCancelacionHttpTest.kt`
nuevo. No se tocaron.

## 5-quater · Auditoría de Codex (gpt-6-astra, high) y port a iOS

**Veredicto: 1 P1 · 3 P2 · 1 P3 — «necesita arreglos antes de mergear».** Auditoría de sólo
lectura, acotada a los archivos de este trabajo (el árbol tenía ~65 archivos de otras sesiones).

🔴 **P1-1 — la coerción de nulos podía presentar una venta como «Cortesía».** `coerceInputValues
= true` en `TransactionRepository` NO distingue el nombre de un modificador del **importe**: un
`"amount": null` caería a `0.0`, el total pasaría de $110 a $10 y la UI lo pintaría como
**cortesía** (`TransactionDetailSheet.kt:681`), con explicación falsa y sin que nada falle.
**Arreglado retirando la coerción**: el campo anulable basta — `TransactionDecodeNullsTest` pasa
sin ella. 🔑 Lección: tolerar nulos se hace **campo por campo**, nunca en bloque sobre dinero.

**P2-2 / P2-3 — mis dos guards no protegían lo que decían.** El de la propina pasaba aunque se
BORRARA la llamada (el patrón encontraba la propia definición) y caía con sólo reformatear
`weight(1f,fill=false)`; el de centavos se evadía con `* 100.0`, paréntesis de más o un comentario
`// round later`. Los dos apretados: ubicación real de la llamada (después de la marca «FIN DE LA
BANDA DESPLAZABLE»), comparación sin espacios, y recorte del comentario antes de mirar.

🔑 **Y el guard apretado encontró un DÉCIMO sitio que se había escapado:**
`PaymentMethodSelectionScreen.kt:901`, `val roundedCents = (rounded * 100).toInt()` — las
sugerencias de efectivo con las que se calcula el cambio. Es exactamente el caso que la auditoría
predijo: la variable se llama `rounded` y burlaba el filtro viejo.

**P3-1** — el comentario del helper decía que truncar es «siempre en contra del cliente»: falso, al
COBRAR el que pierde es el negocio. Corregido.

⬜ **P2-1 NO arreglado y declarado:** en una ventana de 360×640 dp con el teclado (~280 dp), el pie
fijo pide más alto del disponible y sus controles pueden quedar inalcanzables. Codex lo deja en P2
porque cerrando el teclado se recuperan. Es un cambio de diseño del layout que **no se da por bueno
sin compilar y verlo en el aparato**.

### iOS — port del layout hecho y verificado

Las tres cosas de Android, espejadas: el campo de importe y el Toggle de propina salen del
`ScrollView` y entran al pie fijo; conteo de artículos en la lista. El «hueco muerto» **no aplica**:
la hoja de iOS ya es de alto completo (sin `presentationDetents`). iOS **ya estaba bien** en
redondeo (`Int(round(...))`), en el `0`/`nil` de la propina y en omitir nulos.

### Verificación final

| | Resultado |
|---|---|
| Android, tras los arreglos de la auditoría | **15 clases · 125 pruebas · 0 fallos** |
| iOS, iPad Pro 13" (M4) simulado, iOS 18.5 | **`TEST SUCCEEDED` · 1 314 pruebas · 0 fallos** (23 de reembolso) |

⚠️ La primera corrida de iOS salió `exit=65` por el **lanzador de pruebas de UI**
(`avoqado-iosUITests.xctrunner`, «request denied by service delegate») — **0 errores de
compilación**, o sea que el código compilaba y lo que falló fue el simulador. Se repitió con
`-skip-testing:avoqado-iosUITests`. ⬜ Queda sin correr la suite de UI y sin QA en un iPad físico.

## 5-quinquies · Segunda auditoría de Codex (12-sep) — los arreglos del arreglo

Se le pidió auditar **los arreglos de la pasada anterior** (en este repo son la causa más común
de los P1 de la siguiente) más el port a iOS, nunca revisado. Veredicto: **1 P1 · 3 P2 · 1 P3**.

🟢 **Lo que confirmó LIMPIO**, que era el objeto de la pasada: retirar `coerceInputValues` es
correcto y **no resucita** el defecto original (`"modifiers":[{"name":null}]` sigue siendo
admisible porque el campo es anulable); la conversión de la sugerencia de efectivo es correcta; el
comentario corregido también.

### 🟢 P1-1 — CERRADO el 2026-09-12 (era lo más caro que salió, y no era de esta tanda)

**Desmarcar «Incluir propina» no garantiza que la propina se conserve.** Las dos apps mandan bien
`tipRefundCents = 0`; **el servidor lo reasigna después**. Con el cobro original de $100 + $20 de
propina y $90 de venta ya devueltos:

| | Venta | Propina |
|---|---:|---:|
| Disponible | $10 | $20 |
| El cajero pide | $20 con la propina DESMARCADA | |
| **El servidor devuelve** | **$10** | **$10** |

El override explícito se acepta contra la venta ORIGINAL (`refund.dashboard.service.ts:503`) y
luego se reequilibra contra los componentes restantes **aunque hubiera override**
(`:524` + `devueltoDeUnCobro.ts:200`). La discrepancia sólo deja un `warn`; al cajero no se le
vuelve a preguntar. **La pantalla promete algo que el servidor puede incumplir.**

🔑 Codex declara explícitamente que **no se puede atribuir al traslado de `amountBody`**: es
preexistente.

#### El arreglo (12-sep, en el árbol, SIN commitear)

**Un reparto explícito es una restricción, no una sugerencia.** En
`refund.dashboard.service.ts:557`, cuando el llamador manda `tipRefundCents` y el reparto factible
tomaría **más** propina de la pedida, se rechaza con un `BadRequestError` que dice en PESOS cuánto
sí cabe («De este cobro sólo quedan $10.00 de venta sin devolver… Reembolsa como máximo $10.00, o
incluye la propina a propósito»). El mensaje va en pesos y no en centavos como sus vecinos porque
es el único de este archivo que termina en un toast de la tablet y lo acciona un cajero.

🔑 **EL RECHAZO ES DE UN SOLO LADO, y acotarlo costó un test.** La primera versión rechazaba
cualquier discrepancia y rompió una prueba unitaria que ya existía — «componente agotado: si la
propina ya se devolvió, rebalancea el override a venta». Tenía razón la prueba: pedir devolver
propina cuando ya no queda toma **menos** de la autorizada, así que es imposible que perjudique al
mesero, y el total sí cabe en la venta restante. Rechazar ahí dejaría al cajero sin poder cerrar un
reembolso legítimo con el cliente enfrente, y su única salida sería reintentar con
`tipRefundCents: 0`, que es justo lo que el servidor iba a hacer solo. El camino **proporcional**
(sin override) conserva su re-encaje intacto: ahí nadie pidió un reparto concreto.

#### Evidencia

| Qué | Resultado |
|---|---|
| `tests/integration/dashboard/refund-propina-explicita.integration.test.ts` (NUEVO, 4 casos, Postgres real) | **4/4** — `run-avoqado-server.frAOj6` en 🔴 antes del fix |
| Unitarias de reembolso (`refund\|reembolso\|devueltoDeUnCobro`) | **28 suites / 347 pruebas**, local y Alienware **COINCIDEN** |
| Integración de reembolsos | **2 suites / 7 pruebas** |
| `npx tsc -p tsconfig.typecheck.json` | **errores TS: 0**, local y Alienware **COINCIDEN** |
| Sabotaje A · rechazar los dos lados (`>` → `!==`) | tumba **exactamente 2**: la unitaria «componente agotado» y la nueva «pedir más propina de la que queda NO se rechaza» |
| Sabotaje B · retirar el rechazo | tumba **exactamente 1**: «🔴 no consume la propina en silencio» |

Los sabotajes se corrieron en un **worktree `--detach` con el WIP copiado por rsync**, nunca sobre
el árbol compartido; los worktrees quedaron retirados.

#### 🔴 El MISMO defecto vivía en el riel de la TERMINAL, y ahí la corrección es la contraria

Buscando qué controladores comparten el servicio salió que **`refund.tpv.service.ts` re-encaja
igual** (`:719`) y también dejaba sólo un `warn`. Pero **ahí rechazar sería el error**: cuando ese
código corre, el SDK de la terminal (Blumon `CancelIcc` / AngelPay) **ya devolvió el dinero**, así
que un 400 dejaría un reembolso REAL sin fila — peor que el reparto torcido. El propio archivo lo
tenía razonado y dos pruebas lo fijaban como correcto («🔴 reequilibra hacia PROPINA cuando la
venta restante no alcanza»).

Lo que faltaba no era el rechazo sino que **alguien se entere**: se añadió un asiento
`REFUND_SPLIT_NOT_HONORED` en `ActivityLog` con lo pedido, lo aplicado y lo que quedaba de cada
componente, en pesos. Va **post-commit y sin `await` encadenado**, por la misma razón por la que no
se rechaza: un fallo de la bitácora no puede tumbar la transacción y dejar el dinero sin asiento.
El camino normal no escribe nada — se registran las ANOMALÍAS que un dueño audita, no el ruido
diario.

| Riel | Cuándo corre respecto al dinero | Qué hace ahora |
|---|---|---|
| `refund.dashboard.service` (dashboard **y Android/iOS**) | **antes** de mover el dinero | **rechaza** y dice cuánto sí cabe |
| `refund.tpv.service` (PAX / Nexgo) | **después**: el SDK ya devolvió | **re-encaja y lo AUDITA** |

Evidencia del TPV: 2 pruebas nuevas en `tests/unit/services/tpv/refund.acumuladoConPropina.test.ts`
(**29/29** en el archivo), sabotaje C (retirar el asiento) tumba sólo la del rastro y sabotaje D
(auditar siempre) tumba sólo la de control. Suites de reembolso completas: **28 suites / 349
pruebas**, local y Alienware **COINCIDEN**.

⚠️ La ruta `POST /mobile/venues/:id/refunds` (`refund.mobile.service.createRefund`, reembolso NO
asociado a un cobro) no entra: no reparte propina de un cobro original.

⚠️ La prueba de integración exige `TEST_DATABASE_URL` y **se corre con `--selectProjects
integration`**: sin esa bandera avq-verify la manda también al Alienware, que no tiene la base, y
las suites fallan por entorno y no por código.

### P2 — mis guards mentían en las DOS direcciones (arreglado lo arreglable)

- **Falsos negativos**: la expresión partida en dos líneas, `100.00`, `100 * x`, tabuladores, y
  un `round(` en la misma línea sobre OTRA expresión. Ensanchado el patrón (ambos órdenes,
  `100`/`100.0`/`100.00`, espacios y tabuladores); los dos huecos que quedan (multilínea y
  `round(` de otra expresión) **se declaran en el KDoc** en vez de fingir cobertura.
- 🔴 **Falsos POSITIVOS**: rechazaba `(progress * 100).toInt()` — un porcentaje donde truncar es
  deliberado. Un guard que bloquea código legítimo enseña a ablandarlo. Ahora hay salida
  **explícita**: terminar la línea con `// no-es-dinero`.
- **Los guards de layout siguen pasando 7 de 8 mutaciones** (comentar la llamada, `if (false &&
  …)`, envolverla en un `verticalScroll`, callback vacío…). **Caen con la que motivó el guard**
  —borrar la llamada— y con nada más. Se documentó la tabla completa en el propio test: un guard
  que promete más de lo que comprueba es peor que uno que declara su alcance. La protección real
  exige `compose.ui.test`, que el módulo no tiene — **pendiente anotado, no disimulado**.

### P2-3 — iOS hereda el mismo problema de capacidad del pie

El port sacó los controles de dinero del `ScrollView`, pero en un iPhone chico (375×667) con el
teclado decimal abierto **no hay vía de desplazamiento para recuperarlos**: SwiftUI mete el teclado
en el área segura, lo que REDUCE el espacio, y no convierte en desplazables a los hermanos del
`ScrollView`. Es el gemelo del P2-1 de Android. **Los dos siguen abiertos y los dos piden
verificación visual en aparato.**

## 5-sexies · El lado CLIENTE del mismo defecto, cerrado el 12-sep (Android e iOS)

El arreglo del servidor destraba a los aparatos ya instalados sin publicar un APK, pero deja la
mina puesta: el POS seguía mandando `null` explícito y el siguiente guard escrito con esa forma
volvería a tumbar el reembolso. Cerrado en **dos** sitios, no uno.

### `RefundRepository.kt` — el serializador del reembolso

`Json { ignoreUnknownKeys = true; encodeDefaults = true }` **sin `explicitNulls = false`**: un
reembolso por importe viajaba con `"items":null` y uno por artículos con `"amount":null` — los dos
campos exactos que el guard rechazaba. El `Json` se sacó a nivel de archivo (`jsonReembolsos`) para
que una prueba pueda observar el cuerpo REAL en vez de una copia.

**`encodeDefaults = true` se conserva**: `method = "CASH"` del reembolso no asociado tiene default y
el servidor lo necesita para el cajón. Y `tipRefundCents = 0` sigue viajando, porque 0 no es nulo —
«devuelve sólo la venta» y «reparte tú» son cosas distintas, y confundirlas es dinero del mesero.

### 🔴 `NetworkModule.kt` — el MISMO hueco en el converter COMPARTIDO de Retrofit

Un barrido de las 61 construcciones de `Json` del repo encontró que el que Hilt inyecta al
`Converter.Factory` tenía el mismo defecto, con el radio de casi toda la app: alta de artículos a
una orden, detalles de la orden, refresco de token, captura de referidos, materializar un checkout
y los reportes de impresión. `TerminalPaymentService` y `ConteoEnCurso` ya lo llevaban corregido —
el patrón se había reconocido dos veces y el global seguía abierto.

🔴 **Ya estaba mordiendo en otro endpoint:** el Zod de la captura de referidos es
`z.string().optional()` **sin** `.nullable()` (`referrals.schemas.ts:92,104`), así que un
`"intendedOrderId": null` **se rechaza con 400** antes de llegar al servicio. Mismo defecto del
reembolso, latente y sin diagnosticar.

**Antes de tocar algo de ese radio se revisaron en el servidor los 7 cuerpos que salen de ahí:**

| Cuerpo | ¿`null` ≡ ausente? | Evidencia |
|---|---|---|
| items de una orden (9 campos) | **sí** | `order.tpv.service.ts:498-589` — todo `??`/`?.`/`!x`, sólo `create()` |
| detalles de la orden (5) | **sí**, y documentado | `order.mobile.service.ts:1363` dice literal «Android's kotlinx encodeDefaults=true sends null for untouched fields» |
| refresh (`venueId`) | **sí** | `auth.mobile.service.ts:846,898` — comprobaciones de verdad |
| captura de referidos | **sí**, y hoy el `null` ya da 400 | `referrals.schemas.ts:92` |
| materializar checkout (2) | **sí** | `areaTicketV7.mobile.service.ts:1559` (`?? null`, dentro de `create()`) |
| intento de impresión (2) | **sí** | `areaTicketV7.mobile.service.ts:1845` (`?.trim() \|\| null`) |
| **heartbeat del gateway (`address`)** | **NO** | `print.mobile.service.ts:127` — `=== undefined ? undefined : input.address` dentro de un `prisma.printGateway.update`: `null` BORRA la IP, ausente la conserva |

El único que distingue es el heartbeat, y **Android no lo llama**: `gatewayHeartbeat` está declarado
en `ApiService` y no tiene un solo invocador (`syncPrintJobs` sí, desde `ReporteDeComandas.kt:103`).
Cuando se conecte, conservar la última IP conocida es mejor que borrarla — ese campo existe como
respaldo del descubrimiento por mDNS.

### 🔴 P2-1 / P2-3 — el pie que el teclado se comía: MEDIDO en aparato y cerrado

Estaba declarado como «necesita rediseño de layout y verificación en aparato». Se hizo lo segundo
primero, en el OrderPAD 3 (`192.168.1.122`), y el defecto salió **en la pantalla real del aparato,
sin forzar nada**: con un cobro CON propina ($435.98 + $63.99), al tocar el campo de importe el
teclado dejaba fuera el selector de motivo, el resumen «Importe a reembolsar» y **los botones
Cancelar y Reembolsar** — y como el pie no se desliza, no había forma de alcanzarlos sin cerrar el
teclado, ni una sola señal de que existieran.

Los números, medidos y no estimados: encabezado + pestañas 160 dp · pie 365 dp · la casilla de
propina 64 dp más ⇒ **525 dp, o 589 con propina**. Alto disponible con el teclado: ~330 dp en una
pantalla de 640 dp y ~600 dp en un celular moderno — o sea que en el chico no cabe por mucho y en el
grande cabe por 11 dp, que cualquier ajuste de fuente por accesibilidad se lleva.

**El arreglo:** un `BoxWithConstraints` con el `imePadding` encima mide el alto YA descontado el
teclado; por debajo de 640 dp la banda informativa cede su sitio entero y el pie gana su propio
deslizamiento. Con espacio sobrado el modificador es `Modifier` vacío y **la pantalla queda como
estaba** — por eso no se usan dos `weight` a la vez: repartir el sobrante deja hueco muerto cuando
uno de los dos es corto, que es justo el defecto que se arregló el 11-sep.

🟢 **Verificado en el aparato, con el teclado abierto:** tras deslizar, el motivo (y=265), el resumen
(y=404), el aviso de la tarjeta (y=503) y **los dos botones (y=557)** quedan alcanzables sin cerrar
el teclado. No se emitió ningún reembolso: el importe se dejó en $0.00.

⚠️ Dos límites declarados: en **horizontal a 640×360 dp** la hoja mide ~112 dp con el teclado y ahí
no hay layout que salve (no caben ni las pestañas); y la app **se ejecuta en horizontal** en esa
tablet, así que el caso vertical sólo se pudo medir forzando la resolución.

**iOS (P2-3)** recibió el mismo criterio con `ViewThatFits(in: .vertical)`: prueba el pie tal cual y
sólo si no cabe lo entrega envuelto en un `ScrollView`. En iOS 15 (aún soportado) queda como hoy —
sin arreglo, pero sin regresión. ⬜ **Falta verlo en un iPad**: compila, no se ha mirado.

### Evidencia

| Qué | Resultado |
|---|---|
| `RefundRequestJsonTest` (NUEVO, 5 casos) | 5/5 — visto en 🔴 3/5 antes del arreglo |
| `NetworkJsonNullsTest` (NUEVO, 4 casos) | 4/4 — visto en 🔴 2/4 antes |
| Guards del reembolso (7 suites) | 34/34 |
| **Suite completa de Android** | **218 suites · 2 266 pruebas · 0 fallos** |
| `./gradlew assembleDebug` | exit 0 |
| iOS `xcodebuild build` | **BUILD SUCCEEDED** con 8 compilaciones Swift (la corrida previa fue 100 % incremental y su verde no valía) |

## 5-septies · Auditoría adversarial de Codex (gpt-6-astra, xhigh, 12-sep) — 2 regresiones MÍAS

3.5 M de tokens, 31 comandos, sólo lectura. Encontró seis cosas; **dos eran regresiones que yo
había introducido ese mismo día** y una tercera un defecto vivo que nadie había diagnosticado.

### 🔴 Cerradas

**1 · `explicitNulls = false` en el converter COMPARTIDO rompía el borrado de `PrintJob.error`.**
Yo lo había puesto en `NetworkModule` para cubrir de una vez los 36 `@Body` de `ApiService`.
Pero el servidor usa `error: null` como **«borra el error viejo»**, y lo dice en su propio
comentario (`print.mobile.service.ts:75`: «null explícito limpia un error viejo al recuperarse;
undefined lo deja intacto»). `ReporteDeComandas` manda `DONE` + `error = null` justo cuando una
comanda que había fallado por fin SALE. Omitir esa llave dejaba el «Sin papel» pegado y la
comanda impresa seguía figurando como fallida.
🔑 **La lección, que vale más que el arreglo: «null ≡ ausente» es propiedad de CADA endpoint,
no del cliente.** El cambio global se **revirtió**; el arreglo del reembolso se queda donde el
daño está demostrado (`RefundRepository.jsonReembolsos`). `NetworkJsonNullsTest` pasó a ser el
guard INVERSO: exige que el nulo siga viajando, y explica por qué, para que nadie lo repita.

**2 · El modo compacto del layout ESCONDÍA los artículos.** Mi `apretado` miraba sólo el alto,
y en la banda no vive únicamente el aviso: viven `ItemsBody` y «Abrir en la terminal». Con 600 dp
y **el teclado cerrado**, la pestaña de artículos quedaba pidiendo «Selecciona al menos un
artículo» sin un artículo que tocar, y sin forma de recuperarlos. Ahora `apretado` exige además
`tab == AMOUNT`, la única pestaña donde la banda es prescindible (su aviso lo repite el pie); en
artículos el pie mide ~200 dp y cabe sin comprimir nada.

**3 · Un 400 VIVO en producción que nadie había diagnosticado.** El Zod de la captura de
referidos es `z.string().optional()` **sin** `.nullable()`, y el POS manda
`intendedOrderId: null`: la petición rebotaba antes de llegar al servicio. Es el MISMO defecto
del reembolso, en otro endpoint. Arreglado con `.nullish()` en los dos esquemas, en el servidor,
que es su capa. 5 pruebas nuevas, vistas en rojo (2/5) antes.

**4 · La casilla de propina podía no verse al confirmar.** Cierto: en compacto vive dentro del
scroll del pie. El reparto se dice ahora **junto al botón** («Incluye la propina del mesero» /
«Sin tocar la propina del mesero»), así que la decisión se lee sin depender de dónde quedó el
scroll.

### ✅ Lo que la auditoría confirmó que estaba bien

`vieneAusente` **no debilita ningún guard**: `NaN`, `Infinity`, `"6500"`, `[]`, `{}`, `1e21` y
`-0` siguen rechazados y no llegan a Prisma. Y no hay scrolls verticales anidados: banda y pie
son alternativas, no padre e hijo.

### ⬜ Abierto, con decisión del founder pendiente

**A · `unclassifiedPriorRefundCents > 0` salta el bloque del reparto entero** (`:482` y `:524`),
así que con historia sin clasificar se pueden registrar repartos imposibles: el caso de Codex
escribe **$110 de venta devuelta sobre $100 vendidos**. Es un hueco PREEXISTENTE que mi arreglo
no cubre —el rechazo vive dentro de ese `if`—. Cerrarlo cambia cuándo se rechaza un reembolso,
así que no se toca sin decidirlo.

**B · 🟢 RESUELTO — el rechazo pasa a ser de los DOS lados (decisión del founder, 12-sep).**

Se le consultó a una auditoría independiente (Codex gpt-6-astra, high) y su veredicto fue claro:
*«"Todo de propina" es una instrucción exacta: sustituirla por consumo cambia lo autorizado; la
asimetría actual no tiene justificación de producto.»* También desarmó mi propio argumento de los
datos: los 26 reembolsos **no permiten estimar el riesgo**, porque ninguno tocó propina y el POS
estuvo roto parte del periodo — medí la ausencia del caso, no su probabilidad.

🔑 **Y separó dos problemas que yo tenía mezclados, que es lo que más valió de preguntarle:**

| | Qué es | Qué lo arregla |
|---|---|---|
| 1 | El servidor **cambia de componente** sin avisar | este guard |
| 2 | Repetir la operación **devuelve dos veces** | sólo una llave de idempotencia |

Si el cobro tuviera $40 de propina y el cajero pidiera $20 dos veces, **las dos caben** y se
devuelven $40: el guard no lo impide. Cierra que el servidor MIENTA sobre el concepto, no el
duplicado. ⬜ La idempotencia de este carril queda pendiente y declarada (el riel de la terminal
sí la tiene desde el 3-sep, `Payment.idempotencyKey`).

**Del mercado, buscado en vivo y sin adornos:** ni Square, ni Toast, ni Clip, ni Stripe documentan
este caso exacto. Toast deja devolver sólo propina y muestra una confirmación; Square no permite
ajustar parcialmente esa partida; Stripe no tiene un campo equivalente pero **sí ofrece
idempotencia** para que repetir una petición no duplique nada — que es justo el problema 2.

**El mensaje no es genérico, a propósito** (aviso de Codex: un «error» a secas hace que el cajero
lo intente otra vez): dice cuánto se devolvió ya de consumo y de propina, **la fecha del último**,
lo que queda de cada componente, y cierra con «revisa si ya lo devolviste antes». 5 pruebas de
integración (una comprueba el texto) y 43 unitarias.

🔴 **Dos pruebas cambiaron de veredicto conservando su escenario**, y queda escrito por qué: la
unitaria «componente agotado…» fijaba el rebalanceo como correcto —lo era para el mesero, no para
el negocio— y mi cuarta prueba de integración consagraba el mismo coste. Ninguna se debilitó: las
dos exigen ahora que **no se escriba nada**, ni el reembolso ni el decremento del turno.

<!-- histórico -->
**B (planteamiento original) · El rechazo de un solo lado convertía «devuélveme propina» en «devuélvele venta».** Mi
criterio fue «tomar MENOS propina de la pedida no puede perjudicar al mesero». Codex señala lo
que no miré: **perjudica al NEGOCIO**. Pedir dos veces `{amount: 2000, tipRefundCents: 2000}`
sobre $100 + $20 devuelve $20 de propina y luego **$20 de venta**, aunque las dos veces se pidió
«sólo propina». Si la segunda era un reintento, el negocio devolvió el doble. Mi cuarta prueba de
integración **fija ese comportamiento como correcto**. Rechazar los dos lados lo cierra, pero deja
al cajero sin poder cerrar un reembolso con el cliente enfrente, y rompe una prueba unitaria que
ya existía. Es decisión de producto.

### 📏 Y lo primero que había que hacer antes de decidir: MEDIR si pasan

Producción, sólo lectura, 12-sep. Los dos huecos A y B son **teóricos hoy**:

| Medida (180 días salvo donde se diga) | Resultado |
|---|---|
| Reembolsos totales | **26**, en 4 negocios, del 27-abr al 2-sep |
| Cobros con **dos o más** reembolsos (lo que exige el caso B) | **0** |
| Reembolsos que **tocaron la propina** | **0 de 26** — ninguno, nunca |
| Cobros con acumulado pero **sin filas clasificables** (lo que exige el caso A) | **0** |
| Cobros CON propina en los últimos 30 días | 1 071 |

O sea: hay volumen de sobra de cobros con propina y aun así **nadie ha devuelto propina jamás**.
⚠️ El matiz que impide leer esto como «no importa»: el reembolso desde el POS llevaba **roto
desde el 5-sep**, así que estos 26 salen de un mundo donde casi nadie podía reembolsar. Al
desplegar, el volumen sube — conviene decidir antes, sin prisa pero antes.

**C · 🟢 CERRADO el mismo día — la auditoría del TPV ya no era durable, ahora sí.** `void
logAction` va post-commit y sin `await`: una excepción tragada o un proceso que muere dejaba
CERO rastro de que alguien pidió respetar la propina, porque ni el `Payment` ni su historial
guardaban `requestedTipCents`. Ahora el reembolso del TPV persiste la intención en su propio
`processorData`, **dentro de la misma transacción que lo crea** — si el reembolso existe, la
intención existe (`splitHonored: false`, `requestedTipCents`, `appliedTipCents` y los dos
remanentes del momento). La bitácora se conserva, porque es lo que un dueño audita; deja de ser
la única copia. El camino normal no añade ninguna de esas llaves. 2 pruebas, vista la roja antes.

## 6 · Orden de despliegue

1. **Servidor primero.** Es lo único que hace falta para que Dany reembolse hoy: arregla a
   **todos** los aparatos que ya están instalados, sin tocar un APK. Va con el P1-1 cerrado dentro:
   el guard de `vieneAusente` desbloquea el reembolso, y el rechazo del reparto infactible impide
   que el primer reembolso desbloqueado se coma una propina que el cajero pidió respetar.
2. Android después, cuando toque release. Los tres cambios de §5 son aditivos; ninguno cambia el
   contrato.
3. iOS **no se toca** en este trabajo (ya es correcto en nulos y en redondeo).

## 7 · Auditado y descartado (para no volver a investigarlo)

- **La PAX/TPV NO tiene este defecto:** su DTO usa **Gson** (`@SerializedName`,
  `features/payment/data/dto/RefundRequest.kt`), y Gson **omite los nulos** por defecto. Aun así
  se le arregló el guard y se le restauró la normalización, porque el controlador no puede
  depender de con qué librería serializa su cliente.
- **El cobro remoto tablet → terminal está a salvo:** ahí `tipCents` es `Int` **no anulable** en
  Android (`PendingPaymentEntity.kt:19`), así que nunca viaja como null.
- Barrida: 69 usos de `!== undefined &&` en controladores. La mayoría son spreads
  (`...(x !== undefined && {x})`), donde un null simplemente no actualiza el campo — inocuo. El
  único con forma de candado de dinero sobre un campo opcional era el de reembolsos.

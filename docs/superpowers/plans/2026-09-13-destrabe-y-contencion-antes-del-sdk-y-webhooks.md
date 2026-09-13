# Destrabe por consulta, contención de las rutas sin registro y banner honesto

**Estado:** plan para auditar con Codex ANTES de escribir una línea. Nace de dos cosas del
12-sep: el founder se quedó sin poder cobrar en una Nexgo, y la auditoría de Codex
(`gpt-6-astra` xhigh, sesión `01a097cc`) encontró rutas que mueven dinero sin registro.
**Es el paso previo al SDK nuevo de Blumon y al webhook como primer confirmador.**

## Los dos límites que juzgan cada decisión (founder, 12-sep)

> «no podemos interrumpir el proceso de cobro en un negocio, eso sería catastrófico, pero
> tampoco dejando de lado que cobren doble, o no se registre la venta, o que registre la
> venta sin que en realidad haya pasado el cobro»

Se aplican **juntos**. Hoy el sistema cumple el segundo bloqueando la terminal, y falla el
primero porque ese bloqueo no tiene salida por pantalla: las dos veces que ocurrió hubo que
escribir SQL en la base del aparato. **La resolución no es quitar el bloqueo** (eso produjo el
cobro doble del 10-ago): es que **dure segundos y lo resuelva el cajero**.

## Lo que ya está medido (no re-investigar)

| Hecho | Evidencia |
|---|---|
| Una sola fila `INDETERMINADO` reserva la terminal ENTERA, sin filtrar por venue | `PaymentAttemptDao.reserveTerminal` |
| Un cobro RECHAZADO que dejó la libreta incierta bloquea **para siempre**: la recuperación sólo cierra con `Cobrado`, y `NoCobrado` es inalcanzable por diseño | `LedgerUnknownRecovery:44`, `AngelPayChargeVerifier:127` |
| No existe endpoint donde la terminal pregunte por el desenlace de un intento | `ApiService.kt`, sin resultados |
| El banner cuenta filas heredadas y REEMBOLSOS como «cobros pendientes»; la consulta que bloquea sí filtra `legacy_shadow` | `RemotePaymentRequestDao.observePendingObligationCount` vs `reserveTerminal` |
| **Cancelar y Devolver del historial del procesador mueven dinero y no registran nada** (sólo Nexgo: el adaptador Blumon lanza `UnsupportedOperationException`) | `PaymentTransactionsViewModel.executePostOperation` |
| El reembolso Nexgo entra al SDK aunque falle la reserva o la escritura previa, y su contexto no lo puede reconstruir la recuperación (sólo entiende ventas) | `RecordAngelPayRefundUseCase:137,490`, `LedgerApprovalRecovery:62` |
| Una cancelación con `approved=false` puede encadenar una devolución sin exigir rechazo definitivo | `RecordAngelPayRefundUseCase:529` |
| La recuperación abandona a los 5 intentos y sólo atiende la sucursal actual | `PaymentAttemptDao:11`, `LedgerShadowSweepWorker:53,118` |
| Dos registros simultáneos del mismo reembolso total pueden dar un 400 falso que la terminal marca permanente | `refund.tpv.service.ts:350,689,1068` |

## 🔴 F0 · CERCAR LA VENTA, NO EL APARATO — lo que de verdad cumple la primera mitad

Auditoría de Codex (`gpt-6-astra` xhigh, sesión `01a097dc`): **NO APRUEBA** este plan como
solución a los dos límites, y su objeción de fondo es la primera mitad del founder:

> «Cómo sigue cobrando el negocio cuando ningún sistema puede acreditar el desenlace. El caso
> E699 puede seguir siendo UNRESOLVED después de cien consultas. Sin esa salida, "que dure
> segundos" sigue siendo una aspiración.»

Tiene razón, y el código dice por qué. `PaymentAttemptDao.reserveTerminal` tiene **tres**
guardas, y sólo una es la que apaga el aparato:

| Guarda | Alcance | ¿Protege de un cobro doble? |
|---|---|---|
| 1. cualquier fila incierta (`findTerminalHold`) | **TODO el aparato**, sin filtrar venue ni venta | No: una venta NUEVA no tiene relación con la incierta |
| 2. `orderJsonFragment` | la MISMA venta | **Sí** — es la que impide recobrar la misma cuenta |
| 3. lápida del `requestId` | la MISMA solicitud | **Sí** |

Las guardas 2 y 3 son las que cuidan el dinero. **La guarda 1 es la que dejó a la Nexgo
inservible, y no aporta protección contra el cobro doble**: mezcla dos cosas distintas.

- **Ejecución en curso** (`PREPARANDO`, `KERNEL_ACTIVO`, `AUTORIZANDO`): el SDK está dentro
  del aparato. Aquí el bloqueo del aparato es **físico y correcto** — no se puede llamar dos
  veces al lector a la vez.
- **Obligación pendiente** (`INDETERMINADO`, `HOST_RESPONDIO`, `AUTORIZADO`,
  `REGISTRO_FALLIDO`): el SDK ya salió. Falta acreditar o registrar. **Eso cerca una VENTA,
  no un aparato.**

**F0, entonces:** la guarda 1 se reduce a la ejecución en curso; las obligaciones pendientes
pasan a cercar su venta por las guardas 2 y 3, que ya existen. Consecuencia: el negocio
**sigue cobrando otras ventas** mientras la incierta queda cercada, visible y consultable.
Con eso, F2 deja de ser la única salida y pasa a ser lo que cierra el caso.

🔴 Condiciones que F0 NO puede relajar: la venta cercada sigue sin admitir otro cobro; una
obligación sin registrar sigue siendo **barrera del cierre de caja**; y el aparato sigue
bloqueado de verdad mientras el SDK esté dentro. Si no se puede acreditar que el SDK salió,
se trata como ejecución en curso.

### 🟡 F0 · CONSTRUIDO Y VERIFICADO el 12-sep — pero **NO se puede entregar solo**

Todo en `avoqado-tpv`, **sin commitear**. 1 834 pruebas en 152 suites, 0 fallos; producción
compila (`compileProductionDebugKotlin` exit 0, comprobado en un árbol aislado con SÓLO este
cambio, porque el árbol compartido trae el trabajo del QR del recibo de otra sesión).

**Verificado rompiéndolo a propósito: 8 de 8 sabotajes caen en la prueba que los guarda** (árbol
aislado, nunca el compartido; control en verde 11/11 antes y el árbol restaurado después):

| Sabotaje | Cae |
|---|---|
| S8 el criterio de identidad vuelve a discrepar del SQL (`isNullOrBlank`) | ✅ la del `orderId` de espacios |
| S7 la adopción ignora la identidad de la solicitud | ✅ la de adoptar SU cobro |
| S6 el respaldo adopta cualquier fila única, con dueño o sin él | ✅ la de la fila que nombra OTRA solicitud |
| S1 la guarda del aparato vuelve a apagar la caja entera | ✅ la de «cerca su venta y deja cobrar las demás» |
| S4 se cae la cerca por venta (guarda 2) | ✅ la misma |
| S2 la barrera de autorización vuelve a ser del aparato | ✅ la misma |
| S3′ el aparato se suelta sin identidad, **en las DOS capas** | ✅ la de la venta sin cuenta |
| S5′ `HOST_RESPONDIO` deja de apartar, **en las DOS capas** | ✅ la del kernel todavía dentro |

🔑 **S3 y S5 NO caen rompiendo una sola capa** — hay que romper la reserva Y la barrera de
autorización a la vez. Eso no es una prueba decorativa: es la redundancia haciendo su trabajo, y
queda escrito en el código para que nadie borre la segunda creyendo que una prueba la cubre.

⚠️ Costó dos intentos por la máquina, no por el código: el daemon de Kotlin no conseguía sus 4 GB
(«Not enough memory to run compilation») y compilar DENTRO de Gradle fue peor — 535 % de CPU
durante 40 min sin escribir un archivo. Se resolvió dándole al daemon una cifra propia y alcanzable
(`kotlin.daemon.jvmargs=-Xmx3g`, Gradle a 1.6 GB) **sólo en el árbol aislado**; el control pasó en
3 minutos. El `gradle.properties` del árbol compartido no se tocó.

**Qué cambió**, y resultó que el candado del aparato vivía en TRES sitios, no en uno:

| Sitio | Antes | Ahora |
|---|---|---|
| `reserveTerminal`, guarda 1 | cualquier fila no resuelta apagaba la caja | sólo ejecución en curso, o una obligación **sin `orderId`** |
| `casTransition` con `AUTORIZANDO` | igual, un piso más abajo | igual criterio (sin `PREPARANDO`) |
| `findTerminalHold` | igual (sólo lo leen pruebas) | igual criterio |
| `reserveTerminal`, guarda 2 | cercaba la venta **dentro del mismo venue** | cerca la venta en **todo el aparato** (el `orderId` es un cuid global) |

🔴 **`HOST_RESPONDIO` cuenta como ejecución en curso, no como obligación pendiente** — hallazgo
de Codex: la PAX lo escribe ANTES de terminar el kernel (`CompleteEmvTrans` corre después), así
que ahí «el SDK ya salió» sería falso. Se paga con que una fila atorada en ese estado aparte la
caja; es el lado conservador.

**Efecto medido**: una venta incierta con cuenta ya NO apaga la terminal — el negocio sigue
cobrando las demás cuentas— y esa misma cuenta sigue sin admitir un segundo cobro.

**Y un riesgo NUEVO que abrió el cambio, cerrado en el mismo trabajo:** desde que pueden convivir
varias obligaciones pendientes, un ViewModel recreado ya no puede adoptar «la más reciente» —le
colgaría a una solicitud el desenlace de otra cuenta—. Ahora adopta por
`terminalPaymentRequestId`, y sólo cae al comportamiento anterior si hay UNA sola pendiente **y
esa fila no nombra ninguna solicitud**.

### 🔴 Auditoría de Codex del diff (`gpt-6-astra` xhigh, sesión `01a0981d`): «no aprobaría este cambio todavía»

Tres P1. Los dos primeros son de **producto**, no de código, y son la razón por la que F0 no sale solo:

1. **Volver al carrito crea OTRA orden para la misma compra.** Tras un resultado incierto el
   cajero vuelve al carrito (que conserva los productos), toca Cobrar y `prepareForPayment()`
   crea una orden nueva: la cerca por `orderId` no reconoce que es la misma venta.
2. **La misma venta se puede repetir como Pago rápido**, que no lleva `orderId` y por tanto no
   tiene cerca.
3. **La adopción podía contaminar una fila ajena** — ✅ **cerrado**, con su prueba.

🔑 **Por qué 1 y 2 no se arreglan con más candados:** desde la libreta, «reintento de la venta
incierta» y «una venta nueva idéntica» son **indistinguibles**. Bloquear por importe igual
apagaría la segunda taza de café de $50 del día, que es interrumpir el negocio. **Sólo el cajero
sabe cuál de las dos es.**

⇒ **DECISIÓN DEL FOUNDER (12-sep): F0 se entrega JUNTO con el aviso visible.** Entregarlo solo
cambiaría «la terminal se apaga» por «se puede recobrar sin que nadie avise»: sería cambiar el
primer límite por el segundo.

### 🟢 EL AVISO · CONSTRUIDO el 12-sep (sin commitear) — lo que hace entregable a F0

**Lo que decía antes:** «Hay 2 cobros pendientes de confirmar. No repitas esas ventas.», sólo en
el **Inicio**, con un botón de «Ayuda». Un conteo no le deja al cajero decidir nada: no sabe si lo
que tiene enfrente es la venta incierta o una nueva.

**Lo que dice ahora:** «Quedó un cobro de **$120.50** sin confirmar **hace 3 min**. Si es esta
misma venta, no la cobres otra vez.» Con varias, dice cuántas y nombra la más reciente.

**Y dónde:** en las **tres** rutas donde cambia una decisión —Inicio, **Pago rápido** y
**carrito**—, que son exactamente las dos puertas que Codex midió para recobrar la misma venta con
otra identidad. En el Inicio el aviso llega cuando el cajero ya pasó de largo.

| Pieza | Qué cambió |
|---|---|
| `RemotePaymentRequestDao` | la consulta del conteo pasa a **lista** con importe y antigüedad; el conteo se deriva de ella, así no pueden divergir |
| idem | 🔴 `kind = 'SALE'`: una **devolución** pendiente ya no se cuenta como «cobro por repetir» — decía «no repitas esas ventas» sobre dinero que va al revés |
| `AvisoDeCobrosPendientes` (nuevo) | el texto, puro y probado: importe, antigüedad, y nunca «hace -4 min» ni «hace 0 min» |
| `NavRoute.RUTAS_QUE_AVISAN_DE_COBROS_PENDIENTES` | las tres rutas viven con las rutas reales, donde una prueba las alcanza |

🔴 **Las filas HEREDADAS siguen contando**: no apartan la terminal, pero son dinero de desenlace
desconocido igual que las demás, y de eso avisa esto.

**Verificado:** 1 844 pruebas en 153 suites, 0 fallos · `compileProductionDebugKotlin` exit 0 con
la clase nueva generada bajo `productionDebug` (comprobado el `.class`, no sólo el código de
salida) · **4 de 4 sabotajes caen en la prueba que los guarda** (contar devoluciones · el texto
sin dinero · el aviso sólo en el Inicio · la antigüedad negativa).

🔑 **El cuarto sólo cae rompiendo las DOS protecciones a la vez** (`coerceAtLeast` y la rama
`minutos < 1`), igual que S3′ y S5′ de F0. Queda escrito en el código: es redundancia, no una
prueba decorativa. ⚠️ Y salió un defecto de mi propio arnés de sabotajes —dos ediciones al mismo
archivo partían siempre del original, así que la segunda pisaba la primera— que hacía parecer
inofensivo un sabotaje que sí lo es.

### 🔴 SEGUNDA AUDITORÍA DE CODEX sobre TODO el cambio (12-sep, sesión `01a098e6`): 2 P1 NUEVOS — los dos cerrados

El founder la pidió sobre el trabajo completo (F0 + adopción + aviso). Codex verificó los
predicados reproduciéndolos en SQLite con el esquema 34 y el SQL real de los DAO.

🔴 **P1 — «la única pendiente sin dueño» también describe a una venta LOCAL legítima.** El
respaldo de la adopción podía cerrar la obligación de A con el cobro de B. Secuencia medida: A es
una venta local incierta (sin solicitud del POS); F0 deja entrar B, del POS; la recuperación
registra B **antes** de que llegue su callback; buscar por la solicitud de B no encuentra nada
(`REGISTRADO` queda fuera) y el respaldo elegía **A**. El callback aprobado de B escribía su
autorización sobre A, y A quedaba `REGISTRADO` **sin haberse registrado nunca**: su obligación
desaparecía del aviso y de la cerca. **Cerrado retirando el respaldo**: la adopción es sólo por
identidad. Unicidad no demuestra pertenencia. De paso, el callback dejó de poder marcar
`INDETERMINADA` una fila ajena (usaba la consulta de APARATO).

🔴 **P1 — el KIOSCO no veía ningún aviso y podía cobrar dos veces la misma compra.** El flujo de
autoservicio sale de `AppNavigation` antes de dibujar el banner; y al reiniciar conserva el modo
kiosco pero pierde su orden en memoria, así que crea otra y F0 la admite. **Cerrado por el lado
correcto, que no es el aviso:** en autoservicio **no hay cajero** que distinga un reintento de una
venta nueva, y la pantalla la ve el cliente —no se le puede preguntar ni enseñarle el importe de
la venta de otro—. Así que en kiosco **cualquier** obligación pendiente vuelve a apartar el
aparato (`esKiosco` en `reserveTerminal`). Es el único sitio donde F0 se revierte a propósito.

**También cerrados, del mismo informe:** la antigüedad sale de `created_at` y no de `updated_at`
(una cuarentena hacía que una venta de hace horas dijera «hace unos segundos» — justo la pista que
el cajero necesita), y el aviso **nombra hasta tres importes** en vez de sólo el más reciente (con
$120 y $50 decía «2 cobros… $50» y la de $120 quedaba irreconocible). ⚠️ Al escribir eso metí un
defecto propio y lo cacé: contaba las comas del texto para saber cuántas faltaban, y `$8,856.00`
lleva coma — se rompía justo en los importes grandes. Tiene su prueba.

**Declarado y NO cerrado** (del mismo informe): el conteo del aviso dice 50 a partir de 51 (ningún
dinero cuelga de ese número); una fila heredada en `PREPARANDO` o un `KERNEL_ACTIVO` muerto no
aparecen en el aviso (omisión previa, no del cambio); en AngelPay un proceso que muere entre el
callback y el registro deja un `HOST_RESPONDIO` que aparta la caja hasta la cuarentena; y varias
pruebas viejas que pasan por el motivo equivocado. Lo que Codex nombra como lo más importante que
sigue faltando es **poder abrir una obligación y volver a consultar su desenlace desde la
terminal** — que es exactamente F2.

**Estado tras la auditoría:** 1 846 pruebas en 153 suites, 0 fallos; `compileProductionDebugKotlin`
exit 0 con la variante de producción recompilada (comprobado el `.class`, no sólo el código de
salida).

**Lo que Codex dejó abierto y NO es de F0:** un cobro incierto **sin** `orderId` sigue apagando
la terminal entera aunque traiga un `terminalPaymentRequestId` perfectamente identificable. Eso
lo cierra F2.

### 🟢 Los dos huecos que Codex dejó FUERA de la autorización, CERRADOS (13-sep)

Codex autorizó el commit de F0 («Sí: autorizo el commit del diff auditado en `main` del TPV. No
encontré P1 nuevos») y excluyó dos defectos **preexistentes**, no introducidos por ese diff. Los dos
quedaron cerrados con TDD el mismo día, cada uno con su prueba en ROJO antes del arreglo.

**(a) La recuperación EXITOSA de PAX soltaba el lector con `CompleteEmvTrans` pendiente** (confianza
10/10). La PAX escribe `HOST_RESPONDIO` **antes** de `CompleteEmvTrans`, y `LedgerApprovalRecovery`
reclama por ANTIGÜEDAD (120 s): al registrar bien dejaba la fila en `REGISTRADO`, que no aparta el
aparato. La rama de FALLO ya era correcta desde F0 (`REGISTRO_FALLIDO` retiene) — esa asimetría era
la pista. Arreglo: `LlamadasNativasEnVuelo` anota qué intentos tienen su llamada nativa viva **en
este proceso** y la recuperación no toca esas filas; su dueño las registra al salir.

🔑 **Por qué la memoria del proceso es el alcance correcto y no un atajo:** una llamada nativa no
sobrevive a la muerte de su proceso, así que tras un reinicio —el caso normal, «quedó una fila a
medias»— la recuperación procede igual que antes. Persistirlo en Room diría lo contrario de la
verdad al reiniciar y volvería a bloquear la terminal, que es justo lo que F0 cerró.

🔴 **Con tope de 10 min.** Sin él, una llamada que nunca vuelve dejaría el cobro sin registrar para
siempre y el aparato apartado sin salida — la Nexgo inservible de Testarudo. Pasado el tope se
vuelve al comportamiento anterior: es el suelo, nunca peor.

Las dos fronteras viven SÓLO en la libreta (`markAuthorizing`/`markKernelEntered` encienden;
registrar, fallar el registro, encolar, rechazo del kernel y descartar apagan) y
**`markHostResponded` NO apaga la marca**, que es el punto entero del mecanismo.

**(b) `onAngelPaySdkResult` de NEXGO no adoptaba por identidad** (9/10). Con el ViewModel recreado,
`currentPaymentAttemptId` es null y TODAS las escrituras de la libreta van bajo `?.let`: una
declinación limpia del emisor dejaba la fila `AUTORIZANDO` para siempre y la terminal retenida.
`onAngelPayResult` (app-to-app) ya lo recuperaba; cuál de los dos caminos entrega el resultado
depende de la versión del SDK, no del negocio, así que tener sólo uno recuperado dejaba el defecto
vivo en media flota. La adopción es la misma: **sólo por identidad de la solicitud**.

**Verificado:** 1,860 pruebas / 153 suites / 0 fallos (10 nuevas); `compileProductionDebugKotlin` y
`compileNexgoDebugKotlin` en exit 0 con `LlamadasNativasEnVuelo` generada; **5 sabotajes en worktree
aislado y cada uno tumba EXACTAMENTE la prueba que lo guarda** (control limpio antes y después).
Commits en `main` del TPV: `149dcc3` (PAX) · `cd26e26` (Nexgo) · `5a4b5df` (changelog).

⬜ Sigue sin QA en hardware, sin push y sin desplegar.

## Lo que Codex exige antes de implementar (todos verificados en el código)

| # | Hallazgo | Qué cambia |
|---|---|---|
| P1-1 | El servidor guarda evidencia por SOLICITUD, no por INTENTO, y hay intentos sin solicitud (cobro local, reembolso) | Adelantar de F5 el **registro durable del intento** (`attemptId → requestId`, tipo, aparato, afiliación, importes) ANTES de cobrar |
| P1-2 | `CHARGED → REGISTRADO` libera el aparato **con el SDK todavía dentro** | Separar «pago confirmado» de «ejecución terminada»; sólo lo segundo libera |
| P1-3 | **PAX también** ignora el resultado de `openAttempt`/`markAuthorizing` en el reembolso por chip | F1.2 cubre los dos procesadores y los dos sabores |
| P1-4 | El reembolso rechazado no cierra su fila, y escribe `"angelpay"` donde la recuperación busca `"ANGELPAY"` | Tres desenlaces para el REEMBOLSO, con su evidencia negativa; verificador propio (el de ventas exige operación `VENTA`) |
| P1-5 | La llave del reembolso se deriva de pago original + importe + autorización + referencia: reconstruirla mal **registra dinero que no se devolvió** | F1.4 reproduce el MISMO contenido durable que la cola |
| P1-6 | El reembolso Nexgo prueba **referencias alternativas** de otras transacciones del historial con sólo coincidir el importe | Retirar el emparejamiento por semejanza; toda referencia alternativa necesita vínculo acreditado |
| P2 | Dos registros simultáneos del mismo reembolso total dan un **400 falso** que la terminal marca permanente | Recomprobar la idempotencia DENTRO de la transacción, tras el candado y antes de rechazar por saldo |

Y una advertencia sobre F3: `OPERATOR_RECONCILED_NO_CHARGE` acredita hoy la ausencia de cobro
**por el código de estado solamente**. Ese marcador heredado **no** puede convertirse
automáticamente en permiso para descartar una fila local.

## El SDK nuevo de Blumon (lo que Codex sí pudo sostener con el código)

- Sandbox y producción usan **AAR distintos** (1.6.1.2 contra 1.2.0.0): el QA de sandbox **no
  acredita** el comportamiento de producción. El AAR nuevo de producción **no está en
  `app/libs`**.
- 🔑 **El SDK de sandbox YA acepta una `reference` de la app** (chip y contactless, y
  `InitData.reference`) — hoy se manda `""`. Eso vuelve obsoleta la afirmación «Blumon no
  acepta una referencia nuestra». **No demuestra** todavía que acepte un UUID, lo devuelva
  intacto en todos los webhooks, ni que sirva para deduplicar: hay que probarlo.
- Si se confirma, **Blumon dejaría de necesitar el emparejamiento por combinación** y podría
  tener correlación exacta como AngelPay. Es la pieza que más simplifica el webhook.
- **F1 y F3 no se invalidan** al cambiar el SDK; las pruebas de integración con Blumon sí se
  repiten. F4 es de Nexgo y no depende de ese cambio.

## Orden (el de Codex, adoptado)

### F1 · Contener lo que mueve dinero sin registro — primero, es lo único que hoy pierde dinero
- **F1.1** Cancelar y Devolver del historial del procesador: o abren fila de libreta + llave
  ANTES del SDK y su resultado entra a la **misma cola durable** del reembolso de Pagos, o
  **se retiran de la pantalla en Nexgo**. Lo que no puede quedarse es la versión de hoy.
- **F1.2** El reembolso Nexgo **respeta** los booleanos de `openAttempt` y `markAuthorizing`:
  sin reserva o sin persistencia, no entra al SDK.
- **F1.3** Una cancelación que no acredita rechazo definitivo **no encadena** una devolución.
- **F1.4** El contexto del reembolso basta para que la recuperación lo reconstruya COMO
  reembolso (hoy sólo hay registradores de venta).

### F2 · La salida del bloqueo — es lo que hace que el cobro no se interrumpa
- **F2.1** Servidor: `GET /tpv/venues/{venueId}/payment-attempts/{attemptId}/outcome`.
  Valida aparato autenticado, sucursal, procesador, afiliación y el vínculo `attemptId →
  requestId`. Responde `outcome = CHARGED | NOT_CHARGED | UNRESOLVED` con su evidencia.
- **F2.2** `CHARGED` exige un `Payment` del intento exacto con contrato coincidente.
  `NOT_CHARGED` exige **prueba positiva** de no cobro y ejecución terminada. Todo lo demás es
  `UNRESOLVED` y **conserva el bloqueo**: un 404, un historial vacío, la red o el tiempo no
  descartan nada.
- **F2.3** Terminal: aplica la respuesta en UNA transacción (identidad + versión), pasa su
  fila a `REGISTRADO` o `DESCARTADA` y guarda la evidencia. Nunca pisa una aprobación
  concurrente; un intento resuelto no resuelve la solicitud si otro sigue vivo. Prohibido
  `CERRADA`/`ENTREGADA_A_COLA` como atajo, y prohibido borrar filas.
- **F2.4** Pantalla: importe, antigüedad, folio, «no vuelvas a pasar la tarjeta», y los
  botones **Consultar resultado** y **Solicitar conciliación**. Consulta al arrancar, al
  reconectar y al tocar. Con esperas crecientes; escala a soporte pero **nunca abandona**.
- **F2.5** La recuperación deja de rendirse a los 5 intentos y deja de mirar sólo la sucursal
  actual.

### F3 · Palanca de conciliación (clase B) y banner honesto — en la misma entrega
- **F3.1** `releaseUnknownRequest` deja de ser no-op: escribe evidencia, responsable y
  resolución **por intento**. Una palanca sin evidencia no se construye.
- **F3.2** El banner distingue **cobro** de **reembolso**, ignora lo heredado ya acreditado y
  usa la MISMA definición que la consulta que bloquea. Dos consultas que no concuerdan es el
  defecto, no el síntoma.

### F4 · Impresión en Nexgo
Historial, reportes y cortes, «Imprimir en TPV», página de prueba, comandas y recibo de
kiosco por `AngelPaySDK.printTicket`, **y que un fallo se le diga al cajero**. Verificar en
hardware que el QR de facturación salga también en la reimpresión.

### F5 · SDK nuevo de Blumon y webhook como primer confirmador
Van **después**: el webhook necesita que la terminal ya sepa consumir un resultado durable
(F2). Diseño v2 ya auditado en `2026-09-12-webhook-primer-confirmador.md`.

## Decisiones del founder que NO se re-litigan

- **La ranura física se libera sola 20 min después de que la terminal regresa; la VENTA nunca
  se libera por tiempo** (decisión del 12-sep, con los números de producción enfrente). Codex
  lo marcó como defecto aplicando la decisión del 10-sep: **no aplica**.
- Orden de despliegue B: servidor primero, APK después.
- Sin reestructuras grandes: entregas chicas y verificables.

## Cómo se verifica cada fase

Prueba primero y en rojo; sabotaje en copia aislada; integración contra Postgres real en base
desechable (`avoqado_*_test_*` o `codex_testarudo_test_*`, **nunca** `av-db-25`); y **QA en
hardware** con los cuatro escenarios: rechazo acreditado, aprobación sin respuesta, muerte del
proceso entre aprobación y registro, y reinicio. Nada se da por cerrado sin el aparato.

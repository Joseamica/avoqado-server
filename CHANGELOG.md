# Changelog

All notable changes to Avoqado Server will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Checkpoint 2 del webhook como primer confirmador · N0 (servidor, 16-sep-2026): la capacidad viaja EN la solicitud.**
  `terminal:payment_request` lleva `attemptLinkVersion: 1` en los DOS payloads (entrega fresca y replay al reconectar,
  `TERMINAL_ATTEMPT_LINK_VERSION`), sin quitar ningún campo. La TPV sólo espera el ACK del vínculo intento→solicitud (S1) si
  la solicitud que cobra trae la bandera: contra un servidor anterior —o una solicitud reentregada por uno (rollback,
  staging)— no espera nada y sigue por el camino legacy. Codex (revisión acotada del diseño, 16-sep) lo aprobó así y pidió
  que la TPV la persista con la solicitud (Room v35 en `avoqado-tpv`). Pruebas: `terminal-payment.service.test.ts` (fresca
  y replay con la bandera, conservando la restricción de procedencia durable).

- **El webhook de AngelPay como PRIMER confirmador del cobro remoto — checkpoint 1 (servidor), 13-sep-2026.** Plan y
  bitácora: `docs/superpowers/plans/2026-09-12-webhook-primer-confirmador.md`. UNA llave por intento: la terminal anuncia
  `attemptId → requestId` por su socket (`terminal:payment_attempt_opened`, tabla hija `TerminalPaymentAttemptLink` con el
  índice único como único árbitro del dueño) y el `approved` del webhook crea el dinero **por el MISMO registrador** que el
  REST (`recordOrderPayment` / `recordFastPayment` con `registradoVia: 'webhook'`), sólo con correlación EXACTA (vínculo,
  venue del merchant del secreto, `status === 'approved'`, `amount == base + propina`). **Un solo ganador financiero por
  solicitud** (índice único parcial `Payment_terminal_request_winner_key`); una segunda captura acreditada del mismo cobro
  queda como EVIDENCIA (`Payment PENDING` + `processorData.reconciliation` + `ActivityLog
  TERMINAL_PAYMENT_POSSIBLE_SECOND_CAPTURE`), nunca como otro cobro ni fusionada en silencio; el REST posterior con la misma
  llave sólo ENRIQUECE (marca, PAN, modo, método real) y destraba el costo de transacción, que para un Payment nacido del
  webhook queda PENDIENTE durable (`PaymentEffect TRANSACTION_COST`, plazo 2 h) en vez de presentarse como comisión cero.
  `declined` es evidencia y nunca libera. Los eventos PENDING los retoma un worker propio (`angelpay-event-worker`, claim
  atómico con `FOR UPDATE SKIP LOCKED`, lease de 2 min, token de dueño en cada escritura final, backoff exponencial,
  agotamiento visible `ERROR/RETRIES_EXHAUSTED`); el receptor reserva sus primeros 60 s y el backfill del REST no pisa un
  evento bajo lease. La terminal puede consultar SU intento (`GET /tpv/venues/:venueId/terminal-payment/attempts/:attemptId`:
  resultado del intento y estado de la solicitud por separado; nunca atribuye a un intento el Payment de otro; un intento
  desconocido responde `NO_EVIDENCE`, jamás «no cobrado»). Cuando el webhook confirma primero despierta al POS del
  long-poll y avisa a la terminal (`terminal:payment_confirmed`); el long-poll relee la fila al vencer y el vigía recupera el
  resultado durable si el aviso se perdió. El MCP `terminal_payment_requests` muestra `closedVia`, los intentos y cuál ganó;
  `ActivityLog TERMINAL_PAYMENT_CONFIRMED_BY_WEBHOOK` sólo bajo la condición de alarma existente (dinero por webhook sobre
  una solicitud ya cerrada o en cancelación). Migraciones aditivas `20260913170000` y `20260913180000`. Los APK publicados no
  cambian: el vínculo, el aviso y la consulta son el checkpoint 2 (terminal).
  **Ronda 1 de la auditoría final de Codex (13-sep, RECHAZADO 7 P1 · 8 P2, todos cerrados):** la identidad EXACTA manda
  sobre la referencia débil (`yyMMddHHmmss` colisiona en el mismo segundo): con vínculo el evento va directo a la
  confirmación, el matcher débil no contradice una llave fuerte, el backfill salta el evento de otro intento, y la
  deduplicación por referencia exige la misma llave, la misma terminal y la misma solicitud cuando se conocen — un cobro
  acreditado por vínculo nunca se deduplica contra un Payment sin llave; el serial del webhook se compara con la terminal del
  vínculo (`ERROR/LINK_TERMINAL_MISMATCH`); la afiliación acreditada por el webhook se conserva aunque esté desactivada; el
  REST que pierde la carrera bajo el candado consolida sobre el ganador y el webhook ya no inventa `isInternational`; el costo
  diferido repara siempre sus proyecciones desde el costo persistido, crea el costo negativo de los reembolsos que llegaron
  en la espera y sólo termina al converger; S6 valida la procedencia del Payment (`paymentContradiction`) y acota la evidencia
  al venue del vínculo; receptor y backfill escriben como dueño (token / CAS), toda huella del webhook se fusiona en SQL sobre
  el valor vigente, `executionAuthorized` se decide tras escribir y sólo en vuelo, el replay de una segunda captura no crea
  SaleVerification, y `list_payments` declara `costPendingCount`/`netProvisional`.
  **Ronda 2 (13-sep, RECHAZADO otra vez: 7 cerrados · 8 parciales · 4 P1 nuevos, todos cerrados):** el reintento por
  referencia examina TODOS los candidatos de la referencia y elige el de identidad suficiente (descartar al primero nunca
  es permiso para crear); el serial que se conserva en el Payment es el ACREDITADO por el JWT; la identidad por vínculo S1
  manda también en el REST (un Payment sin llave nunca es el intento vinculado, y una transición legítima deja la llave
  como asociación durable); el backfill respeta el vínculo aunque el candidato no tenga llave, reclama y estampa en UNA
  transacción y estrena token de dueño; el método que trae el webhook nunca acredita (un webhook repetido no cierra la
  provisionalidad) y el enriquecimiento se decide sobre la fila VIGENTE bloqueada; el webhook clasifica el replay de una
  segunda captura por lo durable; el costo diferido repara también fecha y configuración de liquidación, cubre TODOS los
  reembolsos por páginas, calcula el costo negativo sobre base + propina y propaga los fallos operativos (el efecto cuenta
  intentos); el costo se atribuye a la afiliación ACREDITADA aunque ya no esté en la configuración; S6 exige procedencia
  también a la evidencia (`evidenceContradiction`); el MCP encuentra al ganador aunque quede fuera del tope de vínculos
  (`attemptsTruncated`).
  **Ronda 3 (13-sep, RECHAZADO otra vez: 4 P1 · 7 P2 · 1 P3, todos cerrados):** la búsqueda por referencia lleva los
  discriminadores en la consulta y pagina hasta resolver la identidad (el candidato número once ya no se vuelve otra venta);
  bajo el candado de la consolidación se revalidan las anclas de identidad de la fila viva y una llave ya de otro Payment
  devuelve a su dueño (dos escritores concurrentes nunca confirman el Payment equivocado); la TARIFA del negocio se congela al
  cobrar (`processorData.pricingSlot`) y una afiliación retirada de la configuración cobra con ella o queda pendiente y
  visible, nunca con la tarifa de otra; sin configuración de liquidación el efecto no termina (obligación durable con motivo
  en `PaymentEffect.lastError`); S6 recorre la evidencia por páginas y cuenta aparte las contradicciones que S2 rechazó; el
  MCP declara los intentos por solicitud (`attemptsTotal`, ventana por `requestId`); el receptor que perdió la propiedad
  contesta el desenlace durable; una sola proyección monetaria (`proyeccionMonetaria.ts`) para comisión, neto y liquidación
  (comisión + neto = importe en los tres escritores); la segunda captura del webhook conserva su provisionalidad; el margen
  de un reembolso parcial sale de los componentes revertidos; y el techo de reembolsos continúa en el siguiente intento.
  **Ronda 4 (13-sep, RECHAZADO otra vez: 6 P1 · 7 P2 · 1 P3, todos cerrados):** la resolución por referencia DEMUESTRA o no
  demuestra — nunca crea a ciegas: keyset sobre columnas inmutables en dos pasadas (la llave que otro escritor acredita entre
  páginas ya no salta candidatos), la búsqueda agotada, una consolidación incierta o el presupuesto agotado rechazan con 503
  reintentable (la terminal reenvía el mismo cobro), la respuesta es siempre el Payment resuelto, y una contradicción con
  identidad débil (misma referencia/importe/terminal, otra autorización) ya no se absorbe: queda como evidencia PENDING de
  COLISIÓN DE REFERENCIA con bitácora; la tarifa se congela DE VERDAD (tasas del negocio y del proveedor en
  `processorData.pricing`, y la vigencia se evalúa a la fecha del cobro), no sólo la etiqueta del slot; todo cobro con
  tarjeta —también por REST— nace con una obligación durable de costo que el cálculo síncrono cierra o deja PENDIENTE y
  visible; el matcher débil del webhook sella bajo el candado del evento tras volver a mirar el vínculo, y un vínculo que
  llega después reabre los eventos sellados sobre otro Payment (huella revocada, el worker confirma por el vínculo); S6
  resuelve la evidencia exacta en una sola consulta SQL; el MCP recorre todos los intentos de una solicitud y muestra los
  motivos del costo pendiente; los reembolsos ya costeados salen de la consulta con presupuesto configurable.
  **Ronda 5 (13-sep, RECHAZADO otra vez: 6 P1 · 5 P2 · 1 P3, todos cerrados):** una consolidación que CONTRADICE ya no
  repara la solicitud con el candidato ajeno (el cargo real deja de nacer como segunda captura); la tarifa se congela sobre
  la afiliación DEFINITIVA, después de la recuperación por serial (TIER-2/3), nunca sobre la que mandó el APK; UN solo
  criterio de cumplimiento del costo, compartido por el worker y el cálculo síncrono de las dos rutas (costo persistido →
  proyecciones → liquidación → reembolsos): la venta rápida por fin proyecta la comisión real y la obligación sólo cierra al
  converger (sin liquidación queda pendiente y visible), con la marca `costPending` decidida en una sola sentencia; el
  cruce de comercio, la discrepancia y el backfill escriben, como el sello débil, bajo el candado del evento y tras releer
  el vínculo; el vínculo y la reapertura de los eventos débiles son una sola transacción (y el vínculo repetido vuelve a
  mirar); los Payments legacy con `type` NULL vuelven a ser candidatos por referencia; la evidencia de colisión se reconoce
  como tal en el webhook y en la consulta por intento; el cliente de un reintento no se liga a la venta de un candidato;
  la revocación de la huella exige la identidad del evento y conserva historial; el validador del snapshot rechaza null y
  booleanos; y el SQL de S6 recorta el serial con la misma clase de espacios que JS.
  **Ronda 6 (13-sep, RECHAZADO: 3 P1 · 6 P2, todos cerrados; el mecanismo nuevo se diseñó CON Codex antes de codificar):** la
  deduplicación por referencia usa la afiliación DEFINITIVA (resuelta ANTES, en las dos rutas; el valor del APK queda como
  evidencia; una resolución incierta rechaza con 503 reintentable) — un replay legacy ya no crea una segunda venta; **exclusión
  por intento** (`candadoDeIntento`: advisory transaccional de dos llaves, namespace reservado, espera acotada) tomada como
  primera sentencia por la publicación del vínculo, la reapertura idempotente y todo escritor débil, con S1 leído después de
  esperar y los Payments de la reapertura en `id ASC` con `FOR NO KEY UPDATE` (sin interbloqueo posible; orden fijado por una
  guardia estática); la discrepancia DÉBIL también se reabre al llegar el vínculo (revocación por identidad, con historial);
  la convergencia del costo es UNA transacción real por lote (fila del Payment `FOR NO KEY UPDATE NOWAIT` como mutex, todo con
  el mismo `tx`, contención como desenlace propio, `costPending` nace con la obligación, sin VenueTransaction no converge);
  validador decimal estricto (`"0x10"` fuera); la prueba del backfill espera la promesa real; y el runner de sabotajes
  CERTIFICA (huella HEAD+WIP, resolución inequívoca de cada prueba declarada, inconclusos distinguidos, JSON + logs).
  **Ronda 7 (14-sep, RECHAZADO: 2 P1 · 6 P2 parciales, todos cerrados):** la consolidación por referencia (registro repetido)
  entra al protocolo del intento — advisory del intento → Payment `FOR UPDATE` → S1 releído bajo el candado en otra sentencia —
  y el `exigeLlave` calculado FUERA de la transacción ya no viaja (un vínculo publicado entre la búsqueda y la consolidación ya
  no convierte un legacy sin llave en «este cobro»); la afiliación es un CONJUNTO de identidades {definitiva, la que mandó el
  APK} en la búsqueda (columna + evidencia `merchantAccountIdFromApk`), en la identidad y en el plan de consolidación — un cambio
  de enrutamiento entre el registro y el replay ya no duplica la venta; conjuntos disjuntos sin autorización que lo desmienta
  = `AFILIACION_INCIERTA` ⇒ evidencia de colisión (PENDING), nunca venta nueva; el snapshot de tarifa distingue AUSENTE /
  VALIDO / SIN_TARIFA / INVALIDO (`includesTax` booleano o null; un snapshot ilegible o de OTRA afiliación deja la obligación
  PENDIENTE con `INVALID_PRICING_SNAPSHOT`, nunca se cae a la configuración de hoy); READ COMMITTED EXPLÍCITO en toda transacción
  del protocolo y en la unidad de costo; la unidad de costo lee configuración, tarifas y proveedor por el MISMO cliente
  transaccional; `VENUE_TRANSACTION_MISSING` e `INVALID_PRICING_SNAPSHOT` son motivos públicos; las pruebas de intercalación
  identifican a los actores por PID; el runner de sabotajes lee resultados ESTRUCTURADOS de Jest (una caída sólo cuenta si es
  de aserción; hooks/timeouts ⇒ INCONCLUSO siempre; el conjunto ejecutado se compara con el control; mutación íntegra en el JSON).
  **Ronda 8 (14-sep, RECHAZADO: 2 P1 · 4 P2, todos cerrados):** la AFILIACIÓN deja de filtrar en la consulta por referencia
  (un replay legacy sin merchant NI autorización —el contrato los admite— quedaba fuera de la OR tras un cambio de
  enrutamiento y nacía como venta nueva): todo candidato con la misma referencia, importe y propina llega a la regla ÚNICA de
  identidad, que lo saca como `AFILIACION` (otro cargo, sólo con autorizaciones presentes y distintas) o `AFILIACION_INCIERTA`
  (evidencia PENDING); un snapshot de tarifa `SIN_TARIFA` (legible, misma afiliación, `venue: null` explícito) se consume
  conservando la afiliación y el slot HISTÓRICO y NUNCA se resuelve con PRIMARY ni con el slot que la afiliación ocupe hoy —
  `AFFILIATION_PRICING_UNRESOLVED` hasta que el slot histórico tenga tarifa vigente A LA FECHA DEL COBRO (la recuperación R3/R4
  se conserva; un `venue` OMITIDO es INVALIDO `VENUE_AUSENTE`, no «sin tarifa»); el fallback a PRIMARY existe SÓLO para un
  Payment sin snapshot y lee por el cliente de la unidad (la guardia revisa TODAS las llamadas); las pruebas de carrera capturan
  al lanzarlas las promesas en vuelo (`enVuelo`) y las asientan acotadas en el `finally`; el runner exige que TODOS los errores
  de una prueba caída sean de aserción (una aserción + un 503 aterrizado después ⇒ INCONCLUSO; `--selftest` con el JSON real
  que Codex objetó); la prueba del snapshot ilegible edita la tarifa de hoy al 8 % ANTES de reparar y sigue cobrando 2.5 %.
  **Ronda 9 (14-sep, RECHAZADO: 1 P1 · 3 P2 · 1 P3, todos cerrados):** un snapshot `SIN_TARIFA` NUNCA converge solo — «sin
  tarifa contratada al cobrar» es un hecho histórico que ninguna configuración posterior cambia (ni PRIMARY, ni el slot que la
  afiliación ocupe hoy, ni una estructura creada después y retrodatada, ni una antigua reactivada o editada en sitio): la
  obligación queda PENDIENTE y visible hasta una acreditación EXPLÍCITA del cargo (fuera del checkpoint 1), y la recuperación
  «al devolver la afiliación a la configuración» que las rondas 3–8 aceptaron queda retirada; la consolidación quita SÓLO los
  nulos de primer nivel del `processorData` existente (`jsonb_strip_nulls` borraba `pricing.venue: null` en cada replay y volvía
  el snapshot «inválido»); una tarifa heredada de la organización conserva su origen y nunca pone su id en la FK
  `venuePricingStructureId` (revientaba el costo de todo Payment sin snapshot en un venue que hereda la tarifa); las pruebas de
  carrera recogen lo observado y afirman DESPUÉS de asentar a todos sus actores (`actores.ts`: un actor sin asentar o un rechazo
  que nadie examinó ⇒ INCONCLUSO con el fallo original conservado); el selftest del runner usa un fixture inmutable y exige el
  caso mixto.
  **Ronda 10 (14-sep, RECHAZADO: 1 P1 · 2 P2 · 1 P3, todos cerrados):** una lectura que FALLA al congelar la tarifa (proveedor,
  tarifa del negocio o configuración) ya no convierte el cobro en «sin snapshot» — cada lectura se captura por separado y la
  evidencia obtenida se conserva (`capturaFallida` con el motivo; sólo el proveedor fallido ⇒ la tarifa congelada manda), una
  captura fallida del lado del negocio queda PENDIENTE con `PRICING_CAPTURE_FAILED` (motivo público, sin consumir intentos) y no
  se relee la tarifa «a la fecha del cobro» al recuperarse la base; `pricing: null` con afiliación registrada es INVALIDO (sólo
  es «sin snapshot» sin afiliación: manual/QR); el snapshot se clasifica ANTES de exigir la configuración de pagos (sin
  configuración, SIN_TARIFA conservaba su motivo en vez de morir en DEAD_LETTER); la fase de aserciones de las pruebas de carrera
  corre dentro de `actores.afirmar` (una aserción caída a medias no deja actores sin examinar) y las carreras contra reloj usan
  `actores.carrera` (el reloj no acredita examen); los textos del lector y del MCP ya no prometen una recuperación que no existe.
  **Ronda 11 (14-sep, RECHAZADO: 1 P1 · 2 P2 · 2 P3, todos cerrados):** la configuración (qué slot ocupa la afiliación) y la
  tarifa de ese slot se congelan desde UNA MISMA vista de la base (transacción `REPEATABLE READ` de sólo lectura) — dos lecturas
  correctas por el cliente global podían congelar «M2 con el 8 %» si entre ambas un administrador ponía a M3 en SECONDARY y
  editaba esa tarifa en sitio, una combinación que nunca existió y que cobraba $80 en vez de $25; si la transacción de captura
  falla en sí, queda `capturaFallida.total` (nunca `pricing: null`); la consolidación de un registro repetido limpia SÓLO los nulos
  de las llaves que ese relleno trae (un `pricing: null` con afiliación, dato viejo o alterado, sobrevive al replay como INVALIDO
  pendiente en vez de volverse «sin snapshot»); el marcador de captura fallida nunca queda vacío y el lector decide por su
  presencia; las pruebas de carrera afirman cada desenlace por separado (un agregado con `Promise.all` tiraba el segundo rechazo)
  con una guardia estática que lo impide, y toda carrera en vuelo entra al protocolo de actores.
  **Ronda 12 (14-sep, PASADA EXHAUSTIVA del checkpoint entero por decisión del founder — RECHAZADO: 7 P1 · 8 P2 bloqueantes ·
  2 no bloqueantes · 1 P3 y una definición de hecho de 18 invariantes; TODO cerrado de una vez con TDD y sabotajes certificados):**
  la tarifa de un cobro nacido del webhook se captura AL INGRESO del evento (la primera evidencia bancaria aceptada) y viaja en el
  evento durable — S4 registra con ESA captura, nunca con la de horas después, y un evento sin ella queda pendiente en vez de
  fabricar VALIDO; una afiliación en DOS slots ya no elige tarifa por orden (captura fallida por configuración ambigua, costo
  pendiente y visible; los escritores de configuración lo rechazan con 400 y un CHECK `NOT VALID` en la base respalda contra dos
  ediciones concurrentes, migración `20260914150000`); el PLAZO ya no acredita el tipo de tarjeta (un método provisional del webhook
  sólo lo acredita el REST de la terminal; vencido el plazo la espera se ESCALA `AWAITING_ACCREDITED_CARD_DATA_OVERDUE`, dentro de
  la unidad y bajo el mutex); la corrección administrativa de tarifas (preview, apply en sus dos modos y reverse) EXCLUYE y explica
  los cobros del protocolo (snapshot presente, incluido `null`, u obligación TRANSACTION_COST), revalidando bajo el mutex del
  Payment; editar o borrar desde el dashboard un cobro del protocolo responde **409 `PAYMENT_PROTECTED_BY_COST_PROTOCOL`** (los no-op
  pasan; reembolso, anulación y corrección van por sus flujos); un resultado NO-success del socket (timeout / failed / cancelled)
  nunca escribe ganador, el árbitro valida la procedencia del puntero histórico con el MISMO criterio compartido del cierre
  (`procedenciaDelPagoDeSolicitud`) y un puntero contaminado se reemplaza por CAS con 🚨 y bitácora
  `TERMINAL_PAYMENT_UNACCREDITED_WINNER_IGNORED`; dos replays SIMULTÁNEOS sin llave del mismo cargo crean UNA venta (candado
  consultivo por venue + referencia como primera sentencia de la creación y relectura bajo el candado, sin `UNIQUE(referenceNumber)`);
  un snapshot VALIDO converge sin la configuración de pagos de hoy; el lector exige la presencia de los campos monetarios y la forma
  del marcador de captura fallida; los escritores de Blumon (webhook MATCHED / DISCREPANCY y el job de auditoría) parchan
  `processorData` con un `||` ATÓMICO en Postgres (nunca reponen un `costPending` viejo ni pisan el snapshot); la llegada del vínculo
  S1 adelanta un approved en backoff y rearma UNA sola vez uno agotado (nunca un rechazo bancario); el backfill del REST exige tipo
  `send_transaction`, estado bancario aprobado e importe entero en centavos antes de sellar (un declined o un importe ilegible
  quedan como evidencia con motivo); la captura resuelve el slot con una consulta ACOTADA (`getEffectivePricingForSlot`, también
  la tarifa heredada de la organización dentro de la misma vista); el costo NEGATIVO de un reembolso posterior a DONE es una
  obligación DURABLE registrada en la misma transacción del reembolso (TPV y dashboard) bajo el mutex del original; el MCP
  `list_payments` marca POR PAGO `costPending` / `feeProvisional`; y las pruebas de pagos registran montajes y liberaciones en su
  protocolo de finalización (un fallo de fixture es INCONCLUSO, nunca una aserción financiera caída).
  **Ronda 13 (14-sep, la auditoría de AUTORIZACIÓN — RECHAZADO: 12 hallazgos de R12 cerrados, 6 parciales, 7 nuevos; TODO cerrado
  de una vez con TDD, sabotajes certificados e inyecciones en los consumidores de las pruebas):** la tarifa se congela sobre la
  PRIMERA evidencia bancaria durable del cargo con UN selector común a los orígenes — el REST de la terminal que crea el Payment
  ANTES de S4 consume la captura del ingreso del evento durable del mismo intento (`evidenciaDeIngreso.ts`), nunca captura «ahora»
  (2.5 % editado al 8 % ya no da $8.50 en vez de $3), un evento pertinente sin captura conserva la incertidumbre y uno recibido por
  OTRA afiliación no acredita ésta; el PUT del dashboard clasifica, valida y ESCRIBE dentro de la misma transacción que posee el
  mutex del Payment (antes escribía después de soltarlo y un reembolso real podía meter el cobro al protocolo en medio); el editor
  de verificaciones de venta (PATCH de organización y MCP `edit_sale_verification`) aplica el mismo criterio bajo el mutex — importe y
  forma de pago de un cobro del protocolo se rechazan con 409 `PAYMENT_PROTECTED_BY_COST_PROTOCOL` y nada se escribe; revisión,
  notas, tipo de venta, no-op y cobros anteriores al protocolo siguen igual; el estado bancario de un evento de AngelPay se clasifica
  EXPLÍCITAMENTE (`estadoBancario.ts`: aprobado · rechazado · ausente legacy · INVALIDO) y un estado presente pero ilegible (`123`,
  `{}`, `""`) queda PENDING con `INVALID_STATUS` en vez de recibir MATCHED en el backfill; la recuperación del costo negativo de un
  reembolso reactiva `costPending` al reabrir o encolar la obligación y PROYECTA el reembolso (fee y neto del Payment y de la
  VenueTransaction del reembolso desde su costo negativo persistido, con la misma regla monetaria: fee −$3 / neto −$97 en un total,
  −$1.00 / −$39 en un parcial de $40) — también cuando el costo negativo ya existía con proyecciones incompletas, y un reembolso sin
  VenueTransaction impide converger; una reclamación de OTRA solicitud sobre un Payment sólo veta el cierre (y el barrido) si está
  ACREDITADA por el criterio compartido, y un puntero sin procedencia (alias contaminado) se registra
  (`TERMINAL_PAYMENT_CONTAMINATED_ALIAS_RESOLVED`) y se resuelve con CAS para que el cargo auténtico cierre su solicitud; y los
  consumidores del protocolo de actores de las pruebas (dashboard, registrador, costo real, costo diferido) llegan siempre a `cerrar`
  con la causa conservada, con un PENDING real nacido del webhook en la suite del dashboard. Autorrevisión previa a la certificación:
  la página de reembolsos con trabajo pendiente ataba un `Date` crudo en `$queryRaw` (timestamptz corrido por la zona de la sesión: en
  local repetía filas) — va por `utcTs`, como fija el guard estático de binds de fecha.
  **Ronda 14 (14-sep, la segunda auditoría de AUTORIZACIÓN — RECHAZADO: 5 de los 7 hallazgos de R13 cerrados, 2 parciales, 5 nuevos;
  TODO cerrado con TDD, sabotajes e inyecciones, y el diseño de los tres mecanismos nuevos consultado a Codex antes de codificar):** la
  PRIMERA evidencia durable APROBADA del intento gobierna la tarifa — elegida EN SQL (`estadoBancarioSql` en el `WHERE`, orden durable
  `createdAt, id`, sin recorte antes del filtro), el ingreso del evento toma el candado del intento y lo fecha estrictamente después del
  último del intento, y las transacciones de dinero del REST toman ese mismo candado como primera sentencia (un segundo webhook del mismo
  intento, S4 fuera de orden o la carrera REST ↔ ingreso ya no imponen una captura posterior); el REEMBOLSO de un cobro del protocolo
  pertenece al protocolo por su original — PUT económico y DELETE del dashboard ⇒ 409 `PAYMENT_PROTECTED_BY_COST_PROTOCOL` (nombrando al
  original), con candados original → reembolso, relectura del puntero bajo el candado y reinicio por savepoint si cambió, y también
  excluido de la corrección genérica de tarifas; el estado bancario se clasifica IGUAL en JavaScript y en SQL (`undefined` ⇒ ausente,
  `null` presente ⇒ inválido, recorte con la clase de espacios de `trim()`, aprobación normalizada) en captura, confirmación, rearme y S6;
  la limpieza de aliases NUNCA espera a otra solicitud (`FOR UPDATE NOWAIT` dentro de un savepoint; 55P03 ⇒ alias diferido con bitácora
  `TERMINAL_PAYMENT_CONTAMINATED_ALIAS_DEFERRED`; relectura y CAS bajo el candado; en transacción real también desde el barrido, que además
  recupera el alias propio diferido aunque el cierre ya haya terminado COMPLETED y conserva un puntero acreditado); y el helper del
  backfill de las pruebas del webhook llega SIEMPRE al cierre común con la causa conservada (INCONCLUSO con ambas causas si además rechaza).
  **Ronda 15 (15-sep, la tercera auditoría de AUTORIZACIÓN — RECHAZADO: 4 de los 5 hallazgos de R14 cerrados, R14-1 parcial, R13-6
  parcial, 3 nuevos; TODO cerrado con TDD, sabotajes e inyecciones, con el diseño de los dos mecanismos nuevos consultado a Codex antes de
  codificar):** un ingreso que entra por el FALLBACK del webhook (la espera del candado del intento vence, 55P03) conserva la evidencia
  del banco pero ya NO acredita ningún orden histórico — queda MARCADO en el evento (`_avoqado.ingresoSinCandado`), el selector de la
  primera evidencia decide la marca y el primer aprobado en UNA sola sentencia y responde `ORDEN_NO_ACREDITADO` para todo el intento (el
  cobro se registra con `capturaFallida.total: EVIDENCIA_DE_INGRESO_SIN_ORDEN`, pendiente y visible hasta una acreditación explícita —
  nunca la tarifa de hoy ni la captura de un evento posterior), y la recuperación lo ORDENA bajo el candado (en el siguiente ingreso
  normal del intento y desde S4, en transacción propia que revalida el claim) fechándolo estrictamente después de todo lo del intento
  (`max(createdAt)+1 ms`, nunca con el reloj) y sellando `ordenadoEn` SIN quitar la marca; la corrección de tarifas por lote (apply y
  reverse) protege el par ORIGINAL → reembolso durante la clasificación y la escritura — bloquea PRIMERO los originales de los reembolsos
  del lote (dentro y fuera del lote, únicos y ordenados, `FOR NO KEY UPDATE NOWAIT` con savepoint interior: un original ocupado aparta a
  sus reembolsos y a sí mismo en vez de esperar a la unidad de costo, explicado en `excludedBusyPaymentIds`), después el lote en `id ASC`,
  relee tipo, venue y puntero bajo los candados y, si cambiaron, suelta TODOS los candados del intento y reinicia (≤3; después 409
  `RATE_CORRECTION_LOCK_UNSTABLE`, que declara que la estructura de tarifas VIGENTE ya quedó actualizada y ningún cobro histórico se tocó);
  y la prueba del timeout del candado vive en el protocolo de actores (montajes registrados al lanzarlos, esperas acotadas, barreras en
  `finally`, `cerrar`/`afirmar`, la espera del candado restaurada en un `finally` exterior), certificada con cuatro inyecciones.
  **Ronda 16 (15-sep, la cuarta auditoría de AUTORIZACIÓN — RECHAZADO: R15-1/2/3 cerrados «como se diseñaron», 3 nuevos; TODO cerrado
  con TDD, sabotajes e inyecciones, sin mecanismo nuevo):** el editor de verificaciones de venta (back-office de PlayTelecom, HTTP y MCP)
  sobre un REEMBOLSO toma también el candado de su ORIGINAL (orden original → reembolso, `bloquearConSuOriginal`, con relectura del
  puntero) ANTES de releer, clasificar y escribir, y conserva los dos hasta commitear — con el original libre, un segundo reembolso real
  podía meterlo al protocolo entre la clasificación «legacy» del reembolso y su UPDATE y el editor cambiaba R1 de −$40 a +$40 sin movimiento
  bancario (reproducido en rojo con las APIs reales); las sondas de «el REST/el ingreso ESPERA el candado del intento» de las carreras de
  tarifa ($3 frente a $8.50) se ATRIBUYEN al actor y al poseedor observados desde su propia conexión y a la llave del intento en `pg_locks`
  (un waiter ajeno de otra llave ya no las satisface; contraprueba certificada); y la comprobación de que la prueba del timeout restaura la
  espera del candado corre DESPUÉS del desenrollado excepcional, comparando con el valor previo y conservando la causa original (con dos
  contrapruebas que omiten o rompen la restauración). De la certificación salieron dos arreglos más: el worker de AngelPay (S4) devuelve el
  lote reclamado en orden determinista (lo más antiguo primero: el `RETURNING` de un `UPDATE … FROM` no conservaba el orden del `ORDER BY`
  y con dos filas podía salir invertido), el fixture de integración purga los fixtures huérfanos de corridas matadas a medias (sus
  obligaciones PENDING contaminaban otras suites de la misma base desechable), y la prueba N1 del webhook drena el backfill del webhook que
  crea el Payment antes de leerlo (su detección del mutante del parche atómico dependía de una carrera).
  **Cierre del CI de `develop` (16-sep):** el full setup de AngelPay (superadmin) es un escritor más de los slots que R12-2 no cubrió — con
  `merchant.mode: 'existing'` un merchant ya colocado en otro slot llegaba al CHECK y salía un 500 anónimo (23514 crudo). Ahora valida la
  configuración resultante ANTES de escribir (400 `AFFILIATION_IN_SEVERAL_SLOTS`, como los demás escritores) y, para TODOS los escritores
  HTTP a la vez, el handler global traduce la violación de `*PaymentConfig_slots_distintos` al mismo 400 + código (`esViolacionDeSlotsDistintos`);
  la prueba de integración que metía el mismo merchant en dos slots (escenario inválido por diseño desde R12-2) pasó a reusar un segundo
  merchant de la misma cuenta. Y `npm run schema:map` corre en transpile-only (`ts-node -T`): con `"files": true` ts-node typecheaba el
  programa entero (Prisma incluido) y ni 4 GB de heap alcanzaban en CI; el mapa commiteado era correcto (diff vacío).

### Changed

- **El resumen de inventario de modificadores recorre los usos por páginas (query-guard 2026-09-10)**: `GET
  /venues/:id/modifiers/inventory/summary` cargaba TODOS los `OrderItemModifier` del rango —cada uno con su modificador, su
  grupo, su materia prima y la cantidad del platillo— para quedarse al final con los 10 de mayor costo. Medido en producción:
  **2,568 filas en una llamada de 30 días**, y el rango de fechas es **opcional**, así que una llamada sin fechas no filtra
  nada y carga el histórico completo del negocio. Ahora `getModifierUsageStats` recorre por páginas de 500 con cursor
  (`orderBy id`), agregando en el mismo mapa; el `limit` se sigue aplicando al final, sobre el agregado COMPLETO, así que el
  resultado no cambia. **Se eligió paginar y NO agregar en SQL a propósito**: el impacto en costo se calcula fila por fila
  (cantidad del platillo × cantidad del modificador × receta × costo por unidad) y `timesUsed` cuenta filas, no unidades.
- **Los empates del resumen de modificadores tienen orden definido (mismo cambio)**: las listas por uso y por costo
  desempataban con el orden en que la base devolvía las filas, que sin `ORDER BY` puede cambiar entre dos peticiones
  idénticas. Ahora desempatan por id. Mismas filas y mismos números; el orden de los empates deja de moverse solo.
- **El panel de ganancias del superadmin recorre los costos por páginas (query-guard 2026-09-08)**: `GET
  /superadmin/earnings/summary` y `/time-series` cargaban de un jalón TODOS los `TransactionCost` del rango, cada uno con su
  pago→negocio y su comercio→proveedor→reparto (un `include` anidado). Medido en producción el 7-sep: **3,772 filas por
  llamada** con el rango por defecto (el mes en curso), y crece con cada cobro con tarjeta; las dos pantallas se piden
  juntas, así que eran dos cargas gigantes por visita. Ahora ambas recorren por páginas de 500 con cursor
  (`createdAt asc, id asc`), y los cobros en línea (`CheckoutSession`) igual. **Se eligió paginar y NO agregar en SQL a
  propósito**: `computeRevenueSplit` redondea a dos decimales POR TRANSACCIÓN, así que sumar los montos antes de repartir
  cambia el dinero — medido en la prueba: 870.19 fila por fila contra 867.24 agrupado, sobre sólo 503 transacciones.
  Verificación: paridad viejo contra nuevo en la base de desarrollo (691 costos, 144 comparaciones sobre 4 rangos × 9
  filtros × 3 granularidades) con **cero diferencias de dinero** en totales, series, `byVenue`, `byMerchant` y `byProvider`.
- **Las tablas del resumen de ganancias tienen orden definido (mismo cambio)**: `byCardType` no se ordenaba y las otras tres
  desempataban por orden de llegada de las filas, que sin `ORDER BY` lo decide Postgres y puede cambiar entre dos peticiones
  idénticas — dos negocios con la misma ganancia se intercambiaban solos. Ahora `byCardType` va por ganancia descendente y
  las cuatro desempatan por id. **Es el único cambio visible en pantalla**: mismas filas y mismos números, orden distinto y
  ya estable. (`totals.averageMargin`, que no se redondea, se mueve por debajo de 1e-9 al cambiar el orden de la suma.)
- **El candado estático de `findMany` sin tope ya mira `TransactionCost` y `CheckoutSession` (mismo cambio)**: el barrido
  sólo cubría 18 modelos y ninguno de estos dos, que crecen una fila por cobro — por eso este camino nunca apareció en el
  inventario. Al ampliarlo salieron a la luz 5 `findMany` sin tope más (`cost-management`, `revenueShareReport`,
  `paymentAnalytics`, `rateCorrectionApply`, `rateCorrectionPreview`): quedan **registrados** en el inventario congelado para
  que no crezcan; su arreglo es trabajo aparte.
- **«Saldo disponible» ya no materializa miles de pagos por apertura (query-guard 2026-09-07)**: la alerta «Consulta
  gigante» siguió disparando después de los arreglos del 1 y 2-sep porque dos caminos de esa pantalla quedaron fuera de la
  reescritura. (1) El efectivo esperado del corte de caja (`GET …/cash-closeouts/expected`) traía TODOS los pagos en
  efectivo desde el último corte para sumarlos en Node; un negocio que nunca ha cortado caja cargaba su historia completa
  (Testarudo: 5,449 filas, una más por cada venta). Ahora Postgres suma y cuenta (`payment.aggregate`) con el veredicto de
  cajón expresado en el `where`: `DRAWER_CASH_WHERE` en `tenderSemantics`, tres ramas excluyentes con la MISMA precedencia
  que `paymentCountsAsDrawerCash` (fundsFlow → snapshot → legacy), y una prueba que cruza las 80 combinaciones posibles
  contra el predicado. (2) La semana de liquidación (`GET …/available-balance/settlement-week`) cargaba 28 días de pagos
  con tarjeta y sus costos en un solo `findMany` (5,451 filas); ahora los recorre por páginas de 500 con cursor, cargando
  las reglas de cada comercio una sola vez conforme aparece, con el mismo motor y el mismo resultado. Ningún número ni
  campo de la respuesta cambia; el inventario de `findMany` sin tope baja en dos. Queda documentado, y NO se toca, el
  puente legacy de `pageSize=10000` en los listados: siguen llegando pestañas abiertas desde antes del 2-sep y cerrarlo
  les mostraría totales parciales hasta recargar.
- **MCP `sales_by_payment_method` y `staff_tips` suman en Postgres, no en Node (query-guard 2026-09-01)**: las dos
  herramientas pasaban por `fetchPaymentsForAnalytics`, que trae TODAS las filas del rango sólo para sumarlas — un agente que pide
  «ventas de este año» materializaba 24 mil pagos (el mismo camino que cazó el query-guard en `basic-metrics`). Ahora
  `mergedPayments.service.ts` expone `aggregatePaymentsByMethod` y `aggregateTipsByProcessor` (`prisma.payment.groupBy` con el MISMO
  `where` que las filas: COMPLETED, reembolsos y órdenes canceladas según las banderas, ventana de fechas) y devuelven UNA fila por
  método o por cajero; los nombres de cajero salen de una consulta acotada al número de cajeros del rango. El puente legacy de MindForm
  se conserva: sus pagos QR viven en otra base y se suman en Node sólo para ese venue, con las mismas reglas y el mismo gate
  (ningún otro venue toca la base legacy). Se eligió `groupBy` y no `$queryRaw` para que el filtro de fechas quede idéntico al de
  `findMany` (sin la trampa de zona de sesión de `utils/sqlDates.ts`). Verificación: golden al centavo contra la base de desarrollo
  (12 venues × 4 rangos, 0 diferencias entre el camino viejo y el nuevo), prueba de integración con base real que fija la paridad
  sobre propinas / reembolso / orden cancelada / QR sin cajero / propina 0, y unitarias del `where` y del gate. `fetchPaymentsForAnalytics`
  sigue existiendo para `getExtendedMetrics` y queda documentado como camino de FILAS sin tope.

### Added

- **PITS H1A — catálogo maestro corporativo, default-off y reversible**: se añadió gobierno de catálogo por organización sin cambiar la
  identidad ni las relaciones operativas de `Product`. Incluye autoridad separada de entitlement/módulo/configuración, roles y permisos por
  organización/sucursal, alta y retiro de artículos con marca/fabricante/familia/subfamilia/presentación/IVA/IEPS/SAT, valores corporativos,
  perfiles de obligatoriedad por tipo de negocio, recetas/costos vivos, importación XLSX segura con preview/confirm/idempotencia, bindings y
  overrides por sucursal, publicación/inversa con outbox, siete tools MCP, exportaciones XLSX versionadas, UI corporativa, control plane de
  superadmin y runbook de canary/rollback. Migración y seeds no conceden acceso; con los gates apagados los flujos legacy de
  producto/menú/inventario/receta/orden permanecen vigentes y sin consultas H1. Región, identificadores regionales y precios regionales
  quedan explícitamente fuera de H1A hasta H1B/H1C; la aceptación contractual de PITS sigue bloqueada por sus layouts y matriz final de
  campos.

- **PITS H0.6 — arqueo ciego de caja opt-in (PRO), compatible con venues y clientes actuales**: se añadió `CASH_RECONCILIATION` como
  entitlement PRO y `VenueSettings.cashReconciliationEnabled` con default `false`; el flag efectivo (tier + opt-in) se entrega en la raíz de
  terminal-config. El cierre TPV acepta de forma aditiva `COUNTED` con decimal canónico o `SKIPPED`, devuelve un outcome explícito, persiste
  conteo/diferencia/auditoría de forma atómica con claim `CLOSING`, y mantiene sin gatear los cuerpos legacy de Desktop/otras integraciones.
  Flag apagado, FREE, campo ausente y APK viejo conservan el comportamiento previo. Customer MCP `list_shifts` ahora expone `cashDeclared` y
  `cashDifference` de forma null-safe.

- **Product availability now reports WHICH raw material is short (RECIPE inventory)**: `product.dashboard.service.ts` exposes two new
  optional fields on the product responses (`getProducts` — the endpoint the TPV/POS consumes at `GET /dashboard/venues/:venueId/products` —
  plus `getProduct` and the barcode lookup): `limitingIngredient` (the bottleneck raw material:
  `{ rawMaterialId, name, required, available, unit, maxPortions }`) and `insufficientIngredients` (the ones that can't make even one
  portion). Computed by new helpers `computeRecipeShortage` + `computeInventoryAvailability`, which unify the three previously-duplicated
  `availableQuantity` blocks into one source of truth using the exact same math (incl. unit conversion via
  `convertUnit`/`areUnitsCompatible`) — so `availableQuantity` is **byte-identical** to before; the shortage fields are purely additive and
  null on QUANTITY products / not-tracked products. Backward-compatible: old clients ignore the new fields. Lets the TPV tell the cashier
  exactly what ran out ("Carne Molida de Res: agotado") instead of a generic "SIN INSUMOS". **MCP kept in sync**: `menu_item_detail`
  (`src/mcp/tools/menu.ts`) gains an `availability` block (live stock + limiting/insufficient ingredients) so an ops agent can answer "¿por
  qué está agotada la X?". No schema change. Paired with avoqado-tpv Fase 2 (info modal on out-of-stock tap).

- **Permission system audit infrastructure** (`scripts/audit-permissions.ts`, `.github/workflows/permissions-audit.yml`,
  `.claude/rules/permissions-policy.md`). Cross-repo static analysis that prevents permission drift between backend, dashboard, TPV and
  Android. Reads `permissions.ts` as source of truth, then greps `checkPermission()` (backend), `<PermissionGate>` + `hasPermission()`
  (dashboard), `hasPermission()` (TPV) — reports `PHANTOM` (route checks a permission no non-SUPERADMIN can satisfy), `CATALOG_GAP` (route
  uses perm missing from `INDIVIDUAL_PERMISSIONS_BY_RESOURCE` → can't be granted individually), `DASHBOARD_DEAD_GATE` (UI gates a perm no
  endpoint checks), `TPV_CLIENT_ONLY`, `NAME_DRIFT` (Levenshtein-1 typos), and `SUPERADMIN_ONLY` (only SUPERADMIN via `*:*` short-circuit).
  Exit code 1 on ERROR. Two npm scripts: `npm run audit:permissions` (warns OK) and `npm run audit:permissions:strict` (fail on WARN too).
  CI workflow runs on every PR touching `permissions.ts`, `src/routes/**`, `src/middlewares/checkPermission*.ts`, plus weekly Monday 09:00
  UTC to catch cross-repo drift. Locally the script auto-discovers sibling repos at `../avoqado-web-dashboard`, `../avoqado-tpv`,
  `../avoqado-android` — in CI only server is checked out. Allowlists for intentional cases (`SUPERADMIN_ONLY_ALLOWLIST`,
  `CATALOG_GAP_ALLOWLIST`) keep the noise floor at zero. Caught 22 real drift cases on first run (5 PHANTOMs in `tpv-commands:*` which are
  documented as TODO until granular middleware lands; 17 catalog gaps in `creditPacks:*`, `loyalty:expire`, `coupons:redeem`,
  `payment-link:read`, etc.). The 4 bugs we fixed in this same release (`role-permissions:update`, `shifts:manage`, `features:write` vs
  `update`, `commissions:process_payout` vs `payout`) would all have been caught by this audit before merge.

- **Backend Option B closure**: new `POST /api/v1/superadmin/venues/:venueId/angelpay-merchants/:merchantAccountId/approve` endpoint +
  `approveDiscoveredAngelPayMerchant` service. Atomically flips `MerchantAccount.active=true` AND assigns it to a `VenuePaymentConfig` slot
  (default: PRIMARY; optional body `{slot:'SECONDARY'|'TERTIARY'}`) inside a single `prisma.$transaction`. Mirrors Blumon's
  auto-attach-on-discovery pattern (Blumon attaches to Terminals via `assignedMerchantIds`; AngelPay is intent-routed and terminal-agnostic,
  so the equivalent home is `VenuePaymentConfig.{primary,secondary,tertiary}AccountId`). Returns 409 ConflictError if the chosen slot is
  already occupied by a different merchant (operator must pick another slot or unassign the incumbent first). When no VenuePaymentConfig
  exists for the venue yet, only PRIMARY-slot approval succeeds (schema requires `primaryAccountId` non-null) — SECONDARY/TERTIARY
  first-approval returns 400 with a clear hint to seed PRIMARY first. Closes Option B workaround so the admin no longer has to manually wire
  approved AngelPay merchants into a slot in a second screen.
- **Backend Option B workaround**: new `POST /api/v1/tpv/angelpay/report-discovered-merchants` endpoint +
  `upsertDiscoveredAngelPayMerchants` service. TPV reports merchants from `AngelPaySDK.getUserMerchants()` after auth; backend idempotently
  upserts `MerchantAccount` rows (existing rows: refresh display fields only, never flip `active` to respect admin decisions; new rows:
  `active=false` PENDING_REVIEW with placeholder credentials). Bypasses Task 10's ACTIVE-account gate (by the time TPV calls, the SDK
  already authenticated). MerchantAccount has no direct `venueId` column — auto-discovered rows enter the global pool and become routable
  only after admin both approves them and wires them into a `VenuePaymentConfig` slot. Workaround while AngelPay confirms server-to-server
  merchant listing endpoint availability.

### Changed

- **PITS H1A release verification is local-only, reproducible and fail-closed**: the server pre-deploy gate now requires a caller-supplied
  disposable `TEST_DATABASE_URL`, preserves explicitly empty remote database selectors, runs the three reset-only H1 migration suites in
  isolated Jest processes, disconnects per-file Prisma pools, and keeps lint read-only. Publication confirmation retries only the exact
  pre-write `P2034` reservation once under the shared attempt lock; the Product transaction is never retried. Outbox claiming now binds all
  six selected columns and converts raw PostgreSQL timestamps through the canonical UTC helper. The final 2026-08-10 localhost run passed
  the complete server gate, H1A dashboard and superadmin scopes; seven unrelated legacy dashboard E2E failures remain a global deploy
  blocker and are not hidden by the scoped H1A approval.

- **Backend approve endpoint per-terminal scoping**: `POST /superadmin/venues/:venueId/angelpay-merchants/:merchantAccountId/approve` body
  now accepts optional `terminalIds: string[]`. When provided non-empty, pushes the merchant ID onto each `Terminal.assignedMerchantIds`
  (idempotent — skips duplicates) inside the same `prisma.$transaction` that flips `active=true` + writes the VenuePaymentConfig slot. Each
  terminalId is validated to belong to the same venue (security: prevents cross-venue assignment) and passes through
  `assertMerchantTerminalCompatible` (Task 11) so e.g. PAX terminal + ANGELPAY merchant rejects with HTTP 409. Empty array or omitted = no
  per-terminal restriction (merchant available on every brand-compatible terminal in the venue via VenuePaymentConfig inheritance). The
  terminal config endpoint already honored `assignedMerchantIds` on the READ path (Task 13): non-empty array means "restrict to these IDs",
  empty means "use venue inheritance". Closes the multi-TPV per-venue scoping gap (e.g. Madre Café with rooftop + cafecito + main floor
  wants different AngelPay merchants per terminal). Controller dedupes incoming IDs and coerces empty arrays to undefined before forwarding
  to the service.
- **Backend controller**: `merchantAccount.controller.create` now forwards `req.body.venueId` to `createMerchantAccount()` — unblocks the
  AngelPay validation gate added in Task 10 (which is a no-op without `venueId`). Existing Blumon callers that don't pass `venueId` keep
  their exact prior behavior. Wire-through is purely additive: the request body destructure adds `venueId`, the service call passes it
  through, and 2 unit tests in `tests/unit/controllers/superadmin/merchantAccount.controller.test.ts` cover both the AngelPay (venueId
  present → forwarded) and Blumon (venueId absent → falsy at the service boundary) paths. Closes Task 17 backend half — paired with
  dashboard `<AngelPayFields>` + `<DeviceCompatibilityBanner>`.

### Added

- **Audit trail for permission denials and permission-set changes** in `ActivityLog`. Two writes added via the existing `logAction()` helper
  (best-effort, never throws, never blocks the response):
  - **`checkPermission` middleware** writes `action='PERMISSION_DENIED'` on every 403 with `entity='permission' | 'venue-access'`,
    `entityId=<perm>`, and `data={ permission, userRole, roleSource, method, path, hasPermissionSet }`. Verified: WAITER POST /products gets
    logged with `menu:create` denial, while 3 successful ADMIN GETs added zero rows (denials only). Lets you query post-deploy
    `SELECT * FROM "ActivityLog" WHERE action='PERMISSION_DENIED' AND "createdAt" > NOW() - INTERVAL '24 hours'` to see exactly which
    user/venue/perm/endpoint is being rejected.
  - **`permissionSet.service.ts`** writes `PERMISSION_SET_{CREATED,UPDATED,DELETED,DUPLICATED}` (previously only winston-logged — invisible
    from the DB). Brings PermissionSet operations to the same audit-trail coverage that `rolePermission.service.ts` and
    `team.dashboard.service.ts` already had via `logAction()`. Captures who created/changed what, when, and with which perm list — useful
    for forensics if a custom role behavior changes unexpectedly.

### Fixed

- **Superadmin onboarding wizard: "pre-approve KYC & activate" now works, and every venue creation is audited**
  (`src/controllers/superadmin/onboarding.controller.ts`, new `src/utils/venueOnboarding.ts`). The wizard
  (`POST /api/v1/superadmin/onboarding/venue`) always created the venue in `ONBOARDING`, and the superadmin frontend then fired a 2nd call
  to `POST /dashboard/superadmin/venues/:id/approve` to activate it. But `approveVenue` **requires `PENDING_ACTIVATION`**
  (`if (venue.status !== PENDING_ACTIVATION) throw`), so activating a freshly-created `ONBOARDING` venue **always failed** with "Cannot
  approve venue in ONBOARDING status". Fixed in-band: the payload accepts `activateImmediately?: boolean`, and a new pure helper
  `resolveInitialVenueState()` sets the venue directly to `ACTIVE` + `active:true` + `statusChangedBy` in the same `$transaction` when it's
  set (default stays `ONBOARDING`/inactive). No change to `approveVenue`'s guard — that path is shared with the legacy KYC-review flow and
  must keep requiring `PENDING_ACTIVATION`. Also: the wizard previously wrote **nothing** to `ActivityLog` (violating the "audit
  value-mutating writes" rule) — it now logs `VENUE_CREATED` on every creation and additionally `VENUE_APPROVED` when activated immediately
  (both best-effort via `logAction`, mirroring `approveVenue`). Purely additive to the response contract; `activateImmediately` is optional
  and defaults to the prior behavior. Unit test: `tests/unit/utils/venueOnboarding.test.ts`.
- **eSIM sales misclassified as "eSIM" in the "Tipo de venta" column** (`src/services/dashboard/sale-verification.org.dashboard.service.ts`,
  `deriveSaleType`). eSIM is a _SIM type_ (the category "E-SIM de promotor"), not a sale type, but `deriveSaleType` gave the category-name
  match `/e-?sim/i` absolute precedence and returned `'ESIM'`, overriding the real `isPortabilidad` flag the promoter captured at sale time.
  So every eSIM sale surfaced as "eSIM" in the org "Ventas" table instead of "Portabilidad" / "Línea nueva" like physical SIMs. Fix:
  `deriveSaleType` now returns `isPortabilidad ? 'PORTABILIDAD' : 'LINEA_NUEVA'` unconditionally (category name ignored). Because `saleType`
  is derived at read time (not stored — only `SaleVerification.isPortabilidad` is persisted), this **retroactively reclassifies all existing
  eSIM sales** from their stored flag with no data migration: eSIMs sold with the portabilidad toggle on → "Portabilidad", otherwise →
  "Línea nueva". The TPV already captures `isPortabilidad` for eSIM categories (the toggle is not skipped for eSIMs), so the underlying data
  is correct. The `'ESIM'` union member is kept for backwards compatibility but is never produced anymore. Paired with the dashboard
  removing the now-dead "eSIM" filter option from "Tipo de venta". (PlayTelecom / Isaac, 2026-06-08)
- **Catalog gaps + dashboard gate drift for granular permission assignment** (`src/lib/permissions.ts`,
  `src/routes/dashboard/paymentLink.routes.ts`, `scripts/audit-permissions.ts`). Audit found 10 cases where backend permissions couldn't be
  assigned individually from the dashboard role editor (default roles got them via wildcards, but custom roles had no toggle). Resolved each
  case based on intent:

  - **Added to `INDIVIDUAL_PERMISSIONS_BY_RESOURCE`** (granular assignment is the right behavior): `creditPacks:read/create/update/delete`
    (4 — new full entry), `payment-link:read/create/update` (new full entry), `coupons:redeem` (existing entry extended), `loyalty:expire`
    (existing entry extended). `coupons:redeem` was particularly important — WAITER/CASHIER already have it in defaults but custom roles
    couldn't be granted it without giving the full `coupons:*` wildcard.
  - **Added to `CATALOG_GAP_ALLOWLIST` with intent comments** (destructive/financial — wildcard-only by design): `settlements:write`
    (confirms settlement incidents — financial), `venues:manage` (OAuth integrations + venue-level config — sensitive). If a venue ever
    needs more granular control over either, the right fix is to decompose them into sub-permissions (`settlements:confirm-incident`,
    `venues:integrations`, etc.) and add those to the catalog rather than expose the broad strokes.
  - **Added granular backend gates** to `paymentLink.routes.ts` (`checkPermission('payment-link:create')` on POST `/`,
    `checkPermission('payment-link:update')` on PUT/PATCH/DELETE endpoints, branding/config PUT, settings PATCH). The dashboard
    `PaymentLinks.tsx` had 5 `<PermissionGate permission="payment-link:create">` blocks but the backend subrouter only checked
    `payment-link:read` on the parent, so the UI gating was cosmetic — anyone with `:read` could call create/update/delete. Now the backend
    honors the same granular split the dashboard exposes.
  - **Audit script improvement**: `isAssignableFromCatalog()` now checks reachability via `PERMISSION_DEPENDENCIES` aliases, so a perm like
    `features:write` (not in catalog but reachable via the `features:update` alias) no longer triggers a false `CATALOG_GAP` warning.
  - Result: audit exits 0 in both default and `--strict` modes — zero ERRORS, zero WARNINGS. Any future drift will fail CI before merge.

- **`features:write` and `features:update` name drift between catalog and routes** (`src/lib/permissions.ts`). Backend routes
  (`dashboard.routes.ts`) historically check `checkPermission('features:write')`, but `INDIVIDUAL_PERMISSIONS_BY_RESOURCE.features` exposed
  `features:update` as the catalog/UI name. Result: a custom role marked with the catalog toggle `features:update` would 403 on the endpoint
  that wants `features:write`, and conversely a custom role marked with `features:write` (Mindform MANAGER's case) would not show up in the
  UI's "Features management" toggle group. Fix: bidirectional alias entries in `PERMISSION_DEPENDENCIES` so `features:write` resolves to
  `[features:write, features:update, features:read]` and `features:update` resolves to `[features:update, features:write, features:read]`.
  The previous `features:write → [features:read, features:write]` dep entry was removed (deduplicated — its `features:read` inclusion is
  preserved by the new alias). Mindform PROD verified: ADMIN (`features:update`) and MANAGER (`features:write`) now both satisfy either name
  without changing their stored overrides. Additive change, no data migration.

- **3 permission set routes in dashboard gated by phantom permission `role-permissions:update`**
  (`src/routes/dashboard.routes.ts:7970, 7978, 7993`). The string `'role-permissions:update'` does not exist anywhere in the permission
  catalog (`DEFAULT_PERMISSIONS`, `PERMISSION_DEPENDENCIES`, `INDIVIDUAL_PERMISSIONS_BY_RESOURCE`) — only SUPERADMIN passed via the `*:*`
  short-circuit. Every ADMIN/OWNER got a 403 trying to create/update/duplicate a PermissionSet. Inconsistent: the DELETE route on the same
  module (line 7986) already used the correct `settings:manage`. Fix: changed all 3 to `settings:manage`, which exists in the catalog and is
  held by ADMIN/OWNER/SUPERADMIN in `DEFAULT_PERMISSIONS`. Zero production impact today (no PermissionSets exist across the entire platform
  — 0 rows across 59 venues), but unblocks the feature for ADMIN/OWNER once anyone tries to use it. Paired with frontend fix in
  `avoqado-web-dashboard` `RolePermissions.tsx:171` which used the same phantom string on the "Crear conjunto de permisos" button gate.

- **TPV `/tpv/venues/:venueId/time-entries` and `/time-entries/active` had a phantom permission gate `shifts:manage` that 403s venues with
  custom perms** (`src/routes/tpv.routes.ts:3402, 3429`). The string `'shifts:manage'` does not exist in `DEFAULT_PERMISSIONS`,
  `PERMISSION_DEPENDENCIES`, or `INDIVIDUAL_PERMISSIONS_BY_RESOURCE` — nobody can literally have it. Default-role users passed via
  `evaluatePermissionList`'s wildcard fallback (`shifts:*` matches `shifts:manage` via `${resource}:*` check), but venues whose admins
  customized `VenueRolePermission` to enumerate `shifts:read/create/update/delete/close` individually (without the `shifts:*` wildcard) had
  no path to satisfy the gate. The endpoints are currently unused by TPV (`TimeclockViewModel` only invokes the self-service
  `/staff/:staffId/time-entries` path which has no permission requirement) and unused by the dashboard, so this was a dormant trap rather
  than an active bug — but any future feature wired to the manager-view endpoint would silently fail for custom-perm venues. Fix: changed
  both route gates to `checkPermission('tpv-time-entries:read')`, which is the canonical manager-view perm and is held literally by
  MANAGER/ADMIN/OWNER in `DEFAULT_PERMISSIONS` (lines 628, 716, 787). No regression possible: (a) `shifts:manage` is phantom so nobody had
  it explicitly, (b) every default role that previously passed via `shifts:*` wildcard match also has `tpv-time-entries:read` literal, (c)
  OWNERs with `['*:*']` pass via the global short-circuit unchanged. Verified Mindform's ADMIN (158 perms) and MANAGER (96 perms) both have
  `tpv-time-entries:read` literal, so the fix is correctness-only for them (they couldn't have hit the bug yet because the endpoint had no
  caller, but they're now positioned to use it). JSDoc comments updated to explain the new gate.

- **TPV cortesía/anulación returns 403 for ADMIN/MANAGER in venues with custom `VenueRolePermission` overrides** (`src/lib/permissions.ts`).
  `POST /tpv/venues/:venueId/orders/:orderId/comp` and `.../void` route gates were checking the data-level `orders:comp` / `orders:void`
  strings, but the canonical permissions issued to operators are the TPV-prefixed `tpv-orders:comp` / `tpv-orders:void` (those are what the
  dashboard role editor exposes and what `DEFAULT_PERMISSIONS` lists for ADMIN/MANAGER/OWNER). For default-role users this worked
  transparently because role defaults include the `orders:*` wildcard which `evaluatePermissionList` matches against `orders:comp`, but for
  venues that customized role permissions via `VenueRolePermission` the wildcard gets exploded into individual
  `orders:read/create/update/cancel` literals (no `orders:comp`/`orders:void`) → wildcard fallback fails → 403. Reproduced 2026-05-20 on
  venue Mindform (`cmisvi38o001fhr2828ygmxi2`): both ADMIN (158 perms) and MANAGER (96 perms) had literal `tpv-orders:comp` +
  `tpv-orders:void` plus individual orders perms but no wildcard nor literal `orders:comp/void` — `Fatima Flores` (ADMIN) and others got 403
  every time they tried cortesía or void from the TPV's `MenuViewModel.compItems`/`voidItems` flow. Additive fix (zero risk of breaking
  other consumers): (a) `PERMISSION_DEPENDENCIES['tpv-orders:comp']` now resolves to include `'orders:comp'` and `['tpv-orders:void']`
  includes `'orders:void'` — anyone granted the TPV-level perm via the dashboard automatically resolves the data-level perm through
  `resolvePermissions`; (b) `INDIVIDUAL_PERMISSIONS_BY_RESOURCE.orders` extended to include `'orders:comp'` and `'orders:void'` so future
  `orders:*` wildcard expansions are consistent. OWNERs with `['*:*']` already pass via the existing global short-circuit; nothing changes
  for them. No data migration, no removal of any existing strings. Paired with `avoqado-tpv` fix to `MenuViewModel.kt:310-311` (was checking
  `orders:comp/void` literals that no expansion path ever produced → button always "Sin permisos para cortesía/anular"; now checks
  `tpv-orders:comp/void`). 6 existing permission unit tests + 18 permissionSet tests pass.

- **AngelPay multi-account: relax MerchantAccount unique key to allow shared merchants across accounts** (migration
  `20260519210000_merchantaccount_unique_per_angelpay_account` + schema + `merchantAccount.service.ts` + `terminal.tpv.controller.ts`).
  Replaces yesterday's orphan-placeholder-cleanup workaround with the architecturally correct fix: changed
  `@@unique([providerId, externalMerchantId])` → `@@unique([providerId, externalMerchantId, angelpayUserAccountId])` so the same AngelPay
  merchant (e.g. afiliación 9814275) CAN exist multiple times in the DB — once per `AngelPayUserAccount` that has access to it. Each row
  gets its own slot assignment, its own cost structure, its own dashboard card, and its own SDK session at payment time. The
  orphan-placeholder cleanup branch from yesterday is removed (`upsertDiscoveredAngelPayMerchants` `existing` branch is now a simple
  in-place update without the slot-repointing transaction). The `findUnique` was replaced with `findFirst` keyed by the 3-column tuple.
  Postgres unique constraints treat NULL as distinct, so Blumon rows (which always have `angelpayUserAccountId = NULL`) retain their
  de-facto uniqueness because Blumon never inserts duplicate `externalMerchantId`s; a partial unique index could be added later if a
  stricter guarantee is needed. TPV config controller (`/tpv/terminals/:serial/config`) now eager-loads `angelpayUserAccount.email` and
  conditionally appends ` ({email})` to `displayName` ONLY when two rows share the same `externalMerchantId` — single-account venues keep
  clean labels. Includes SQL backfill executed on local `cmpaiwleb001f9kh88csbymkm` venue: cloned merchant 61 row for `contacto@avoqado.io`,
  repointed secondary slot to the new row, cloned the cost structure so the dashboard card shows "1 costo". Result: TPV merchant switcher
  will render `Avoqado (ventas@avoqado.io)` and `Avoqado (contacto@avoqado.io)` as distinct options, cashier picks → `switchAccount` swaps
  the SDK session → cobra under that account.

- **AngelPay multi-account: `reportDiscoveredMerchants` controller wasn't forwarding `angelpayUserAccountId`**
  (`angelpayValidation.tpv.controller.ts`). The TPV report endpoint already had the `accountId` in the request body and the controller
  looked up the `AngelPayUserAccount` to resolve `venueId` — but the call to `upsertDiscoveredAngelPayMerchants` only passed
  `{ venueId, merchants }`, dropping the account context entirely. Result: every TPV report was upgraded as if it had no account scoping,
  breaking (a) FK back-fill for new merchant rows, (b) placeholder-by-account preference, and (c) the new shared-merchant orphan-placeholder
  cleanup (see entry below). Fix: forward `angelpayUserAccountId: accountId` in the service call.

- **AngelPay multi-account: placeholder never upgrades when sharing a merchant with another account** (`upsertDiscoveredAngelPayMerchants`
  in `merchantAccount.service.ts`). When a venue has two AngelPay accounts (e.g. ventas@ + contacto@) and both accounts have access to the
  SAME AngelPay merchant (same `angelpayId`), the second account's reserved placeholder stayed `AWAITING_*` forever. Two interacting bugs:
  (1) the existing-merchant branch only updated the row's affiliation/name and never touched any placeholder reserved for the second
  account; (2) the placeholder upgrade branch (only reached when the merchant is unknown) wasn't filtered by `angelpayUserAccountId` — it
  would have grabbed _any_ placeholder in the venue and upgraded the wrong account's slot. Fix: (a) in the existing branch, after the
  in-place update look up an orphan placeholder owned by the report's `angelpayUserAccountId`, repoint whichever `VenuePaymentConfig` slot
  held the placeholder to the existing merchant, then delete the placeholder (single transaction); (b) in the upgrade branch, prefer
  placeholders owned by the report's `angelpayUserAccountId` and only fall back to unlinked placeholders, never picking another account's
  reserved slot. Routing still works because TPV's `switchAccount(B)` flips the SDK session at payment time independently of the
  `MerchantAccount.angelpayUserAccountId` FK. Cleanup also deletes the placeholder's `ProviderCostStructure` rows first (no
  `ON DELETE CASCADE` on that FK — first cut threw
  `P2003: Foreign key constraint violated on the constraint: ProviderCostStructure_merchantAccountId_fkey` because `reserveSlot` seeds a
  default cost row when the placeholder is created). Reproduced 2026-05-19 with `contacto@avoqado.io` sharing AngelPay merchant 61 (Avoqado
  / afiliación 9814275) with `ventas@avoqado.io`.

- **B4Bit currency field name**: `createPaymentOrder` was sending `fiat_currency` + `output_currency` (both undocumented), causing B4Bit to
  ignore the currency and fall back to its default — orders charged in $25 MXN were rendered as $25 USD on the QR. Per
  https://docs.b4bit.com/pay/api/endpoints/orders-create/, the documented field is `fiat`. Now sends `fiat: "MXN"` only.

### Changed

- **Backend data migration**: normalized `Terminal.brand` values to canonical set `PAX | NEXGO | INGENICO | VERIFONE`. Migration
  `20260518011942_normalize_terminal_brand` uppercases and standardizes pre-existing free-text variants (e.g., `pax`, `pax a910s`, `n86` →
  `PAX`/`NEXGO`). This is the data prerequisite for the upcoming device-provider compatibility validation (Task 10+) which gates AngelPay
  merchants to NEXGO terminals and Blumon merchants to PAX terminals. Dev DB had 0 Terminal rows at write time — migration is a forward-fix
  for sandbox/production datasets that may have free-text values.
- **B4Bit crypto auth simplified — fully login-less**: Removed the B4Bit username/password login flow entirely. Per B4Bit docs
  (https://docs.b4bit.com/pay/api/autenticacion/), the only required header is `X-Device-Id: <api-key-uuid4>` — no `Authorization` header,
  no signIn endpoint. Changes across three layers:
  - `b4bit.service.ts` (payment path): removed `getAuthToken()`, `cachedAuthToken`, `loginUrl` config, and `Authorization: Token` from
    `createPaymentOrder`/`getPaymentStatus`
  - `cryptoConfig.dashboard.service.ts` (setup wizard): removed `getAuthData()`, `cachedAuth`, `listB4BitDevices()`, `loginUrl`,
    `username`/`password` from config, and `Authorization: Token` from `completeCryptoSetup` validation
  - `dashboard.routes.ts` + `cryptoConfig.dashboard.controller.ts`: removed `GET /dashboard/crypto/devices` route + `listDevices` controller
  - Web dashboard (`CryptoConfigSection.tsx`): replaced the "Select device" dropdown (which depended on `signIn`) with a manual Device ID
    text input where the admin pastes the UUID directly from the B4Bit dashboard. Removed `listDevices()` from `crypto-config.service.ts`
  - **Env vars `B4BIT_USERNAME` and `B4BIT_PASSWORD` are no longer used** — safe to remove from all environments. `secretKey` still used
    ONLY for webhook HMAC validation

### Added

- **Backend schema**: `AngelPayUserAccount` model + `AngelPayAccountStatus` enum
  (`PENDING_PIN | ACTIVE | PIN_ROTATION_REQUIRED | SUSPENDED | DELETED`) for per-venue AngelPay credential storage. Design choices:
  `pinEncrypted` is nullable (null = no PIN provisioned yet, matches `PENDING_PIN` status); FK to `Venue` uses `onDelete: Restrict` (cascade
  would silently drop the AngelPay credential trail; operator must explicitly transition status to `DELETED` first); no `@@index([venueId])`
  (redundant with `@unique` constraint). First schema change for the AngelPay SDK 1.0.5 multi-merchant migration (D3 lifecycle). Migration:
  `20260518010202_add_angelpay_user_account`.
- **Backend schema**: optional display fields on `MerchantAccount` — `angelpayAffiliation` (the affiliation number from AngelPay's
  `MerchantOption.afiliationNumber`) and `angelpayMerchantName` (display name from `MerchantOption.name`). Both nullable, populated only for
  AngelPay merchant accounts. The actual AngelPay merchant ID is stored in the existing `externalMerchantId` column (per spec §3.2 — no new
  typed column required since `externalMerchantId` is already unique per provider).
- **Backend seed**: `PaymentProvider` row for AngelPay (`code: 'ANGELPAY'`, name "Angel Pay", PAYMENT_PROCESSOR, MX). `configSchema` has no
  required fields — AngelPay merchant IDs ride on the existing `MerchantAccount.externalMerchantId` (which is already required +
  unique-per-provider); the schema only documents the optional display fields (`angelpayAffiliation`, `angelpayMerchantName`).
- **Backend lib**: `src/lib/providerDeviceCompatibility.ts` — defines the `PROVIDER_DEVICE_COMPATIBILITY` catalog (`BLUMON: ['PAX']`,
  `ANGELPAY: ['NEXGO']`), the cheap `isProviderCompatibleWithBrand()` predicate (permissive on unknown providers / null brand), and the
  DB-aware `assertVenueHasCompatibleTerminal()` guard that counts ACTIVE terminals via Prisma. Throws `IncompatibleDeviceError` (new — HTTP
  409, code `INCOMPATIBLE_DEVICE`, appended to `src/errors/AppError.ts`) when an AngelPay merchant is being created for a venue that has
  zero ACTIVE NEXGO terminals (or vice versa for Blumon/PAX). Accepts an optional `Prisma.TransactionClient` so callers can run it inside
  `prisma.$transaction()`. TDD-driven: 15 unit tests in `tests/unit/lib/providerDeviceCompatibility.test.ts` (mocked-prisma pattern matching
  the rest of `tests/unit/`). Wired into `createMerchantAccount` in Task 10 and into terminal assignment + brand change in Tasks 11–13.
- **Backend service**: provider↔device compatibility guard wired into `assignMerchantToTerminal` (Task 11, validation point #2 of 4). When
  code mutates `Terminal.assignedMerchantIds`, the merchant's provider must be compatible with the terminal's brand (e.g., ANGELPAY
  merchants → NEXGO terminals only). Rejects with `IncompatibleDeviceError` (HTTP 409). Bulk-assign paths emit a single error listing all
  incompatible merchants for the operator UI. Two helpers added to `src/lib/providerDeviceCompatibility.ts`:
  `assertMerchantTerminalCompatible(terminalId, merchantId, tx?)` for single-merchant push paths and
  `assertMerchantsTerminalCompatible(terminalId, merchantIds[], tx?)` for set/replace flows. Wired into the canonical service path
  (`terminals.superadmin.service.updateTerminal` + `createTerminal`) and 6 bypass paths in the superadmin controllers:
  `terminal.controller.assignMerchantsToTerminal`, four push sites in `merchantAccount.controller` (Blumon auto-fetch single, Blumon batch
  auto-fetch, batch assign terminals, Full Setup auto-attach + additional), and `onboarding.controller` terminal create. Auto-attach paths
  log + skip incompatible terminals (matching serial number from a different brand era should not fail the whole flow); operator-explicit
  paths fail hard with the error surfaced to the UI. TDD-driven: 5 unit tests in
  `tests/unit/services/dashboard/terminals.superadmin.deviceCompatibility.test.ts`.
- **Backend service**: `createMerchantAccount` now enforces provider↔device compatibility via `assertVenueHasCompatibleTerminal` (Task 8) —
  ANGELPAY merchants require a NEXGO terminal in the venue, BLUMON merchants require PAX. Adds AngelPay-specific branch: requires ACTIVE
  `AngelPayUserAccount`, validates `externalMerchantId` as numeric string (AngelPay merchant IDs are integers), and stores placeholder
  `encryptCredentials({})` blob in `credentialsEncrypted` (real auth lives on `AngelPayUserAccount`). The compat gate runs only when the new
  optional `venueId` is supplied on `CreateMerchantAccountData` (existing Blumon callers that omit it keep legacy behavior; callers that
  include it get the gate for free). Blumon path otherwise unchanged. TDD-driven: 5 unit tests in
  `tests/unit/services/superadmin/merchantAccount.deviceCompatibility.test.ts` (mocked Prisma + mocked compat helper). Spec §3.1, §4.4.
- **Backend service**: `src/services/superadmin/angelpayUserAccount.service.ts` — 8-function lifecycle CRUD for `AngelPayUserAccount` (D3):
  `createAngelPayUserAccount` (validates email + optional 6-digit PIN, returns `PENDING_PIN` or `ACTIVE` depending on whether PIN was
  provided, rejects duplicate venue accounts with `ConflictError`), `setAngelPayUserAccountPin` (encrypts + transitions to `ACTIVE`, clears
  prior `lastValidationErr` / `statusReason`), `markAngelPayUserAccountRotationRequired` / `suspendAngelPayUserAccount` /
  `softDeleteAngelPayUserAccount` (status transitions with audit fields), `markAngelPayUserAccountValidated` /
  `recordAngelPayUserAccountError` (TPV-side validation reporting — status unchanged), `getAngelPayUserAccountForTerminal` (terminal → venue
  → account join). PIN encryption reuses `encryptCredentials` from `merchantAccount.service.ts` (now exported) for a single canonical
  credentials-at-rest format. Standalone-exported-function style matches the rest of `services/superadmin/`. TDD-driven: 14 unit tests in
  `tests/unit/services/superadmin/angelpayUserAccount.service.test.ts` (mocked Prisma + mocked encryption helper).
- **B4Bit minimum amount validation**: `initiateCryptoPayment` now rejects orders below $20 MXN (2000 centavos) with a clear error
  `El monto mínimo para pagar con cripto es $20 MXN`. Prevents confusing validation errors from B4Bit's API when merchants try to charge
  small amounts
- **Backend endpoint**: `/api/v1/tpv/terminals/:serialNumber/config` now (a) filters returned `merchants[]` to only providers compatible
  with `terminal.brand` (validation point #4 of 4 — runtime gate / defense in depth), and (b) includes a new optional `angelpayAuth` payload
  `{ accountId, email, pin, environment }` when the terminal is NEXGO and the venue has an ACTIVE `AngelPayUserAccount`. PIN is decrypted
  server-side and transported over TLS; never logged or persisted on the TPV (see spec §4.5b PIN handling rules). Merchant DTO extended
  additively with `externalMerchantId`, `isActive`, `angelpayAffiliation`, `angelpayMerchantName` per spec §6.4. `decryptCredentials` in
  `src/services/superadmin/merchantAccount.service.ts` was exported (it already existed but was internal). TDD-driven: 4 unit tests in
  `tests/unit/controllers/tpv/terminal.tpv.angelpay.test.ts` (mocked Prisma + mocked compat/decrypt/account helpers). Spec §3.1 (point 2d),
  §4.4, §4.5, §4.5b, §6.4.
- **Backend endpoints (superadmin)**: 6 new endpoints exposing `AngelPayUserAccountService` to the dashboard for Phase 2 UI (Task 15):
  `GET /superadmin/venues/:venueId/angelpay-account`, `POST .../angelpay-account` (create), `PATCH /superadmin/angelpay-accounts/:id/pin`
  (rotate PIN, transitions to ACTIVE), `PATCH .../:id/status` (single endpoint dispatched by body.status to
  `markAngelPayUserAccountRotationRequired` or `suspendAngelPayUserAccount` — keeps dashboard symmetric), `DELETE .../:id` (soft delete).
  All gated by the existing superadmin auth + role middleware (no new middleware needed); response payloads strip `pinEncrypted` so
  ciphertext never crosses the wire. Two new service helpers (`getAngelPayUserAccountByVenueId`, `getAngelPayUserAccountById`) added to
  support 404-before-mutation. New controller `src/controllers/superadmin/angelpayUserAccount.controller.ts` + routes
  `src/routes/superadmin/angelpayUserAccount.routes.ts` mounted at the superadmin router root so both venue-scoped
  (`/venues/:venueId/angelpay-account`) and id-scoped (`/angelpay-accounts/:id/...`) paths live in one file. TDD-driven: 10 unit tests in
  `tests/unit/controllers/superadmin/angelpayUserAccount.controller.test.ts` covering happy paths + 404 + 400 dispatch failures.
- **Backend endpoints**: two new TPV report endpoints (Task 14, closes backend Phase 1). `POST /api/v1/tpv/angelpay/report-validation`
  accepts `{ accountId, state, ... }` and updates the corresponding `AngelPayUserAccount` (`markAngelPayUserAccountValidated` on
  AUTHENTICATED with `externalUserId`, `recordAngelPayUserAccountError` on AUTH_ERROR or CONFIG_MISMATCH with structured `missingInAvoqado`
  / `missingInSdk` diff). `POST /api/v1/tpv/angelpay/report-merchant-switch` accepts `{ fromMerchantId, toMerchantId, durationMs }` and
  emits a structured audit log line (no DB writes — switch events live in logs/observability tooling for now per spec §8.2). Both routes
  require terminal-auth via `authenticateTokenMiddleware` (JWT carries `terminalSerialNumber` in `req.authContext`) and return 204 on
  success; bad state / missing required fields surface as `BadRequestError` (HTTP 400) through the standard error handler. TDD-driven: 9
  unit tests in `tests/unit/controllers/tpv/angelpayValidation.tpv.controller.test.ts` (mocked service). Spec §4.6, §8.2.

### Fixed

- **Recent customers endpoint**: Removed `lastVisitAt: { not: null }` filter from `getRecentCustomers` — new customers with no visits were
  excluded. Now returns all active customers, ordered by most recent visit first (nulls last), then by creation date
- **Command Center timezone bugs**: All date boundary calculations in `commandCenter.service.ts` now use venue timezone instead of UTC.
  Affected methods: `getSummary()`, `getInsights()`, `getTopSellers()`, `getCategoryBreakdown()`, `getStockVsSales()`. "Today", "this week",
  and "this month" now correctly correspond to the venue's local midnight rather than UTC midnight. Raw SQL date grouping in sales trend
  also uses venue timezone so late-night sales are attributed to the correct local day
- **Commission system timezone bugs**: `getPeriodDateRange()` in `commission-utils.ts` now uses venue timezone instead of UTC for all period
  boundaries (DAILY, WEEKLY, BIWEEKLY, MONTHLY, QUARTERLY, YEARLY). The `_timezone` parameter was unused (defaulting to UTC) — now renamed
  to `timezone` with `DEFAULT_TIMEZONE` default. All callers updated: `commission-aggregation.service.ts`, `commission-tier.service.ts`,
  `commission-milestone.service.ts`. Staff commission stats in `commission-calculation.service.ts` also fixed (thisMonthStart/lastMonth
  boundaries)
- **Sales goal timezone bugs**: `calculateCurrentSales()` in `sales-goal.service.ts` and `goal-resolution.service.ts` now uses venue
  timezone for date boundaries. Previously used `new Date()` (UTC midnight = 6pm Mexico), causing daily goals to reset mid-afternoon

### Added

- **Order Guest Information & Actions System** (2025-01-19)

  - `prisma/schema.prisma`: Added `specialRequests` field to Order model for dietary restrictions, allergies, special occasions
  - `prisma/schema.prisma`: Created `OrderAction` audit table with ActionType enum (COMP, VOID, DISCOUNT, SPLIT, MERGE, TRANSFER)
  - `order.tpv.service.ts:556-701`: Implemented `removeOrderItem()` with optimistic concurrency control
    - Delete specific items from orders with version checking
    - Automatic total recalculation and Socket.IO event broadcasting
    - Prevents removal from paid orders
  - `order.tpv.service.ts:703-815`: Implemented `updateGuestInfo()` for guest management
    - Update covers, customerName, customerPhone, specialRequests
    - Real-time Socket.IO event broadcasting
    - Supports DINE_IN guest tracking and TAKEOUT customer info
  - `order.tpv.service.ts` (appended): Implemented `compItems()` for service recovery
    - Comp specific items or entire order
    - Required reason field for audit trail
    - Creates OrderAction record with COMP type
    - Use cases: food quality issues, long wait times, service recovery
  - `order.tpv.service.ts` (appended): Implemented `voidItems()` for order corrections
    - Void specific items with optimistic locking
    - Required reason field for audit trail
    - Creates OrderAction record with VOID type
    - Use cases: incorrect entry, customer cancellation
  - `order.tpv.service.ts` (appended): Implemented `applyDiscount()` for flexible discounts
    - Supports PERCENTAGE (1-100%) and FIXED_AMOUNT discounts
    - Item-level or order-level discount application
    - Creates OrderAction record with DISCOUNT type
    - Optimistic concurrency control with version field
  - `order.tpv.controller.ts:90-111`: Added `removeOrderItem()` controller
  - `order.tpv.controller.ts:113-138`: Added `updateGuestInfo()` controller
  - `order.tpv.controller.ts:140-165`: Added `compItems()` controller
  - `order.tpv.controller.ts:167-192`: Added `voidItems()` controller
  - `order.tpv.controller.ts:194-221`: Added `applyDiscount()` controller
  - `tpv.schema.ts:258-270`: Added `removeOrderItemSchema` validation
  - `tpv.schema.ts:273-288`: Added `updateGuestInfoSchema` validation with phone regex
  - `tpv.schema.ts:291-305`: Added `compItemsSchema` validation (empty itemIds = comp entire order)
  - `tpv.schema.ts:307-320`: Added `voidItemsSchema` validation with required reason
  - `tpv.schema.ts:322-349`: Added `applyDiscountSchema` validation with percentage range check (1-100)
  - `tpv.routes.ts:2392-2398`: Added DELETE `/venues/:venueId/orders/:orderId/items/:itemId` route
  - `tpv.routes.ts:2449-2455`: Added PATCH `/venues/:venueId/orders/:orderId/guest` route
  - `tpv.routes.ts:2513-2519`: Added POST `/venues/:venueId/orders/:orderId/comp` route with `orders:comp` permission
  - `tpv.routes.ts:2577-2583`: Added POST `/venues/:venueId/orders/:orderId/void` route with `orders:void` permission
  - `tpv.routes.ts:2648-2654`: Added POST `/venues/:venueId/orders/:orderId/discount` route with `orders:discount` permission
  - **WHY**: Enables Square POS-style MenuScreen redesign with 4 tabs (Menu, Check, Actions, Guest)
  - **IMPACT**: Android app can now manage order lifecycle with full audit trail for compliance and reporting

- **abandoned-orders-cleanup.job.ts: Auto-cleanup for abandoned "Pedido rápido" orders** (abandoned-orders-cleanup.job.ts,
  server.ts:21,60,157)

  - **Problem**: When users click "Pedido rápido" then press Back, empty PENDING orders accumulate in the system
  - **Solution**: Cron job that auto-deletes abandoned orders every 15 minutes
  - **Deletion Criteria**:
    - ✅ Order has 0 items (never added anything)
    - ✅ Status = PENDING (not paid)
    - ✅ Created > 30 minutes ago
    - ✅ Type = TAKEOUT (don't delete table orders)
  - **Frequency**: Runs every 15 minutes
  - **Inspiration**: Toast POS uses similar auto-cleanup for "draft orders"
  - **Impact**: Prevents cluttering "Pedidos abiertos" list with abandoned orders
  - **Safety**: Only deletes empty TAKEOUT orders, never deletes table orders or orders with items
  - **Logging**: Logs each deleted order with age and order number
  - **Testing**: Call `abandonedOrdersCleanupJob.cleanupNow()` to manually trigger

- **order.tpv.service.ts: Modifiers support for order items** (order.tpv.service.ts:260-392)

  - Added `modifierIds?: string[]` to `AddOrderItemInput` interface
  - Backend now accepts modifier IDs when adding items to orders
  - Automatically calculates modifier pricing and adds to item total
  - Creates `OrderItemModifier` records linking modifiers to order items
  - Includes modifiers in order responses (`getOrder`, `getOrders`, `addItemsToOrder`)
  - Calculates item total as: `(product price + sum of modifier prices) * quantity`
  - **WHY**: Android app can now persist selected modifiers (BBQ, Chipotle Mayo, Ranch) to database
  - **IMPACT**: Selected modifiers now appear in order panel and receipts

- **Terminal Activation Validation on Login** (2025-01-03)
  - `src/schemas/tpv.schema.ts` (lines 17-22): Added `serialNumber` field to `pinLoginSchema`
  - `src/services/tpv/auth.tpv.service.ts` (lines 69-100): Validate terminal activation status on login
    - Check if terminal exists for the venue
    - Validate `activatedAt` is not null
    - Reject login if terminal status is RETIRED or INACTIVE
    - Return specific error code: `TERMINAL_NOT_ACTIVATED`
  - `src/controllers/tpv/auth.tpv.controller.ts` (lines 18-20): Extract `serialNumber` from request body
  - **WHY**: Prevents unauthorized device access after admin manually deactivates a terminal
  - **BREAKING CHANGE**: Android app MUST now send `serialNumber` in login request

### Fixed

- **product.dashboard.service.ts: CRITICAL - getProducts() not including nested modifiers in response**
  (product.dashboard.service.ts:95-106)

  - **Problem**: Android ProductSelectorBottomSheet showed ModifierGroup name ("Aderezos") but no individual modifiers (BBQ, Chipotle Mayo,
    Ranch) because backend was not including them in API response
  - **Root Cause**: `getProducts()` function had `group: true` instead of nested `group: { include: { modifiers: true } }`
  - **Inconsistency**: `getProduct()` (singular) correctly included modifiers, but `getProducts()` (plural - used by Android) did not
  - **Solution**: Updated Prisma query to match `getProduct()` pattern:
    ```typescript
    modifierGroups: {
      include: {
        group: {
          include: {
            modifiers: {
              orderBy: { displayOrder: 'asc' }
            }
          }
        }
      },
      orderBy: { displayOrder: 'asc' }
    }
    ```
  - **Impact**: Android now receives full modifier data, ProductSelectorBottomSheet displays checkboxes for BBQ, Chipotle Mayo, Ranch when
    clicking "Alitas Buffalo"
  - **Testing**:
    - Click "Alitas Buffalo" on Android → Modal shows "Aderezos" with 3 modifiers
    - API response now includes `modifiers: [{ id, name, priceAdjustment, displayOrder }]` inside each ModifierGroup

- shift.tpv.service.ts: Add real-time calculation of shift totals in getCurrentShift (shift.tpv.service.ts:66-173)

  - **CRITICAL FIX**: Shift totals now update in real-time when payments are recorded
  - Previous behavior: `totalSales`, `totalCardPayments`, etc., only updated when shift was closed
  - TPV was showing "$0" for active shifts even after successful payments
  - Now dynamically calculates totals from all `COMPLETED` payments associated with shift
  - Also calculates `totalOrders` and `totalProductsSold` in real-time
  - Payment method breakdown (cash/card/voucher/other) updated immediately
  - Fix ensures TPV shift screen always displays accurate current totals
  - Impact: Critical user-facing bug - staff could not see their sales during active shift

- payment.tpv.service.ts: Fix rating parsing for numeric strings from Android app (payment.tpv.service.ts:24-39)
  - Updated `mapTpvRatingToNumeric()` to parse numeric strings ("1"-"5") from Android app
  - Previous version only accepted categorical strings ("EXCELLENT", "GOOD", "POOR")
  - Backend was receiving `reviewRating="4"` but returning null, preventing Review record creation
  - Now correctly parses numeric strings and validates range 1-5
  - Backward compatible with legacy categorical format
  - Fix enables Review records to appear in dashboard after Android payment with rating

### Changed

- auth.tpv.service.ts: Switch to plain text PIN authentication (src/services/tpv/auth.tpv.service.ts:26-58)
  - Remove bcrypt comparison logic (removed loop with bcrypt.compare)
  - Use direct Prisma query with plain text PIN matching: `pin: pin`
  - Remove bcrypt import
  - Reduces authentication time (no bcrypt overhead)
  - User requirement: "its only 4 digits and its not critical"
  - Security trade-off: Plain text PINs for simplicity (4-6 digit codes only)

### Security

- ✅ **Terminal Activation Enforcement**: Devices cannot login after manual deactivation
  - Prevents reuse of deactivated terminals
  - Logs warning when login attempted on non-activated terminal
  - Forces re-activation flow through admin dashboard
- ⚠️ Plain text PIN storage: TPV PINs are now stored and compared as plain text (4-6 digits)
  - Generic error message prevents PIN enumeration: "Staff member not found or not authorized"
  - Rate limiting still enforced on backend (10 attempts per 15 min)
  - Decision: User explicitly requested plain text over bcrypt for 4-digit PINs

## [1.0.0] - 2025-01-30

### Added

- Initial release with complete restaurant management backend
- Multi-tenant architecture (Organization → Venue isolation)
- Terminal activation system (Square POS pattern)
- Staff authentication with JWT tokens
- Role-based access control (SUPERADMIN → VIEWER hierarchy)
- Inventory management with FIFO batch tracking
- Order and payment processing
- Real-time Socket.IO integration
- Stripe subscription management

[Unreleased]: https://github.com/yourusername/avoqado-server/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/yourusername/avoqado-server/releases/tag/v1.0.0

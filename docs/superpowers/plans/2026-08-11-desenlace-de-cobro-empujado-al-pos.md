# El desenlace del cobro se empuja al POS, no se persigue

**Repos:** avoqado-server (primero) · avoqado-android · avoqado-ios
**Origen:** medido en hardware el 2026-08-11 (D3 + Nexgo N860, tarjeta real).
Ver memoria `doble-cobro-tarjeta-por-error-de-transporte`.
**v2 — reescrito tras revisión de Codex.** La v1 tenía un defecto que reintroducía el
doble cobro; está documentado abajo para que nadie lo reintroduzca.

---

## El problema, con números

Los tres pasillos del doble cobro están cerrados y verificados. Lo que quedó es que
**el aviso llega tarde y sólo si alguien pregunta**:

```
09:31:11.170  el POS recibe el 409 del cancel → empieza a sondear
09:31:11.4 / 12.2 / 14.5   tres sondeos (esperas 0 / 500 ms / 2 s)
09:31:14.484  se arma la llave → el cajero YA podría saberlo
09:31:18      la terminal registra el cobro
              ...pero nadie se lo dice al POS hasta la venta siguiente (90 s después)
```

1. **~2.5 s de retraso** — el cliente adivina cuándo preguntar porque nadie le avisa.
2. **Silencio indefinido** — si el cajero se va a otra pantalla, nadie sondea.

El server sabe el desenlace al instante y el POS ya está conectado por Socket.IO. Hoy
el server sólo emite *hacia la terminal*, nunca de regreso al POS.

---

## 🔴 El defecto de la v1, y por qué el evento es un DESPERTADOR

La v1 decía: *"si el sondeo ya lo resolvió, el evento no hace nada"*. Está mal, y es el
mismo bug que llevamos tres pasillos cerrando.

`closeRowFromPaymentTx` **a propósito** asciende `CANCELLED`/`FAILED`/`CANCEL_REQUESTED`
a `COMPLETED` cuando después aparece el Payment — el código lo llama *"verdad de fondo
de que el dinero se movió"*. O sea que **el estado de un cobro SÍ cambia después de
resuelto**. Con la regla de la v1:

```
1. llega 'cancelled'          → el cliente resuelve y BORRA la llave
2. segundos después, REST     → la fila pasa a COMPLETED
3. la regla "el primero gana" → ese segundo evento se ignora
4. el cajero cobra otra vez   → DOBLE COBRO
```

**Dos reglas que reemplazan la de la v1:**

1. **Máquina de estados monotónica, no deduplicación.** `COMPLETED` domina siempre,
   aunque llegue tarde. Nunca se degrada de `COMPLETED` a otra cosa.
2. 🔴 **El evento es un DESPERTADOR, no una orden.** El cliente NO actúa sobre el
   payload: lo usa para ir a leer el estado durable.

```
evento socket → despierta al cliente → GET estado durable → decide
```

Ese GET cuesta milisegundos y elimina de un golpe los eventos falsos, viejos y fuera de
orden. Y resuelve la contradicción de la v1, que decía "el push no es fuente de verdad"
y a la vez "se resuelve al instante con el evento": si el cliente actúa sobre el
payload, el push **es** la verdad.

---

## S0. Tres huecos preexistentes que hay que tapar ANTES

No los introduce esta feature; ya pueden costar dinero hoy. Pero el push los vuelve
**inmediatos**: hoy son corrupción en la base, con push serían una instrucción al
cajero. Se pueden entregar solos, y van primero.

### S0.1 — Cualquier socket autenticado puede falsificar un resultado

`socketManager.ts:341` toma el payload de `terminal:payment_result` y se lo pasa directo
a `handlePaymentResult`. Registra el `socketId` en el log y **nunca lo usa para
autorizar**. No verifica que el socket sea una TPV, ni que sea *esa* TPV, ni el venue,
ni valida el esquema.

Un dashboard, una tablet o una terminal equivocada con un `requestId` conocido puede
mandar `success` y cerrar la fila. Con el push, eso se convierte en un "ya se cobró"
instantáneo en la pantalla del cajero.

**Arreglo:** pasar la identidad del socket al servicio y validar fila ↔ venue ↔ terminal
normalizada. Validar el payload con Zod.

### S0.2 — El cierre por REST no verifica pertenencia

`closeRowFromPaymentTx` busca `where: { requestId }` y nada más: sin venue, terminal,
orden ni monto. Una TPV defectuosa o comprometida puede adjuntar el
`terminalPaymentRequestId` de otra venta y marcarla pagada con un Payment ajeno.

**Arreglo:** verificar al menos mismo `venueId`, terminal esperada, orden compatible y
monto/propina compatibles antes de cerrar.

### S0.3 — Un Payment que NO está completado cierra la fila como COMPLETED

El esquema admite `PENDING`, `FAILED`, `PROCESSING` y `REFUNDED`, y los dos llamadores
(`payment.tpv.service.ts:2120` y `:3017`) llaman a `closeRowFromPaymentTx`
**incondicionalmente**, sin mirar `newPayment.status`.

🔴 Esto ya puede producir un falso *"ya se cobró"* — **la dirección más cara, porque el
comercio pierde el dinero en silencio**: el cajero no cobra una venta que nunca se pagó.

**Arreglo:** sólo `newPayment.status === COMPLETED` produce el desenlace de dinero movido.

---

## S1. El evento

**`terminal:payment_outcome`**, payload mínimo:

```ts
{ requestId, status, paymentId }
```

Sin datos de tarjeta. Es un despertador: el cliente lo usa para saber *a quién*
preguntar, no *qué creer*.

### S1.1 — Se emite el estado DURABLE, nunca el payload que llegó

`closeRow` es fire-and-forget y **puede ser no-op** si la fila ya era terminal. Caso
real posible: REST ya dejó `COMPLETED`, llega tarde un `cancelled` por socket, el CAS no
modifica nada — y emitir el payload entrante le diría al POS "cancelado" mientras la
base dice "cobrado".

`closeRow` y `closeRowFromPaymentTx` deben devolver `{ closed, outcome }` con el estado
durable resultante. **Sólo se emite ese estado canónico, después del `await`.** Si el
cierre durable falló, no se emite un desenlace supuesto — hoy `closeRowFromPaymentTx`
se traga sus errores.

### S1.2 — A quién se emite

A los sockets del venue (`roomManager.getVenueSockets(venueId)`), **filtrando por
clientes POS** — hoy ese conjunto incluye dashboard, KDS y las propias TPV. No sólo al
socket que inició el cobro: pudo reconectarse con otro id, que es justo el escenario que
arreglamos. El `requestId` es el filtro final; sólo la tablet que lo tiene actúa.

> ⚠️ **No existe room de Socket.IO por venue.** `addToVenueRoom` sólo llena un `Map`;
> las rooms reales (`socket.join`) son sólo para mesas. Se usa `getVenueSockets()`.
>
> ⚠️ **Esto se rompe en multi-instancia.** Es un `Map` local. Hoy funciona porque
> producción está fijada a una instancia (`render.yaml:73`). Antes de escalar hace falta
> `socket.join(venueRoom)` real + `io.to(venueRoom).emit(...)`, o Pub/Sub explícito.
> Queda anotado aquí para que el día que escalen no se descubra en un local.

### 🔴 S1.3 — La emisión va DESPUÉS del commit, en dos puntos exactos

Los límites seguros son **después de que retornan las transacciones**:
`payment.tpv.service.ts:2182` y `:3022`. **No** dentro de `closeRowFromPaymentTx`, y
**tampoco** esperar a los `PAYMENT_COMPLETED` actuales (`:2335`, `:3153`): antes de esos
hay trabajo auxiliar lento.

Emitir dentro de la transacción anunciaría un cobro que aún puede revertirse. **Anunciar
dinero que no se movió es peor que el bug que arreglamos.**

---

## Clientes: Android · iOS (tras el deploy del server)

Espejo exacto por nombre. Van en el MISMO trabajo, por la regla de paridad.

### C1. El evento despierta, el estado durable decide

Al recibir `terminal:payment_outcome` con un `requestId` que coincide con el cobro en
vuelo o con la llave durable armada: **se consulta el estado durable** y se decide con
esa respuesta. Nunca se actúa sobre el payload.

`COMPLETED` corrige cualquier desenlace anterior. **El sondeo de 3 intentos se queda
intacto** como red de seguridad.

### C2. El indicador aparece al ARMAR la llave, no al recibir el push

A los ~3.3 s ya hay incertidumbre y ahí debe salir la banda: *"Un cobro anterior quedó
sin confirmar — revisa la terminal"*, con acción **Revisar**. Persistente, sobrevive a
cambios de pestaña y de turno. Hoy **no hay ningún indicador fuera del flujo de pago**.

El push sólo cambia la banda de "sin confirmar" a un desenlace verificado. **Nunca borra
la evidencia en silencio.**

### C3. Recuperación al reconectar y al volver a foreground

Socket.IO **no reproduce eventos perdidos**, y en segundo plano el móvil puede estar
desconectado. Al reconectar o volver a foreground, si existe llave durable, el cliente
consulta el estado **solo** — sin esperar a que alguien toque "Revisar" ni a la venta
siguiente.

(Si algún día hace falta avisar con la app suspendida, ahí sí APNs/FCM sería un canal
secundario inevitable. Hoy no está en alcance.)

### C4. El aviso al resolver cambia de tono

Hoy usa `AvoqadoSuccessToast` — palomita verde que se va sola — para *"El cobro anterior
sí se había realizado"*. Instrumento equivocado: no es una celebración, es dinero
cobrado en una venta que se creía cancelada. Pasa a un aviso que el cajero descarta a
conciencia y que dice qué pasó y qué hacer: *"Se cobraron $X en la venta anterior.
Búscala en Ventas para dar el recibo."*

---

## Tests

**Los 5 originales:**
1. Emite cuando SÍ había long-poll esperando.
2. Emite cuando NO había (el caso del cancel).
3. El payload lleva `requestId`, `status`, `paymentId` y nada más.
4. Un rollback de la transacción NO emite.
5. No truena si el venue no tiene sockets conectados.

**Los 10 que agregó la revisión:**
6. `cancelled` → REST `COMPLETED`: el segundo desenlace SÍ se procesa.
7. REST `COMPLETED` → socket `cancelled`: nunca se degrada.
8. `closeRow` no-op: no emite el payload entrante.
9. Socket de otra terminal / otro venue / otro tipo de cliente: resultado rechazado.
10. `terminalPaymentRequestId` de otra orden, venue, terminal o monto: no cierra.
11. Payment `FAILED`/`PENDING`/`PROCESSING`: jamás produce `COMPLETED`.
12. Fallo interno del cierre: el Payment commitea, pero NO se emite falso éxito.
13. Los dos llamadores REST: prueba de rollback y de emisión post-commit.
14. Reconectar / volver a foreground recupera un desenlace perdido.
15. Duplicados y eventos fuera de orden.

---

## Orden y compatibilidad

1. **S0 primero** (los tres huecos preexistentes) — se puede entregar solo.
2. **Server S1 a `develop` y desplegado.** El evento es **aditivo**: las versiones viejas
   lo ignoran y siguen con su sondeo. No se renombra ni se quita nada.
3. **Android e iOS en el MISMO trabajo.**
4. **Verificación en hardware**: D3 + Nexgo, $0.15, cancelar al pasar la tarjeta.
   Criterio de éxito: el aviso sale **inmediato y sin que nadie inicie otra venta**.

## Lo que NO se toca

- El sondeo de 3 intentos (0 / 500 ms / 2 s) — es la red de seguridad.
- La fila durable como fuente de verdad.
- `mustReconcile` / `cancelRequested` — verificados con tarjeta física.

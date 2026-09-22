# Ninguna terminal muerta: el cobro LOCAL también tiene salida

**Origen:** instrucción del founder (2026-09-22): *«no puede quedar ninguna terminal muerta»*, tras
quedarse sin poder cobrar en la N86 por TERCERA vez y tener que escribir SQL en la base del aparato.
**Repos:** `avoqado-server` · `avoqado-tpv`. (android/iOS: no se tocan — su carril ya tiene salida.)
**Tier:** core, gratis, sin interruptor. Es un defecto de disponibilidad de cobro.

## 1. La cadena exacta, medida el 22-sep (no inferida)

Un **Pago rápido** en la terminal (sin solicitud del POS) cuyo desenlace queda incierto mata el
aparato entero y no tiene ninguna salida dentro del producto. Los cinco eslabones, cada uno
verificado en el código:

1. `PaymentAttemptDao.findTerminalHold` (:85-99) aparta el APARATO cuando la fila es
   `INDETERMINADO` **sin `orderId`** — y un Pago rápido nunca tiene `orderId`, porque no hay venta
   que cercar. La cerca del 13-sep («cercar la venta, no el aparato») no puede aplicarse aquí.
2. `AngelPayPaymentViewModel.esperarVeredictoDelServidor` (:3228-3237) exige
   `_socketRequestId != null`; sin él pinta «NO vuelvas a cobrar… pregúntale al supervisor» **sin
   reloj, sin botón y sin reintento**. Es el callejón.
3. `GET …/terminal-payment/attempts/:attemptId` → `consultarIntentoDeTerminal` arranca con
   `findAttemptLink(attemptId)` y devuelve `null` (404) si no hay vínculo.
4. `TerminalPaymentAttemptLink.requestId` es **obligatorio y con FK** a `TerminalPaymentRequest`
   (`schema.prisma`). Un cobro local **no puede tener vínculo**: no existe la solicitud a la que
   apuntar.
5. `POST …/attempts/:attemptId/no-instrument-resolution` exige `requestId` en el cuerpo
   (`no-instrument-resolution.service.ts:39`), bloquea la fila de la solicitud con `FOR UPDATE` y
   despierta al POS. Sin solicitud, no aplica.

**Cuánto ocurre — el dato que faltaba:** en la libreta de la N86, **13 de 27 intentos (48 %) son
locales y ninguno tiene `orderId`**. No es un caso raro: es la mitad de los cobros de esa terminal.

🔑 **El principio que se rompió:** toda la maquinaria de recuperación —ventana de confirmación,
declaración del cajero, evidencia del webhook, liberación— cuelga de `TerminalPaymentRequest`, o
sea del POS. El intento, que es donde de verdad vive el dinero, no tiene carril propio.

## 2. Lo que NO se hace (y por qué)

- ❌ **Dejar que el cajero declare sin preguntarle al servidor.** Es exactamente lo que produjo el
  cobro doble del 2026-08-10. La duda se resuelve preguntando por el desenlace ACREDITADO.
- ❌ **Liberar por reloj.** Decisión del founder del 10-sep, no se re-litiga.
- ❌ **Un endpoint nuevo paralelo.** Duplicar el carril del dinero es lo que ha producido defectos
  cada vez (`reconcileBankDeclined` copiado de `reconcileUncharged`, 21-sep). Se entra por el
  núcleo existente.

## 3. El diseño: el carril es del INTENTO, no de la solicitud

| # | Pieza | Dónde | Qué cambia |
|---|---|---|---|
| A | **La consulta contesta sin vínculo** | server | `consultarIntentoDeTerminal` deja de exigir vínculo: con `Payment.idempotencyKey = attemptId` de ESTA terminal y ESTE venue ⇒ `RECORDED`; con evidencia del webhook ⇒ la que haya; sin nada ⇒ `NO_EVIDENCE` explícito (hoy: 404 mudo) |
| B | **La declaración acepta un intento sin solicitud** | server | `requestId` pasa a opcional. Sin él: no hay fila que cerrar ni POS que despertar — sólo constancia inmutable y la respuesta que deja a la terminal soltar SU fila |
| C | **La pantalla entra a la ventana** | tpv | Se retira el `requestId == null` del guard: un cobro local obtiene reloj de 30 s, «El cliente no presentó tarjeta» y «Consultar de nuevo», igual que uno del POS |

**Dónde vive la constancia de B** (decisión abierta, ver §5): `operatorResolution` hoy vive en
`TerminalPaymentAttemptLink`, que exige `requestId`.

## 4. Lo que NO puede debilitarse (invariantes heredados)

- Una aprobación tardía **contradice** la declaración, nunca la borra: el trigger
  `preserve_no_instrument_resolution` vuelve inmutable el testimonio del cajero.
- La evidencia positiva durable de la TPV (`server_processor_evidence`) sigue vetando la
  liberación, el cancel remoto y la cerca de la misma venta.
- La declaración es **online-only a propósito**: sin red no se encola (la afirmación del cajero
  caduca).
- El mensaje de un rechazo lo escribe el SERVIDOR.

## 5. Decisiones abiertas antes de construir B

1. **Dónde se guarda la declaración de un intento sin solicitud.** Opción (a): `requestId`
   nullable en el vínculo — reusa el trigger y la inmutabilidad, pero toca una FK viva. Opción (b):
   tabla propia `TerminalAttemptResolution` — aditiva y sin riesgo sobre lo existente, pero duplica
   el concepto. **Recomendación: (b)**, porque (a) hace nullable una columna de la que cuelgan un
   trigger, un `count` de unicidad y `resolverEsperaDelPos`.
2. **Qué pasa si el webhook acredita dinero DESPUÉS de la declaración local.** Propuesta: igual que
   hoy en el carril del POS — 🚨 y contradicción en pantalla, nunca borrar el testimonio.

## 6. Orden

Servidor (A y B) → desplegar → TPV (C) con la próxima release. C sin A es inerte; A sin C no rompe
nada (ningún cliente llama todavía).

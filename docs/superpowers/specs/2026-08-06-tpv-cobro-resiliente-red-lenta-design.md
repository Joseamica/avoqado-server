# Cobro resiliente en red lenta — diseño

**Fecha:** 2026-08-06 · **Repos:** `avoqado-tpv` (principal), `avoqado-server` (telemetría) **Objetivo del founder, textual:** _"si la
terminal tiene internet inestable o 3g o lento con latencia, los pagos sí pasen sin problemas, y ya después la conexión con el backend para
lo demás — sin romper nada."_

---

## 1. El problema, acotado con datos

La ventana crítica es **tarjeta presentada → el cajero sabe qué pasó**. Todo lo anterior (menú, plano) puede ser lento con mal internet y es
aceptable, como en cualquier POS.

Un cobro son **dos viajes de red**:

| Pata            | Qué es                                     | Estado hoy                                                                                                                                                                                                          |
| --------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Autorización | SDK → procesador (aquí se mueve el dinero) | Pasa con red lenta, pero **sin techo ni feedback**: ninguno de los dos rieles le pone timeout, y en un bache la pantalla se ve congelada sin salida                                                                 |
| 2. Registro     | app → nuestro backend                      | **Ya resuelta y verificada**: en PAX no bloquea la pantalla; si falla, encola con llave idempotente y drena sola. Producción 30 días: 1 registro tardío de 524, y ese uno fue la cola funcionando (Mindform, 763 s) |

Medido además: ~785 ms el registro (764 ms TTFB del server), 90 % de llamadas reusan conexión del pool, y en 3G la latencia por viaje
(300-800 ms) pesa más que los bytes (un auth EMV son ~2-5 KB; 5 KB pasan en ~100 ms incluso a 384 kbps).

**Punto ciego confirmado:** un cobro que nunca se autorizó por falta de red no deja rastro ni en `Payment` ni en `ProviderEventLog`. La pata
1 es invisible desde el server. La evidencia previa de que sí duele: análisis de flota 2026-07 con 1,318 episodios de apagón de pagos
(heartbeats vivos, cero cobros), Doña Simona a la cabeza con 47.

## 2. Qué queda FUERA de este diseño (y por qué)

- **Cobro offline real (EMV floor limit / store-and-forward).** El SDK de AngelPay no lo expone — verificado en su documentación
  (developers.angelpay-qa.com.mx, SDK v1.12.0): no hay límite de piso, no hay SAF; `offline` sólo aparece como código de error `E605`.
  Square/Clover/Toast sólo lo ofrecen con banda magnética y pérdida a cargo del comercio. Si se quiere, es una conversación con
  AngelPay/Blumon, no código nuestro.
- **AngelPay no-bloqueante** (que NEXGO no espere el registro, como PAX). Es el único cambio que reordena el flujo del dinero y arriesga la
  clase de bug documentada en el colector de Blumon ("money moved with no record and no alert"). Va en su propio diseño, con los guards
  (`recordingInFlight`, `isCharging`) diseñados primero.
- **Optimización del server** (sacar inventario/CFDI/sockets de los 764 ms). Los datos de producción muestran que el registro no está
  fallando; es mejora de UX de NEXGO y va después de lo anterior.

## 3. Diseño: tres componentes, todos aditivos

**Invariante global: cero bytes nuevos en la ventana del cobro.** Nada de lo que sigue manda tráfico mientras hay una tarjeta en juego, y
nada reordena el camino feliz.

### 3.1 Vigilante de autorización (los dos rieles)

Hoy: sin techo, sin señal. Un bache de red = pantalla congelada indefinida (el patrón del incidente Mindform 2026-07-16 y la forma de Doña
Simona).

Diseño:

- Un temporizador de **observación** arranca al iniciar la autorización del SDK.
- A los **~8 s**: la pantalla muestra _"Sigue procesando… no retires la tarjeta"_.
- A los **~25 s**: mensaje más fuerte con guía (_"La red está lenta. NO cobres de nuevo; verifica el resultado en Pagos antes de
  reintentar"_).
- 🔴 **El vigilante NUNCA cancela la llamada del SDK.** Si el procesador aprobó y nosotros abandonamos, hay dinero movido sin que la app lo
  sepa (el problema clásico de reversos, que no controlamos). Es sólo honestidad de UI sobre un estado ya existente.
- No toca banderas del flujo (`_isPaymentInProgress`, `chargeAttemptActive`): observa, no muta. Mismo patrón ya probado en Mesas (aviso
  "Sigue enviando la ronda…" a los 4 s).

Archivos: `PaymentViewModel.kt` (production y sandbox, byte-idénticos en el bloque) y `AngelPayPaymentViewModel.kt` + sus pantallas. **Esto
toca Cobrar deliberadamente y con autorización del founder** — es la excepción explícita a la regla "Cobrar intocable", acotada a agregar
observación, con la red de tests existente como termómetro.

### 3.2 `NonCancellable` en el registro

Hueco encontrado por auditoría: `recordPaymentUseCase` no está envuelto en `NonCancellable`. Si el proceso muere a media reintento (hasta 5
con backoff, ~67.5 s peor caso), el cobro puede **saltarse la cola offline**: dinero cobrado, sin registro y sin encolar. Blindar la
invocación en ambos rieles con el patrón que la cola ya usa (`withContext(NonCancellable + IO)` + rethrow de `CancellationException`).

### 3.3 Telemetría de la pata invisible

Contar en el aparato, por intento de autorización: código de resultado (`Sxxx`/`Nxxx`/…), duración, y riel. Guardado local mínimo; **se
reporta en lote cuando vuelve la red y nunca mientras hay un cobro activo** — viaja a cuestas del heartbeat existente (campo opcional
aditivo), sin endpoint nuevo. El server lo acepta como campo opcional y lo persiste para poder responder, por local: _cuántos intentos de
cobro fallan por red_. Sin datos de tarjeta, sin montos — sólo códigos y duraciones.

## 4. Riesgos y mitigaciones

| Riesgo                                                     | Mitigación                                                                                                                             |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| El vigilante interfiere con la máquina de estados del pago | Es observación pura: no muta banderas ni cancela; tests fijan que el flujo feliz es byte-idéntico                                      |
| Timeout mata una autorización aprobada                     | Prohibido por diseño: el vigilante no cancela nada, nunca                                                                              |
| La telemetría compite con un pago en 3G                    | Se difiere mientras `chargeAttemptActive`; viaja en el heartbeat, en lote                                                              |
| Romper la cola al envolver en `NonCancellable`             | Cambio aditivo con sabotaje: matar el proceso a media reintento debe dejar fila en cola                                                |
| Drift entre flavors                                        | El bloque tocado de `PaymentViewModel` debe quedar byte-idéntico production/sandbox (verificado con `diff`, como el fix del `orderId`) |

## 5. Criterios de éxito

1. Con red lenta simulada (receta del repo: `flaky-proxy.mjs` / `devBaseUrl` a puerto muerto para la pata 2; throttling para la pata 1),
   **ninguna pantalla se ve congelada más de 8 s sin mensaje**.
2. Matar el proceso durante el registro deja el cobro **en la cola**, siempre.
3. Tras una semana en producción, el dashboard puede responder: intentos de autorización fallidos por red, por local, por día.
4. El camino feliz de ambos rieles queda **byte-idéntico** en comportamiento: mismos estados, mismos tiempos, misma pantalla de éxito.

## 6. Verificación

Tests unitarios + pasada de sabotaje por componente (romper lo que cada uno protege, confirmar rojo, restaurar — el verde no es evidencia).
Hardware: PAX y NEXGO reales, con la receta de red degradada; el cobro con tarjeta física lo ejecuta el founder.

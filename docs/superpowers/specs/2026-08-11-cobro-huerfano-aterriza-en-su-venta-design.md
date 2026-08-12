# El cobro que sobrevive a una cancelación debe aterrizar en SU venta

**Repos:** avoqado-server (raíz) · avoqado-android · avoqado-ios **Origen:** encontrado por el founder probando en hardware el 2026-08-11,
con tarjeta real, después de cerrar los tres pasillos del doble cobro. Ver memoria `doble-cobro-tarjeta-por-error-de-transporte`.

---

## Qué pasa hoy, medido

Secuencia real, reproducida en un Sunmi T3 Pro con una Nexgo N860 y tarjeta física:

```
19:36:15  el POS manda un cobro de $0.30 a la terminal
          ── el cliente inserta la tarjeta y teclea su NIP ──
19:37:22  el cajero cancela desde el POS  →  el server contesta 409
19:37:25  la terminal cobra igual y registra el pago por REST
```

El dinero se registra bien, pero **en una venta inventada**:

```
Payment  $0.30  CREDIT_CARD  COMPLETED
  └── Order  FAST-1786498645249   total $0.30   tableId: (ninguno)   líneas: 0
```

**Cero líneas de producto.** La venta real —la que tenía los artículos que el cliente se está llevando— sigue sin pagar, y su carrito sigue
abierto en el POS.

### Lo que eso rompe

|                       | Consecuencia                                              |
| --------------------- | --------------------------------------------------------- |
| Inventario            | No se descuenta lo que sí se vendió                       |
| Reportes por producto | Esa venta no existe para ellos: es un monto suelto        |
| Comisión / atribución | El mesero no queda ligado a lo que vendió                 |
| El cajero             | Ve artículos sin pagar de algo que el cliente **ya pagó** |

El dinero cuadra. La venta no. Y es el tipo de descuadre que nadie reclama, porque el total del día sí suma.

---

## La raíz: el server ya sabe a qué orden pertenece, y lo ignora

La ruta de cobro rápido (`recordFastPayment`, `payment.tpv.service.ts:3017`) **recibe el `terminalPaymentRequestId`** — hoy lo usa sólo para
cerrar la fila de arbitraje. Y esa fila (`TerminalPaymentRequest`) **guarda el `orderId`** de la venta que originó el cobro.

O sea: la información está ahí, en la misma llamada. Sólo no se usa para decidir dónde cae el dinero.

### El cambio

```
si el cobro trae terminalPaymentRequestId
   y esa fila tiene orderId
      → se paga ESA orden
   si no
      → FAST, como hoy (venta rápida legítima, sin orden previa)
```

Con eso, **sin que el cajero haga nada**: la venta queda con sus productos, se descuenta el inventario, los reportes la ven, y el carrito se
cierra pagado.

### 🔴 Trampas que hay que respetar

1. **Idempotencia.** El desenlace puede llegar por DOS caminos (socket y REST). Atarlo a la orden real tiene que ser idempotente o se
   duplica la venta. Es exactamente el terreno donde ya hay tres puertas tapadas — no se improvisa.
2. **La orden pudo quedar CANCELLED.** Medido: cancelar el cobro de una mesa **cancela la orden**. Pagar una orden cancelada la revive a
   `COMPLETED` (comprobado con un pago en efectivo de $498). Hay que decidir explícitamente si eso es lo deseado o si la orden debe
   reabrirse de otra forma.
3. **Sólo aplica a la orden de ESA solicitud.** Nunca "la orden más reciente" ni nada inferido: la fila dice cuál es, y si no la dice, es
   FAST.
4. **Las ventas rápidas sin orden se quedan como están.** No es el caso problemático.

---

## Lo que decide el cajero, y lo que no

Con la raíz arreglada, al cajero le queda **una sola pregunta, y es la única que sólo él puede contestar**: ¿el cliente se llevó el
producto?

La pantalla de "Cobro anterior sin confirmar" —que ya existe y ya lo frena ahí— le diría _"este cobro pagó la venta de $X"_ con dos salidas:

- **Entregar** → no hay nada más que hacer; la venta ya quedó bien
- **Devolver** → el cliente se fue; se marca para reembolso (hoy, a mano en la terminal)

### 🔑 El principio, que es lo reusable

**Al humano se le pregunta sólo lo que sólo el humano sabe.**

El sistema sabe perfectamente a qué orden pertenece ese dinero: está en la fila. Lo que no puede saber es si el cliente se llevó el producto
o se fue molesto.

La alternativa —"que el POS decida cómo manejarlo"— suena flexible y es peor: le pide a un cajero con fila que resuelva un problema
**contable**, sin manera de ver las consecuencias en inventario y reportes. Ahí es donde se toman las decisiones malas, y además cada local
lo resolvería distinto.

---

## Estado y alcance

**Ya arreglado hoy (no re-hacer):**

- Los tres pasillos del doble cobro, verificados con tarjeta física.
- El watchdog cerrando una solicitud con el pago de otro (`266bd2df`).
- La alerta cuando el watchdog descubre dinero movido pese al cancel (`13eb3089`).
- Resolver un cobro ajeno ya no suelta al cajero en la venta siguiente (android `6a09101`; **falta el espejo iOS**).

**Este spec NO incluye** el reembolso por TPV — se parkea aparte, abajo.

---

## ~~Parked~~ HECHO (2026-08-12): reembolso por TPV

Idea del founder el mismo día, construida el 2026-08-12. Lo que estaba parkeado era una pregunta —"¿el SDK puede devolver?"— y la respuesta
resultó ser **sí, y de sobra**:

- **AngelPay** expone `refundTransaction` (ya integrado vía `AngelPaySdkPostOperationsAdapter`).
- **Blumon** expone `CancelIcc` + `ValidateCancel` para devolver transacciones COMPLETED por operationID.
- Y la TPV **ya tenía el flujo entero hecho** (`RefundConfirmation`), con los dos procesadores resueltos, entrando por el `paymentId` de
  Avoqado.

Lo único que faltaba era el canal: `terminal:*` llevaba cobros, cancelaciones e impresión, y ahora lleva un cuarto evento.

**Lo construido** (server `5f1bebbb` · tpv `cdc8b4a` · android `70785cb` · ios `6ee0dce`):

```
POS "Abrir en la terminal" → POST /mobile/venues/:id/terminals/:id/refund-request
                           → terminal:refund_request → la TPV abre ESE cobro
                           → una persona lo confirma con la tarjeta
                           → la TPV registra el reembolso por su ruta de siempre
```

🔑 **El evento abre una pantalla; no autoriza que se mueva dinero.** El ACK contesta `opened`/`rejected`, nunca "se devolvió": esperar a que
alguien pase la tarjeta son minutos con el cajero congelado. Por lo mismo el POS **no** registra el reembolso — lo hace la TPV, o se contaría
dos veces — y el éxito en pantalla dice explícitamente que todavía no se ha devuelto nada.

Como abrir una pantalla es idempotente, no hace falta fila durable de arbitraje: un evento perdido o duplicado, en el peor caso, abre una
pantalla de más.

**Tier:** ninguno nuevo (decisión del founder, 2026-08-12) — el reembolso ya existía en todos los planes y ya se podía hacer a mano en el
aparato; esto sólo evita la caminata. El control sigue siendo el permiso `payments:refund`.

**Lo que sigue sin existir:** una devolución **automática** sin nadie en la terminal. No es una limitación del canal sino del medio: la
tarjeta tiene que estar presente. No lo vendas como "reembolso remoto".

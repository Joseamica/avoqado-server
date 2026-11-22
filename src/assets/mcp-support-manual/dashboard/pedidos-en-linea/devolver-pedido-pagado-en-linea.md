---
title: Devolver un pedido en línea pagado con tarjeta en el panel
description: Cancela y devuelve, o devuelve ya cerrado, un pedido en línea que entró solo, cobrado con tarjeta: a su tarjeta o como saldo a favor, también si no lo recogió.
product: dashboard
category: pedidos-en-linea
task: devolver-pedido-pagado-en-linea
requiredPermissions:
  - payments:refund
money: true
sourceRepo: avoqado-web-dashboard
sourceRef: f4e3180b42107eeb9e66a62174fa76fa21ffe9ad
browserTested: 2026-11-21
keywords:
  - devolver pedido en línea
  - reembolso pedido en línea
  - cancelar pedido pagado
  - me cobraron y no recogí
  - no recogió su pedido
  - no lo recogió
  - la clienta cambió de opinión
  - devolver como saldo a favor
  - devolver a la tarjeta
  - cancelar y devolver
  - la devolución no aparece en el banco
---

## Antes de empezar

Necesitas permiso para reembolsar. Un pedido pagado en línea no se devuelve solo, ni si no lo recogió ni si la clienta cambió de opinión: lo decide el negocio, y la clienta no lo puede cancelar desde su celular. Sólo un pedido ya cobrado (abierto en una caja) tiene algo que devolver: al que nadie abrió no se le cobró nada.

En los pedidos que entran solos se devuelve completo, nunca una parte, y tú eliges a dónde:
- *Saldo a favor en <tu negocio>*: «Lo usa al pagar en caja en <tu negocio>; nunca se cambia por efectivo.»
- *A su tarjeta*: «Con tarjeta, el negocio no recupera la comisión de Stripe de este cobro.»

Se devuelve desde el panel: la terminal y el POS no devuelven estos pedidos, y en *Ventas* › *Transacciones* sale «Devuelve este pago desde Pedidos en línea para que regrese a la tarjeta del cliente.».

## Pasos

1. Si todavía no se entrega, en *Ventas* › *Pedidos en línea* › *Bandeja*, en «Por entregar», toca *Cancelar y devolver*.
2. Si ya se cerró (entregado o «No lo recogió»), abre el pedido en *Ventas* › *Pedidos* y toca *Devolver*; en las primeras 24 horas también sale en la *Bandeja*, en «Últimas 24 horas».
3. En «Devolver el pago · folio …», revisa «Se devuelve completo: $…». Si dice «Si ya se está preparando, avísale a cocina.», avísale tú: la comanda que ya salió no se recoge sola.
4. En «¿A dónde se devuelve?», elige *Saldo a favor en <tu negocio>* o *A su tarjeta*.
5. Elige el *Motivo* (*Productos devueltos*, *Cargo accidental*, *Pedido cancelado*, *Cargo fraudulento* u *Otro*) y, si quieres, escribe una *Nota (opcional)*.
6. Toca *Devolver $… como saldo a favor* o *Devolver $… a la tarjeta*. Si sale «Devuelto como saldo a favor» o «Devuelto a la tarjeta», ya quedó. El pedido dice «Devolviendo…» mientras se procesa y luego «Devuelto».

## Problemas frecuentes

- Si la clienta dice «me cobraron y no recogí»: al terminar el día el pedido quedó como «No lo recogió», cobrado. Si el negocio decide devolverlo, sigue los pasos desde *Ventas* › *Pedidos* con *Devolver*.
- Si sale «Stripe está procesando la devolución», «Enviando a Stripe…» o «La devolución está en proceso; revisa en un momento», va en camino: no la repitas.
- Si la clienta dice que la devolución no le aparece en el banco: con «Devuelto a la tarjeta», Stripe ya la mandó; cuándo la ve depende de su banco.
- Si sale «No hubo respuesta. Vuelve a intentarlo: no se devuelve dos veces.» o «La respuesta no fue definitiva. Reintenta con lo mismo: no se devuelve dos veces.», toca *Reintentar*: sólo se puede repetir igual hasta saber qué pasó.
- Si sale «Hubo otra devolución de este pedido. Revisa la lista antes de devolver.», «Hay una devolución nueva en la lista. Revísala antes de devolver.» o «Ya hay una devolución en curso de este pedido; espera a que termine.», revisa «Devoluciones de este pedido» antes de hacer otra.
- Si sale «Se está imprimiendo la comanda; intenta en un momento», espera unos segundos y vuelve a intentarlo.
- Si sale «El saldo a favor no está activo en Avoqado para este negocio. Puedes devolverlo a su tarjeta; no se aplicó nada.» o «Este pedido no tiene una clienta con cuenta: no hay a quién abonarle el saldo a favor. Puedes devolverlo a su tarjeta; no se aplicó nada.», elige *A su tarjeta*.
- Si sale «Este cobro ya tiene una devolución hecha fuera de Avoqado, directo en Stripe: termínala desde Stripe. Aquí no se devolvió ni se abonó nada.», alguien ya devolvió desde Stripe: termínala ahí.
- Si sale «No pudimos revisar en Stripe si este cobro ya se devolvió por fuera de Avoqado. Intenta de nuevo en un momento; no se aplicó nada.», vuelve a intentarlo en un momento.
- Si sale «El banco no hizo la devolución; no se anotó nada», no se devolvió nada.
- Si el pedido dice «El banco regresó la devolución: se le debe a la clienta» o «La devolución falló después: devuélvelo por otro medio», en «Devolver por otro medio:» toca *Efectivo de la caja* (pide el permiso de reembolsar en efectivo) o *Transferencia*. Primero se registra y después se entrega el dinero:
  - Sale «Antes de darle el dinero: ¿registras que le devuelves $… en efectivo de la caja abierta? No se puede deshacer.» (o «Antes de transferir: ¿registras que le transfieres $… al cliente? No se puede deshacer.»). Toca *Sí, registrar*, o *Todavía no* si no quieres seguir.
  - Si sale «Registrado: ahora sí, dale $… al cliente» (o «Registrado: ahora sí, transfiérele $… al cliente»), ahora sí entrégale el dinero o transfiérelo. Antes de ese aviso no le des nada.
  - Si sale «Ya estaba registrada: revisa si ya se le entregó; no se lo des otra vez», alguien ya la registró: no le des el dinero otra vez.
  - Si sale «Este cobro ya tiene $… devueltos directo en Stripe, por fuera de Avoqado: no le des los $… otra vez. Revisa en Stripe si al cliente ya le llegó. Aquí no se pagó ni se registró nada.», no le des nada: ya se le devolvió desde Stripe.
- Si dice «Ya no queda nada por devolver.», ya se devolvió todo.
- En los pedidos que sí se aceptan («Sí, alguien del personal lo acepta») el botón es *Devolver a la tarjeta*: el dinero sólo regresa a la tarjeta y se puede devolver una parte.

## Sin internet

El panel necesita internet. Si se corta a media devolución, sale «No hubo respuesta. Vuelve a intentarlo: no se devuelve dos veces.»: toca *Reintentar* con lo mismo, que nunca devuelve dos veces.

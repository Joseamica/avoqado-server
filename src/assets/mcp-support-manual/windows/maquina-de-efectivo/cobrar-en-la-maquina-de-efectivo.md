---
title: Cobrar en la máquina de efectivo en el POS Windows
description: El cliente paga en efectivo en la QuickPay Mini desde el POS Windows; la máquina recibe el dinero, da el cambio y la venta se registra sola.
product: windows
category: maquina-de-efectivo
task: cobrar-en-la-maquina-de-efectivo
requiredPermissions:
  - payments:create
money: true
versionMin: 2.25.57
sourceRepo: avoqado-android
sourceRef: e7d51ad0634df24ba3522a7364884567fd82009d
deviceTested: 2026-11-22
keywords:
  - cobrar en la máquina
  - efectivo en la máquina
  - la máquina no me dio cambio
  - la máquina no da centavos
  - la máquina está ocupada
  - la máquina no responde
  - sigues ahí
  - cancelar y devolverme mi dinero
  - no puedo cobrar en la máquina
---

## Antes de empezar

La PC tiene que estar emparejada con la máquina. En esa PC sólo se cobra con la máquina o con tarjeta: no sale el efectivo a mano.

## Pasos

1. En *Cobrar*, con los productos en la venta, toca *Cobrar* con el total. Si salen *¿Algo más?*, *¿Cómo fue tu experiencia?* o *Propina*, complétalas o sáltalas.
2. Toca *Efectivo en la máquina*. Sale «Preparando la máquina…» y luego «Paga en la máquina».
3. El cliente mete billetes y monedas en la máquina. La pantalla enseña *Por pagar*, *Recibido* y lo que falta o su cambio.
4. Si se arrepiente, toca *Cancelar y devolverme mi dinero*: la máquina regresa lo que entró y sale «Cobro cancelado: recoge tu dinero».
5. Al completar, la máquina da el cambio y la caja enseña lo cobrado y el cambio. Si no pudo dar todo, dice «Te debemos $… de cambio: pasa a caja a cobrarlo · Folio …».
6. Toca *Venta nueva* para seguir.

## Problemas frecuentes

- Si *Efectivo en la máquina* sale en gris, la razón sale debajo:
  - «La máquina no responde»: revisa que esté prendida y en la red.
  - «La máquina está ocupada»: alguien la usa, también desde su propia pantalla; vuelve sola al terminar.
  - «La máquina cobra sólo una venta nueva y completa: cóbrala con tarjeta» (una mesa o una cuenta dividida), «Esta venta se restauró…», «Esta venta ya intentó cobrarse con tarjeta…» y «Las reservas se cobran en caja o con tarjeta»: así nunca se cobra dos veces la misma venta.
- «La máquina no da centavos: paga con tarjeta»: el total no termina en .00 ni en .50.
- «Este carrito tiene descuento: cóbralo con tarjeta o en caja» y «Este carrito tiene un premio de lealtad: cóbralo con tarjeta o en caja»: la máquina no cobra ventas con descuento ni con premio.
- «La máquina tiene poco cambio: paga con el monto exacto o con tarjeta» es sólo un aviso: se puede seguir.
- Si en 2 minutos no entra dinero nuevo, sale «¿Sigues ahí? Toca para continuar». Si nadie lo toca en 30 segundos, el cobro se cancela, la máquina se queda con lo que entró y sale «Se canceló el cobro». Si la persona regresa, se le paga con un retiro de caja.
- «Hay 1 ticket sin imprimir» (o varios): toca *Imprimir*.
- Si dice «Esperando a la máquina», no lo cobres otra vez: un gerente lo resuelve en el panel.

## Sin internet

La máquina cobra igual. La venta se guarda en la PC y sube sola: dice «Se sincronizará cuando haya conexión» y el ticket, «Precio por confirmar». Con internet dice «Registrando la venta…» y luego «Venta sincronizada». Si el precio bajó antes de subir, se cobra el menor y la diferencia se le debe al cliente.

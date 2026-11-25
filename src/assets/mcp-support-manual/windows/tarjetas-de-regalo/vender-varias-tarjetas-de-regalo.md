---
title: Vender varias tarjetas de regalo en una sola venta en el POS Windows
description: En Vender tarjeta, agrega otra tarjeta con su monto y su entrega, o quita una, antes de cobrar la cuenta de tarjetas.
product: windows
category: tarjetas-de-regalo
task: vender-varias-tarjetas-de-regalo
requiredPermissions:
  - giftCards:sell
money: true
versionMin: 2.25.22
sourceRepo: avoqado-android
sourceRef: 78e5372f37ed7791d86fc1fe621d4a073e5a09ff
keywords:
  - vender varias tarjetas de regalo
  - agregar otra tarjeta
  - quitar tarjeta de la venta
  - dos tarjetas de regalo
  - varias gift cards
---

## Antes de empezar

Es la misma pantalla de *Vender tarjeta* (en *Cobrar* › *Atajos* › *Tarjeta de regalo*), con el carrito vacío: las tarjetas se venden en su propia cuenta. Vender pide el permiso de vender tarjetas de regalo.

## Pasos

1. En *Vender tarjeta*, llena la *Tarjeta de regalo 1*: su monto (o *Otro monto*) y cómo la entregas.
2. Toca *Agregar otra tarjeta*: sale *Tarjeta de regalo 2*, con su propio monto, su entrega y *Para (opcional)*.
3. Para sacar una de la venta, toca *Quitar tarjeta* debajo de ella.
4. Si alguna va por WhatsApp o correo, llena *De parte de*.
5. Toca *Cobrar …* arriba (dice el total de todas) y cobra esa cuenta.

## Problemas frecuentes

- *Quitar tarjeta* sólo sale cuando hay más de una tarjeta en la venta.
- *Agregar otra tarjeta* se apaga al llegar a 20 tarjetas en una venta.
- Si sale «El total debe quedar debajo de …», la venta pasa del tope por compra: quita una tarjeta o baja un monto.
- Si sale «Entre … y …» debajo de un monto, ese monto está fuera de los límites del negocio.
- Si sale «Obligatorio con WhatsApp o correo», escribe *De parte de*.

## Sin internet

- Si aparece «Sin conexión: las tarjetas de regalo necesitan internet», no se puede vender hasta que vuelva la conexión.

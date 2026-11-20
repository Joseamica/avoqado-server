---
title: Anular o dar de cortesía un producto ya enviado en el POS Android
description: Quita de la cuenta de una mesa un producto que ya se mandó a cocina, o déjalo sin cobrar, desde Mesas en el POS Android.
product: android
category: mesas
task: anular-producto-enviado
requiredPermissions: []
featureCode: TABLE_SERVICE
gateKind: FEATURE
money: true
sourceRepo: avoqado-android
sourceRef: 0caaeb42c542cc3ca61144e7b615dab1fc3a1209
keywords:
  - cancelar un producto
  - quitar un producto que ya se mandó
  - anular producto
  - anular un platillo
  - borrar un producto de la mesa
  - el cliente cambió de parecer
  - cambiar una bebida ya enviada
  - se mandó a cocina por error
  - no puedo quitar un producto enviado
  - cortesía de un producto de la mesa
---

## Antes de empezar

Es para productos que ya se enviaron a cocina en una cuenta de *Mesas*. Anular pide el permiso de anular artículos y la cortesía el de dar cortesías; de fábrica los traen gerente, administrador y dueño. Lo que todavía no se envía no pasa por aquí.

## Pasos

1. En *Mesas*, toca la mesa ocupada para abrir su cuenta. En el teléfono, toca antes *Ver cheque*.
2. Toca el producto que ya se envió.
3. En *Motivo*, elige uno, por ejemplo «El cliente cambió de parecer».
4. Toca *Anular producto*: sale de la cuenta y el total baja. Si aparece «Producto anulado — …», quedó.
5. Para dejarlo en la cuenta sin cobrarlo, en vez de anular toca *Dar de cortesía*.
6. Si aparece el teclado del PIN, un gerente escribe su PIN para autorizarlo.

## Problemas frecuentes

- Si *Anular producto* sale en gris con «Es el único producto de la cuenta. Para quitarlo usa «Anular cuenta», o manda primero lo que lo reemplaza y luego anúlalo.»: agrega y envía primero el producto nuevo, o anula la cuenta completa.
- Si *Anular producto* sale en gris con «Es parte de una promoción y no se anula suelto…», ese producto es una pieza de un combo: dalo de cortesía o anula la cuenta completa.
- Si aparece «Esta cuenta ya tiene pagos registrados y ya no se pueden anular sus productos…» o «Esta cuenta ya está pagada…», no se anuló: si hay que devolver dinero, alguien con permiso hace un *Reembolso*.
- La comanda que ya salió no se corrige sola: avisa a cocina que ese producto se anuló.
- Un producto que ya es cortesía no se abre al tocarlo.

## Sin internet

- Si aparece «Sin conexión — anular un producto enviado necesita internet; se habilita al volver la señal», no se anuló: hazlo cuando vuelva la conexión. La cortesía de un producto enviado también necesita internet.
- Si aparece «Sin conexión: no supimos si el producto se anuló…», la red se cortó a media anulación: cuando vuelva, revisa la cuenta antes de anularlo otra vez.

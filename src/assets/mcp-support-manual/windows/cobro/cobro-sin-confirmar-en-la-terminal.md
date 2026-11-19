---
title: Cuando el cobro con terminal queda sin confirmar en el POS Windows
description: Qué hacer si, al cobrar una venta, el POS Windows no sabe si la terminal cobró la tarjeta, o avisa que la terminal está ocupada.
product: windows
category: cobro
task: cobro-sin-confirmar-en-la-terminal
requiredPermissions:
  - payments:create
money: true
versionMin: 2.25.32
sourceRepo: avoqado-android
sourceRef: c07a2bbebf453598963bf96f3208f66193dd5efb
keywords:
  - cobro sin confirmar
  - terminal ocupada
  - no sé si se cobró
  - no se cobró
  - cobrar dos veces
  - cobro pendiente
---

## Antes de empezar

Cuando el POS no sabe si la tarjeta se cobró, pregunta si se cobró la venta. No la vuelvas a cobrar hasta saber qué pasó en la terminal.

## Pasos

1. Mira la pantalla de la terminal para ver si el cobro pasó.
2. Si la terminal dice aprobado, espera en esa pantalla: mientras se ve, el POS sigue preguntando solo.
3. Si la terminal no cobró, toca *No se cobró* y luego *Sí, no se cobró*; si lo acepta, ya puedes volver a cobrar.
4. Si sale «Pide a un gerente que ingrese su PIN», un gerente teclea su PIN para confirmarlo.
5. Si no puedes esperar, toca *Salir (queda pendiente)*: el cobro sigue sin confirmar; no lo cobres otra vez hasta saber si pasó.
6. Si dice «Terminal ocupada…», este cobro no se envió ni se cobró: espera a que termine o elige otra terminal; si aparece *Revisar ese cobro*, tócalo para ver el que la ocupa.

## Problemas frecuentes

- Si la terminal dice aprobado y pasan varios minutos sin que se registre, no lo cobres otra vez: una persona de soporte tiene que revisarlo.
- Si aparece *Cancelar la venta* y ya no la vas a cobrar, tócalo: pide cancelar el cobro y, si la venta se creó en ese cobro, también la venta, lo que pide además el permiso de cancelar ventas sin cobrar. Puede quedar pendiente o resultar cobrado: no la cobres otra vez mientras no conste, y si queda pendiente, una persona tiene que revisarla. Si consta que no se cobró, una mesa o una cuenta que ya existía sigue abierta; si la terminal sí cobró, ese pago se queda en la cuenta: queda pagada o con lo que falte.
- Si aparece «Esta venta tiene un cobro pendiente de confirmar.», otra terminal tampoco sirve: toca *Revisar ese cobro* si aparece.
- Si aparece «La terminal reporta este cobro sin terminar…» al confirmar, no lo cobres otra vez: espera a que la terminal termine y vuelve a intentarlo; si no termina, una persona tiene que revisarlo.
- Si aparece «Tu sesión se renovó. Vuelve a confirmar que no se cobró.», toca otra vez *No se cobró*.

## Sin internet

- Si aparece «Sin conexión: la revisión necesita internet. No cobres esta venta otra vez hasta confirmarla.», la revisión y el *No se cobró* necesitan internet: vuelve a intentarlo con conexión y no cobres esa venta otra vez.
- Si aparece «Sin conexión: la revisión necesita internet; puedes cobrar en efectivo», la duda es de otra venta y no frena ésta, pero ésta sigue con sus propias reglas sin internet: por ejemplo, una cuenta de tarjetas de regalo se cobra cuando vuelva la conexión.

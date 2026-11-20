---
title: Cancelar un cobro mandado a la terminal en el POS Windows
description: Cómo pedir en el POS Windows que se cancele un cobro ya mandado a la terminal, y qué hacer si queda pendiente o la terminal sí cobró.
product: windows
category: cobro
task: cancelar-cobro-en-la-terminal
requiredPermissions:
  - payments:create
money: true
versionMin: 2.25.32
sourceRepo: avoqado-android
sourceRef: c07a2bbebf453598963bf96f3208f66193dd5efb
deviceTested: 2026-11-18
keywords:
  - cancelar cobro
  - cancelar en la terminal
  - cancelación pendiente
  - cancelando el cobro
  - la terminal sí cobró
---

## Antes de empezar

Cancelar no toca la venta mientras no conste que la tarjeta no se cobró; si la terminal sí cobró, ese cobro se queda en la venta.

## Pasos

1. Mientras dice *Esperando respuesta de la terminal*, toca *Cancelar*.
2. Espera mientras dice «Cancelando el cobro…». Si consta que no se cobró, sales del cobro; si consta que sí cobró, sale «La terminal sí cobró este pago…».
3. Si sale «Cancelación pendiente», mira la pantalla de la terminal.
4. Si la terminal no cobró, toca *No se cobró* y luego *Sí, no se cobró*; si sale «Pide a un gerente que ingrese su PIN», un gerente teclea su PIN.
5. Para no esperar, toca *Salir (queda pendiente)*: mientras siga pendiente, arriba sale la banda «Cancelaciones pendientes».
6. Toca esa banda: en *Operaciones por revisar*, la cancelación tiene *Volver a consultar*.

## Problemas frecuentes

- Si la terminal sí cobró y era sólo una parte de una venta dividida, lo demás sigue por cobrar.
- Si tras cancelar el POS pregunta si se cobró la venta, no la vuelvas a cobrar: mira la terminal y sigue esa pantalla.
- Si aparece «La terminal ya está libre, pero no consta si esta venta se cobró…», mira la terminal: si no cobró, decláralo con *No se cobró*.
- Si aparece *No se cobró* en esa cancelación, mira la terminal: si no cobró, tócalo para declararlo.
- Cancelar el cobro de una mesa o de una cuenta que ya existía (por ejemplo, la siguiente parte de una venta dividida) no cancela la cuenta: si consta que no se cobró, sigue abierta; si la terminal sí cobró, ese pago se queda en la cuenta: queda pagada o con lo que falte.
- Si la venta se creó en ese cobro, para cancelarla el usuario de la computadora necesita además el permiso de cancelar ventas sin cobrar; sin él, la cancelación se queda en *Operaciones por revisar* y la venta sigue abierta.
- Si aparece «No se pudo guardar la cancelación en este equipo. Inténtalo de nuevo.», no se mandó nada: vuelve a tocar *Cancelar*.

## Sin internet

- Si aparece «Sin conexión en esta tablet: la cancelación se enviará en cuanto vuelva la red…», la cancelación quedó guardada en la computadora; la terminal puede seguir mostrando el cobro.

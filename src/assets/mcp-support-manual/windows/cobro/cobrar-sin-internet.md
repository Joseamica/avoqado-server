---
title: Cobrar sin internet en el POS Windows
description: Qué se puede cobrar sin conexión en el POS Windows: el efectivo se guarda en la computadora y se envía solo.
product: windows
category: cobro
task: cobrar-sin-internet
requiredPermissions:
  - payments:create
money: true
versionMin: 2.25.4
sourceRepo: avoqado-android
sourceRef: c07a2bbebf453598963bf96f3208f66193dd5efb
keywords:
  - sin internet
  - sin conexión
  - sin red
  - offline
  - por sincronizar
  - ventas pendientes
---

## Antes de empezar

Sin conexión, arriba sale la banda «Sin conexión — las ventas se guardan en el dispositivo» (o cuántas hay por sincronizar).

## Pasos

1. Cobra en efectivo como siempre: toca *Cobrar* con el total y, en la fila *Efectivo*, el monto sugerido o *Personalizado*.
2. Si al terminar dice «Se sincronizará cuando haya conexión», el cobro quedó guardado en la computadora.
3. Cuando vuelve la conexión, el POS lo envía solo; si sigues en esa pantalla, cambia a «Venta sincronizada».

## Problemas frecuentes

- Si dice «No se pudo sincronizar esta venta. Revísala en Pendientes.», esa venta no subió y alguien tiene que revisarla.
- Si sale «Sin conexión: el premio necesita internet…», cobra cuando vuelva la conexión o quita el premio.
- Si aparece *Sin conexión: el cupón necesita internet…*, ese cobro no quedó guardado: cobra cuando vuelva la conexión, o quita el cupón y revisa el nuevo total.
- Sin conexión no se cobra con terminal: en *Seleccionar terminal* sale «Sin conexión: el cobro con tarjeta necesita internet…».

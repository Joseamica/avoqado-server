---
title: Cobrar sin internet en el POS Android
description: Qué se puede cobrar sin conexión en el POS Android: el efectivo se guarda en el aparato y se envía solo.
product: android
category: cobro
task: cobrar-sin-internet
requiredPermissions:
  - payments:create
money: true
versionMin: 2.25.0
sourceRepo: avoqado-android
sourceRef: 843c15ae06bf68dd0d9c755525a9971e701052b7
deviceTested: 2026-11-18
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
2. Si al terminar dice «Se sincronizará cuando haya conexión», el cobro quedó guardado en el aparato.
3. Cuando vuelve la conexión, el POS lo envía solo; si sigues en esa pantalla, cambia a «Venta sincronizada».

## Problemas frecuentes

- Si dice «No se pudo sincronizar esta venta. Revísala en Pendientes.», esa venta no subió y alguien tiene que revisarla.
- Si sale «Sin conexión: el premio necesita internet…», cobra cuando vuelva la conexión o quita el premio.
- Si aparece «Sin conexión: el cupón necesita internet. Reintenta cuando vuelva la conexión, o quita el cupón para cobrar sin él.», ese cobro no quedó guardado: espera a que vuelva la conexión, o quita el cupón, revisa el nuevo total y cóbralo.
- Sin conexión no se cobra con terminal: en *Seleccionar terminal* sale «Sin conexión: el cobro con tarjeta necesita internet…».

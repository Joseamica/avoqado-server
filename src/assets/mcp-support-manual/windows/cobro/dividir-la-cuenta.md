---
title: Dividir la cuenta en el POS Windows
description: Divide el cobro de una venta del carrito en el POS Windows por producto, en partes iguales o por monto.
product: windows
category: cobro
task: dividir-la-cuenta
requiredPermissions:
  - payments:create
money: true
versionMin: 2.25.32
sourceRepo: avoqado-android
sourceRef: c07a2bbebf453598963bf96f3208f66193dd5efb
deviceTested: 2026-11-18
keywords:
  - dividir cuenta
  - dividir importe
  - pagar por separado
  - partes iguales
  - por producto
  - monto personalizado
---

## Antes de empezar

Es para una venta del carrito de *Cobrar*, no para una cuenta de *Mesas*.

## Pasos

1. Con los productos en el carrito, toca el botón de tres puntos (*Opciones de sección*) y luego *Dividir cuenta*; o, en la pantalla del cobro, toca *Dividir importe*.
2. Elige *Por producto*, *Partes iguales* o *Monto personalizado*.
3. Por producto: marca los productos de este pago y toca *Confirmar selección*.
4. Partes iguales: ajusta el *Número de personas* y toca *Dividir en … partes*.
5. Monto personalizado: escribe el *Monto a cobrar* y toca *Cobrar …*.
6. Cobra esa parte como siempre. Lo que falta queda en el carrito: cóbralo con *Cobrar* (puedes volver a dividirlo).

## Problemas frecuentes

- Con un solo renglón en la venta no sale *Por producto*: usa *Partes iguales* o *Monto personalizado*.
- Si la venta lleva una membresía, sale «Las membresías se cobran en un solo pago…»: cóbrala por separado o quítala del carrito para dividir.

## Sin internet

Sin conexión, al dividir sale «Dividir necesita conexión con Avoqado. Cobra todo junto o espera a que vuelva la conexión.».

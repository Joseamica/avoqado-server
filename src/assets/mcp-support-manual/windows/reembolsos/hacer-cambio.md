---
title: Hacer un cambio de producto en el POS Windows
description: Cambia en el POS Windows un producto de una venta cobrada por otro; la diferencia se cobra o se devuelve.
product: windows
category: reembolsos
task: hacer-cambio
requiredPermissions:
  - payments:refund
money: true
versionMin: 2.25.32
sourceRepo: avoqado-android
sourceRef: c07a2bbebf453598963bf96f3208f66193dd5efb
deviceTested: 2026-11-18
keywords:
  - cambio
  - cambio de talla
  - cambiar producto
  - devolución por cambio
  - cambio parejo
  - diferencia
---

## Antes de empezar

*Cambio* sale en la venta sólo si el negocio tiene prendidos los cambios y tienes permiso para reembolsar, o el negocio usa el código de encargado.

## Pasos

1. En *Ventas*, toca la venta y luego *Cambio*.
2. En la lista de productos, toca lo que se lleva la clienta. Si la ventana está angosta, luego abre el resumen con el botón de abajo.
3. En el resumen, en *REGRESA*, marca lo que regresa (se marca una pieza, o la promoción completa; agrega piezas con *Aumentar cantidad*) y elige su *Motivo*.
4. Si sale *Vuelve al inventario*, déjala marcada sólo si la pieza se puede volver a vender (con *Defecto* se desmarca sola). Lo que se lleva sale en *SE LLEVA*; para quitarlo, toca su X.
5. Abajo del resumen dice la diferencia: toca *Cobrar …*, *Devolver …* o *Hacer cambio parejo*.
6. Si te pide cómo se paga o se devuelve la diferencia, elige la opción. Al terminar sale «¡Cambio hecho!» y puedes tocar *Imprimir*.

## Problemas frecuentes

- Si devuelves la diferencia con *Transferencia*, el POS sólo registra el cambio: la transferencia se la haces tú.
- Devolver en efectivo la diferencia de un cobro hecho con otro medio pide otro permiso. Sin él, *Efectivo* sale apagado con «Devolver efectivo de un cobro con otro medio necesita permiso de un encargado»; si el negocio usa el código de encargado, dice «Necesitarás que un encargado autorice la devolución en efectivo con su código.».

## Sin internet

Sin conexión, *Cambio* no se puede usar: sale «El cambio necesita conexión».

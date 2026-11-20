---
title: Reembolsar una venta en el POS Windows
description: Reembolsa una venta cobrada desde Ventas en el POS Windows, por artículos o por importe.
product: windows
category: reembolsos
task: reembolsar-venta
requiredPermissions:
  - payments:refund
money: true
versionMin: 2.25.32
sourceRepo: avoqado-android
sourceRef: c07a2bbebf453598963bf96f3208f66193dd5efb
deviceTested: 2026-11-18
keywords:
  - reembolso
  - reembolsar
  - devolver dinero
  - devolución
  - emitir reembolso
  - cancelar cobro
---

## Antes de empezar

*Emitir reembolso* sale si tienes permiso para reembolsar. Si no lo tienes y el negocio usa el código de encargado, al tocarlo se pide el código de un encargado.

## Pasos

1. En *Ventas*, toca la venta y luego *Emitir reembolso*.
2. Elige *Reembolsar artículos* y marca los artículos (si un artículo tiene varias piezas, se marcan todas; ajústalas con *Menos* y *Más*), o *Reembolsos por importe* y escribe el importe.
3. Si sale *Reabastecer existencias*, marca sólo los artículos que sí regresaron al inventario.
4. Si sale *Incluir propina en el reembolso*, revísala: marcada, también se devuelve propina, y puede venir ya marcada. En *Motivo del reembolso*, elige el motivo.
5. Si sale *Devolver con*, elige cómo devuelves el dinero. Si dice *Este cobro fue con tarjeta*, toca *Abrir en la terminal* y que ahí confirmen la devolución con la tarjeta.
6. Si no, toca *Reembolsar* con el importe.

## Problemas frecuentes

- Si el botón no se prende, arriba de él dice qué falta (por ejemplo, «Elige el motivo del reembolso.»).
- Si dice que sólo se registra («Esto sólo lo registra…» o «Tú le haces la transferencia; aquí sólo queda registrado.»), el POS no mueve el dinero: se lo devuelves tú por ese medio.
- Devolver en efectivo un cobro que no fue en efectivo pide otro permiso. Si no lo tienes, debajo de *Devolver con* dice si un encargado lo autoriza con su código o si tiene que hacerlo él desde su usuario.

## Sin internet

Si sale «Sin conexión: no se pudo confirmar el reembolso. Antes de repetirlo, revisa en Ventas si ya aparece.», no lo repitas hasta revisar la venta en *Ventas*.

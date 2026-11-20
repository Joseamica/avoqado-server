---
title: Reembolsar un pago en el panel
description: Registra el reembolso de un pago desde Ventas › Transacciones en el panel, por artículos o por importe.
product: dashboard
category: reembolsos
task: reembolsar-un-pago
requiredPermissions:
  - payments:refund
money: true
sourceRepo: avoqado-web-dashboard
sourceRef: 1fe15c5cd61ffe8386b239114ea6c8eb6f5e006a
browserTested: 2026-11-12
keywords:
  - reembolso
  - reembolsar
  - devolver dinero
  - devolución
  - emitir reembolso
  - reembolso en el panel
---

## Antes de empezar

Necesitas permiso para reembolsar. Si el pago fue con tarjeta bancaria, el reembolso del panel no le regresa el dinero a la tarjeta.

## Pasos

1. En *Ventas* › *Transacciones*, abre el pago. Arriba del detalle, toca el botón ⋯ y luego *Emitir reembolso*.
2. Elige *Reembolsar artículos* y marca los artículos (con varias piezas se marcan todas las que quedan; ajústalas con − y +), o *Reembolsos por importe* y escribe el importe.
3. Por artículos, toca *Reembolsar artículos*. Si sale *Reabastecer existencias*, deja marcados sólo los que regresan al inventario y toca *Reabastecer existencias*, o toca *Omitir*.
4. En *Motivo del reembolso*, elige el motivo. Si sale *Incluir propina en el reembolso*, revísala: marcada, el reembolso también toca la propina, y puede venir ya marcada.
5. Toca *Reembolsar*. Si sale «Reembolso emitido», ya quedó.

## Problemas frecuentes

- *Emitir reembolso* sale apagado si el pago ya se reembolsó completo, o si no cargaron sus reembolsos (en el detalle sale «No pudimos cargar esta información. Inténtalo de nuevo.»).
- *Reembolsar* se prende hasta elegir el motivo. Por importe, además, el importe no puede pasar del máximo que dice junto a él; si te pasas, sale «El importe excede el máximo reembolsable».
- Si después de tocar *Reembolsar* sale «Reembolso sin confirmar», «No tienes permiso para emitir reembolsos…» o cualquier otro error, no lo repitas ni le pidas a otra persona que lo haga: el reembolso pudo quedar en un primer intento. Pide que lo revise una persona del equipo de Avoqado.
- Si sale «Devuelve este pago desde Pedidos en línea para que regrese a la tarjeta del cliente.», ese pago no se reembolsa aquí; *Ver la cuenta* abre su cuenta.

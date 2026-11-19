---
title: Cambiar el monto de una liga de pago en el panel
description: Corrige el monto de una liga de pago que ya mandaste, desde Ventas › Ligas de Pago en el panel; el enlace sigue siendo el mismo.
product: dashboard
category: ligas-de-pago
task: cambiar-monto-de-liga-de-pago
requiredPermissions:
  - payment-link:read
  - payment-link:create
  - payment-link:update
money: true
sourceRepo: avoqado-web-dashboard
sourceRef: 1fe15c5cd61ffe8386b239114ea6c8eb6f5e006a
browserTested: 2026-11-12
keywords:
  - editar liga
  - me equivoqué de monto
  - cambiar el monto de la liga
  - corregir liga de pago
  - ya la mandé
---

## Antes de empezar

*Editar* sale si tienes permiso para crear ligas, y guardar pide permiso para editarlas. Una liga archivada ya no se puede editar.

## Pasos

1. En *Ventas* › *Ligas de Pago* › *Ligas de pago*, toca el botón ⋯ de la liga y toca *Editar*.
2. En *Monto*, con *Fijo* elegido, escribe el monto correcto en *Monto (MXN)*.
3. Toca *Guardar*. Si sale «Liga de pago actualizada», ya quedó: es el mismo enlace, no hace falta mandar otro.

## Problemas frecuentes

- Una liga de productos no tiene *Monto (MXN)*: su total sale de los productos que lleva.
- Si la liga tiene un descuento, cambiar el monto también pide permiso para aplicar descuentos.
- Cambiar el monto no toca los pagos que ya entraron por esa liga; en su renglón, *Pagos* y *Total cobrado* dicen lo que ya entró.
- Si tu cliente ya estaba pagando cuando lo cambiaste, ese pago en curso puede seguir con el monto anterior. No le pidas que pague otra vez: pide que lo revise una persona del equipo de Avoqado.
- Si sale «Error», debajo dice por qué; por ejemplo, «No se puede editar una liga de pago archivada».

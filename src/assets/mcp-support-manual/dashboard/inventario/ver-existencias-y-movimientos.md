---
title: Ver las existencias y los movimientos del inventario en el panel
description: Dónde ver en el panel cuánto tienes de cada artículo e ingrediente y qué movimientos lo cambiaron, para revisar por qué no cuadra.
product: dashboard
category: inventario
task: ver-existencias-y-movimientos
requiredPermissions:
  - inventory:read
featureCode: INVENTORY_TRACKING
gateKind: FEATURE
sourceRepo: avoqado-web-dashboard
sourceRef: 1fe15c5cd61ffe8386b239114ea6c8eb6f5e006a
keywords:
  - inventario no cuadra
  - historial de inventario
  - movimientos de inventario
  - existencias
  - cuánto tengo
---

## Antes de empezar

El inventario es para los negocios que tienen incluida la función de inventario. Necesitas permiso para ver el inventario. Para que en *Resumen de existencias* salgan los productos del menú también necesitas permiso para ver el menú.

## Pasos

1. En *Inventario* › *Resumen de existencias*, la pestaña *Artículos e Ingredientes* muestra lo que tienes de cada uno. La pestaña *Basados en Receta* muestra los productos basados en receta.
2. En *Inventario* › *Historial*, cada renglón es un movimiento, con su *Fecha*, su *Nombre* y su *Ajuste*.
3. Para encontrar un artículo, toca la lupa y escribe su nombre. Toca un movimiento para ver su detalle.
4. Las mermas registradas están en *Inventario* › *Mermas*, y los conteos en *Inventario* › *Conteos de inventario*.

## Problemas frecuentes

- En *Historial*, el filtro *Fecha* filtra los movimientos de la página que tienes abierta, no todo el historial: para buscar un artículo, usa la lupa.
- Los conteos se hacen en el POS: en el panel se revisan.

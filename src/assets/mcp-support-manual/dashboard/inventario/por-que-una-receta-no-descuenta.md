---
title: Revisar por qué una receta no descuenta sus ingredientes en el panel
description: Qué revisar en el panel cuando vendes un producto con receta y no bajan sus ingredientes en el inventario.
product: dashboard
category: inventario
task: por-que-una-receta-no-descuenta
requiredPermissions:
  - menu:read
featureCode: INVENTORY_TRACKING
gateKind: FEATURE
sourceRepo: avoqado-web-dashboard
sourceRef: 1fe15c5cd61ffe8386b239114ea6c8eb6f5e006a
keywords:
  - receta no descuenta
  - no baja el inventario
  - no se descuentan los ingredientes
  - rastrear por receta
---

## Antes de empezar

El inventario es para los negocios que tienen incluida la función de inventario. Necesitas permiso para ver el menú: de ahí salen los productos. Para *Recetas* también necesitas permiso para ver el inventario, y para crear la receta, permiso para crear en él. Para cambiar el producto necesitas permiso para editar el menú.

## Pasos

1. En *Inventario* › *Recetas*, busca el producto. Si en su renglón sale *Agregar Receta* en lugar de *Editar*, todavía no tiene receta: créala.
2. Abre el producto en *Productos*, dentro del menú de tu catálogo (su nombre cambia según tu giro, por ejemplo *Menú* o *Catálogo*), y entra a la pestaña *Inventario*.
3. En *Seguimiento de Inventario*, elige *Rastrear por receta* y toca *Guardar*.

## Problemas frecuentes

- Con *No rastrear inventario*, las ventas del producto no descuentan su receta.
- Con *Rastrear por cantidad*, la venta descuenta las piezas del producto, no los ingredientes de su receta.
- Si el producto llevaba *Rastrear por cantidad*, al tocar *Agregar Receta* sale «¿Cambiar a Receta?»: con *Sí, cambiar* se borra su conteo por cantidad y luego se abre la receta. Para eso necesitas permiso para editar el inventario.
- Si no encuentras el producto en *Recetas*, revisa directo su pestaña *Inventario* (pasos 2 y 3).

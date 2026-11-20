---
title: Crear la receta de un producto en el panel
description: Arma la receta de un producto con sus ingredientes y porciones desde Inventario › Recetas en el panel.
product: dashboard
category: inventario
task: crear-receta
requiredPermissions:
  - inventory:read
  - inventory:create
  - menu:read
featureCode: INVENTORY_TRACKING
gateKind: FEATURE
sourceRepo: avoqado-web-dashboard
sourceRef: 1fe15c5cd61ffe8386b239114ea6c8eb6f5e006a
keywords:
  - crear receta
  - receta del producto
  - ingredientes de un platillo
  - costo de receta
---

## Antes de empezar

El inventario es para los negocios que tienen incluida la función de inventario. Necesitas permiso para ver el inventario y para crear en él, y permiso para ver el menú: de ahí sale la lista de productos.

## Pasos

1. En *Inventario* › *Recetas*, toca *Agregar Receta*.
2. Busca el producto y elígelo; toca *Siguiente*. Los que ya tienen receta salen marcados «Ya tiene receta».
3. Escribe las *Porciones por receta*. Busca cada ingrediente, escribe la cantidad y toca *Agregar*. Toca *Siguiente*.
4. Revisa el resumen y toca *Crear Receta*: sale «Receta creada exitosamente».

## Problemas frecuentes

- *Siguiente* se queda apagado hasta que eliges el producto, y en el segundo paso hasta que hay al menos un ingrediente y una porción o más.
- *Agregar* se prende hasta que escribes una cantidad mayor que cero.
- Si sale «Error», el aviso trae la razón; si no la trae, dice «Error al crear la receta».

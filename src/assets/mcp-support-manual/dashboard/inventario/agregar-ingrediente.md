---
title: Agregar un ingrediente en el panel
description: Da de alta un ingrediente o insumo con su unidad, sus existencias y su costo desde Inventario › Ingredientes en el panel.
product: dashboard
category: inventario
task: agregar-ingrediente
requiredPermissions:
  - inventory:read
  - inventory:create
featureCode: INVENTORY_TRACKING
gateKind: FEATURE
sourceRepo: avoqado-web-dashboard
sourceRef: 1fe15c5cd61ffe8386b239114ea6c8eb6f5e006a
keywords:
  - agregar ingrediente
  - dar de alta insumo
  - materia prima nueva
  - nuevo ingrediente
---

## Antes de empezar

El inventario es para los negocios que tienen incluida la función de inventario. Necesitas permiso para ver el inventario y para crear en él.

## Pasos

1. En *Inventario* › *Ingredientes*, toca *Agregar Ingrediente*.
2. Escribe el *Nombre* y el *SKU* (el botón de junto genera uno), y revisa la *Categoría* y la *Unidad*: ya traen un valor.
3. Escribe el *Stock Actual*, el *Stock Mínimo* y el *Punto de Reorden*.
4. En *Costo y Compra*, escribe el *Costo por Unidad*.
5. Toca *Guardar*: sale «Ingrediente creada exitosamente».

## Problemas frecuentes

- Si debajo de un campo sale «Requerido», llénalo. Si marcas *Perecedero*, también pide la *Vida Útil (días)*.
- Si sale «El stock mínimo debe ser menor o igual al punto de reorden…», sube el *Punto de Reorden* o baja el *Stock Mínimo*.
- Si al tocar *Guardar* sale «Ya existe un ingrediente con este SKU en este establecimiento» o cualquier otro error, no lo vuelvas a crear, tampoco con otro SKU: pudo quedar creado en un primer intento. Pide que lo revise una persona del equipo de Avoqado.

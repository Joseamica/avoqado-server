---
title: Crear una orden de compra en el panel
description: Pide mercancía a un proveedor con una orden de compra desde Inventario › Pedidos en el panel, como borrador o lista.
product: dashboard
category: inventario
task: crear-orden-de-compra
requiredPermissions:
  - inventory:read
  - inventory:create
featureCode: INVENTORY_TRACKING
gateKind: FEATURE
sourceRepo: avoqado-web-dashboard
sourceRef: 1fe15c5cd61ffe8386b239114ea6c8eb6f5e006a
keywords:
  - orden de compra
  - pedido a proveedor
  - comprar insumos
  - nueva orden de compra
---

## Antes de empezar

El inventario es para los negocios que tienen incluida la función de inventario. Necesitas permiso para ver el inventario y para crear en él; *Crear Orden* también pide permiso para editarlo.

## Pasos

1. En *Inventario* › *Pedidos*, toca *Crear Orden de Compra*.
2. En *Nombre de proveedor*, toca *Seleccionar proveedor* y elige uno. Si no existe, escribe su nombre, toca *Crear "…"*, llena sus datos y toca *Guardar Proveedor*.
3. En *Artículos de la Orden*, toca *Agregar Artículo*, elige qué pides y llena la *Cantidad* y el *Precio Unitario*. Repite por cada artículo.
4. Toca *Crear Orden*. Si todavía no está lista, toca *Guardar como Borrador*.

## Problemas frecuentes

- Si sale «Debes seleccionar un proveedor» o «Debes agregar al menos un artículo», revisa: un renglón sin material, o con cantidad o precio en cero, no cuenta.
- Si sale «Orden de compra creada exitosamente» y después «Error al enviar la orden para aprobación», la orden sí se creó, aunque el panel no sabe si quedó como borrador o confirmada: no la crees otra vez. Pide que lo revise una persona del equipo de Avoqado.
- Si al tocar *Crear Orden* o *Guardar como Borrador* sale cualquier otro error, no la crees otra vez: pudo quedar creada en un primer intento. Pide que lo revise una persona del equipo de Avoqado.

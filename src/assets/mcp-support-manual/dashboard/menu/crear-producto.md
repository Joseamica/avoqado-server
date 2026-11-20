---
title: Crear un producto en el panel
description: Da de alta un producto suelto (sin variantes) desde Productos en el panel, con su tipo, nombre, precio y categoría.
product: dashboard
category: menu
task: crear-producto
requiredPermissions:
  - menu:read
  - menu:create
  - inventory:update
featureCode: INVENTORY_TRACKING
gateKind: FEATURE
sourceRepo: avoqado-web-dashboard
sourceRef: 1fe15c5cd61ffe8386b239114ea6c8eb6f5e006a
keywords:
  - dar de alta un producto
  - agregar producto
  - nuevo producto
  - agregar platillo
---

## Antes de empezar

El panel guarda el producto nuevo sólo si tienes permiso para crear productos y para editar el inventario, y si tu negocio tiene incluida la función de inventario.

## Pasos

1. En la barra lateral, abre el menú de tu catálogo (su nombre cambia según tu giro, por ejemplo *Menú* o *Catálogo*), entra a *Productos* y toca *Nuevo producto*.
2. Elige el tipo de artículo y toca *Siguiente*.
3. Escribe el *Nombre del Producto* y el *Precio* y, si aparece, elige la *Categoría*.
4. Toca *Finalizar*.

## Problemas frecuentes

- Si sale «La categoría es requerida», elige una categoría de la lista. Si todavía no tienes ninguna, créala primero en *Categorías*.
- Si sale «El nombre del producto es requerido» o «El precio es requerido», llena ese campo.
- Si sale «Error» con un texto que menciona INVENTORY_TRACKING, tu negocio no tiene incluida la función de inventario. Si sale con «Permission '…' required», te falta ese permiso.
- Si al tocar *Finalizar* sale cualquier «Error», también esos dos, no lo vuelvas a crear ni le pidas a otra persona que lo cree: pudo quedar creado en un primer intento. Pide que lo revise una persona del equipo de Avoqado.

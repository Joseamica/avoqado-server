---
title: Crear un producto en el panel
description: Da de alta un producto suelto (sin variantes) desde Productos en el panel, con su tipo, nombre, precio, categoría y, si quieres, sus piezas.
product: dashboard
category: menu
task: crear-producto
requiredPermissions:
  - menu:read
  - menu:create
  - inventory:update
sourceRepo: avoqado-web-dashboard
sourceRef: 501e37072a13f5ed8f22e3d650f2598d3d8820b6
keywords:
  - dar de alta un producto
  - agregar producto
  - nuevo producto
  - agregar platillo
  - no me deja contar piezas
  - inventario sale bloqueado
  - no tengo acceso al inventario
---

## Antes de empezar

Para guardar un producto nuevo necesitas permiso para crear productos y para editar el inventario, aunque no le cuentes piezas. Dar de alta productos y contar sus piezas es de todos los planes; llevar un producto por receta es del plan Premium.

## Pasos

1. En la barra lateral, abre el menú de tu catálogo (su nombre cambia según tu giro, por ejemplo *Menú* o *Catálogo*), entra a *Productos* y toca *Nuevo producto*.
2. Elige el tipo de artículo y toca *Siguiente*.
3. Escribe el *Nombre del Producto* y el *Precio* y, si aparece, elige la *Categoría*.
4. Si quieres llevar cuántas piezas tienes, toca *Inventario* (si no lo ves, búscalo en *Más opciones*; lo digital y las donaciones no llevan piezas), deja *Seguimiento de Cantidad* y escribe el *Stock Inicial*.
5. Toca *Finalizar*.

## Problemas frecuentes

- Si sale «La categoría es requerida», elige una categoría de la lista. Si todavía no tienes ninguna, créala primero en *Categorías*.
- Si sale «El nombre del producto es requerido» o «El precio es requerido», llena ese campo.
- Si *Inventario* no se abre y dice «Tu usuario no tiene acceso al inventario de este negocio. Pídeselo a tu administrador.», tu usuario no puede contar piezas en este negocio: pídele ese permiso a tu administrador.
- Si al tocar *Finalizar* sale «Ya no puedes contar las piezas de este producto: cambió tu acceso o tu plan. Apaga «Inventario» para guardarlo sin piezas, o pídele el permiso a tu administrador.», el producto no se guardó. Toca la ✕ de *Inventario*, confirma con *Quitar* y vuelve a tocar *Finalizar*.
- Si sale «No pudimos revisar tu plan. Cierra esta ventana y vuelve a abrirla.», el producto no se guardó: cierra la ventana, ábrela otra vez y vuelve a llenarlo.
- Si sale «Error» con «Permission 'inventory:update' required», el producto no se guardó: a tu usuario le falta el permiso para editar el inventario, y te lo da tu administrador.
- Si al tocar *Finalizar* sale cualquier otro «Error», no lo vuelvas a crear ni le pidas a otra persona que lo cree: pudo quedar creado aunque saliera el error. Pide que lo revise una persona del equipo de Avoqado.

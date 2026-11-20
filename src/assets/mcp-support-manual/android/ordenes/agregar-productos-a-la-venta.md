---
title: Agregar productos a la venta en el POS Android
description: Agrega productos al carrito tocándolos, buscándolos o escaneando su código, con sus opciones, en el POS Android.
product: android
category: ordenes
task: agregar-productos-a-la-venta
requiredPermissions:
  - menu:read
versionMin: 2.25.4
sourceRepo: avoqado-android
sourceRef: 843c15ae06bf68dd0d9c755525a9971e701052b7
keywords:
  - agregar producto
  - tomar la orden
  - vender un producto
  - buscar producto
  - escanear código de barras
  - modificadores
  - repetir la misma opción
  - dos de la misma
  - no me deja poner dos iguales
  - opciones del producto
  - producto nuevo no aparece
  - precio no se actualiza
  - menú del aparato
---

## Antes de empezar

Se hace en *Cobrar*. Los productos se cargan con el permiso de ver el menú; sin él, sólo salen los que este aparato ya tenía guardados.

## Pasos

1. En *Cobrar*, toca la pestaña *Todos los productos* y toca el producto.
2. Para buscarlo, toca *Buscar*, escribe su nombre y toca el resultado.
3. Para leer su código de barras, toca el botón *Escanear código de barras*.
4. Si el producto tiene opciones, elígelas y toca *Agregar al carrito*; los grupos que dicen *Requerido* no se pueden dejar vacíos.
   Si un grupo trae *−* y *+* en cada opción, la misma opción se puede elegir varias veces (por ejemplo, 2 de cochinita y 1 de papa): toca *+* las veces que la quieras y *−* para quitar una. Cada vez cuenta para el *Requerido* y se cobra a su precio; el *+* se apaga al llegar al máximo del grupo o al tope de esa opción.
5. Si el producto dice cuántas variantes tiene, tócalo, elige una opción de cada grupo y toca *Agregar al carrito*.
6. Si se vende por peso, ponlo en la báscula o escribe el *Peso (kg)* (con báscula, toca antes *Capturar manualmente*), y toca *Agregar*.

## Problemas frecuentes

- Si una opción no deja repetirse (casilla en vez de *−* y *+*), el grupo no tiene prendido «Se puede repetir la misma opción»: se prende en el panel, en el grupo de modificadores. En el iPad todavía se elige cada opción una vez.
- Si faltan modificadores obligatorios, al tocar *Agregar al carrito* aparece arriba «Falta elegir: …». En variantes, debajo del botón aparece «Elige una opción de cada grupo para agregar.»
- Si al escanear sale «Producto no encontrado», ese código no está en el catálogo cargado en este aparato: toca el botón *Actualizar productos* (junto a *Buscar*) y vuelve a escanear.
- Si un producto que diste de alta o cambiaste en el panel no sale, o sale con su precio de antes, toca *Actualizar productos* antes de agregarlo.
- Si aparece *Todo ▸*, tócalo para ver el catálogo sin el filtro del menú, o busca el producto con *Buscar*.

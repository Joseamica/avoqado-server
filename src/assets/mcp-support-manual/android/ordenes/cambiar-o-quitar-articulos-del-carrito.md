---
title: Cambiar o quitar artículos del carrito en el POS Android
description: Cambia la cantidad o la nota de un artículo del carrito, quítalo o vacía el carrito antes de cobrar en el POS Android.
product: android
category: ordenes
task: cambiar-o-quitar-articulos-del-carrito
requiredPermissions: []
sourceRepo: avoqado-android
sourceRef: 8fe89cf59b8fce2b30eb49eb01db50e0fa819508
keywords:
  - cambiar cantidad
  - quitar producto del carrito
  - borrar artículo
  - nota del artículo
  - vaciar carrito
  - editar la orden
  - dice que tiene tope de usos
  - no se puede poner en un vale
  - no hay existencia libre suficiente
  - no cubren la venta
  - vale sin existencia
---

## Antes de empezar

En *Cobrar*, con artículos en el carrito. En el teléfono, toca antes *Ver carrito*.

## Pasos

1. Toca el artículo en el carrito.
2. Cambia la *Cantidad* con − y +.
3. Para una indicación (sin cebolla, para llevar), toca *Nota del artículo*, escríbela y toca *Guardar nota*.
4. Para quitarlo, toca *Eliminar artículo*, o desliza su renglón hacia la izquierda.
5. Para quitar todo, toca el botón de tres puntos (*Mas opciones*) arriba del carrito, luego *Vaciar carrito* y *Vaciar*.

## Problemas frecuentes

- Un artículo de una promoción no se abre: deslízalo hacia la izquierda y toca *Quitar combo* para quitar el combo completo.
- En un artículo vendido por peso no sale *Cantidad*: quítalo y vuelve a pesarlo.
- Si aparece «No se puede vaciar», la venta de vales ya tiene un abono: cobra su saldo pendiente para terminarla.
- Si aparece «El descuento «…» tiene tope de usos y no se puede poner en un vale: emite el vale sin ese descuento.» o «…no se puede usar en una venta con vales: quítalo de ese producto para cobrar.», quita del carrito el producto que lleva ese descuento y agrégalo otra vez sin él: un descuento con tope de usos no entra en una venta con vales.
- Si al cobrar una venta con vales aparece «No hay existencia libre suficiente de "…". Disponible: …; requerida: ….», «Los lotes FIFO de "…" no cubren la venta…», «Los lotes FIFO no cubren la reserva del vale.» o «La existencia reservada ya no está disponible.», falta inventario y esa venta no se puede cerrar: en una venta con vales todo necesita existencia.
  - Si salió al confirmar el cobro de una venta sin abonos, no se registró ningún pago y nada llegó a la terminal. Si ya tienes el efectivo en la mano, no quedó registrado: devuélveselo al cliente mientras corriges. Quita o baja la cantidad del producto que se agregó en la caja (o de su extra) y vuelve a cobrar; si pide volver a escanear el vale, escanéalo otra vez.
  - Si falta un producto del vale (su renglón no se puede editar), pide a un encargado que registre la entrada en el inventario y vuelve a cobrar.
  - Si la venta ya tenía un abono, lo ya cobrado sigue registrado: no lo cobres otra vez. Cobra sólo el saldo cuando el encargado registre la entrada.
  - Si el cliente ya había pagado por fuera («Ya pagó de otra forma»), ese pago no quedó registrado: regístralo otra vez después de corregir.

---
title: Dar un descuento o una cortesía en el POS Windows
description: Aplica un descuento a toda la venta o a un producto con opciones, o da de cortesía un artículo o la venta, en Cobrar del POS Windows.
product: windows
category: cobro
task: dar-descuento-o-cortesia
requiredPermissions: []
money: true
sourceRepo: avoqado-android
sourceRef: 212f9cf4f150b7770cf6e753e5e2dbd78451948f
deviceTested: 2026-11-18
keywords:
  - descuento
  - descuento manual
  - descuento de la cuenta
  - cortesía
  - regalar un producto
  - venta en cero
  - no tienes permiso
  - descuento en la mesa
  - dice que tiene tope de usos
  - no se puede poner en un vale
  - no me deja quitar el descuento
  - quitar en gris
  - el descuento dice agotado
  - has reached its usage limit
---

## Antes de empezar

Los pasos son para una venta con productos en el carrito de *Cobrar*. En una cuenta de *Mesas* el descuento es de toda la cuenta: en la pestaña *Acciones* toca *Descuentos*; en «Disponibles» toca el que quieras (si sale «Motivo del descuento», elige el motivo) y, en «Aplicados», *Quitar* lo quita. Si la ventana está angosta, toca antes *Ver carrito*. Al cobrar, el servidor pide el permiso de aplicar descuentos para un descuento de la venta, y el permiso de dar cortesías para la cortesía de un artículo; éste último lo traen de fábrica gerente, administrador y dueño.

## Pasos

1. Para un descuento de toda la venta, toca *Agregar descuento* debajo de los artículos del carrito, o en la pestaña *Atajos* toca *Descuentos*.
2. Toca uno de los *Descuentos predefinidos*, o toca *Descuento manual*, elige % o $, escribe el *Porcentaje* o el *Monto* y toca *Aplicar descuento*.
3. Para quitarlo, en esa misma pantalla toca la X junto a «… aplicado».
4. Para dar de cortesía un artículo del carrito, tócalo y toca *Cortesía*: debajo sale «Cortesía del administrador». Toca *Cortesía* otra vez para quitarla.
5. Al agregar un producto con opciones, antes de *Agregar al carrito* puedes tocar *Descuentos* (los que aplican a ese producto) o *Cortesía*: elige el motivo y toca *Aplicar cortesía*.
6. Para dar de cortesía toda la venta, en *Atajos* toca *Cortesía*, luego *Aplicar cortesia* y *Confirmar*: es un descuento del 100% de la venta.

## Problemas frecuentes

- La venta lleva un solo descuento de toda la venta: elegir otro, o la cortesía de toda la venta, reemplaza al que tenía.
- Si la venta trae renglones de vales, no se le pone descuento de toda la venta ni cortesía a esos renglones.
- Un artículo de una promoción no se abre al tocarlo: no se le da cortesía suelta.
- Un descuento con tope de usos (en el panel, *Usos Totales Máximos* o *Usos Máximos por Cliente*) no entra en una venta con vales. Si al emitir un vale aparece «El descuento «…» tiene tope de usos y no se puede poner en un vale: emite el vale sin ese descuento.», el vale no salió: quita ese producto del carrito, agrégalo sin ese descuento y emite el vale otra vez.
- Si al cobrar una venta con vales aparece «El descuento «…» tiene tope de usos y no se puede usar en una venta con vales: quítalo de ese producto para cobrar.», la venta no se cobró: quita el producto suelto que lleva ese descuento, agrégalo sin él y vuelve a cobrar.
- Si en una cuenta de *Mesas* un descuento dice «Fija: viene del cobro de vales» y su *Quitar* sale en gris, al tocarlo aparece «Esta rebaja quedó fija al cobrar los vales y no se quita desde la caja. Si hay que cambiarla, avisa a un encargado.»: esa rebaja no se quita desde la caja. En versiones anteriores a la 2.25.52, *Quitar* se ve activo y al tocarlo sale «Este descuento quedó fijo al cobrar los vales y no se quita desde la caja…».
- Si al aplicar un descuento en una cuenta de *Mesas* aparece «Discount "…" has reached its usage limit», ese descuento ya usó todos sus usos (su tope): no se aplicó. Elige otro o deja la cuenta sin él. Cada cuenta de *Mesas* que lleva el descuento gasta un uso al aplicarlo; quitarlo de la cuenta, o anular la cuenta sin cobrar, regresa el uso.
- En *Cobrar*, una venta con un descuento que ya no tiene usos se cobra igual: lo cobrado nunca se rechaza por el tope. Su uso cuenta aunque el descuento pase de su tope, y queda registrado para el dueño.
- Si aparece «Este artículo no tiene descuentos propios», no hay descuentos para ese producto: los de toda la venta se ponen con *Agregar descuento*.
- Si aparece al cobrar «No tienes permiso» y pide que te activen «dar una cortesía» o «aplicar un descuento», la venta no se registró: quita la cortesía o el descuento, o que la cobre con su propia sesión alguien que tenga ese permiso.

## Sin internet

- Lo hecho sin conexión con un descuento que tiene tope de usos (cobrar en *Cobrar* o aplicarlo en una cuenta de *Mesas*) no se rechaza al volver el internet: se guarda y su uso cuenta, aunque pase del tope.

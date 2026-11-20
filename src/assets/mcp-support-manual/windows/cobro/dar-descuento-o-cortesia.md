---
title: Dar un descuento o una cortesía en el POS Windows
description: Aplica un descuento a toda la venta o a un producto con opciones, o da de cortesía un artículo o la venta, en Cobrar del POS Windows.
product: windows
category: cobro
task: dar-descuento-o-cortesia
requiredPermissions: []
money: true
sourceRepo: avoqado-android
sourceRef: c07a2bbebf453598963bf96f3208f66193dd5efb
deviceTested: 2026-11-18
keywords:
  - descuento
  - descuento manual
  - descuento de la cuenta
  - cortesía
  - regalar un producto
  - venta en cero
  - no tienes permiso
---

## Antes de empezar

Es para una venta con productos en el carrito de *Cobrar*, no para una cuenta de *Mesas*. Si la ventana está angosta, toca antes *Ver carrito*. Al cobrar, el servidor pide el permiso de aplicar descuentos para un descuento de la venta, y el permiso de dar cortesías para la cortesía de un artículo; éste último lo traen de fábrica gerente, administrador y dueño.

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
- Si aparece «Este artículo no tiene descuentos propios», no hay descuentos para ese producto: los de toda la venta se ponen con *Agregar descuento*.
- Si aparece al cobrar «No tienes permiso» y pide que te activen «dar una cortesía» o «aplicar un descuento», la venta no se registró: quita la cortesía o el descuento, o que la cobre con su propia sesión alguien que tenga ese permiso.

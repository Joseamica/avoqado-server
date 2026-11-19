---
title: Dar un descuento o una cortesía en el POS Android
description: Aplica un descuento a toda la venta o a un producto con opciones, o da de cortesía un artículo o la venta, en Cobrar del POS Android.
product: android
category: cobro
task: dar-descuento-o-cortesia
requiredPermissions: []
money: true
sourceRepo: avoqado-android
sourceRef: 843c15ae06bf68dd0d9c755525a9971e701052b7
deviceTested: 2026-11-18
keywords:
  - descuento
  - descuento manual
  - descuento de la cuenta
  - cortesía
  - regalar un producto
  - venta en cero
  - PIN de gerente
---

## Antes de empezar

Es para una venta con productos en el carrito de *Cobrar*, no para una cuenta de *Mesas*. En el teléfono, toca antes *Ver carrito*. Al cobrar, el servidor pide el permiso de aplicar descuentos para un descuento de la venta, y el permiso de dar cortesías para la cortesía de un artículo; éste último lo traen de fábrica gerente, administrador y dueño.

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
- Si aparece al cobrar «Este descuento deja la cuenta en $0: es una cortesía. Vuelve a cobrar para pedir el PIN de un gerente, o quita el descuento.», no se registró la venta: vuelve a cobrar para que un gerente escriba su PIN, o quita la cortesía o el descuento.
- Si aparece el teclado del PIN al cobrar una venta con cortesía, o con un descuento que la deja en $0, un gerente tiene que escribir su PIN para autorizarla.
- Si aparece «Este descuento deja la cuenta en $0: es una cortesía. Esta cortesía la da un gerente con su sesión.», que la cobre un gerente con su propia sesión, o quita el descuento.

## Sin internet

- Si aparece «Sin conexión: el PIN del gerente necesita internet. Quita el descuento o cobra cuando vuelva la red.», ese cobro no salió: quita el descuento o cobra cuando vuelva la conexión.

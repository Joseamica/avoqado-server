---
title: Aplicar un descuento o un cupón en Cobrar en la terminal
description: En Cobrar, pon un descuento manual en porcentaje o en pesos a la venta, o aplica el código de un cupón, antes de cobrar.
product: tpv
category: cobro
task: aplicar-descuento-o-cupon
requiredPermissions:
  - discounts:apply
money: true
versionMin: 2.14.0
sourceRepo: avoqado-tpv
sourceRef: 031f14db2969606125a4a04c9f8f30bdd402a660
deviceTested: 2026-11-25
keywords:
  - descuento en la terminal
  - descuento manual
  - aplicar cupón en la terminal
  - código de cupón
  - quitar descuento
  - sin permiso para descuento
---

## Antes de empezar

Es en *Cobrar*, con productos en el carrito. *Descuento* pide el permiso de aplicar descuentos (sin él, dice «Sin permiso»), y el descuento escrito a mano viene en el plan Pro. El cupón pide el permiso de canjear cupones (de fábrica, del mesero para arriba). La venta lleva un solo descuento: uno nuevo reemplaza al que tenía.

## Pasos

1. En *Cobrar*, abre la pestaña *Shortcuts*.
2. Para un descuento a mano, toca *Descuento*, elige *Porcentaje* o *Monto fijo* y escribe el valor; si quieres, el *Motivo (opcional)*.
3. Revisa «Descuento: −…» y toca *Aplicar* (si ya había uno escrito a mano, el botón dice *Reemplazar descuento*). Para quitarlo, entra otra vez a *Descuento* y toca *Quitar* junto a «Descuento manual aplicado».
4. Para un cupón, toca *Cupón*, escribe su *Código* y toca *Aplicar cupón*.
5. Si es válido, la venta baja con el cupón y regresas a *Shortcuts*. Al entrar otra vez a *Cupón* sale «Aplicado: …» con su valor; para quitarlo, toca *Quitar*.
6. Cobra la venta como siempre.

## Problemas frecuentes

- Si al tocar *Descuento* o *Cupón* sale «Agrega items al carrito primero» (o «El carrito está vacío»), agrega productos primero.
- Si el código del cupón no es válido, debajo sale por qué.
- Si ya había un descuento, sale «Descuento actual: … Si aplicas uno manual, este será reemplazado.».

## Sin internet

- Si *Cupón* dice «Necesita internet», no se puede validar ni quitar un cupón hasta que vuelva la conexión.
- Desde la 2.16.2, si se va la red después de aplicar el cupón, la venta no se cobra (tampoco en efectivo) y sale «Sin conexión: el cupón necesita internet. Reintenta cuando vuelva la conexión, o quita el cupón para cobrar sin él.»: espera a que vuelva la conexión para cobrarla o quitar el cupón.

---
title: Aplicar el premio de la tarjeta de sellos al cobrar en el POS Windows
description: Escanea en Cobrar la tarjeta digital del cliente; si tiene un premio de sellos por cobrar, aplícalo a la venta y cóbrala con el descuento.
product: windows
category: lealtad
task: aplicar-premio-de-sellos
requiredPermissions: []
featureCode: LOYALTY_PROGRAM
gateKind: FEATURE
money: true
versionMin: 2.22.2
sourceRepo: avoqado-android
sourceRef: 78e5372f37ed7791d86fc1fe621d4a073e5a09ff
deviceTested: 2026-11-25
keywords:
  - aplicar premio de sellos
  - canjear premio de lealtad
  - tiene un premio por cobrar
  - escanear tarjeta digital del cliente
  - tarjeta de sellos llena
  - producto gratis por sellos
---

## Antes de empezar

Es en *Cobrar*, con la venta en el carrito. El cliente enseña la tarjeta digital de sellos de su celular. Al escanearla, la venta queda ligada a ese cliente y, al cobrar, la compra le suma su sello (salvo que el negocio limite los sellos por día y ya haya llegado a su tope). El premio necesita internet.

## Pasos

1. Escanea el código de la tarjeta digital del cliente con el lector de la computadora.
2. Sale un aviso con su nombre y cuántos sellos tiene. Si dice «🎁 Tiene un premio por cobrar: …», toca *Aplicar …*.
3. En el carrito sale «Premio: …» con el descuento, o «Se calcula al cobrar».
4. Cobra la venta como siempre: el total ya trae el premio.
5. Para no usarlo en esta venta, toca la X de ese renglón (*Quitar premio*) antes de cobrar.

## Problemas frecuentes

- Si el aviso no trae premio, sólo dice su avance («… de … sellos · esta compra le suma otro»): toca *Listo*. Ese aviso no revisa el tope de sellos por día: si el cliente ya llegó, al cobrar no suma.
- Si el renglón dice «No aplica a esta venta», el premio no corresponde a lo que lleva el carrito.
- Si dice «Esta venta ya se está cobrando por partes: su premio no se puede cambiar.», el premio ya no se cambia en esa venta.
- Si al cobrar sale «Revisa el premio», el premio no quedó como lo anunció el carrito: revisa el total antes de entregar.

## Sin internet

- Si al cobrar sale «Sin conexión: el premio necesita internet. Reintenta cuando vuelva la conexión, o quita el premio para cobrar sin él.», la venta no se cobró (tampoco en efectivo): reintenta con red o toca *Quitar premio*.

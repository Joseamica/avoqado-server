---
title: Aplicar el premio de la tarjeta de sellos al cobrar en el POS Android
description: Escanea en Cobrar la tarjeta digital del cliente; si tiene un premio de sellos por cobrar, aplícalo a la venta y cóbrala con el descuento.
product: android
category: lealtad
task: aplicar-premio-de-sellos
requiredPermissions:
  - loyalty:read
featureCode: LOYALTY_PROGRAM
gateKind: FEATURE
money: true
versionMin: 2.20.0
sourceRepo: avoqado-android
sourceRef: 1c3999b1bf9de45ea788cbcf57a3ab6f75847a47
deviceTested: 2026-11-25
keywords:
  - aplicar premio de sellos
  - canjear premio de lealtad
  - tiene un premio por cobrar
  - escanear tarjeta digital del cliente
  - tarjeta de sellos llena
  - producto gratis por sellos
  - producto no encontrado al escanear la tarjeta del cliente
  - tarjeta no encontrada
  - escanear tarjeta del cliente sin internet
---

## Antes de empezar

Es en *Cobrar*, con la venta en el carrito. El cliente enseña la tarjeta digital de sellos de su celular. Al escanearla, la venta queda ligada a ese cliente y, al cobrar, la compra le suma su sello (salvo que el negocio limite los sellos por día y ya haya llegado a su tope). El premio necesita internet.

## Pasos

1. Escanea el código de la tarjeta digital del cliente con el lector.
2. Sale un aviso con su nombre y cuántos sellos tiene. Si dice «🎁 Tiene un premio por cobrar: …», toca *Aplicar …*.
3. En el carrito sale «Premio: …» con el descuento, o «Se calcula al cobrar».
4. Cobra la venta como siempre: el total ya trae el premio.
5. Para no usarlo en esta venta, toca la X de ese renglón (*Quitar premio*) antes de cobrar.

## Problemas frecuentes

- Si el aviso no trae premio, sólo dice su avance: toca *Listo*. Desde la versión 2.25.60, el aviso también dice si ESTA compra suma sello: «esta compra le suma otro», «ya recibió su sello de hoy» (el negocio limita los sellos por día y el cliente ya llegó a su tope), «la tarjeta de sellos está apagada» o «esta compra no suma sello». Si no pudo comprobarlo en 1 segundo, sólo enseña el avance, sin esa frase; y en una venta que ya se cobra por partes tampoco la lleva. En versiones anteriores a la 2.25.60 el aviso siempre dice «esta compra le suma otro» y no revisa el tope del día: si el cliente ya llegó a su tope, al cobrar no suma sello aunque el aviso lo prometa.
- Si el renglón dice «No aplica a esta venta», el premio no corresponde a lo que lleva el carrito.
- La primera vez que se usa un lector nuevo puede perderse un carácter y salir «Producto no encontrado» con el código casi completo: cierra el aviso y vuelve a escanear.
- Si dice «Esta venta ya se está cobrando por partes: su premio no se puede cambiar.», el premio ya no se cambia en esa venta.
- Si al escanear sale «Tarjeta no encontrada» («Esa tarjeta no es de un cliente de este negocio. Puedes elegir al cliente a mano desde el carrito.»), la tarjeta es de otro negocio o ya no sirve: toca *Entendido* y elige al cliente desde el carrito (*Agregar cliente*, o *Cambiar cliente* si ya hay uno). Si sale «No se pudo leer la tarjeta», vuelve a escanearla o elígelo desde el carrito. Ninguno de los dos ofrece crear un producto: no des de alta el código de una tarjeta como producto.
- Si al cobrar sale «Revisa el premio», el premio no quedó como lo anunció el carrito: revisa el total antes de entregar.

## Sin internet

- Si al escanear la tarjeta sale «Sin conexión» («La tarjeta del cliente se lee cuando vuelva la red. Mientras, puedes elegir al cliente a mano desde el carrito.»), toca *Entendido* y elige al cliente desde el carrito (*Agregar cliente*; sin internet busca entre los clientes guardados en la tablet). La venta queda a su nombre y se cobra en efectivo como siempre. El premio no se aplica sin internet. En versiones anteriores sale «Producto no encontrado» con *Crear nuevo*: ciérralo con la X y no crees el producto.
- Si al cobrar sale «Sin conexión: el premio necesita internet. Reintenta cuando vuelva la conexión, o quita el premio para cobrar sin él.», la venta no se cobró (tampoco en efectivo): reintenta con red o toca *Quitar premio*.

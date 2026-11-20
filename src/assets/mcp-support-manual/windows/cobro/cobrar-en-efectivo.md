---
title: Cobrar en efectivo en el POS Windows
description: Cobra una venta en efectivo en el POS Windows: toca el billete que te dieron o escribe el monto recibido.
product: windows
category: cobro
task: cobrar-en-efectivo
requiredPermissions:
  - payments:create
money: true
versionMin: 2.25.4
sourceRepo: avoqado-android
sourceRef: c07a2bbebf453598963bf96f3208f66193dd5efb
deviceTested: 2026-11-18
keywords:
  - pago en efectivo
  - cobrar en efectivo
  - efectivo
  - cash
  - cambio
  - monto recibido
---

## Pasos

1. En *Cobrar*, con los productos en la venta, toca *Cobrar* con el total; si la ventana está angosta, primero toca *Ver carrito*.
2. Si salen pantallas antes del pago (*¿Algo más?*, *¿Cómo fue tu experiencia?* o *Propina*), complétalas o sáltalas con *No, gracias*, *Omitir* o *Sin propina*.
3. En la fila *Efectivo*, toca el monto sugerido que te dieron o toca *Personalizado*.
4. Con *Personalizado*, en *Monto recibido* escribe lo que te dieron con sus centavos (para $200.00, teclea 20000), revisa el monto que sale y toca *Confirmar*.
5. Al terminar se ve lo cobrado y, si hay que dar cambio, «Cambio: …». Toca *Venta nueva* para seguir.

## Problemas frecuentes

- En *Monto recibido*, *Confirmar* se prende hasta que el monto llega al total.
- Si esta computadora tiene prendido *El cliente elige propina y calificación* y la pantalla del cliente está en un segundo monitor, el cliente califica o elige la propina en su pantalla; para seguir sin eso, a los 8 segundos sale *Continuar sin calificación* o *Continuar sin propina*.

## Sin internet

Si al terminar dice «Se sincronizará cuando haya conexión», el cobro quedó guardado en la computadora y se envía solo cuando vuelve la conexión.

Si sale «Sin conexión: el premio necesita internet…», cobra cuando vuelva la conexión o quita el premio.

Si aparece *Sin conexión: el cupón necesita internet…*, ese cobro no quedó guardado: cobra cuando vuelva la conexión, o quita el cupón y revisa el nuevo total.

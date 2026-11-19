---
title: Cobrar en efectivo en el POS Android
description: Cobra una venta en efectivo en el POS Android: toca el billete que te dieron o escribe el monto recibido.
product: android
category: cobro
task: cobrar-en-efectivo
requiredPermissions:
  - payments:create
money: true
versionMin: 2.25.0
sourceRepo: avoqado-android
sourceRef: 843c15ae06bf68dd0d9c755525a9971e701052b7
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

1. En *Cobrar*, con los productos en la venta, toca *Cobrar* con el total; en el teléfono, primero toca *Ver carrito*.
2. Si salen pantallas antes del pago (*¿Algo más?*, *¿Cómo fue tu experiencia?* o *Propina*), complétalas o sáltalas con *No, gracias*, *Omitir* o *Sin propina*.
3. En la fila *Efectivo*, toca el monto sugerido que te dieron o toca *Personalizado*.
4. Con *Personalizado*, en *Monto recibido* escribe lo que te dieron con sus centavos (para $200.00, teclea 20000), revisa el monto que sale y toca *Confirmar*.
5. Al terminar se ve lo cobrado y, si hay que dar cambio, «Cambio: …». Toca *Venta nueva* para seguir.

## Problemas frecuentes

- En *Monto recibido*, *Confirmar* se prende hasta que el monto llega al total.
- Si este aparato tiene prendido *El cliente elige propina y calificación* y una pantalla del cliente que se puede tocar, el cliente califica o elige la propina en su pantalla; para seguir sin eso, a los 8 segundos sale *Continuar sin calificación* o *Continuar sin propina*.

## Sin internet

Si al terminar dice «Se sincronizará cuando haya conexión», el cobro quedó guardado en el aparato y se envía solo cuando vuelve la conexión.

Si sale «Sin conexión: el premio necesita internet…», cobra cuando vuelva la conexión o quita el premio.

Si aparece «Sin conexión: el cupón necesita internet. Reintenta cuando vuelva la conexión, o quita el cupón para cobrar sin él.», ese cobro no quedó guardado: espera a que vuelva la conexión, o quita el cupón, revisa el nuevo total y cóbralo.

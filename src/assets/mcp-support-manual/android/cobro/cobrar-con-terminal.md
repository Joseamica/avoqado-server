---
title: Mandar el cobro a la terminal en el POS Android
description: Manda el cobro de una venta del POS Android a una terminal conectada para que el cliente pague ahí.
product: android
category: cobro
task: cobrar-con-terminal
requiredPermissions:
  - payments:create
money: true
sourceRepo: avoqado-android
sourceRef: 843c15ae06bf68dd0d9c755525a9971e701052b7
deviceTested: 2026-11-18
keywords:
  - cobrar con terminal
  - mandar a la terminal
  - pagar con tarjeta
  - tarjeta
  - terminal
  - seleccionar terminal
---

## Pasos

1. En *Cobrar*, con los productos en la venta, toca *Cobrar* con el total; en el teléfono, primero toca *Ver carrito*.
2. Si salen pantallas antes del pago (*¿Algo más?*, *¿Cómo fue tu experiencia?* o *Propina*), complétalas o sáltalas con *No, gracias*, *Omitir* o *Sin propina*.
3. Toca *Cobrar con terminal*.
4. En *Seleccionar terminal*, toca la terminal donde va a pagar el cliente.
5. En la terminal, si pide elegir la cuenta de cobro, elígela, y si sale *Método de pago*, toca *Tarjeta*. Mientras el POS dice *Esperando respuesta de la terminal*, el cobro sigue ahí; cuando pasa, toca *Venta nueva*.

## Problemas frecuentes

- Si dice «No hay terminales conectadas», toca *Reintentar*.
- Si este aparato tiene prendido *El cliente elige propina y calificación* y una pantalla del cliente que se puede tocar, el cliente califica o elige la propina en su pantalla; para seguir sin eso, a los 8 segundos sale *Continuar sin calificación* o *Continuar sin propina*.

## Sin internet

Si en *Seleccionar terminal* sale «Sin conexión: el cobro con tarjeta necesita internet. Cobra en efectivo o espera a que vuelva la red.», cobra en efectivo o espera a que vuelva la conexión.

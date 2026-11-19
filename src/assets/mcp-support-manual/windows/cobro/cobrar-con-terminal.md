---
title: Mandar el cobro a la terminal en el POS Windows
description: Manda el cobro de una venta del POS Windows a una terminal conectada para que el cliente pague ahí.
product: windows
category: cobro
task: cobrar-con-terminal
requiredPermissions:
  - payments:create
money: true
sourceRepo: avoqado-android
sourceRef: c07a2bbebf453598963bf96f3208f66193dd5efb
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

1. En *Cobrar*, con los productos en la venta, toca *Cobrar* con el total; si la ventana está angosta, primero toca *Ver carrito*.
2. Si salen pantallas antes del pago (*¿Algo más?*, *¿Cómo fue tu experiencia?* o *Propina*), complétalas o sáltalas con *No, gracias*, *Omitir* o *Sin propina*.
3. Toca *Cobrar con terminal*.
4. En *Seleccionar terminal*, toca la terminal donde va a pagar el cliente.
5. En la terminal, si pide elegir la cuenta de cobro, elígela, y si sale *Método de pago*, toca *Tarjeta*. Mientras el POS dice *Esperando respuesta de la terminal*, el cobro sigue ahí; cuando pasa, toca *Venta nueva*.

## Problemas frecuentes

- Si dice «No hay terminales conectadas», toca *Reintentar*.
- Si esta computadora tiene prendido *El cliente elige propina y calificación* y la pantalla del cliente está en un segundo monitor, el cliente califica o elige la propina en su pantalla; para seguir sin eso, a los 8 segundos sale *Continuar sin calificación* o *Continuar sin propina*.

## Sin internet

Si en *Seleccionar terminal* sale «Sin conexión: el cobro con tarjeta necesita internet. Cobra en efectivo o espera a que vuelva la red.», cobra en efectivo o espera a que vuelva la conexión.

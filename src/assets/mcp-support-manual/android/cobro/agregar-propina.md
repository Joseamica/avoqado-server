---
title: Agregar propina al cobrar en el POS Android
description: Agrega la propina de la venta al cobrar en el POS Android, con un porcentaje sugerido o con otra cantidad.
product: android
category: cobro
task: agregar-propina
requiredPermissions:
  - payments:create
money: true
sourceRepo: avoqado-android
sourceRef: 843c15ae06bf68dd0d9c755525a9971e701052b7
deviceTested: 2026-11-18
keywords:
  - propina
  - dejar propina
  - porcentaje de propina
  - otra cantidad
  - sin propina
---

## Antes de empezar

La pantalla *Propina* sale al cobrar sólo si el negocio tiene prendido *Pedir propina*.

## Pasos

1. En *Cobrar*, con los productos en la venta, toca *Cobrar* con el total; en el teléfono, primero toca *Ver carrito*.
2. Si sale *¿Algo más?*, toca *No, gracias* para seguir, o marca una sugerencia y toca *Continuar*: si sigue disponible, se agrega a la venta; si no, el cobro sigue sin ella.
3. Si sale *¿Cómo fue tu experiencia?*, elige las estrellas y toca *Continuar*, o toca *Omitir*.
4. En *Propina*, toca un porcentaje (debajo dice cuánto es) u *Otra cantidad* y mira el símbolo: con % tecleas porcentaje; con $, centavos ($20.00 es 2000). El botón de al lado cambia el símbolo y borra lo escrito.
5. Toca *Continuar* con el nuevo total, o toca *Sin propina*.
6. Cobra como siempre en *Efectivo* o con *Cobrar con terminal*: el total ya trae la propina.

## Problemas frecuentes

- En *Propina*, *Continuar* se prende hasta que eliges un porcentaje o escribes una cantidad.
- En pesos, revisa el monto que sale antes de *Continuar*: 20 es $0.20.
- Si este aparato tiene prendido *El cliente elige propina y calificación* y una pantalla del cliente que se puede tocar, la calificación y la propina las da el cliente en su pantalla: el POS dice «El cliente está calificando» o «El cliente está eligiendo propina». Para seguir sin eso, a los 8 segundos sale *Continuar sin calificación* o *Continuar sin propina*.

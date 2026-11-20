---
title: Abrir y cerrar la caja en el POS Android
description: Abre el turno de caja con el monto inicial y ciérralo con el conteo del efectivo en el POS Android; incluye el corte.
product: android
category: caja
task: abrir-y-cerrar-caja
requiredPermissions:
  - payments:create
money: true
sourceRepo: avoqado-android
sourceRef: 843c15ae06bf68dd0d9c755525a9971e701052b7
deviceTested: 2026-11-18
keywords:
  - abrir caja
  - cerrar caja
  - turno de caja
  - corte de caja
  - corte parcial
  - arqueo
  - fondo de caja
---

## Antes de empezar

*Caja* en *Más* es sólo para cajero, gerente, administrador y dueño.

## Pasos

1. En *Más*, toca *Caja*. En el teléfono, toca luego *Turno en curso*.
2. Para abrir, toca *Abrir caja*, escribe el *Monto inicial ($)* y toca *Abrir caja*.
3. Para ver cómo va el turno sin cerrarlo, toca *Corte parcial*.
4. Para cerrar, toca *Cerrar caja* y escribe en *Conteo real ($)* el efectivo que hay dentro del cajón, con el fondo inicial.
5. Toca *Cerrar caja*. Si pregunta «¿Contaste lo que quedó dentro del cajón?», toca *Volver a contar* o *Cerrar con este conteo*.
6. Sale el *Corte de caja* con el resultado; toca *Imprimir corte* para sacarlo en papel.

## Sin internet

Si dice «Caja abierta sin conexión: se sincronizará al recuperar la red», la caja quedó abierta en el aparato y se envía sola cuando vuelve la conexión.

Si cierras sin conexión, el corte dice «Sin conexión: este corte sólo incluye lo registrado en este aparato…»: el cierre se envía solo cuando vuelve la conexión.

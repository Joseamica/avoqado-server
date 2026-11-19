---
title: Cobrar con tarjeta en la terminal PAX
description: Cobra una venta con tarjeta de crédito o débito en la terminal PAX, empezando en Pago rápido.
product: tpv
category: cobro
task: cobrar-con-tarjeta
deviceFamily: PAX
requiredPermissions:
  - payments:create
money: true
versionMin: 2.7.1
sourceRepo: avoqado-tpv
sourceRef: 031f14db2969606125a4a04c9f8f30bdd402a660
deviceTested: 2026-11-18
keywords:
  - pagar con tarjeta
  - cobrar con tarjeta
  - tarjeta de crédito
  - tarjeta de débito
  - meses sin intereses
  - pago rápido
---

## Pasos

1. En el inicio, toca *Pago rápido*, escribe el monto en *Cantidad personalizada* y toca la palomita.
2. Si salen pantallas antes del pago (calificación, propina u otra), complétalas; la calificación se salta con *Saltar* y la propina con *Sin propina*.
3. Si sale *Cuenta de cobro*, elige la cuenta; luego, en *Método de pago*, toca *Tarjeta*.
4. Si sale *Seleccione su promocion*, toca *Pago directo*, o *Meses sin intereses* y elige los meses.
5. Cuando diga *Acerca o inserta la tarjeta*, el cliente acerca o inserta su tarjeta. Si pide *Ingrese su PIN*, el cliente lo teclea en la terminal.
6. Cuando el cobro pasa, se ve el recibo: toca *Nuevo Pago* para el siguiente cobro.

## Sin internet

Sin conexión, *Tarjeta* sale apagada y abajo dice «Necesita internet. Cobra en efectivo; la venta se guarda en la terminal.»: toca *Efectivo*. Si la conexión se cae justo al tocar *Tarjeta* y sale «Sin conexión a internet.» con «¿Cobrar en efectivo?», toca *Cobrar en Efectivo*.

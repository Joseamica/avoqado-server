---
title: Cobrar con tarjeta en la terminal Nexgo
description: Cobra una venta con tarjeta de crédito o débito en la terminal Nexgo, empezando en Pago rápido.
product: tpv
category: cobro
task: cobrar-con-tarjeta
deviceFamily: NEXGO
requiredPermissions:
  - payments:create
money: true
versionMin: 2.12.5
sourceRepo: avoqado-tpv
sourceRef: 031f14db2969606125a4a04c9f8f30bdd402a660
deviceTested: 2026-11-18
keywords:
  - pagar con tarjeta
  - cobrar con tarjeta
  - tarjeta de crédito
  - tarjeta de débito
  - angelpay
  - pago rápido
---

## Pasos

1. En el inicio, toca *Pago rápido*, escribe el monto en *Cantidad personalizada* y toca la palomita.
2. Si salen pantallas antes del pago (calificación, propina u otra), complétalas; la calificación se salta con *Saltar* y la propina con *Sin propina*.
3. En *Metodo de Pago*, si sale *Cuenta de cobro*, elige la cuenta; luego toca *Tarjeta*.
4. Mientras la terminal dice *No cierres esta pantalla*, el cliente presenta su tarjeta cuando se le pida.
5. Cuando el cobro pasa, se ve el recibo: toca *Nuevo Pago* para el siguiente cobro.

## Problemas frecuentes

- Si sale *Cobro sin confirmar*, no vuelvas a cobrar esa venta: puede que sí se haya cobrado.

## Sin internet

Puede salir «Sin conexión con el servidor.» con «Puedes cobrar en efectivo. Tarjeta y cripto vuelven cuando regrese la conexión.».

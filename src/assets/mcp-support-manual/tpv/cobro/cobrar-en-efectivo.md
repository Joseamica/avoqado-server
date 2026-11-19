---
title: Cobrar en efectivo en la terminal
description: Registra un cobro en efectivo en la terminal PAX o Nexgo, empezando en Pago rápido.
product: tpv
category: cobro
task: cobrar-en-efectivo
requiredPermissions:
  - payments:create
money: true
versionMin: 2.9.1
sourceRepo: avoqado-tpv
sourceRef: 031f14db2969606125a4a04c9f8f30bdd402a660
deviceTested: 2026-11-18
keywords:
  - pago en efectivo
  - cobrar en efectivo
  - efectivo
  - cash
  - pago rápido
---

## Pasos

1. En el inicio, toca *Pago rápido*, escribe el monto en *Cantidad personalizada* y toca la palomita.
2. Si salen pantallas antes del pago (calificación, propina u otra), complétalas; la calificación se salta con *Saltar* y la propina con *Sin propina*.
3. En *Método de pago*, toca *Efectivo*.
4. En *Confirmar pago en efectivo*, revisa el monto y toca *Confirmar*.
5. Cuando el cobro pasa, se ve el recibo: toca *Nuevo Pago* para el siguiente cobro.

## Problemas frecuentes

- Si tocaste *Efectivo* por error, en *Confirmar pago en efectivo* toca *Cancelar*.

## Sin internet

Si no hay conexión al registrar el cobro en efectivo y aun así se ve el recibo, el cobro quedó guardado en la terminal y se envía solo cuando vuelve la conexión.

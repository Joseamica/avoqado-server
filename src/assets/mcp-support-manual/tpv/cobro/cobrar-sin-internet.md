---
title: Cobrar sin internet en la terminal
description: Qué se puede cobrar sin conexión en la terminal: el efectivo se guarda en la terminal y se envía solo.
product: tpv
category: cobro
task: cobrar-sin-internet
requiredPermissions:
  - payments:create
money: true
versionMin: 2.11.1
sourceRepo: avoqado-tpv
sourceRef: 031f14db2969606125a4a04c9f8f30bdd402a660
deviceTested: 2026-11-18
keywords:
  - sin internet
  - sin conexión
  - sin red
  - offline
  - pagos pendientes
  - pagos fallidos
---

## Antes de empezar

Sin internet la terminal puede cobrar en efectivo. Arriba sale el aviso «Sin conexión a internet».

## Pasos

1. Escribe el monto como siempre con *Pago rápido* y avanza hasta *Método de pago*.
2. Toca *Efectivo*.
3. En *Confirmar pago en efectivo*, toca *Confirmar*.
4. Si se ve el recibo, el cobro quedó guardado en la terminal y se envía solo cuando vuelve la conexión.

## Problemas frecuentes

- Si *Pago rápido* sale apagado con *Sin conexión*, espera a que vuelva la conexión para cobrar.
- En la PAX, si sale «Sin conexión con el servidor.» con «No se pudo confirmar que la caja esté abierta. Intenta de nuevo cuando regrese la conexión.», el cobro no se hizo: cóbralo cuando regrese la conexión.
- En la PAX, sin red *Tarjeta* sale apagada con «Necesita internet. Cobra en efectivo; la venta se guarda en la terminal.». Si la conexión se cae justo al tocar *Tarjeta* y sale «Sin conexión a internet.» con «¿Cobrar en efectivo?», toca *Cobrar en Efectivo*.
- En la Nexgo puede salir «Sin conexión con el servidor.» con «Puedes cobrar en efectivo. Tarjeta y cripto vuelven cuando regrese la conexión.».

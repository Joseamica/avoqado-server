---
title: Agregar propina al cobrar en la terminal
description: Agrega la propina del cliente en la pantalla Propina antes de cobrar, con un porcentaje o un monto personalizado.
product: tpv
category: cobro
task: agregar-propina
requiredPermissions:
  - payments:create
money: true
versionMin: 2.7.1
sourceRepo: avoqado-tpv
sourceRef: 031f14db2969606125a4a04c9f8f30bdd402a660
deviceTested: 2026-11-18
keywords:
  - propina
  - dejar propina
  - porcentaje de propina
  - propina personalizada
  - sin propina
---

## Antes de empezar

La pantalla *Propina* sale al cobrar sólo si la terminal tiene encendida *Pantalla de Propina* en *Configuración de Pago*.

## Pasos

1. En *Propina*, toca uno de los porcentajes; debajo de cada uno se ve cuánto es en pesos.
2. Para otra cantidad, toca *Monto personalizado*.
3. En *Propina personalizada*, escribe la propina (con *$/%* cambias entre *Monto fijo* y *Porcentaje*) y toca la palomita.
4. Toca *Continuar*, o *Sin propina* si el cliente no deja.

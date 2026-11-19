---
title: Resolver una tarjeta que no pasa en la terminal PAX
description: Qué hacer en la terminal PAX cuando la tarjeta no pasa por contactless, pide chip o el pago sale rechazado.
product: tpv
category: cobro
task: tarjeta-no-pasa
deviceFamily: PAX
requiredPermissions:
  - payments:create
money: true
versionMin: 2.9.1
sourceRepo: avoqado-tpv
sourceRef: 031f14db2969606125a4a04c9f8f30bdd402a660
keywords:
  - falla el contactless
  - la tarjeta no pasa
  - no pasa la tarjeta
  - pide chip
  - pago rechazado
  - tarjeta rechazada
---

## Antes de empezar

Estos avisos salen en *Error en el Pago*, después de que el cliente acerca o inserta la tarjeta.

## Pasos

1. Si dice «Esta tarjeta pide chip», «Esta tarjeta requiere chip.» o «El lector no aceptó esta tarjeta por contactless», pide al cliente que inserte la tarjeta en el chip y toca *Reintentar*.
2. Si dice «La tarjeta se retiró demasiado rápido.» o «Se detectaron múltiples tarjetas.», toca *Reintentar*: que el cliente acerque una sola tarjeta y la deje sobre el lector hasta que termine.
3. Si sale «Pago rechazado», pide al cliente otra forma de pago.

## Problemas frecuentes

- Si aparece «El cliente debe confirmar el pago en su teléfono o reloj», que lo confirme en su teléfono o reloj, lo vuelva a acercar y toca *Reintentar*.
- Si aparece «Esta tarjeta no es compatible con contactless en esta terminal», pide que la inserten en el chip y toca *Reintentar*.
- Si aparece *Estamos confirmando el cobro*, no vuelvas a pasar la tarjeta: resuélvelo como explica la guía para resolver un cobro sin confirmar en la terminal PAX.

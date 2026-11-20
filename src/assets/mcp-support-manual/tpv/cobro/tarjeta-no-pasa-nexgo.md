---
title: Resolver una tarjeta que no pasa en la terminal Nexgo
description: Qué hacer en la terminal Nexgo cuando la tarjeta no pasa, no se cobró o el cobro sale rechazado.
product: tpv
category: cobro
task: tarjeta-no-pasa
deviceFamily: NEXGO
requiredPermissions:
  - payments:create
money: true
versionMin: 2.12.5
sourceRepo: avoqado-tpv
sourceRef: 031f14db2969606125a4a04c9f8f30bdd402a660
deviceTested: 2026-11-18
keywords:
  - la tarjeta no pasa
  - no pasa la tarjeta
  - falla el contactless
  - no acepta amex
  - pago rechazado
  - tarjeta rechazada
---

## Antes de empezar

Mientras dice *No cierres esta pantalla*, el cliente presenta su tarjeta. Si no pasa, la terminal enseña *No se cobró* o *Error en el pago* con el motivo.

## Pasos

1. Si el cobro llegó del punto de venta y sale *No se cobró*, vuelve a enviarlo desde el punto de venta.
2. Si empezaste el cobro en la terminal y dice «Retira la tarjeta del lector: no se cobró nada.», pide que retiren la tarjeta y toca *Intentar de nuevo*.
3. Si empezaste el cobro en la terminal y dice «Tiempo agotado: nadie acercó una tarjeta. No se cobró nada.», toca *Intentar de nuevo* y que el cliente presente su tarjeta cuando se le pida.
4. Si dice que la terminal no acepta tarjetas AMEX, pide otra tarjeta u otra forma de pago.
5. Si sale *Error en el pago* con «Pide al cliente que inserte la tarjeta en el chip.», que la inserte y toca *Reintentar*.
6. Si es otro motivo, pide otra tarjeta y toca *Reintentar* (o *Intentar de nuevo*, si el cobro empezó en la terminal), o toca *Regresar* para salir de ese cobro.

## Problemas frecuentes

- Si aparece el código E608 en el motivo, pide que inserten la tarjeta en el chip y vuelve a intentar el cobro.
- Si aparece *Cobro sin confirmar*, no vuelvas a cobrar esa venta: resuélvelo como explica la guía para resolver un cobro sin confirmar en la terminal Nexgo.

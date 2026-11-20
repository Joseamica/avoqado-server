---
title: Resolver que no salga la pantalla de propina en la terminal
description: Por qué la terminal no pide propina al cobrar y cómo volver a encender la pantalla de propina en Configuración.
product: tpv
category: cobro
task: no-sale-la-propina
requiredPermissions:
  - tpv-terminal:settings
money: true
versionMin: 2.7.1
sourceRepo: avoqado-tpv
sourceRef: 031f14db2969606125a4a04c9f8f30bdd402a660
deviceTested: 2026-11-18
keywords:
  - no sale la propina
  - la terminal no pide propina
  - no veo la propina
  - pantalla de propina
  - quitar la propina
---

## Antes de empezar

La terminal pide propina sólo con *Pantalla de Propina* encendida. *Configuración* sale apagado en el menú del engrane si tu usuario no tiene permiso para configurar la terminal.

## Pasos

1. En el inicio, toca el engrane de la barra de arriba y luego *Configuración*.
2. Abre *Configuración de Pago* y enciende *Pantalla de Propina*. Para dejar de pedir propina, apágala.
3. Desde el siguiente cobro que empieces en la terminal, sale *Propina* antes de elegir cómo paga el cliente.

## Problemas frecuentes

- Si el cobro lo manda el punto de venta y pide saltar la propina, la terminal no la pide.
- En la PAX, con *Pantalla de Propina* apagada, la propina que mande el punto de venta con el cobro no se suma al cobro: déjala encendida si el punto de venta pide la propina.

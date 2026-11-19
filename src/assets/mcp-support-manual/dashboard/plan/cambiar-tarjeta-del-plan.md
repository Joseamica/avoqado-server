---
title: Actualizar el método de pago del plan en el panel
description: En Configuración › Plan y facturación › Plan, Actualizar método de pago te lleva a la página de pagos de tu plan.
product: dashboard
category: plan
task: cambiar-tarjeta-del-plan
requiredPermissions:
  - billing:read
  - billing:subscriptions:read
  - billing:subscriptions:manage
money: true
sourceRepo: avoqado-web-dashboard
sourceRef: 1fe15c5cd61ffe8386b239114ea6c8eb6f5e006a
browserTested: 2026-11-12
keywords:
  - cambiar tarjeta
  - no pudimos cobrar tu plan
  - pago pendiente
  - actualizar método de pago
  - tarjeta vencida
---

## Antes de empezar

*Plan y facturación* sale en *Configuración* para un administrador o el dueño con permiso de facturación. *Actualizar método de pago* pide además permiso para gestionar suscripciones.

## Pasos

1. En *Configuración* › *Plan y facturación* › *Plan*, toca *Actualizar método de pago*: el panel te lleva a la página de pagos del plan.

## Problemas frecuentes

- Si junto a tu plan dice «No pudimos cobrar tu plan…» o «Tu pago está pendiente…», el cobro del plan falló: cambia la tarjeta.
- *Actualizar método de pago* no sale en Gratis, en un plan de cortesía, en un negocio fundador ni junto a *Cancelar renovación*.
- Agregar una tarjeta en la pestaña *Métodos de pago* o marcarla *Predeterminado* no siempre cambia la tarjeta del plan: el plan puede tener la suya. Para el plan, usa *Actualizar método de pago*.

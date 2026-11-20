---
title: Contratar el plan Pro o Premium desde Gratis en el panel
description: Desde Configuración › Plan y facturación › Plan, un negocio en Gratis sin funciones sueltas elige Pro o Premium y pasa a la página de pago.
product: dashboard
category: plan
task: contratar-un-plan
requiredPermissions:
  - billing:read
  - billing:subscriptions:read
  - billing:subscriptions:manage
money: true
sourceRepo: avoqado-web-dashboard
sourceRef: 1fe15c5cd61ffe8386b239114ea6c8eb6f5e006a
browserTested: 2026-11-12
keywords:
  - contratar pro
  - subir de plan
  - pagar el plan
  - cambiar de plan
---

## Antes de empezar

*Plan y facturación* sale en *Configuración* para un administrador o el dueño con permiso de facturación; contratar pide además permiso para gestionar suscripciones. Esta página es para un negocio en *Gratis* (ahí *Gratis* dice *Tu plan actual*) que no paga funciones sueltas.

## Pasos

1. En *Configuración* › *Plan y facturación* › *Plan*, en *Tu plan:* toca *Pro* o *Premium*. Cada uno dice su precio y cuántas funciones trae.
2. Elige *Mensual* o *Anual*.
3. Revisa *Tu cambio*, con su total, y toca *Revisar y pagar*.
4. Se abre la página de pago. Al terminar regresas al panel y sale «Pago recibido. Estamos activando tu plan…».

## Problemas frecuentes

- Si los botones salen apagados y dice «Pide a tu administrador permiso para gestionar suscripciones.», tu usuario no puede cambiar el plan.
- Si sale «Pago cancelado. Tu plan no cambió.», saliste de la página de pago sin pagar.
- Si al volver sale «Tu pago se registró…» y *Tu plan actual* no cambia, no vuelvas a pagar: pide que lo revise una persona del equipo de Avoqado.
- Si sale un aviso en rojo en *Tu cambio*, léelo: dice por qué no se pudo abrir el pago.
- Si ya pagas una función suelta que el plan incluye, al tocar *Revisar y pagar* desaparecen *Mensual* y *Anual* y *Tu cambio* cambia: el cambio sigue otro camino que esta página no explica.
- Si ya pagas un plan y quieres otro, *Tu cambio* puede mostrar *Cambio asistido* («Este cambio lo hacemos contigo para no cobrarte dos veces.»), que abre *Hablar con un asesor*.

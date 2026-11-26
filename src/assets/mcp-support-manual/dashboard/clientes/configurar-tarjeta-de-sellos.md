---
title: Configurar la tarjeta de sellos en el panel
description: Prende la tarjeta de sellos y define cuántos sellos llenan la cartilla y qué premio se gana, desde Clientes › Tarjeta digital en el panel.
product: dashboard
category: clientes
task: configurar-tarjeta-de-sellos
requiredPermissions:
  - loyalty:read
  - loyalty:update
featureCode: LOYALTY_PROGRAM
gateKind: FEATURE
sourceRepo: avoqado-web-dashboard
sourceRef: 5902b8c1f1583e3c9c9445ff0f1a78b6bd245517
keywords:
  - tarjeta de sellos
  - cartilla de sellos
  - programa de sellos
  - premio por visitas
---

## Antes de empezar

El programa de lealtad es para los negocios que lo tienen incluido en su plan. Necesitas permiso para ver y para editar la lealtad.

## Pasos

1. En *Clientes* › *Tarjeta digital*, en *Tu programa de sellos*, prende *Tarjeta de sellos activa*.
2. Escribe los *Sellos para llenar la cartilla* y, en *Cómo se lee el premio*, el nombre del premio.
3. En *Qué se gana*, elige *Un producto gratis*, *Un porcentaje* o *Un monto fijo*. Con porcentaje o monto, escribe cuánto.
4. Toca *Guardar programa*: sale «Programa de sellos guardado».

## Problemas frecuentes

- *Guardar cambios*, arriba de la pantalla, guarda el diseño de la tarjeta, no el programa: el programa se guarda con *Guardar programa*.
- La tarjeta de sellos no depende de los puntos: con *Tarjeta de sellos activa* prendida, las ventas con cliente suman su sello aunque en *Clientes* › *Programa de Lealtad* el *Programa de Puntos* esté en *Inactivo*.
- Si sale «No se pudo guardar», revisa el texto que trae debajo: ahí viene la razón cuando el sistema la da.

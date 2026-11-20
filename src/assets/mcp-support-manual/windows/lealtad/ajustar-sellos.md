---
title: Ajustar los sellos de un cliente en el POS Windows
description: Corrige cuántos sellos tiene la tarjeta de un cliente, con su motivo, desde Clientes en el POS Windows.
product: windows
category: lealtad
task: ajustar-sellos
requiredPermissions:
  - customers:read
  - loyalty:read
  - loyalty:adjust
featureCode: LOYALTY_PROGRAM
gateKind: FEATURE
versionMin: 2.25.32
sourceRepo: avoqado-android
sourceRef: c07a2bbebf453598963bf96f3208f66193dd5efb
keywords:
  - ajustar sellos
  - corregir sellos
  - tarjeta de sellos
  - agregar sellos a mano
  - lealtad
---

## Antes de empezar

La *Tarjeta de sellos* sale en la ficha del cliente cuando el negocio tiene su programa de sellos y su plan incluye la lealtad. *Ajustar sellos* sólo aparece con el permiso de ajustar la lealtad. Si *Clientes* no sale en *Más*, lo escondieron en *Personalizar menú* de esta computadora.

## Pasos

1. En *Más*, toca *Clientes* y toca al cliente.
2. En *Tarjeta de sellos*, toca *Ajustar sellos*.
3. En «¿Cuántos sellos tiene?», escribe el total que debe quedar, de 0 al máximo de la tarjeta.
4. Escribe el *Motivo* (al menos 5 letras) y toca *Guardar*: sale «¡Sellos ajustados!».

## Problemas frecuentes

- Si el total llega al máximo, la tarjeta se completa: el cliente gana su premio y empieza una tarjeta nueva en 0.
- Si sale «Los sellos de este cliente cambiaron mientras tanto…», revisa el total nuevo y vuelve a ajustar.

## Sin internet

- Si aparece «Sin conexión: los sellos se ajustan con internet» en la ficha, la tarjeta no se pudo leer: vuelve a abrir al cliente cuando regrese la red.
- Si aparece dentro de *Ajustar sellos*, no se pudo confirmar si el ajuste quedó. No repitas el ajuste: una persona de soporte tiene que revisarlo.

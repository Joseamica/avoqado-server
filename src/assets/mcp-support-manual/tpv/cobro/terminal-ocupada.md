---
title: Cuando el punto de venta dice que la terminal está ocupada, qué hacer en la terminal
description: Qué revisar en la terminal cuando el punto de venta no le puede mandar un cobro porque está ocupada con otro.
product: tpv
category: cobro
task: terminal-ocupada
requiredPermissions: []
money: true
versionMin: 2.11.1
sourceRepo: avoqado-tpv
sourceRef: 031f14db2969606125a4a04c9f8f30bdd402a660
keywords:
  - terminal ocupada
  - ocupada procesando otro cobro
  - no puedo mandar el cobro a la terminal
  - la terminal no recibe el cobro
  - cobro trabado
---

## Antes de empezar

El punto de venta dice que la terminal está ocupada mientras tiene un cobro en curso. Un cobro que se queda sin respuesta se cierra solo como no cobrado, suele tardar cerca de un minuto, y la terminal queda libre. Mientras ese cobro siga en curso y sea de la misma venta, no se la cobres al cliente de otra forma, ni aquí ni en otra terminal.

## Pasos

1. Mira la pantalla de la terminal: si está cobrando (dice *Acerca o inserta la tarjeta*, *Ingrese su PIN* o *No cierres esta pantalla*), deja que el cliente termine. En la PAX, si sale *Cancelar*, también puedes tocarlo.
2. Si dice *Estamos confirmando el cobro* o *Cobro sin confirmar*, no lo vuelvas a cobrar: resuélvelo como explica la guía para resolver un cobro sin confirmar.
3. Si arriba sale «Quedó un cobro de … sin confirmar» de un cobro que mandó el punto de venta, espera: se cierra solo y el aviso se quita. Luego vuelve a mandarlo desde el punto de venta.
4. Si lo que ocupaba la terminal era otra venta y ya terminó, vuelve a mandar este cobro desde el punto de venta.

## Problemas frecuentes

- Si aparece «El POS pidió cancelar, pero el cobro ya empezó: termina o cancela en la terminal.», termina el cobro o cancélalo en la terminal.
- Si aparece «El POS canceló este cobro. No se cobró.» o «El cobro se cerró sin cobrar. Vuelve a cobrar desde el punto de venta.», manda el cobro otra vez desde el punto de venta. El primero también sale si nadie tocó la terminal en unos minutos.
- Si aparece «Este cobro ya se cerró. Pídele al POS que lo vuelva a enviar.», toca *Cancelar* y vuelve a mandarlo desde el punto de venta. Pasa cuando la terminal todavía muestra un cobro que ya se cerró, por ejemplo después de quedarse sin internet.
- Si aparece «Hay otro cobro en curso en esta terminal», espera a que termine; si no ves ningún cobro en la pantalla, reinicia la app.
- Si aparece «Este cobro del POS NO se inició», espera a que termine el otro cobro; si es de otra venta, también puedes cobrar con otra terminal.
- Si aparece *No se cobró* en el aviso de arriba, úsalo sólo si estás seguro de que no se cobró, como explica la guía para declarar que un cobro no se cobró desde el aviso.

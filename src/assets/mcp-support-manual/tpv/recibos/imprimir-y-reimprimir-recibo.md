---
title: Imprimir y reimprimir el recibo en la terminal
description: Imprime el recibo al terminar un cobro y reimprime después uno o varios pagos desde el historial de pagos de la terminal.
product: tpv
category: recibos
task: imprimir-recibo
requiredPermissions:
  - payments:read
versionMin: 2.12.2
sourceRepo: avoqado-tpv
sourceRef: 031f14db2969606125a4a04c9f8f30bdd402a660
keywords:
  - imprimir ticket
  - reimprimir ticket
  - imprimir recibo
  - copia del ticket
  - ticket de venta
---

## Antes de empezar

En la Nexgo sólo imprime el modelo N86. En la PAX, *Imprimir* sale en el recibo si la terminal tiene impresora y encendida *Opciones de Recibo* en *Configuración de Pago*.

## Pasos

1. Al terminar un cobro, en la pantalla del recibo toca *Imprimir*.
2. Para reimprimir después, en el inicio toca *Pagos*.
3. En *Historial de Pagos*, toca el ícono de la impresora de arriba y luego los pagos que quieres (máximo 20).
4. Toca el botón de la impresora de abajo, que muestra cuántos pagos elegiste.
5. En *Imprimir pagos*, elige *Individual* (un recibo por pago) o *Resumen* (todos en un recibo) y toca *Imprimir*.

## Problemas frecuentes

- En la PAX, si al terminar un cobro sale *No se pudo imprimir*, el cobro sí quedó aprobado: toca *Volver al recibo* e imprime otra vez.
- En la Nexgo, «Esta terminal no tiene impresora»: ese modelo no imprime.

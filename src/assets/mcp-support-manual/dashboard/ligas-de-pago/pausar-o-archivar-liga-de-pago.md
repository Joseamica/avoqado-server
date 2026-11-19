---
title: Pausar, reanudar o archivar una liga de pago en el panel
description: Pausa, reanuda o archiva una liga de pago desde Ventas › Ligas de Pago en el panel.
product: dashboard
category: ligas-de-pago
task: pausar-o-archivar-liga-de-pago
requiredPermissions:
  - payment-link:read
  - payment-link:create
  - payment-link:update
money: true
sourceRepo: avoqado-web-dashboard
sourceRef: 1fe15c5cd61ffe8386b239114ea6c8eb6f5e006a
browserTested: 2026-11-12
keywords:
  - pausar liga
  - archivar liga
  - desactivar liga de pago
  - reanudar liga
  - borrar liga de pago
---

## Antes de empezar

Necesitas permiso para ver, crear y editar ligas de pago. Una liga pausada o archivada ya no deja empezar un pago nuevo, pero un pago que el cliente ya había empezado todavía puede terminar.

## Pasos

1. En *Ventas* › *Ligas de Pago* › *Ligas de pago*, busca la liga y toca el botón ⋯ de su renglón.
2. Toca *Pausar* para que no se puedan empezar pagos nuevos por ahora. Si ya está pausada, toca *Reanudar* para volver a activarla.
3. Para quitarla para siempre, toca *Archivar* y confirma con *Archivar*. Archivar no se puede deshacer.

## Problemas frecuentes

- *Pausar* sólo sale en una liga activa y *Reanudar* sólo en una pausada.
- Al terminar sale «Liga de pago pausada», «Liga de pago reanudada» o «Liga de pago archivada». Si sale «Error», debajo dice por qué.

---
title: Editar los totales o eliminar un turno de caja en el panel
description: Corrige el subtotal y la propina que guarda un turno, o elimina un turno cerrado y con su caja cerrada, desde Ventas › Turnos de caja.
product: dashboard
category: turnos
task: editar-o-eliminar-turno
requiredPermissions:
  - shifts:read
money: true
sourceRepo: avoqado-web-dashboard
sourceRef: 1fe15c5cd61ffe8386b239114ea6c8eb6f5e006a
browserTested: 2026-11-12
keywords:
  - editar turno
  - borrar turno
  - eliminar turno
  - corregir turno
  - turno mal cerrado
---

## Antes de empezar

Editar pide permiso para editar turnos; eliminar, permiso para borrar turnos (por omisión, administrador o dueño). Editar cambia el subtotal y la propina que guarda el turno, no sus pagos. Eliminar no se deshace.

## Pasos

1. En *Ventas* › *Turnos de caja*, busca el turno. En su fila, el lápiz es para editar y el bote de basura para eliminar.
2. Para editar, cambia *Subtotal* y *Propina Total*, revisa el *Total* y toca *Guardar*. Si sale «Actualizado exitosamente», ya quedó.
3. Dentro del turno también puedes tocar *Editar*: los mismos dos campos salen en *Resumen Financiero* y se guardan con *Guardar*.
4. Para eliminar, en «Confirmar Eliminación» toca *Eliminar*. Si sale «Eliminado exitosamente», el turno ya no está.

## Problemas frecuentes

- Un turno abierto, que se está cerrando o con la caja abierta no se puede eliminar. Si sale «Error al eliminar», no lo vuelvas a eliminar: pudo quedar eliminado en un primer intento. Pide que lo revise una persona del equipo de Avoqado.
- Al eliminar un turno, sus ventas y pagos no se borran: se quedan sin turno.
- Para corregir sólo el efectivo contado de un corte, usa *Corregir conteo* dentro del turno, no *Editar*.

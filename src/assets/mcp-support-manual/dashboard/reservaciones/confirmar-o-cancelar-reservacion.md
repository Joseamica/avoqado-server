---
title: Confirmar, registrar la llegada o cancelar una reservación en el panel
description: Cambia el estado de una reservación en el panel: confirmarla, hacer check-in, completarla, marcar No Show o cancelarla.
product: dashboard
category: reservaciones
task: confirmar-o-cancelar-reservacion
requiredPermissions:
  - reservations:read
featureCode: RESERVATIONS
gateKind: FEATURE
money: true
sourceRepo: avoqado-web-dashboard
sourceRef: 1fe15c5cd61ffe8386b239114ea6c8eb6f5e006a
browserTested: 2026-11-12
keywords:
  - cancelar reservación
  - confirmar cita
  - check-in de la cita
  - no se presentó
  - no show
---

## Antes de empezar

Reservaciones es para los negocios que tienen incluida esa función. Para confirmar, hacer check-in, completar o marcar No Show necesitas permiso para editar reservaciones; para cancelar, permiso para cancelarlas. Cada botón sale según el estado de la reservación.

## Pasos

1. En *Reservaciones* › *Resumen*, toca la reservación para abrirla.
2. Si está pendiente, toca *Confirmar*: sale «Reservación confirmada».
3. Cuando el cliente llegue, toca *Check-in*. Al terminar, toca *Completar*.
4. Si una reservación confirmada no llegó, toca *Marcar No Show* y confírmalo con *Marcar No Show*.
5. Para cancelarla, toca *Cancelar* y luego *Confirmar Cancelación*: sale «Reservación cancelada».

## Problemas frecuentes

- *Cancelar* sale mientras la reservación está pendiente o confirmada.
- Si la reservación tenía depósito o usó créditos de un paquete, al cancelarla se aplican las reglas de *Cancelación* de tu negocio. No le prometas una devolución al cliente: si pregunta por ella, pide que lo revise una persona del equipo de Avoqado.
- Si al cancelar sale un error, no lo repitas: la reservación pudo quedar cancelada, con su depósito o sus créditos en proceso. Pide que lo revise una persona del equipo de Avoqado.

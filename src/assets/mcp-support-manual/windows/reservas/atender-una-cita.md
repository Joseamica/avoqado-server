---
title: Confirmar, registrar la llegada o completar una cita en el POS Windows
description: Abre una cita del Calendario y márcala como confirmada, llegada, completada o no presentada en el POS Windows.
product: windows
category: reservas
task: atender-una-cita
requiredPermissions:
  - reservations:update
featureCode: RESERVATIONS
gateKind: FEATURE
sourceRepo: avoqado-android
sourceRef: c07a2bbebf453598963bf96f3208f66193dd5efb
keywords:
  - confirmar cita
  - check-in
  - registrar llegada
  - completar cita
  - no se presentó
  - no show
---

## Antes de empezar

*Calendario* sólo sale cuando en esta computadora se activaron las reservas (en *Más*, *Reservaciones* y luego *Activar reservas*) y el plan las incluye.

## Pasos

1. En *Calendario*, toca la cita.
2. Si el cliente confirmó que viene, toca *Confirmar*.
3. Cuando llegue, toca *Check-in*.
4. Al terminar el servicio, toca *Completar*.
5. Si no llegó, toca *No se presentó*.

## Problemas frecuentes

- Cada botón se prende sólo en su momento: *Confirmar* en una cita pendiente, *Check-in* y *No se presentó* antes de la llegada, y *Completar* después del *Check-in*.
- Sin el permiso de editar reservaciones, los botones salen apagados.

## Sin internet

- Si aparece «Sin conexión: … al volver el internet.», la acción quedó guardada en la computadora, pero no siempre se manda sola cuando vuelve el internet: no la repitas. Cuando regrese, revisa la cita en *Calendario*; si sigue igual, una persona de soporte tiene que revisarlo.

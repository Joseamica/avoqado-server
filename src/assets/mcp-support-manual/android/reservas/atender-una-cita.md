---
title: Confirmar, registrar la llegada o completar una cita en el POS Android
description: Abre una cita del Calendario y márcala como confirmada, llegada, completada o no presentada en el POS Android.
product: android
category: reservas
task: atender-una-cita
requiredPermissions:
  - reservations:read
  - reservations:update
featureCode: RESERVATIONS
gateKind: FEATURE
sourceRepo: avoqado-android
sourceRef: 843c15ae06bf68dd0d9c755525a9971e701052b7
keywords:
  - confirmar cita
  - check-in
  - registrar llegada
  - completar cita
  - no se presentó
  - no show
---

## Antes de empezar

*Calendario* sólo sale cuando en este aparato se activaron las reservas (en *Más*, *Reservaciones* y luego *Activar reservas*) y el plan las incluye.

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

- Si aparece «Sin conexión: … al volver el internet.», la acción quedó guardada en el aparato: la app la manda la próxima vez que el aparato se vuelva a conectar a la red o que se reinicie la app; si sólo se cayó el internet y el aparato siguió conectado a su red, puede quedarse esperando. Cuando vuelva el internet, revisa la cita en *Calendario*.

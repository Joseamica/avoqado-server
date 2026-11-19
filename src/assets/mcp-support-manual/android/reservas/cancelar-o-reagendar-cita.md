---
title: Cancelar o reagendar una cita en el POS Android
description: Cambia la fecha y hora de una cita o cancélala desde el Calendario del POS Android.
product: android
category: reservas
task: cancelar-o-reagendar-cita
requiredPermissions:
  - reservations:read
featureCode: RESERVATIONS
gateKind: FEATURE
sourceRepo: avoqado-android
sourceRef: 843c15ae06bf68dd0d9c755525a9971e701052b7
keywords:
  - cancelar cita
  - reagendar cita
  - cambiar la hora de la cita
  - reprogramar
  - mover cita
---

## Antes de empezar

*Calendario* sólo sale cuando en este aparato se activaron las reservas (en *Más*, *Reservaciones* y luego *Activar reservas*) y el plan las incluye.

## Pasos

1. En *Calendario*, toca la cita.
2. Para cambiarla (necesitas el permiso de editar reservaciones), toca *Reagendar*, elige la *Fecha*, el *Inicio* y el *Fin*, y toca *Continuar*.
3. Elige el *Tipo de notificación* para avisarle al cliente (puedes escribir un *Mensaje de notificación*) y toca *Reprogramar cita*.
4. Para cancelarla (necesitas el permiso de cancelar reservaciones), toca *Cancelar*, escribe el *Motivo (opcional)* y toca *Confirmar cancelación*.

## Problemas frecuentes

- *Reagendar* sólo se prende antes de la llegada del cliente; *Cancelar*, hasta antes de completarla.
- Una cita cancelada no se puede volver a abrir.
- Si sale «Sin número de teléfono», el cliente no recibirá aviso por WhatsApp ni SMS.

## Sin internet

- Si aparece «Sin conexión: se reagendará al volver el internet.» o «Sin conexión: se cancelará al volver el internet.», el cambio quedó guardado en el aparato: la app la manda la próxima vez que el aparato se vuelva a conectar a la red o que se reinicie la app; si sólo se cayó el internet y el aparato siguió conectado a su red, puede quedarse esperando. Cuando vuelva el internet, revisa la cita en *Calendario*.

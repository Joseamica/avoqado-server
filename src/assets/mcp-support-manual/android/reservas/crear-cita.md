---
title: Crear una cita en el POS Android
description: Agenda una cita con su cliente, servicio, fecha y hora desde el Calendario del POS Android.
product: android
category: reservas
task: crear-cita
requiredPermissions:
  - reservations:read
  - reservations:create
  - customers:read
  - menu:read
featureCode: RESERVATIONS
gateKind: FEATURE
sourceRepo: avoqado-android
sourceRef: 843c15ae06bf68dd0d9c755525a9971e701052b7
keywords:
  - crear cita
  - agendar cita
  - nueva reserva
  - reservar
  - apartar horario
---

## Antes de empezar

*Calendario* sólo sale cuando en este aparato se activaron las reservas (en *Más*, *Reservaciones* y luego *Activar reservas*) y el plan las incluye.

## Pasos

1. En *Calendario*, toca el botón *Crear* (el +) o un horario libre, y luego *Crear cita*.
2. Toca *Seleccionar cliente* y elige al cliente.
3. Toca *Seleccionar servicio* y elige el servicio.
4. En *Fecha y hora*, elige el día y un horario disponible; si hace falta, completa los *Detalles*.
5. Toca *Crear*: sale «¡Reserva creada!».

## Problemas frecuentes

- Si *Crear* no se prende, arriba dice qué falta, por ejemplo «Elige el cliente y el servicio para crear la cita».
- Si sale «Horario lleno», *Sobre-agendar* la agenda de todos modos.
- Si aparece «Este servicio no tiene profesionistas configurados…», asígnalos desde el panel antes de crear la cita.

## Sin internet

- Si aparece «Guardado sin conexión», la cita quedó guardada en el aparato, pero todavía no está creada: la app la manda la próxima vez que el aparato se vuelva a conectar a la red o que se reinicie la app; si sólo se cayó el internet y el aparato siguió conectado a su red, puede quedarse esperando. El servidor todavía puede rechazarla (por ejemplo, si ese horario ya se ocupó): cuando vuelva el internet, revisa en *Calendario* que aparezca.

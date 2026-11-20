---
title: Crear una cita en el POS Windows
description: Agenda una cita con su cliente, servicio, fecha y hora desde el Calendario del POS Windows.
product: windows
category: reservas
task: crear-cita
requiredPermissions:
  - reservations:create
  - customers:read
  - menu:read
featureCode: RESERVATIONS
gateKind: FEATURE
sourceRepo: avoqado-android
sourceRef: c07a2bbebf453598963bf96f3208f66193dd5efb
keywords:
  - crear cita
  - agendar cita
  - nueva reserva
  - reservar
  - apartar horario
---

## Antes de empezar

*Calendario* sólo sale cuando en esta computadora se activaron las reservas (en *Más*, *Reservaciones* y luego *Activar reservas*) y el plan las incluye.

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

- Si aparece «Guardado sin conexión», la cita quedó guardada en la computadora, pero no siempre se manda sola cuando vuelve el internet: no la vuelvas a crear. Cuando regrese, revisa en *Calendario* que aparezca; si no aparece, una persona de soporte tiene que revisarlo.

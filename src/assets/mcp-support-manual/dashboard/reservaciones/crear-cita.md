---
title: Crear una cita en el panel
description: Agenda una cita para un cliente desde Reservaciones en el panel, con su servicio, fecha y hora.
product: dashboard
category: reservaciones
task: crear-cita
requiredPermissions:
  - reservations:read
  - reservations:create
featureCode: RESERVATIONS
gateKind: FEATURE
sourceRepo: avoqado-web-dashboard
sourceRef: 1fe15c5cd61ffe8386b239114ea6c8eb6f5e006a
keywords:
  - agendar cita
  - nueva reservación
  - apartar una cita
  - reservar a un cliente
---

## Antes de empezar

Reservaciones es para los negocios que tienen incluida esa función. Necesitas permiso para ver y para crear reservaciones. Para elegir el servicio necesitas permiso para ver el menú; para buscar al cliente, permiso para ver clientes, y para darlo de alta ahí mismo, permiso para crear clientes.

## Pasos

1. En *Reservaciones* › *Resumen*, toca *Crear* y elige *Cita*.
2. En *Cliente*, busca al cliente y elígelo. Si no existe, elige *+ Crear cliente* y, al terminar, búscalo y elígelo. Si no lo vas a registrar, escribe su *Nombre del invitado*.
3. En *Servicios y artículos*, busca el servicio y elígelo. Si el servicio tiene duración, la *Duración* se llena sola.
4. En *Fecha y hora*, elige el día y la hora. Si salen *Horarios disponibles*, puedes tocar uno; los que dicen «Lleno» ya no tienen lugar.
5. Toca *Guardar*: sale «Reservación creada exitosamente».

## Problemas frecuentes

- Si sale «El nombre es requerido», elige al cliente en *Cliente* o escribe el *Nombre del invitado*. Ese aviso sale antes de mandar la cita.
- Si sale «Este servicio no tiene profesionistas configurados…», asígnale personal al servicio en la configuración de reservaciones. Ese aviso también sale antes de mandar la cita.
- Si después de tocar *Guardar* sale cualquier otro aviso o error en lugar de «Reservación creada exitosamente», por ejemplo «¿Sobre-agendar este horario?» o «Cambió la duración del servicio», no la guardes otra vez ni confirmes el sobre-agendado: la cita pudo quedar creada en un primer intento. Pide que lo revise una persona del equipo de Avoqado.
- Si al crear el cliente sale un error, no lo crees otra vez: pudo quedar creado. Pide que lo revise una persona del equipo de Avoqado.

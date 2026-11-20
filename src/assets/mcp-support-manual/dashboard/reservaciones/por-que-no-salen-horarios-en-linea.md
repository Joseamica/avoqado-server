---
title: Revisar por qué no salen horarios para reservar en línea en el panel
description: Qué revisar en el panel cuando tus clientes no ven horarios para reservar en línea: la reserva en línea, el horario del día, el aviso mínimo y el personal.
product: dashboard
category: reservaciones
task: por-que-no-salen-horarios-en-linea
requiredPermissions:
  - reservations:read
featureCode: RESERVATIONS
gateKind: FEATURE
sourceRepo: avoqado-web-dashboard
sourceRef: 1fe15c5cd61ffe8386b239114ea6c8eb6f5e006a
keywords:
  - no salen horarios
  - no pueden agendar en línea
  - reservar en línea
  - horario de reservaciones
  - disponibilidad
---

## Antes de empezar

Reservaciones es para los negocios que tienen incluida esa función. *Reservaciones* › *Ajustes* › *General* lo abre un administrador o el dueño. Para guardar cambios ahí o en *Editar disponibilidad* necesitas permiso para editar reservaciones.

## Pasos

1. En *Reservaciones* › *Ajustes* › *General*, revisa que *Habilitar reservaciones online* esté prendido. Si cambias algo, toca *Guardar Cambios*.
2. En *Reservaciones* › *Calendario*, toca el botón del reloj (*Editar disponibilidad*): el día tiene que estar marcado y con horario. Toca *Listo* para guardarlo.
3. En *Ajustes* › *General*, el *Aviso mínimo* quita los horarios de cita que empiezan antes de ese tiempo a partir de ahora.
4. Un horario de cita sale sólo si el servicio completo cabe antes de que cierre ese horario del día.
5. Con *Personal disponible* en *Capacidad para citas*, o con *Permitir que el cliente elija profesionista* prendido, un horario de cita sale sólo si alguien del personal está libre para ese servicio.
6. Para clases, los horarios en línea son los de las clases que ya están creadas y salen en el *Calendario*.

## Problemas frecuentes

- El personal de cada servicio y su horario se revisan en *Profesionistas por servicio* y *Horario del profesionista*, en *Reservaciones* › *Ajustes* › *General*. Para verlos se necesita permiso para ver el menú y el equipo.
- En *Editar disponibilidad*, *Cambio único* y *Calendario recurrente* guardan el mismo horario por día de la semana: un cambio en *Cambio único* también queda para las semanas que siguen.

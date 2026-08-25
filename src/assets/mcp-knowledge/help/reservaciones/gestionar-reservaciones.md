---
title: Gestionar reservaciones
description: Revisa reservas, calendario, lista de espera y ajustes de reservaciones.
product: dashboard
category: reservaciones
featureCode: AVOQADO_RESERVATIONS
dashboardRoutes:
  - reservations
  - reservations/calendar
  - reservations/waitlist
  - reservations/settings
  - reservations/online-booking
roles:
  - OWNER
  - ADMIN
  - MANAGER
  - HOST
lastVerified: 2026-05-20
sourceRepo: avoqado-web-dashboard
popular: true
relatedArticles:
  - configurar-reservaciones-avanzadas
  - comprar-addons-suscripciones
---

## Antes de empezar

Reservaciones combina operacion diaria y configuracion. Antes de mover una reserva, confirma fecha, hora, cliente, numero de personas y canal de origen. Si vas a cambiar ajustes, revisa primero el impacto en disponibilidad futura y en enlaces de reserva en linea.

Los roles HOST, MANAGER, ADMIN y OWNER pueden tener responsabilidades distintas. Define internamente quien puede crear, modificar, cancelar o confirmar reservaciones.

## Pasos

1. Abre **Reservaciones**.
2. Usa la lista para revisar reservas del dia o cambia a **Calendario** para ver disponibilidad.
3. Abre una reservacion para validar cliente, hora, cantidad de personas y estado.
4. Usa **Lista de espera** para dar seguimiento a clientes sin mesa confirmada.
5. Revisa **Canales** u **Online booking** si quieres validar enlaces de reserva.
6. Entra a **Ajustes** solo si necesitas cambiar reglas operativas.

## Problemas frecuentes

Si una reservacion no aparece, revisa fecha, sucursal, estado y canal. Si un cliente no puede reservar en linea, valida disponibilidad, horarios y enlace publicado. Si hay sobrecupo, revisa reglas de capacidad. Si no puedes cambiar ajustes, tu rol probablemente no tiene permisos administrativos.

## Operacion diaria recomendada

Al inicio del dia, revisa calendario, lista de reservas y lista de espera. Durante servicio, confirma cambios de estado para evitar duplicados o mesas apartadas sin seguimiento. Al cierre, revisa cancelaciones y no-shows para detectar patrones de horario o canal.

Si modificas ajustes, valida inmediatamente una reserva de prueba o revisa la disponibilidad publica. Cambios en horarios, capacidad o canales online pueden afectar reservas futuras sin que el equipo lo note de inmediato.

## Cuando pedir ayuda

Pide soporte si reservas online no muestran disponibilidad correcta, si una reserva desaparece sin cambio de estado o si el calendario muestra sobrecupo despues de revisar ajustes. Incluye fecha, hora, numero de personas, sucursal y canal de origen.

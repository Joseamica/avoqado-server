---
title: Usar la lista de espera en el POS Android
description: Anota a un cliente en la lista de espera y, cuando haya lugar, conviértelo en cita o quítalo, en el POS Android.
product: android
category: reservas
task: lista-de-espera
requiredPermissions:
  - reservations:read
featureCode: RESERVATIONS
gateKind: FEATURE
sourceRepo: avoqado-android
sourceRef: 843c15ae06bf68dd0d9c755525a9971e701052b7
keywords:
  - lista de espera
  - anotar cliente en espera
  - promover de la lista
  - quitar de la lista de espera
  - waitlist
---

## Antes de empezar

*Lista de espera* sale en *Más* cuando en este aparato se activaron las reservas y el plan las incluye. La lista necesita conexión. Agregar y promover piden el permiso de crear reservaciones (promover, también el de editarlas), y quitar, el de cancelarlas. Elegir un cliente guardado pide el de ver clientes, y elegir el servicio al promover, el de ver el menú.

## Pasos

1. En *Más*, toca *Lista de espera*.
2. Toca el + de arriba.
3. Para elegir un cliente guardado, apaga *Invitado*, busca en *Buscar cliente* y selecciónalo. Para alguien sin registro, deja *Invitado* activado y escribe su *Nombre*.
4. Ajusta *Personas* y la *Fecha y hora*, y toca *Agregar*.
5. Cuando haya lugar, toca *Promover*: se abre la cita con su cliente, personas y horario; elige el servicio en *Seleccionar servicio*, un horario disponible en *Fecha y hora* y toca *Crear*.
6. Para sacarlo de la lista, toca *Quitar*.

## Problemas frecuentes

- Si *Agregar* no se prende, abajo dice qué falta: «Busca y elige un cliente para agregarlo» o «Escribe el nombre del cliente para agregarlo».
- *Promover* y *Quitar* sólo salen para quien sigue esperando.
- Si al tocar *Agregar* la ventana no se cierra, el alta no se pudo confirmar. No lo vuelvas a agregar: una persona de soporte tiene que confirmar si quedó registrado.

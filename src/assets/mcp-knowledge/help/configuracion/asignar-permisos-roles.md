---
title: Asignar permisos y roles
description: Configura que puede ver y hacer cada rol dentro del Dashboard.
product: dashboard
category: configuracion
featureCode: AVOQADO_SETTINGS
dashboardRoutes:
  - settings/role-permissions
  - team
roles:
  - OWNER
  - ADMIN
lastVerified: 2026-05-21
sourceRepo: avoqado-web-dashboard
popular: true
relatedArticles:
  - gestionar-miembros
  - configurar-datos-local
---

## Antes de empezar

Permisos y roles controla el alcance operativo de cada usuario. Antes de cambiar una regla, define que tarea necesita hacer el equipo y que informacion no deberia ver. Evita usar permisos amplios para resolver un bloqueo temporal; es mejor ajustar el permiso exacto o revisar la asignacion del miembro.

Los cambios afectan al local activo. Si una persona trabaja en varias sucursales, puede tener rol y permisos diferentes por cada una. Confirma siempre que estas en el venue correcto antes de guardar.

## Pasos

1. Abre **Configuracion > Permisos y roles**.
2. Revisa el rol que quieres modificar.
3. Identifica el modulo o permiso especifico que necesitas activar o desactivar.
4. Guarda cambios y pide al usuario cerrar y volver a iniciar sesion si no ve el cambio.
5. Abre **Equipo > Miembros** para confirmar que la persona tenga el rol correcto.
6. Haz una prueba con el usuario o con una cuenta equivalente antes de asumir que el permiso quedo aplicado.

## Problemas frecuentes

Si el usuario no ve una seccion, revisa primero su rol y despues el permiso del modulo. Si ve informacion de mas, reduce permisos y valida si tiene acceso a otras sucursales. Si el cambio no aparece de inmediato, pide cerrar sesion, borrar filtros o recargar el Dashboard. Si la pantalla no aparece, tu usuario no tiene permiso administrativo suficiente.

## Buenas practicas de seguridad

Asigna el menor permiso posible. OWNER y ADMIN deben reservarse para responsables de operacion, pagos, configuracion o equipo. MANAGER puede servir para supervision diaria; CASHIER, WAITER, HOST y VIEWER deben usarse para tareas acotadas. Revisa permisos despues de cambios de puesto, bajas de personal o apertura de nuevas sucursales.

Documenta cambios sensibles: quien pidio el ajuste, que permiso se cambio y por que. Esto ayuda a explicar accesos en auditorias internas o cuando alguien reporta que ya no puede entrar a una seccion.

## Cuando pedir ayuda

Contacta soporte si un permiso guardado no se respeta, si un rol aparece sin opciones esperadas o si un usuario conserva acceso despues de retirarlo. Incluye correo del usuario, sucursal, rol esperado, permiso afectado y captura de la configuracion.

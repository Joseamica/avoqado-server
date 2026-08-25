---
title: Gestionar miembros del equipo
description: Agrega, revisa y administra usuarios asignados al local.
product: dashboard
category: equipo
featureCode: AVOQADO_TEAM
dashboardRoutes:
  - team
roles:
  - OWNER
  - ADMIN
lastVerified: 2026-05-20
sourceRepo: avoqado-web-dashboard
popular: true
---

## Antes de empezar

Gestionar miembros controla quien puede entrar al Dashboard y que puede hacer dentro del local. Antes de agregar o modificar a alguien, define que rol necesita: administracion, operacion, caja, servicio, host o solo lectura. Un rol con permisos de mas puede exponer informacion sensible; un rol limitado puede bloquear tareas diarias.

Si tu negocio tiene varias sucursales, confirma si el usuario debe entrar a una sola ubicacion o a varias.

## Pasos

1. Abre **Equipo > Miembros**.
2. Busca al usuario por nombre o correo.
3. Abre el perfil para revisar rol, sucursales asignadas y estado.
4. Si agregas un usuario, captura correo correcto y rol inicial.
5. Si cambias permisos, explica al usuario que puede necesitar cerrar y volver a iniciar sesion.
6. Verifica despues que el usuario vea las secciones necesarias.

## Problemas frecuentes

Si un usuario no puede entrar, revisa que el correo sea correcto y que el usuario este activo. Si entra pero no ve una seccion, revisa rol y permisos. Si no aparece una sucursal, falta asignacion al local. Si alguien ve informacion que no deberia, baja permisos de inmediato y revisa accesos en otras sucursales.

## Recomendaciones de permisos

Asigna el menor permiso que permita hacer el trabajo. OWNER y ADMIN deben reservarse para personas que administran configuracion, pagos, equipo o informacion sensible. MANAGER suele servir para supervision operativa. CASHIER, WAITER, HOST y VIEWER deben usarse cuando el usuario solo necesita tareas especificas.

Cuando cambies un rol, pide al usuario cerrar y volver a iniciar sesion si no ve el cambio. Si el usuario trabaja en varias sucursales, valida cada asignacion por separado porque puede tener rol distinto por local.

## Cuando pedir ayuda

Escala si una invitacion no llega, si el usuario acepta invitacion pero no aparece activo o si los permisos visibles no coinciden con el rol asignado. Comparte correo, rol esperado, sucursal y captura del perfil del miembro.

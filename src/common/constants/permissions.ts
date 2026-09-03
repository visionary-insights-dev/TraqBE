import { Role } from '@prisma/client';

/**
 * Maps granular permission codes (as referenced in the API spec) to the roles
 * that are allowed to perform them.
 *
 * The JWT carries a single role, and the existing PermissionsGuard matches
 * `@RequirePermission('ROLE')` against the user's role(s). `permissionRoles()`
 * resolves a granular code to its role codes so it can be passed directly to
 * `@RequirePermission(...)`. True DB-backed RBAC is deferred until the
 * Permissions/Roles modules and their tables are built.
 */
export const PERMISSION_ROLES: Record<string, Role[]> = {
  // Organization settings
  'organization.settings.read': [Role.SUPER_ADMIN, Role.MENTOR, Role.SCHOLAR],
  'organization.settings.update': [Role.SUPER_ADMIN],

  // User management — SUPER_ADMIN only per spec
  'users.read': [Role.SUPER_ADMIN],
  'users.invite': [Role.SUPER_ADMIN],
  'users.update': [Role.SUPER_ADMIN],
  'users.archive': [Role.SUPER_ADMIN],

  // Any authenticated user (self-service)
  'users.me.read': [Role.SUPER_ADMIN, Role.MENTOR, Role.SCHOLAR],
  'users.me.update': [Role.SUPER_ADMIN, Role.MENTOR, Role.SCHOLAR],
};

/**
 * Resolve a granular permission code to the role codes that grant it,
 * for use with `@RequirePermission(...)`.
 */
export function permissionRoles(code: string): Role[] {
  return PERMISSION_ROLES[code] ?? [];
}

import { Prisma, type ConnectedLibrary } from "@prisma/client";

/** Current data consumers share this rule; historical listings and physical
 * recovery/Undo deliberately have separate policies. */
export const currentReadableRootWhere = {
  isEnabled: true,
  readPermission: true,
  status: "CONNECTED",
  disconnectedAt: null,
  hiddenFromActiveListAt: null,
  mergedAt: null,
  canonicalConnectedLibraryId: null,
} as const satisfies Prisma.ConnectedLibraryWhereInput;

type RootField = keyof typeof currentReadableRootWhere;
export type CurrentReadableRootState = Pick<ConnectedLibrary, RootField>;
export const currentReadableRootSelect = Object.fromEntries(
  Object.keys(currentReadableRootWhere).map((field) => [field, true]),
) as { [Field in RootField]: true };

export function isCurrentReadableRoot(root: CurrentReadableRootState | null | undefined) {
  return Boolean(root && (Object.keys(currentReadableRootWhere) as RootField[])
    .every((field) => root[field] === currentReadableRootWhere[field]));
}

// Fixed SQL alias and mapped column name; values come only from the canonical
// rule above. SQL and Prisma cannot silently acquire different root policies.
export const currentReadableRootSql = Prisma.join(
  (Object.entries(currentReadableRootWhere) as Array<[RootField, boolean | string | null]>)
    .map(([field, value]) => {
      const column = Prisma.raw(`root."${field === "isEnabled" ? "enabled" : field}"`);
      return value === null ? Prisma.sql`${column} IS NULL` :
        typeof value === "string" ? Prisma.sql`${column}::text = ${value}` : Prisma.sql`${column} = ${value}`;
    }),
  " AND ",
);

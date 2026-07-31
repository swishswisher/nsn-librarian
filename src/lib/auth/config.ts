export type NsnAuthRole = "OWNER" | "LIBRARIAN";

export type ConfiguredAuthUser = {
  email: string;
  name: string;
  passwordHash: string;
  role: NsnAuthRole;
};

const maximumApprovedUsers = 2;

function normalizedEmail(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function validRole(value: unknown): value is NsnAuthRole {
  return value === "OWNER" || value === "LIBRARIAN";
}

export function configuredAuthUsers(): ConfiguredAuthUser[] {
  const raw = process.env.NSN_AUTH_USERS_JSON?.trim();

  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;

    if (!Array.isArray(parsed)) {
      return [];
    }

    const users = parsed
      .map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          return null;
        }

        const candidate = entry as Record<string, unknown>;
        const email = normalizedEmail(candidate.email);
        const name =
          typeof candidate.name === "string" ? candidate.name.trim() : "";
        const passwordHash =
          typeof candidate.passwordHash === "string"
            ? candidate.passwordHash.trim()
            : "";
        const role = candidate.role;

        if (
          !email ||
          !email.includes("@") ||
          !name ||
          !passwordHash.startsWith("scrypt$") ||
          !validRole(role)
        ) {
          return null;
        }

        return {
          email,
          name,
          passwordHash,
          role,
        } satisfies ConfiguredAuthUser;
      })
      .filter((user): user is ConfiguredAuthUser => user !== null);

    return users.filter(
      (user, index) => users.findIndex((item) => item.email === user.email) === index,
    );
  } catch {
    return [];
  }
}

export function findConfiguredAuthUser(email: string) {
  const normalized = normalizedEmail(email);
  return configuredAuthUsers().find((user) => user.email === normalized) ?? null;
}

export function authConfigurationStatus() {
  const secret = process.env.NSN_AUTH_SECRET?.trim() ?? "";
  const users = configuredAuthUsers();
  const tooManyUsers = users.length > maximumApprovedUsers;

  return {
    configured: secret.length >= 32 && users.length > 0 && !tooManyUsers,
    hasSecret: secret.length >= 32,
    maximumApprovedUsers,
    tooManyUsers,
    userCount: users.length,
  };
}

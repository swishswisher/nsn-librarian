export type NsnAuthRole = "OWNER" | "LIBRARIAN";

export type ConfiguredAuthUser = {
  email: string;
  googleSubject: string | null;
  name: string;
  role: NsnAuthRole;
};

const maximumApprovedUsers = 2;

function normalizedEmail(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function validRole(value: unknown): value is NsnAuthRole {
  return value === "OWNER" || value === "LIBRARIAN";
}

export function authSecret() {
  const secret = process.env.AUTH_SECRET?.trim() ?? "";
  return secret.length >= 32 ? secret : null;
}

export function googleOAuthCredentials() {
  const clientId = process.env.AUTH_GOOGLE_ID?.trim() ?? "";
  const clientSecret = process.env.AUTH_GOOGLE_SECRET?.trim() ?? "";

  return {
    clientId,
    clientSecret,
    configured: Boolean(clientId && clientSecret),
  };
}

export function configuredAuthUsers(): ConfiguredAuthUser[] {
  const raw = process.env.NSN_AUTH_ALLOWED_USERS_JSON?.trim();

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
        const googleSubject =
          typeof candidate.googleSubject === "string" &&
          candidate.googleSubject.trim()
            ? candidate.googleSubject.trim()
            : null;
        const role = candidate.role;

        if (!email || !email.includes("@") || !name || !validRole(role)) {
          return null;
        }

        return {
          email,
          googleSubject,
          name,
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
  const secret = authSecret();
  const google = googleOAuthCredentials();
  const users = configuredAuthUsers();
  const tooManyUsers = users.length > maximumApprovedUsers;

  return {
    configured:
      Boolean(secret) && google.configured && users.length > 0 && !tooManyUsers,
    hasGoogleCredentials: google.configured,
    hasSecret: Boolean(secret),
    maximumApprovedUsers,
    tooManyUsers,
    userCount: users.length,
  };
}

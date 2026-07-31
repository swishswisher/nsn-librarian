import { redirect } from "next/navigation";

import { authConfigurationStatus } from "@/lib/auth/config";
import { safeInternalPath } from "@/lib/auth/http";
import { getHumanSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

const errorMessages: Record<string, string> = {
  configuration:
    "Sign-in is not configured yet. Add the approved users and authentication secret before using the Librarian.",
  invalid: "The email or password was not recognized.",
  locked:
    "Sign-in is temporarily paused after several unsuccessful attempts. Please wait 15 minutes and try again.",
  unavailable:
    "The Librarian could not complete sign-in right now. Confirm the database migration and try again.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getHumanSession();

  if (session) {
    redirect("/admin/library");
  }

  const params = await searchParams;
  const errorKey = typeof params.error === "string" ? params.error : "";
  const nextPath = safeInternalPath(
    typeof params.next === "string" ? params.next : undefined,
  );
  const configuration = authConfigurationStatus();
  const errorMessage = errorMessages[errorKey];

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden px-5 py-12">
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(214,238,233,0.95),transparent_42%),radial-gradient(circle_at_bottom_right,rgba(233,217,184,0.7),transparent_38%)]"
      />

      <section className="nsn-card relative z-10 w-full max-w-md p-7 sm:p-9">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full border border-[var(--nsn-border)] bg-[var(--nsn-sage-mist)] text-xl font-semibold text-[var(--nsn-teal-dark)]">
            NSN
          </div>
          <p className="mb-2 text-xs font-bold uppercase tracking-[0.24em] text-[var(--nsn-teal)]">
            Private Librarian
          </p>
          <h1 className="nsn-display text-3xl text-[var(--nsn-navy)]">
            Welcome back
          </h1>
          <p className="mt-3 text-sm leading-6 text-[var(--nsn-slate)]">
            Sign in with one of the two approved accounts. There is no public
            registration.
          </p>
        </div>

        {errorMessage ? (
          <div
            className="mb-5 rounded-lg border border-[var(--nsn-danger)]/30 bg-red-50 px-4 py-3 text-sm leading-5 text-[var(--nsn-danger)]"
            role="alert"
          >
            {errorMessage}
          </div>
        ) : null}

        {!configuration.configured && !errorMessage ? (
          <div
            className="mb-5 rounded-lg border border-[var(--nsn-warning)]/30 bg-amber-50 px-4 py-3 text-sm leading-5 text-[var(--nsn-warning)]"
            role="status"
          >
            Authentication still needs its production environment variables.
          </div>
        ) : null}

        <form action="/api/auth/login" className="space-y-5" method="post">
          <input name="next" type="hidden" value={nextPath} />

          <label className="block">
            <span className="mb-2 block text-sm font-semibold text-[var(--nsn-navy)]">
              Email address
            </span>
            <input
              autoCapitalize="none"
              autoComplete="email"
              className="nsn-input w-full"
              inputMode="email"
              maxLength={254}
              name="email"
              required
              spellCheck={false}
              type="email"
            />
          </label>

          <label className="block">
            <span className="mb-2 block text-sm font-semibold text-[var(--nsn-navy)]">
              Password
            </span>
            <input
              autoComplete="current-password"
              className="nsn-input w-full"
              maxLength={512}
              minLength={12}
              name="password"
              required
              type="password"
            />
          </label>

          <button
            className="w-full rounded-lg bg-[var(--nsn-teal-dark)] px-4 py-3 text-sm font-bold text-white shadow-sm transition hover:bg-[var(--nsn-teal)] focus:outline-none focus:ring-2 focus:ring-[var(--nsn-teal)] focus:ring-offset-2"
            type="submit"
          >
            Enter the Librarian
          </button>
        </form>

        <p className="mt-6 text-center text-xs leading-5 text-[var(--nsn-warm-gray)]">
          Sessions expire after eight hours. File-changing actions still require
          Deanne&apos;s separate approval and typed confirmation.
        </p>
      </section>
    </main>
  );
}

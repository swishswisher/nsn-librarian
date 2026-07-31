import { redirect } from "next/navigation";

import { authConfigurationStatus } from "@/lib/auth/config";
import { safeInternalPath } from "@/lib/auth/http";
import { getHumanSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

const errorMessages: Record<string, string> = {
  configuration:
    "Google sign-in is not configured yet. Add the Google OAuth credentials, authentication secret, and approved accounts before using the Librarian.",
  denied: "Google sign-in was cancelled. No account was connected.",
  invalid:
    "That Google sign-in response could not be verified. Please start again from this page.",
  unauthorized:
    "That Google account is not approved for NSN Librarian. Sign out of Google or choose one of the two approved accounts.",
  unavailable:
    "The Librarian could not complete Google sign-in right now. Please try again shortly.",
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
  const googleSignInUrl = `/api/auth/google/start?next=${encodeURIComponent(nextPath)}`;

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
            Continue with one of the two approved Google accounts. NSN does not
            receive or store your Google password.
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
            Google authentication still needs its production environment
            variables.
          </div>
        ) : null}

        <a
          className="flex w-full items-center justify-center gap-3 rounded-lg border border-[var(--nsn-border)] bg-white px-4 py-3 text-sm font-bold text-[var(--nsn-navy)] shadow-sm transition hover:border-[var(--nsn-teal)] hover:bg-[var(--nsn-sage-mist)] focus:outline-none focus:ring-2 focus:ring-[var(--nsn-teal)] focus:ring-offset-2"
          href={googleSignInUrl}
        >
          <svg
            aria-hidden="true"
            className="h-5 w-5"
            viewBox="0 0 24 24"
          >
            <path
              d="M21.6 12.23c0-.71-.06-1.39-.18-2.05H12v3.87h5.38a4.6 4.6 0 0 1-2 3.02v2.51h3.24c1.9-1.75 2.98-4.33 2.98-7.35Z"
              fill="#4285F4"
            />
            <path
              d="M12 22c2.7 0 4.98-.9 6.64-2.42l-3.24-2.51c-.9.6-2.05.96-3.4.96-2.61 0-4.82-1.76-5.61-4.13H3.04v2.59A10 10 0 0 0 12 22Z"
              fill="#34A853"
            />
            <path
              d="M6.39 13.9A6.03 6.03 0 0 1 6.08 12c0-.66.11-1.3.31-1.9V7.51H3.04A10 10 0 0 0 2 12c0 1.61.38 3.14 1.04 4.49l3.35-2.59Z"
              fill="#FBBC05"
            />
            <path
              d="M12 5.97c1.47 0 2.79.5 3.82 1.5l2.87-2.87A9.62 9.62 0 0 0 12 2a10 10 0 0 0-8.96 5.51l3.35 2.59C7.18 7.73 9.39 5.97 12 5.97Z"
              fill="#EA4335"
            />
          </svg>
          Continue with Google
        </a>

        <div className="mt-6 rounded-lg border border-[var(--nsn-border)] bg-[var(--nsn-sand)]/55 px-4 py-3 text-xs leading-5 text-[var(--nsn-slate)]">
          NSN requests only your Google identity: name, verified email address,
          and profile picture. It does not request Gmail, Drive, Calendar, or
          other Google data.
        </div>

        <p className="mt-6 text-center text-xs leading-5 text-[var(--nsn-warm-gray)]">
          Sessions expire after eight hours. File-changing actions still require
          Deanne&apos;s separate approval and typed confirmation.
        </p>
      </section>
    </main>
  );
}

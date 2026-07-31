import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import {
  HUMAN_SESSION_COOKIE,
  verifyHumanSessionToken,
} from "./token";

export async function getHumanSession() {
  const cookieStore = await cookies();
  return verifyHumanSessionToken(cookieStore.get(HUMAN_SESSION_COOKIE)?.value);
}

export async function requireHumanSession(nextPath = "/admin/library") {
  const session = await getHumanSession();

  if (!session) {
    redirect(`/login?next=${encodeURIComponent(nextPath)}`);
  }

  return session;
}

import { createHash } from "node:crypto";
import path from "node:path";

import { OPENAI_DEFAULT_MODEL } from "./openai-client";
import { AI_OBSERVER_SYSTEM_PROMPT, AI_OBSERVER_USER_PROMPT_TEMPLATE } from "./prompts";

// Bump this when extraction or grounding semantics change without a Bridge release.
export const observationProcessingVersion = "phase1-grounded-observer-v2";
export const defaultMaxInputCharacters = 120_000;

export function observationFingerprint(input: {
  bridgeDeviceId: string;
  bridgeRootId: string;
  bridgeVersion: string;
  checksum: string | null;
  connectedLibraryId: string;
  fileType: string;
  relativePath: string;
}) {
  if (!process.env.OPENAI_API_KEY?.trim() || !/^[a-f\d]{64}$/i.test(input.checksum ?? "")) {
    return null;
  }

  const relativePath = path.posix.normalize(input.relativePath.replace(/\\/g, "/"));

  if (relativePath === "." || relativePath.startsWith("../") || path.posix.isAbsolute(relativePath)) {
    return null;
  }

  return createHash("sha256").update(JSON.stringify({
    bridgeDeviceId: input.bridgeDeviceId,
    bridgeRootId: input.bridgeRootId,
    bridgeVersion: input.bridgeVersion,
    checksum: input.checksum?.toLowerCase(),
    connectedLibraryId: input.connectedLibraryId,
    fileType: input.fileType,
    model: process.env.OPENAI_MODEL?.trim() || OPENAI_DEFAULT_MODEL,
    processingVersion: observationProcessingVersion,
    prompt: createHash("sha256")
      .update(AI_OBSERVER_SYSTEM_PROMPT + AI_OBSERVER_USER_PROMPT_TEMPLATE)
      .digest("hex"),
    relativePath,
  })).digest("hex");
}

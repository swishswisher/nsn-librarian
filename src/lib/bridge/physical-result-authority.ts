import { BridgeCloudError } from "./cloud-coordinator";

type ActionIdentity = { id: string; actionType: string; sourceRelativePath: string | null;
  destinationRelativePath: string; checksum: string | null };

// Missing/legacy results cannot establish absence of an effect. Only the
// native owner's explicit no-effect proof settles an unsuccessful action.
export function physicalResultState(result: Record<string, unknown> | undefined): "COMPLETED" | "FAILED" | "PENDING" {
  if (result?.status === "COMPLETED") return "COMPLETED";
  return result?.physicalEffect === "NONE" && ["FAILED", "PENDING"].includes(String(result.status)) ? "FAILED" : "PENDING";
}

export function physicalResultChanged(actionType: string, result: Record<string, unknown> | undefined) {
  return result?.status === "COMPLETED" && (actionType !== "CREATE_FOLDER" || result.createdFilesystemItem === true);
}

// Validate the complete submitted owner set before writing any action. A
// summary cannot turn missing, duplicate, or mismatched physical evidence into
// success. Missing results remain pending and can never claim a move or no effect.
export function physicalResultIndex(value: unknown, actions: ActionIdentity[]) {
  const owners = new Map(actions.map((action) => [action.id, action]));
  const results = new Map<string, Record<string, unknown>>();
  if (value === undefined || value === null) return results;
  if (!Array.isArray(value)) throw new BridgeCloudError("Physical action results must be an array.", 422);
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new BridgeCloudError("Invalid physical action result.", 422);
    const result = entry as Record<string, unknown>;
    const owner = typeof result.actionId === "string" ? owners.get(result.actionId) : undefined;
    if (!owner || results.has(owner.id)) throw new BridgeCloudError("Unknown or repeated physical action identity.", 422);
    if (result.physicalEffect === "NONE" && (result.actionType !== owner.actionType || result.sourceRelativePath !== owner.sourceRelativePath ||
        result.destinationRelativePath !== owner.destinationRelativePath || result.createdFilesystemItem === true ||
        (result.sourceChecksumBefore != null && result.sourceChecksumBefore !== owner.checksum)))
      throw new BridgeCloudError("No-effect proof does not match its authorized physical action.", 422);
    if (result.status === "COMPLETED") {
      if (owner.actionType === "CREATE_FOLDER" && typeof result.createdFilesystemItem !== "boolean")
        throw new BridgeCloudError("Folder outcomes must prove whether a directory was created.", 422);
      if (result.actionType !== owner.actionType || result.sourceRelativePath !== owner.sourceRelativePath ||
          result.destinationRelativePath !== owner.destinationRelativePath ||
          (owner.actionType !== "CREATE_FOLDER" && owner.actionType !== "REMOVE_FOLDER" &&
            (!owner.checksum || !/^[a-f0-9]{64}$/iu.test(owner.checksum) ||
              result.sourceChecksumBefore !== owner.checksum || result.destinationChecksumAfter !== owner.checksum))) {
        throw new BridgeCloudError("Physical action result does not match its authorized paths and checksum.", 422);
      }
    }
    results.set(owner.id, result);
  }
  return results;
}

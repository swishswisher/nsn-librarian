import { BridgeCloudError } from "./cloud-coordinator";

type ActionIdentity = { id: string; actionType: string; sourceRelativePath: string | null;
  destinationRelativePath: string; checksum: string | null };

// Validate the complete submitted owner set before writing any action. A
// summary cannot turn missing, duplicate, or mismatched physical evidence into
// success. Missing results remain failed/incomplete and can never claim a move.
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
    if (result.status === "COMPLETED") {
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

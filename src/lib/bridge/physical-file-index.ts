import { connectedRootAliases, normalizePhysicalRelativePath, stableLocalFilePath, type PhysicalFileIdentityInput } from "./physical-file-identity";

export type PhysicalIndexWork = { fileVisits?: number; aliasLookups?: number; unionMoves?: number; targetChecks?: number };

// Alias equality is conservative physical identity, never semantic identity.
// Transitive alias components suppress ambiguous duplicate proposals; they do
// not delete source rows or collapse authorized copies at different paths.
export function physicalFileClasses<T extends PhysicalFileIdentityInput>(files: T[], work?: PhysicalIndexWork) {
  const parent = files.map((_, index) => index), size = files.map(() => 1);
  const find = (index: number): number => { while (parent[index] !== index) { parent[index] = parent[parent[index]]; index = parent[index]; } return index; };
  const unite = (a: number, b: number) => {
    let left = find(a), right = find(b); if (left === right) return;
    if (size[left] < size[right]) [left, right] = [right, left];
    parent[right] = left; size[left] += size[right];
    if (work) work.unionMoves = (work.unionMoves ?? 0) + 1;
  };
  const rootAliases = new Map<string, number>();
  for (const [index, file] of files.entries()) {
    if (work) work.fileVisits = (work.fileVisits ?? 0) + 1;
    for (const alias of connectedRootAliases(file.scanSession.connectedFolder, file.localPath)) {
      if (work) work.aliasLookups = (work.aliasLookups ?? 0) + 1;
      const prior = rootAliases.get(alias); if (prior !== undefined) unite(index, prior); else rootAliases.set(alias, index);
    }
  }
  const insensitive = new Set<number>();
  for (const [index, file] of files.entries()) if (["WINDOWS", "MACOS"].includes(file.scanSession.connectedFolder.platform.toUpperCase())) insensitive.add(find(index));
  const rootFor = files.map((_, index) => find(index));
  // Reset the disjoint sets to represent files rather than whole roots.
  for (let index = 0; index < files.length; index++) { parent[index] = index; size[index] = 1; }
  const paths = new Map<string, number>();
  for (const [index, file] of files.entries()) {
    const root = rootFor[index]; const stable = stableLocalFilePath(file.localPath, file.scanSession.connectedFolder.platform);
    const keys = [`root:${root}\u0000${normalizePhysicalRelativePath(file.relativePath, insensitive.has(root))}`, ...(stable ? [`absolute:${stable}`] : [])];
    for (const key of keys) { const prior = paths.get(key); if (prior === undefined) paths.set(key, index); else unite(index, prior); }
  }
  return files.map((_, index) => find(index));
}

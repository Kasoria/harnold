import fs from "node:fs";
import path from "node:path";

/**
 * Resolves a path inside a root folder and refuses anything outside it.
 * The lexical check alone is not enough: a symlink inside the root can point anywhere
 * on the disk, so the real path of the closest existing ancestor is checked as well.
 * The target may not exist yet (new file) – then its parent chain is verified instead.
 */
export function resolveInsideRoot(rootDirectory: string, relativePath: string, outsideError: Error): string {
  const resolvedRoot = path.resolve(rootDirectory);
  const absolutePath = path.resolve(resolvedRoot, relativePath.replace(/^\/+/, ""));
  if (absolutePath !== resolvedRoot && !absolutePath.startsWith(resolvedRoot + path.sep)) throw outsideError;
  // A missing root is created later; without a real path there is nothing a symlink could escape through.
  const realRoot = realPathOrNull(resolvedRoot);
  if (!realRoot) return absolutePath;
  const closestExisting = closestExistingAncestor(absolutePath);
  if (!closestExisting) return absolutePath;
  const realExisting = realPathOrNull(closestExisting);
  if (realExisting && realExisting !== realRoot && !realExisting.startsWith(realRoot + path.sep)) throw outsideError;
  return absolutePath;
}

function realPathOrNull(candidatePath: string): string | null {
  try {
    return fs.realpathSync(candidatePath);
  } catch {
    return null;
  }
}

function closestExistingAncestor(absolutePath: string): string | null {
  let currentPath = absolutePath;
  for (;;) {
    if (fs.existsSync(currentPath)) return currentPath;
    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) return null;
    currentPath = parentPath;
  }
}

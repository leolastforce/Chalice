const completeSnapshots = new Map<string, Map<string, string>>();

function scopeFor(sessionKey: string | undefined): string {
  return sessionKey ?? "";
}

export function recordAutoReadAllComplete(sessionKey: string | undefined, absolutePath: string, snapshotId: string): void {
  const scope = scopeFor(sessionKey);
  let snapshots = completeSnapshots.get(scope);
  if (!snapshots) {
    snapshots = new Map();
    completeSnapshots.set(scope, snapshots);
  }
  snapshots.set(absolutePath, snapshotId);
}

export function getAutoReadAllSnapshot(sessionKey: string | undefined, absolutePath: string): string | undefined {
  return completeSnapshots.get(scopeFor(sessionKey))?.get(absolutePath);
}

export function clearAutoReadAllComplete(sessionKey: string | undefined): void {
  completeSnapshots.delete(scopeFor(sessionKey));
}

export function clearAllAutoReadAllComplete(): void {
  completeSnapshots.clear();
}

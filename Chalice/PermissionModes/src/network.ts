/**
 * Network session state — live domain grants, denials, and the open/filtered
 * toggle that back the sandbox-runtime ask callback.
 */

export type NetAskResult = "allow-session" | "allow-forever" | "deny" | "dismiss";
export type NetAsk = (host: string, port: number | undefined) => Promise<NetAskResult>;

export function matchesDomainPattern(host: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) {
    return host.toLowerCase().endsWith("." + pattern.slice(2).toLowerCase());
  }
  return host.toLowerCase() === pattern.toLowerCase();
}

export function isHostAllowed(host: string, patterns: Iterable<string>): boolean {
  for (const p of patterns) if (matchesDomainPattern(host, p)) return true;
  return false;
}

export function normalizeDomain(raw: string): string | undefined {
  let d = raw.trim().toLowerCase();
  d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  d = d.replace(/^[^/@]*@/, "");
  d = d.replace(/[/?#].*$/, "");
  d = d.replace(/:\d+$/, "");
  return d.length > 0 ? d : undefined;
}

export class NetworkSession {
  open = false;
  private allow = new Set<string>();
  private deny = new Set<string>();
  private pending = new Map<string, Promise<boolean>>();

  grant(patterns: string[]): void {
    for (const raw of patterns) {
      const p = raw.toLowerCase();
      this.allow.add(p);
      this.deny.delete(p);
    }
  }

  grants(): string[] {
    return [...this.allow];
  }

  denies(): string[] {
    return [...this.deny];
  }

  isGranted(host: string): boolean {
    return isHostAllowed(host, this.allow);
  }

  clear(): void {
    this.allow.clear();
    this.deny.clear();
    this.open = false;
  }

  async decide(rawHost: string, port: number | undefined, ask: NetAsk | undefined): Promise<boolean> {
    const host = rawHost.toLowerCase();
    if (this.open) return true;
    if (this.isGranted(host)) return true;
    if (this.deny.has(host)) return false;
    if (!ask) return false;
    let p = this.pending.get(host);
    if (!p) {
      p = (async () => {
        const result = await ask(host, port);
        if (result === "allow-session" || result === "allow-forever") {
          this.grant([host]);
          return true;
        }
        if (result === "deny") this.deny.add(host);
        return false;
      })().finally(() => this.pending.delete(host));
      this.pending.set(host, p);
    }
    return await p;
  }
}

import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface Memory {
	id: string;
	text: string;
	scope: "global" | "project";
	project?: string;
	createdAt: string;
	updatedAt: string;
}

function projectKey(cwd: string): string {
	return createHash("sha256").update(resolve(cwd)).digest("hex");
}

export class MemoryStore {
	private readonly dir: string;
	private readonly project: string;

	constructor(agentDir: string, cwd: string) {
		this.dir = join(agentDir, "memory");
		this.project = projectKey(cwd);
	}

	list(): Memory[] {
		let files: string[];
		try {
			files = readdirSync(this.dir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const memories: Memory[] = [];
		for (const file of files) {
			if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue;
			try {
				const value: unknown = JSON.parse(readFileSync(join(this.dir, file), "utf8"));
				if (!value || typeof value !== "object") continue;
				const memory = value as Partial<Memory>;
				if (memory.id !== file.slice(0, -5) || typeof memory.text !== "string" ||
					(memory.scope !== "global" && memory.scope !== "project") ||
					(memory.scope === "project" && memory.project !== this.project) ||
					typeof memory.createdAt !== "string" || typeof memory.updatedAt !== "string") continue;
				memories.push(memory as Memory);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
			}
		}
		return memories.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
	}

	private withLock<T>(id: string, action: () => T): T {
		if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid memory ID");
		mkdirSync(this.dir, { recursive: true, mode: 0o700 });
		const lock = join(this.dir, `.${id}.lock`);
		try {
			mkdirSync(lock, { mode: 0o700 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Memory is being modified; try again");
			throw error;
		}
		try { return action(); } finally { rmdirSync(lock); }
	}

	save(text: string, scope: "global" | "project", id?: string): Memory {
		const clean = text.trim();
		if (!clean || clean.length > 1000) throw new Error("Memory must be between 1 and 1000 characters");
		const memoryId = id ?? randomUUID();
		return this.withLock(memoryId, () => {
			const existing = id ? this.list().find((item) => item.id === id) : undefined;
			if (id && !existing) throw new Error("Memory not found in this scope");
			const now = new Date().toISOString();
			const memory: Memory = {
				id: memoryId, text: clean, scope,
				...(scope === "project" ? { project: this.project } : {}),
				createdAt: existing?.createdAt ?? now, updatedAt: now,
			};
			const path = join(this.dir, `${memory.id}.json`);
			const temp = join(this.dir, `.${randomUUID()}.tmp`);
			try {
				writeFileSync(temp, JSON.stringify(memory), { mode: 0o600, flag: "wx" });
				renameSync(temp, path);
			} finally {
				try { unlinkSync(temp); } catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
			}
			return memory;
		});
	}

	delete(id: string, expected?: Memory): boolean {
		return this.withLock(id, () => {
			const memory = this.list().find((item) => item.id === id);
			if (!memory) return false;
			if (expected && (memory.text !== expected.text || memory.scope !== expected.scope || memory.updatedAt !== expected.updatedAt || memory.project !== expected.project)) return false;
			try { unlinkSync(join(this.dir, `${memory.id}.json`)); return true; } catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
				throw error;
			}
		});
	}
}

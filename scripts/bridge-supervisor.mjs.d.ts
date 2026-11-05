export function backoffDelay(failures: number, options?: { baseMs?: number; maxMs?: number }): number;
export function acquireInstanceLock(path: string): Promise<{ release: () => Promise<void> }>;
export function probeHealth(port: number, host?: string, timeoutMs?: number): Promise<{ status: number }>;
export function runSupervisor(options: Record<string, unknown>): Promise<{ restarts: number }>;

import { setTimeout as delay } from "node:timers/promises";
import { StdioTransport } from "@earendil-works/pi-mcp";

// Pi-mcp 1.2.0 forgets the process group when the direct child exits. Retain our
// ownership until cleanup completes, including a crash before client.close().
export class OwnedStdioTransport extends StdioTransport {
  private group: number | undefined;
  private closing: Promise<void> | undefined;
  private watching: ReturnType<typeof setInterval> | undefined;

  constructor(options: ConstructorParameters<typeof StdioTransport>[0]) {
    super(options);
    this.onClose(() => { void this.close().catch(() => {}); });
  }

  override async start(): Promise<void> {
    const starting = super.start();
    // spawn is synchronous inside start(), before its first await.
    if (process.platform !== "win32") this.group = this.pid;
    await starting;
    if (this.group !== undefined && !this.closing) {
      // Node's child "close" waits for inherited pipes, even after parent exit.
      // The pinned transport exposes only its PID, not the child exit event.
      this.watching = setInterval(() => {
        if (this.group !== undefined && !parentAlive(this.group)) void this.close().catch(() => {});
      }, 100);
      this.watching.unref();
    }
  }

  override close(): Promise<void> {
    // Assign before super.close can synchronously emit a close notification.
    return this.closing ??= Promise.resolve().then(async () => {
      clearInterval(this.watching);
      try { await super.close(); }
      finally {
        const group = this.group;
        this.group = undefined;
        if (group !== undefined && signalGroup(group, "SIGTERM")) {
          await delay(100);
          signalGroup(group, "SIGKILL");
        }
        this.emitClose();
      }
    });
  }
}

function parentAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

function signalGroup(group: number, signal: NodeJS.Signals): boolean {
  try { process.kill(-group, signal); return true; }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

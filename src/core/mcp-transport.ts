import { setTimeout as delay } from "node:timers/promises";
import { StdioTransport } from "@earendil-works/pi-mcp";

// Pi-mcp 1.2.0 forgets the process group when the direct child exits. Retain our
// ownership until cleanup completes, including a crash before client.close().
export class OwnedStdioTransport extends StdioTransport {
  private group: number | undefined;
  private closing: Promise<void> | undefined;

  constructor(options: ConstructorParameters<typeof StdioTransport>[0]) {
    super(options);
    this.onClose(() => { void this.close().catch(() => {}); });
  }

  override async start(): Promise<void> {
    const starting = super.start();
    // spawn is synchronous inside start(), before its first await.
    if (process.platform !== "win32") this.group = this.pid;
    await starting;
  }

  override close(): Promise<void> {
    // Assign before super.close can synchronously emit a close notification.
    return this.closing ??= Promise.resolve().then(async () => {
      try { await super.close(); }
      finally {
        const group = this.group;
        this.group = undefined;
        if (group !== undefined && signalGroup(group, "SIGTERM")) {
          await delay(100);
          signalGroup(group, "SIGKILL");
        }
      }
    });
  }
}

function signalGroup(group: number, signal: NodeJS.Signals): boolean {
  try { process.kill(-group, signal); return true; }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

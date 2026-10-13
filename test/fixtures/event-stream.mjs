import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

// All fixture instructions come from this synthetic account file, not the host.
const config = JSON.parse(readFileSync(process.env.TASKFAST_CONFIG, "utf8"));
const record = (kind, extra = {}) => appendFileSync(config.journal, JSON.stringify({ kind, pid: process.pid, cwd: process.cwd(), ...extra }) + "\n");
const unexpected = Object.keys(process.env).filter((key) => !["PATH", "HOME", "TASKFAST_CONFIG"].includes(key));
if (unexpected.length) throw new Error(`unexpected child environment: ${unexpected.join(", ")}`);
if (JSON.stringify(process.argv.slice(2)) === JSON.stringify(["--version"])) {
  record("version");
  process.stdout.write("taskfast 0.19.0\n");
  process.exit(0);
}
if (JSON.stringify(process.argv.slice(2)) === JSON.stringify(["--env", "staging", "me"])) {
  record("me", { configPath: process.env.TASKFAST_CONFIG });
  process.stdout.write(JSON.stringify({ ok: true, data: { profile: { id: "33333333-3333-4333-8333-333333333333" } } }) + "\n");
  process.exit(0);
}
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["events", "stream", "--ack-stdin", "--env", "staging"])) {
  throw new Error("fixture accepts only a staging event stream");
}
record("start", { configPath: process.env.TASKFAST_CONFIG });
process.once("SIGTERM", () => { record("stop"); process.exit(0); });
const input = createInterface({ input: process.stdin });
input.on("line", (id) => {
  if (!config.event || id !== config.event.event_id) throw new Error(`unexpected ACK: ${id}`);
  record("ack", { id });
  if (config.exitAfterAck) process.exit(0);
});
if (config.event) process.stdout.write(JSON.stringify(config.event) + "\n");

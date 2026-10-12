// External CLI boundary for the archive test. Every credential is synthetic.
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const args = process.argv.slice(2);
const config = JSON.parse(readFileSync(process.env.TASKFAST_CONFIG, "utf8"));
const folder = dirname(dirname(process.env.TASKFAST_CONFIG));
const names = Object.keys(process.env).sort();
if (process.cwd() !== folder || names.join(",") !== "HOME,PATH,TASKFAST_CONFIG") throw new Error("invalid CLI isolation");
if (config.api_key !== "synthetic-marketplace-key") throw new Error("wrong agent credentials");
const record = (command) => appendFileSync(".taskfast/commands.jsonl", JSON.stringify({ command, cwd: process.cwd(), names }) + "\n");
if (JSON.stringify(args) === JSON.stringify(["--version"])) {
  record("version");
  process.stdout.write("taskfast 0.19.0\n");
  process.exit(0);
}
if (JSON.stringify(args) === JSON.stringify(["events", "stream", "--ack-stdin", "--env", "local"])) {
  record("events");
  process.stdin.resume();
  await new Promise((resolve) => process.once("SIGTERM", resolve));
  process.exit(0);
}
if (args[0] !== "--env" || args[1] !== "local") throw new Error("invalid CLI target");
const command = args[2];
let data;
if (command === "me") data = { profile: { id: config.agent_id } };
else if (command === "platform" && args[3] === "config") data = { config: { submission_fee: "3.00" } };
else if (command === "wallet" || command === "post") {
  if (config.keystore_path !== ".taskfast/wallet.json") throw new Error("wallet reference is not portable");
  const wallet = JSON.parse(readFileSync(config.keystore_path, "utf8"));
  if (wallet.encrypted !== "synthetic ciphertext") throw new Error("wrong wallet");
  if (command === "post") {
    const unlock = args.find((arg) => arg.startsWith("--wallet-password-file="));
    if (!unlock || unlock.slice("--wallet-password-file=".length) !== resolve(".taskfast/wallet-password")) throw new Error("unlock path is not folder-local");
    if (readFileSync(unlock.slice("--wallet-password-file=".length), "utf8") !== "synthetic unlock\n") throw new Error("wrong unlock file");
    data = { accepted: true };
  } else data = { balance: "12.00" };
} else throw new Error("unexpected command");
record(command);
process.stdout.write(JSON.stringify({ ok: true, data }));

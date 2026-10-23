// Spike for #144: does Pi Durable 1.2.0 open its storage in a SQLite-backed
// Durable Object and run one turn under workerd? Throwaway; not part of the kit.
import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import * as piDurable from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";

const { createRegistry, defineDoc } = piDurable;
// Same lookup as src/core/agent.ts: the one export with an `open` factory.
const [PiRuntime] = Object.values(piDurable).filter((value) => typeof value === "object" && value !== null && typeof value.open === "function");

// Stands in for the policy ledger: a session doc that must outlive the DO.
const Ledger = defineDoc({ kind: "spike.ledger", version: 1, scope: "session", initial: () => ({ actions: {} }) });

export class Agent extends DurableObject {
  async open() {
    const faux = fauxProvider({ models: [{ id: "test" }] });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage("Checked the marketplace. Nothing to do.")]);
    const storage = await openDurableObjectSqliteStorage(this.ctx.storage);
    const pi = await PiRuntime.open(storage, { models, registry: createRegistry(), settings: { toolExecution: "sequential" } }, context);
    const model = { provider: "faux", modelId: "test" };
    const conversation = await pi.root(context, { agent: { model } });
    await conversation.configure({ model }, context);
    return { pi, conversation, faux };
  }

  async fetch(request) {
    const url = new URL(request.url);
    const started = Date.now();
    const { pi, conversation, faux } = await this.open();
    const openMs = Date.now() - started;
    if (url.pathname === "/turn") {
      const key = url.searchParams.get("key") ?? "bid:task-1";
      const reserved = await conversation.commit(async (tx) => {
        const ledger = await tx.doc(Ledger);
        if (ledger.actions[key]) return false;
        ledger.actions[key] = { state: "reserved", at: new Date().toISOString() };
        return true;
      }, context);
      await conversation.submit({ type: "input", content: "Check your marketplace work." }, context);
      await conversation.waitForIdle(context);
      return Response.json({ reserved, openMs, modelCalls: faux.state.callCount, ...(await this.read(pi, conversation)) });
    }
    return Response.json({ openMs, ...(await this.read(pi, conversation)) });
  }

  async read(pi, conversation) {
    const { messages } = await conversation.context(context);
    const ledger = (await pi.snapshot(Ledger, context)) ?? { actions: {} };
    return { messages: messages.map((m) => m.role), actions: Object.keys(ledger.actions) };
  }
}

export default {
  fetch: (request, env) => env.AGENT.get(env.AGENT.idFromName("spike")).fetch(request),
};

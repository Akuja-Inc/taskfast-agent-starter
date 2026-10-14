import type { Storage } from "@earendil-works/pi-durable";
import { openAgentStorage } from "../src/core/storage.js";

// Delegates everything to the real store until armed; then every method except
// close throws, so the Session fails while its self-close still reaches storage.
export async function failingStorage(file: string, armed: () => boolean): Promise<Storage> {
  return new Proxy(await openAgentStorage(file), {
    get(target, key) {
      const value: unknown = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      return key !== "close" && armed() ? async () => { throw new Error("injected storage failure"); } : value.bind(target);
    },
  });
}

import { describe, expect, it } from "vitest";
import { consoleNavigation } from "../src/console-navigation.js";

const routes = consoleNavigation();
describe("console destination URLs", () => {
  it("round trips the agent path, page and every expanded panel without adding other state", () => {
    const route = { ...routes.empty(), agent: "alice's studio", open: ["turn:call/1", "turn:call/2"], raw: ["turn", "a:event-id"] };
    const href = routes.href(route);
    const url = new URL(href, "http://console");
    expect(url.pathname).toBe("/agents/alice's%20studio");
    expect(routes.read(url.pathname, url.search)).toEqual(route);
    expect(href).not.toContain("token");
  });
  it("round trips editing destinations and server wizard steps", () => {
    const route = { ...routes.empty(), agent: "alice", tab: "capabilities" as const, capability: { screen: "server" as const, item: "docs", step: 2 } };
    expect(routes.href(route)).toBe("/agents/alice?tab=capabilities&screen=server&item=docs&step=2");
    const url = new URL(routes.href(route), "http://console");
    expect(routes.read(url.pathname, url.search)).toEqual(route);
  });
  it.each([
    ["/agents/alice/more", ""], ["/agents/%2f", ""], ["/agents/%5C", ""], ["/agents/%00", ""], ["/agents/%2e%2e", ""], ["/agents/%zz", ""],
    ["/agents/alice", "?tab=unknown"], ["/agents/alice", "?tab=briefing&tab=timeline"], ["/agents/alice", "?token=secret"],
    ["/agents/alice", "?open="], ["/agents/alice", "?raw=%00"], ["/agents/alice", "?screen=server"], ["/agents/alice", "?tab="],
    ["/agents/alice", "?tab=capabilities&screen="], ["/agents/alice", "?tab=capabilities&screen=server&step="],
    ["/agents/alice", "?tab=capabilities&screen=skill"], ["/agents/alice", "?tab=capabilities&screen=server&step=9"],
    ["/agents/alice", "?tab=capabilities&screen=review&item=missing"], ["/agents/alice", "?tab=capabilities&screen=review&step=1"],
  ])("keeps invalid destinations explicit: %s%s", (path, query) => {
    expect(routes.read(path, query).invalid).toBe(true);
  });
  it("reads a root bootstrap without inventing an agent", () => {
    expect(routes.read("/", "")).toEqual(routes.empty());
  });
});

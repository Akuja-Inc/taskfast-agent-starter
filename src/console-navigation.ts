export type ConsoleDestination = {
  agent: string | null;
  tab: "timeline" | "settings" | "capabilities";
  open: string[];
  raw: string[];
  capability: { screen: "overview" | "import" | "skill" | "server" | "review" | "taskfast" | "credential"; item: string; step: number };
  invalid: boolean;
};

/** Serialized into the console page. Only destination identities belong here. */
export function consoleNavigation() {
  const empty = (): ConsoleDestination => ({ agent: null, tab: "timeline", open: [], raw: [], capability: { screen: "overview", item: "", step: 0 }, invalid: false });
  const agentName = (value: string) => !!value && value !== "." && value !== ".." && !/[\\/\u0000-\u001f\u007f]/.test(value);
  function read(pathname: string, search: string): ConsoleDestination {
    const route = empty();
    if (pathname !== "/") {
      const match = /^\/agents\/([^/]+)$/.exec(pathname);
      try { route.agent = match ? decodeURIComponent(match[1]!) : null; } catch { route.invalid = true; }
      if (!route.agent || !agentName(route.agent)) route.invalid = true;
    }
    const query = new URLSearchParams(search);
    const single = ["tab", "screen", "item", "step"];
    for (const key of query.keys()) if (![...single, "open", "raw"].includes(key) || single.includes(key) && query.getAll(key).length !== 1) route.invalid = true;
    const tab = query.get("tab") ?? "timeline";
    if (tab === "timeline" || tab === "settings" || tab === "capabilities") route.tab = tab;
    else if (tab === "briefing") route.tab = "settings"; // Saved links from before #115.
    else route.invalid = true;
    route.open = [...new Set(query.getAll("open"))];
    route.raw = [...new Set(query.getAll("raw"))];
    if ([...route.open, ...route.raw].some((key) => !key || key.length > 1024 || /[\u0000-\u001f\u007f]/.test(key))) route.invalid = true;
    const screen = query.get("screen") ?? "overview";
    if (screen === "overview" || screen === "import" || screen === "skill" || screen === "server" || screen === "review" || screen === "taskfast" || screen === "credential") route.capability.screen = screen;
    else route.invalid = true;
    const item = query.get("item") || "";
    if (item && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(item)) route.invalid = true;
    route.capability.item = item;
    const step = query.get("step") ?? "0";
    if (!["0", "1", "2"].includes(step)) route.invalid = true;
    else route.capability.step = Number(step);
    if (route.tab !== "capabilities" && (query.has("screen") || query.has("item") || query.has("step"))) route.invalid = true;
    if (route.capability.screen !== "server" && query.has("step")) route.invalid = true;
    if (["overview", "review", "taskfast"].includes(screen) && item || ["skill", "credential"].includes(screen) && !item) route.invalid = true;
    return route;
  }
  function href(route: ConsoleDestination): string {
    const query = new URLSearchParams();
    if (route.tab !== "timeline") query.set("tab", route.tab);
    for (const key of route.open) query.append("open", key);
    for (const key of route.raw) query.append("raw", key);
    if (route.tab === "capabilities") {
      if (route.capability.screen !== "overview") query.set("screen", route.capability.screen);
      if (route.capability.item) query.set("item", route.capability.item);
      if (route.capability.screen === "server" && route.capability.step) query.set("step", String(route.capability.step));
    }
    return (route.agent ? "/agents/" + encodeURIComponent(route.agent) : "/") + (query.size ? "?" + query.toString() : "");
  }
  return { empty, read, href };
}

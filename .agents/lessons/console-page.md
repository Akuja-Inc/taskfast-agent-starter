# Console page

- `el()` in `src/console-page.ts` flattens its children one level only, so a helper that returns `[node, [nodes...]]` renders the inner array as text; spread nested lists (`...list.map(...)`) before passing them. (long-timeline PR)

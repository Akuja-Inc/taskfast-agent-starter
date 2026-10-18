# Console token links in an open tab

Opening a token link must authenticate the console even when the tab already displays the base URL. Browsers treat a change to `#token=...` as same-document navigation, so the page's startup code does not run again.

The page now recognizes valid token fragments on `hashchange` and automatically reloads the document. Startup remains the only place that installs a link's token and removes it from the address bar. Users do not need to reload or paste the token themselves.

## Why a fresh document

Replacing the token in place would keep requests and callbacks from the old session alive. In particular, an old request's 401 response can clear authentication. Starting a new document isolates the new token from those callbacks without adding a second authentication lifecycle.

The reload resets in-memory drafts and views, as navigation to a fresh console page already does. It preserves the existing warning for unsaved capability edits. Cancelling that warning keeps the existing document and its authentication. A reload neither undoes nor repeats an already-dispatched server action.

## State transitions

| Current state | Event | Result |
| --- | --- | --- |
| New document | Valid token fragment | Save token, remove fragment, request the roster. |
| Open locked page | Valid token fragment arrives | Automatically reload, then authenticate at startup. |
| Open authenticated page | Valid token fragment arrives | Automatically reload with the supplied token and fresh page state. |
| Any open page | Empty, malformed or unrelated fragment | Keep the document and authentication unchanged. |
| New document | Server refuses a well-formed token | Clear the saved token and show the unlock form. |
| Unsaved capability editor | Reload triggers the existing unload warning | Continue only if the user permits leaving. |

## Local verification

The unit tests exercise the served page script and run in normal CI. The Chromium regression exercises same-document navigation, token replacement, URL cleanup and authenticated requests. Both use synthetic tokens. They do not open marketplace agents, model providers, stores or TaskFast accounts.

```sh
pnpm exec vitest run test/console-page.test.ts
TASKFAST_BROWSER=/path/to/chromium pnpm exec vitest run test/console-capabilities-page.test.ts
pnpm check
```

Before and after screenshots are captured by the Chromium regression and committed beside this document. The PR pins the images to their evidence commit.

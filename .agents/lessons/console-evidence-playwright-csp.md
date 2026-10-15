# Console evidence captures and the page CSP

- The console page's CSP (`script-src 'unsafe-inline'`) refuses Playwright's `evaluate` and `wait_for_function` during evidence captures; create the browser context with `bypass_csp=True` to drive the page. (issue #30)
- A stream push keeps the console reader's scroll position, so a queue row or band that appears near the composer can sit below the fold in a viewport capture; scroll to `document.documentElement.scrollHeight` before each evidence screenshot. (issue #57)

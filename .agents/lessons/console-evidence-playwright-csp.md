# Console evidence captures and the page CSP

- The console page's CSP (`script-src 'unsafe-inline'`) refuses Playwright's `evaluate` and `wait_for_function` during evidence captures; create the browser context with `bypass_csp=True` to drive the page. (issue #30)

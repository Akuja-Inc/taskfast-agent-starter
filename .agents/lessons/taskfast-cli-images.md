# taskfast CLI images

- `node:*-slim` images ship without `ca-certificates`, so the `taskfast` CLI in them fails every HTTPS call with `network: builder error`; install the package in the final stage. (#144 PR4)

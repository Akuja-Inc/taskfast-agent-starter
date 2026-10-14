# Pi storage failure injection

- A deduplicated `deliver()` commit writes nothing to storage; an injected `Storage` failure must force a state-changing commit, such as a new event key, or the session never fails. (PR for #38)

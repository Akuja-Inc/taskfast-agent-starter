# Event task links

- Event admission checks identity and name, not `task_id`; keep malformed IDs as text and link only UUID-shaped IDs, because `encodeURIComponent` throws on lone Unicode surrogates that JSON preserves. (PR #114)

# Terminal command policy

Terminal execution is classified before any process is started:

- read-only inspection commands can proceed;
- workspace or environment mutations require an explicit approval decision;
- destructive root-level operations and disk formatting are blocked.

`assessCommand` is deterministic and side-effect free. `assertCommandAllowed` is the execution boundary; the terminal runner must call it immediately before spawning a process and pass approval only after the user has approved that exact command.


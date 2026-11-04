# Context conflict detection

Conflict detection is intentionally conservative. `detectConflicts` only compares structured directives written as `key: value` or `key = value` lines. When two blocks use the same normalized key with different values, the result reports a possible conflict and keeps both original blocks intact.

The detector does not choose a winner, rewrite content, change priority, or auto-remove an observation. Resolution remains an explicit user decision in the Context Manager.


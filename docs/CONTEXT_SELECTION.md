# Deterministic context selection

`selectContext` is a pure, local selector. It does not call a model, mutate the database, or silently inject observations. Given the same candidates and budget, it returns the same selected and omitted blocks.

Selection order is:

1. pinned blocks;
2. explicit priority (`P0` through `P3`);
3. membership position;
4. block ID as a stable tie-breaker.

Non-pinned blocks that would exceed the visible token budget are returned as omitted with a `budget` reason. Pinned blocks are always included and may make the reported total exceed the budget; this preserves an explicit user pin rather than silently dropping it.


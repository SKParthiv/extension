# Local retrieval

The initial retrieval path is local and bounded. `retrieveLocalText` accepts workspace file contents supplied by the extension host, scores files by repeated query-term matches, returns capped snippets with line ranges, and uses path order as a stable tie-breaker.

It does not download an index, call a provider, use embeddings, or read outside the supplied file set. The caller controls the file and character limits before retrieved text is added to context assembly.


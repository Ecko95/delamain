# Repo Research Tools

Research date: 2026-05-15. Star counts below were observed via GitHub API on that date and will drift.

## 1. jcodemunch-mcp deep-dive

### Overview

`jcodemunch-mcp` is a large Python MCP server for local code intelligence. It is centered on tree-sitter parsing, a persistent repository index, symbol-level retrieval, and token-budgeted context assembly. The project is not just an MCP server: it also ships a CLI (`gcm`), watcher tooling, Git hooks, and a PR-review GitHub Action (`speedreview`).

The core promise is accurate repo exploration with fewer tokens. That claim is mostly true for already-indexed codebases. The server is good at finding and packaging code structure, call graphs, blast radius, dead code, duplicate implementations, and architectural signals.

### MCP tools exposed

The canonical tool surface in `src/jcodemunch_mcp/server.py` is 60+ tools, grouped roughly as:

- Indexing and discovery: `index_repo`, `index_folder`, `index_file`, `summarize_repo`, `list_repos`, `resolve_repo`, `suggest_queries`, `get_repo_outline`, `get_file_tree`, `get_file_outline`
- Search and retrieval: `search_symbols`, `get_symbol_source`, `get_context_bundle`, `get_file_content`, `search_text`, `search_columns`, `get_ranked_context`, `assemble_task_context`, `search_ast`
- Relationships and impact: `find_importers`, `find_references`, `check_references`, `get_dependency_graph`, `get_class_hierarchy`, `get_related_symbols`, `get_call_hierarchy`, `get_blast_radius`, `check_rename_safe`, `check_delete_safe`, `get_impact_preview`, `get_changed_symbols`, `get_symbol_provenance`, `get_pr_risk_profile`
- Architecture and quality: `get_dependency_cycles`, `get_coupling_metrics`, `get_layer_violations`, `get_extraction_candidates`, `get_cross_repo_map`, `get_group_contracts`, `get_tectonic_map`, `get_signal_chains`, `get_symbol_complexity`, `get_churn_rate`, `get_hotspots`, `get_repo_health`, `get_symbol_importance`, `get_repo_map`, `find_dead_code`, `get_dead_code_v2`, `get_untested_symbols`, `find_similar_symbols`
- Utilities and session state: `get_session_stats`, `get_session_context`, `get_session_snapshot`, `plan_turn`, `register_edit`, `invalidate_cache`, `test_summarizer`, `audit_agent_config`, `get_watch_status`, `analyze_perf`, `tune_weights`, `check_embedding_drift`, `digest`, `get_file_risk`, `set_tool_tier`, `announce_model`, `jcodemunch_guide`

### Implementation notes

- `search_symbols` is BM25-based over tokenized symbol metadata, with stemming, abbreviation expansion, fuzzy fallback, PageRank/centrality tie-breaking, and optional semantic or hybrid search.
- `get_repo_map` ranks files by PageRank and greedily packs symbol signatures under a token budget for cold-start orientation.
- `assemble_task_context` classifies a task into one of six intents (`explore`, `debug`, `refactor`, `extend`, `audit`, `review`) and orchestrates other tools into a single token-budgeted capsule.
- `find_similar_symbols` blends semantic embeddings, structural signature similarity, and call-graph behavior to surface consolidation candidates.
- `get_group_contracts` surfaces shared API contracts across multiple indexed repos and can attach churn, provenance, and runtime evidence.
- `search_ast` is the cross-language structural checker: preset anti-patterns plus custom mini-DSL queries.
- The server lazily imports heavier dependencies to keep cold-start cost down.

### License

This is not a normal permissive OSS package. The repo LICENSE is a dual-use / non-commercial license: personal, academic, and research use are free; commercial use requires a paid license. The README lists commercial prices of roughly $79 builder, $349 studio, and $1,999 platform.

### Does the self-description hold up?

Mostly, but only if the claim is read narrowly.

- Accurate: it is genuinely strong for structured code exploration, symbol lookup, impact analysis, duplicate detection, AST-based review, and repo-map generation.
- Accurate: it can help a researcher model understand an already indexed repo much faster than file-by-file browsing.
- Overstated: it does not discover GitHub repositories, rank “good repos,” or inspect issues/PRs/releases as first-class GitHub research signals.
- Overstated: it is not a GitHub repo discovery engine. A repo must be indexed first, so it helps after selection, not before.

Bottom line: it lives up to “token-efficient code exploration,” but not to “find good GitHub repos” unless that phrase is meant to mean “analyze a repo you already picked.”

## 2. Hands-on assessment

Would installing this MCP help a Claude Code session do better repo research?

Yes, in these scenarios:

- You already have the repo cloned or indexed and need to understand it quickly.
- You want function-level lookup instead of opening giant files.
- You need blast-radius, dead-code, duplicate-implementation, or architecture analysis.
- You are comparing candidate repos that have already been indexed and want a structural summary.
- You want review-oriented signals on a known codebase, especially via `search_ast`, `get_blast_radius`, `get_pr_risk_profile`, `find_similar_symbols`, or `assemble_task_context`.

No, or not enough, in these scenarios:

- You need to discover candidate repos on GitHub by keyword, stars, recent activity, topic, or maintainer signal.
- You need issue, PR, release, or security alert access as part of repo evaluation.
- You want the model to triage “good repos” from search results before cloning anything.
- You are optimizing for minimal setup and broad GitHub coverage rather than deep local code intelligence.

My read: jcodemunch is an excellent second-stage tool, not a first-stage discovery tool.

## 3. Alternative tools

| Name | URL | Stars | What it does | Strengths | Weaknesses |
|---|---|---:|---|---|---|
| GitHub MCP Server | https://github.com/github/github-mcp-server | 29,859 | Official GitHub MCP for repos, code, issues, PRs, workflows, security, and collaboration. | Best GitHub-native breadth; strong repo/issue/PR access; official support. | Not a deep local code-intelligence engine; little repo-quality scoring beyond GitHub metadata. |
| Octocode MCP | https://github.com/bgauryy/octocode-mcp | 826 | Research-focused MCP with GitHub/GitLab repo search, implementation lookup, PR exploration, local tools, LSP, and skills. | Closest all-in-one “researcher model” experience; includes PR reviewer and roast skills. | More opinionated and heavier; smaller community than GitHub MCP. |
| codebase-memory-mcp | https://github.com/DeusData/codebase-memory-mcp | 2,352 | Fast code-intelligence MCP with persistent knowledge graph, semantic/BM25 search, call graphs, architecture, and cross-repo links. | Very strong local repo analysis; fast indexing; broad language support; serious graph features. | Not GitHub-search oriented; no built-in issues/PR discovery layer. |
| Probe | https://github.com/probelabs/probe | 595 | AST-aware code search/context engine with MCP, CLI agent, structural queries, and zero-setup search. | Great for code review and fast code understanding; deterministic; easy to run. | Less of a GitHub-repo research stack; no first-class GitHub repo/PR/issue workflow. |
| Repomix | https://github.com/yamadashy/repomix | 24,880 | Packs a repository into a single AI-friendly file, with token counting and compression. | Best “one-shot handoff” tool; simple; great for sending a repo to any model. | Not a discovery tool; little/no live repo analysis beyond packaging. |
| githubsearchmcp | https://github.com/PeiFeng877/githubsearchmcp | 0 | MCP for GitHub repo search, README fetch, and release info. | Narrow but useful for first-pass discovery and lightweight evaluation. | No code-tree or code-review depth; tiny ecosystem signal. |
| RepoIntel | https://github.com/ashish-tripathi57/RepoIntel | 0 | MCP + HTTP service that wraps GitHub REST for repo info, open issues, and repo health metrics. | Good for repo-level triage and maintainer/activity signals. | Shallow code intelligence; tiny adoption; no real code navigation. |
| RepoMap-AI | https://github.com/TusharKarkera22/RepoMap-AI | 8 | Tree-sitter repo maps with dependency graph, PageRank ranking, token-budget output, and MCP integration. | Good “map first” codebase overview; lightweight and direct. | Smaller project; less broad than codebase-memory-mcp or jcodemunch. |

`ast-grep` is a notable adjacent CLI for structural search and rewrite, but I left it out of the top 8 because it is an excellent local code-review tool rather than a GitHub repository discovery or evaluation stack.

## 4. Comparison matrix

Legend: `Y` = explicit first-class support, `P` = partial or indirect, `N` = not really.

| Tool | Search by keyword | Search by code | Tree exploration | Issue/PR access | Code-review prompts | Star-velocity / signal scoring |
|---|---|---|---|---|---|---|
| GitHub MCP Server | Y | P | Y | Y | P | P |
| Octocode MCP | Y | Y | Y | Y | Y | P |
| codebase-memory-mcp | Y | Y | Y | N | P | P |
| Probe | Y | Y | Y | N | P | P |
| Repomix | N | N | P | N | N | N |

Takeaway: none of the top five is a true GitHub repo-quality scorer. The closest to “quality signals” are GitHub MCP Server via GitHub metadata and RepoIntel via health metrics; the closest to “code understanding” are octocode, codebase-memory-mcp, and probe.

## 5. Recommendation for our use case

For codex-peers research swarms, I would not install jcodemunch just to discover or rank GitHub repositories. It is the wrong tool for the first mile.

If we want one MCP installed into `peer-codex-home`, the best default is the official GitHub MCP Server.

Why:

- It directly covers repository search, code browsing, issues, PRs, workflows, security, and repo metadata.
- That matches the actual swarm workflow: discover candidates, inspect signals, then decide what deserves deeper analysis.
- It has the cleanest GitHub-native story and the largest practical surface for repo research.

Cost / benefit:

- Cost: GitHub auth/config setup, some dependency on GitHub availability/rate limits, and less deep local code intelligence than specialized analyzers.
- Benefit: it gives every peer a single, broad, trusted entry point into GitHub itself.

If we are willing to install a second tool later, I would add `codebase-memory-mcp` or `probe` for deep local repository analysis. If we want a more opinionated all-in-one research stack, `octocode-mcp` is the strongest “single package” alternative, but I would still default to GitHub MCP first.

## 6. Build vs buy

Yes, you can get most of the discovery value with a small custom MCP that wraps `gh search repos` and `gh api`.

The 80% version would be a very small server with these tools:

```text
search_repos(query, sort="stars", language=None, min_stars=0)
repo_snapshot(owner, repo)
repo_readme(owner, repo)
repo_tree(owner, repo, path="")
repo_issues(owner, repo, state="open", limit=20)
repo_pulls(owner, repo, state="open", limit=20)
repo_health(owner, repo)
```

What that buys you:

- repo discovery by keyword, language, topic, and popularity
- repo triage from stars/forks/updated_at/license/readme quality
- issue and PR inspection for maintenance signal
- a simple computed “research score” from stars, recency, issue velocity, release freshness, and maintainer responsiveness

What it would not buy you:

- symbol-level code intelligence
- call graphs
- blast-radius analysis
- duplicate implementation clustering
- AST-based structural review

So the build-vs-buy answer is:

- Build the tiny GitHub wrapper if the swarm’s first job is discovery and triage.
- Buy a deeper code-intelligence tool if the swarm’s job is to understand and review the code inside a selected repo.

## Sources

- https://github.com/jgravelle/jcodemunch-mcp
- https://github.com/jgravelle/jcodemunch-mcp/blob/main/README.md
- https://github.com/jgravelle/jcodemunch-mcp/blob/main/LICENSE
- https://github.com/jgravelle/jcodemunch-mcp/blob/main/src/jcodemunch_mcp/server.py
- https://github.com/jgravelle/jcodemunch-mcp/blob/main/src/jcodemunch_mcp/tools/search_symbols.py
- https://github.com/jgravelle/jcodemunch-mcp/blob/main/src/jcodemunch_mcp/tools/get_repo_map.py
- https://github.com/jgravelle/jcodemunch-mcp/blob/main/src/jcodemunch_mcp/tools/assemble_task_context.py
- https://github.com/jgravelle/jcodemunch-mcp/blob/main/src/jcodemunch_mcp/tools/find_similar_symbols.py
- https://github.com/jgravelle/jcodemunch-mcp/blob/main/src/jcodemunch_mcp/tools/get_group_contracts.py
- https://github.com/jgravelle/jcodemunch-mcp/blob/main/src/jcodemunch_mcp/tools/search_ast.py
- https://github.com/github/github-mcp-server
- https://github.com/bgauryy/octocode-mcp
- https://github.com/DeusData/codebase-memory-mcp
- https://github.com/probelabs/probe
- https://github.com/yamadashy/repomix
- https://github.com/PeiFeng877/githubsearchmcp
- https://github.com/ashish-tripathi57/RepoIntel
- https://github.com/TusharKarkera22/RepoMap-AI

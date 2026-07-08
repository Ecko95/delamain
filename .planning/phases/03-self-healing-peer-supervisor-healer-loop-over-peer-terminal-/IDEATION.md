# Phase 3 Ideation Record — How We Got Here (2026-07-08)

Conversation record for discuss-phase context. CONTEXT.md holds the design; this holds the reasoning and the decisions that shaped it.

## Origin

Session started as portfolio/next-project ideation. Four candidate ideas emerged, composing one thesis ("GSD gives structure → poka-yoke makes specs enforceable → evals measure outcomes → jidoka makes autonomy safe → self-healing is the capstone"):

1. **Agent evaluation harness** — measure whether AI-driven development produces better software (defect escape rate, spec drift, rework ratio, cost per shipped feature) from GSD/delamain/Claude Code traces.
2. **Self-healing production service** — agent gets paged instead of human: read trace, reproduce in worktree, propose fix, open PR.
3. **Poka-yoke spec compiler** — SPEC.md → executable deterministic CI gates (contract tests, schemas, invariants); spec drift mechanically impossible instead of LLM-judged.
4. **Jidoka layer / andon cord for agent fleets** — runtime abnormality detection over agent traces (thrash loops, scope creep, retry storms, cost anomalies) → freeze worktree, snapshot, page human with one-screen diagnosis.

## Grilling decisions (in order)

- **Prime goal:** potential product/startup (not just portfolio).
- **Wedge chosen:** jidoka safety layer (documented whitespace — funded AI-SRE vendors ship no circuit-breakers between agent and write path).
- **First user:** Joshua + Claude Code/delamain (dogfood via hooks/transcripts; OTel later).
- **Andon action v1:** detect + halt + diagnose (pause agent, snapshot worktree, one-screen why; no auto-remediation).
- **Detection v1:** deterministic rules only (same-file-edit counts, out-of-surface files, tool-error streaks, token/cost budgets, retry storms, test-pass regression). LLM judge deferred to v2.

## The kill

Joshua halted the product framing: *"why would people bother — they'll just go with whatever Claude or Codex recommends when something breaks."* Verdict accepted as correct:

- Platform vendors (Anthropic/OpenAI) will absorb agent guardrails natively within ~12 months; standalone gets sherlocked.
- Individual devs won't adopt/pay — re-prompting is good enough + zero setup.
- The surviving buyer (cross-vendor enterprise fleets needing vendor-independent audit) is unreachable for a solo founder.
- **Jidoka survives as a feature, not a company.** Generalized filter adopted: build things where the agent is the labor, not the subject.

## The pivot

Self-healing survives pointed *inward* at delamain — Joshua is user zero, pain is real (peers failing overnight and sitting dead), zero adoption friction (ships inside a tool he already runs). The jidoka trust rules (evidence-logged actions, retry ceilings, per-class earned autonomy) carry over as the design's non-negotiables.

## Research findings that shaped the design (3 background agents, 2026 sources)

- **AI-SRE landscape:** Resolve AI ($1.5B), Traversal, Cleric, PagerDuty SRE Agent, incident.io — all stop at investigation; autonomous remediation universally human-gated. Cleric's "earn autonomy per problem type" (accuracy demonstrated before write access, per failure class) is the trust model to mirror.
- **Failure data:** UC Berkeley MAST study (1,642 traces): 41–86.7% agent task failure; top categories step repetition 15.7%, reasoning/action mismatch 13.2%, requirement-following 11.8%. Tool-call failure 3–15% in production ⇒ near-certain failures in long chains ⇒ retry ceilings mandatory. Hallucinated-topology cascades (wrong service name → remediation aimed at wrong target) are the most-cited trust-killer ⇒ evidence-logged classifications.
- **Documented whitespace:** circuit-breakers/action budgets between agent and write path missing even in funded deployments; k8s auto-remediation credible only for narrow well-understood failure classes with dry-run-first rollout — mirrors our per-class enable + dry-run default.
- **Community sentiment:** trust is earned unidirectionally and slowly; recommended rollout = human manually executes/scores every suggested remediation before enabling auto-execution.
- **Eval/observability market:** consolidating fast (Langfuse→ClickHouse, Galileo→Cisco, Helicone→Mintlify); ~89% of agent teams have observability, only ~52% run real evals. Relevant later if healer accuracy scorecards ever become externally interesting.

## Deferred / future seeds

- Healer accuracy scorecard over time = the "earned autonomy" evidence; possible future public story after months of dogfooding.
- Poka-yoke spec compiler and evals harness ideas parked — revisit only through the "agent is the labor, not the subject" filter.

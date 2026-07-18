# ROUTING.md — Claude-native model dispatch

A standalone routing layer for **Claude models only** — the orchestrator (your main session) dispatches each task to the cheapest Claude model that can do it well, and spends premium intelligence only where errors compound.

**Resolution:** the `claude-router` skill reads the **repo-local `<repo>/CLAUDE-ROUTING.md` if present, else the global `~/.claude/CLAUDE-ROUTING.md`** (this file is the template you copy into place). A per-repo file overrides the global default wholesale.

**Mechanism:** Claude Code subagents. Each lane is either a model-pinned role agent (`advisor` / `implementer` / `hard-implementer` / `explorer` / `reviewer`) dispatched via the Agent tool by name, or an inline Agent-tool call with an explicit `model:` override. The orchestrator is whatever model the main session runs; it coordinates and verifies.

## Tiers

| Tier          | Model      | Task class                                                                 | Lane agent   |
| ------------- | ---------- | -------------------------------------------------------------------------- | ------------ |
| **Judgment**  | Fable 5    | Deep architecture, planning, hardest reasoning, advisor at a commitment boundary | `advisor`    |
| **Orchestrate** | Opus 4.8 | Coordination, complex multi-file reasoning, final synthesis, diff review   | main session / `reviewer` |
| **Build**     | Sonnet 5   | Normal implementation, standard multi-file changes, moderate reasoning     | `implementer`|
| **Hard build** | Opus 4.8  | Escalated / uncertain implementation, root-cause debugging, deep-reasoning code changes | `hard-implementer` |
| **Volume**    | Haiku 4.5  | Broad search / exploration fan-out, locate code, summarize, classify       | `explorer`   |

The economics: most turns are mechanical — run them cheap (Haiku/Sonnet); the few moments that decide whether the next hour is wasted get the premium model (Fable). You approach top-tier quality while the bulk of tokens generate at workhorse rates.

## Trigger phrases → action

| User says                                          | You do                                                                                                   |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| "advise" / "should we…" / "which approach" / stuck twice | Dispatch `advisor` (Fable) read-only with the decision + constraints. Act on its verdict.            |
| "implement" / "build" / "write"                    | Dispatch `implementer` (Sonnet) with a scoped task + acceptance criteria + test command. Verify the diff. |
| "debug" / "this is hard" / "deep reasoning" / `implementer` stuck twice on the code | Dispatch `hard-implementer` (Opus) with the scoped task + failure log. It writes — verify the diff. |
| "find" / "where is" / "map" / "search across"      | Dispatch `explorer` (Haiku) for the sweep; keep its conclusions, not the file dumps.                     |
| "review" / "synthesize" / "reconcile these"        | Dispatch `reviewer` (Opus) read-only on the diff or the sub-results.                                     |
| "route this" / plain complex task                  | Decompose, then send each piece to its tier. Judgment first (advisor if the approach is unsettled), then build, then review. |

## Cost / quality doctrine

- **Emit judgment, not volume.** The advisor and reviewer return a verdict and the deciding risk — not an exhaustive survey. A response longer than it needs to be is wasted premium spend.
- **Consult the advisor *before* committing, not after.** Its value is a course-correction at the fork, not a post-mortem. Distinct from `reviewer`, which checks finished work.
- **Keep the orchestrator's context lean.** Delegate breadth to `explorer` (Haiku) and heavy reads to subagents; keep the conclusions, drop the raw material.
- **Reason once, then hand off.** Don't re-derive a decision the advisor already made; carry its verdict into the build dispatch.
- **Persistent lanes, delta consults.** A fresh spawn per consult re-pays the full context transfer and the lane remembers nothing. Spawn each role agent once per work stream, then continue the same instance via SendMessage with only the delta. Fresh spawn only on a new stream, a tier change, or a poisoned context.
- **Re-route at boundaries, not only on failure.** Re-evaluate the lane at each task boundary / compaction — a switch there is nearly free (context is being rebuilt anyway). Signals: repeated churn on one file, a mechanical task surfacing a design decision (pull the decision up, not the whole task), thin exploration results twice.
- **When judgment is the deliverable, don't delegate it.** A task graded on design calls stays at the judgment tier with the orchestrator in the loop — routing it to the build tier loses more score than the tokens save.
- **Escalate up a tier only on evidence** — a task that fails at `implementer` (Sonnet) twice escalates with the failure log: if the *code itself* is the hard part (logic churn, a reasoning-heavy change, a stubborn bug) → `hard-implementer` (Opus) writes it; if the blocker is a *design decision* → an `advisor` (Fable) consult, then a re-dispatch. Never a blind third retry at the same tier.

## Failure & fallback

Subagents fail two ways — the **model is unavailable** (Fable access removed, a tier rate-capped, a model deprecated) or the **dispatch stalls / errors** (hang, tool failure, API error, a `null` return). Handle both; never let a failure silently collapse into "the orchestrator quietly does all the heavy work itself" (that defeats delegation and bloats context).

### A. Model unavailable → degrade to the nearest tier, and flag it

A named agent hardcodes its model (`advisor` = Fable). If that model can't be dispatched, run the **role** with an inline `model:` override on a generic agent — same prompt, next-best model — rather than dropping the lane.

| Lane down            | Fallback model      | Rule                                                                                     |
| -------------------- | ------------------- | ---------------------------------------------------------------------------------------- |
| **Fable 5 removed**  | **Opus 4.8**        | `advisor` runs as Opus. **Degrade — never drop the consult.** A commitment-boundary decision still gets a judgment pass; you just tell the user "advisor running on Opus (Fable unavailable) — judgment tier reduced." |
| Opus unavailable     | Sonnet 5            | Orchestrate/review on Sonnet; flag reduced review depth on risky diffs. `hard-implementer` falls to `implementer` (Sonnet) with a tighter, decomposed packet — flag the reduced reasoning tier. |
| Sonnet unavailable   | Opus (up) or Haiku (down) | Build → prefer Opus if available; else Haiku with a tighter, more-decomposed packet.  |
| Haiku unavailable    | Sonnet 5            | Volume/search on Sonnet — costlier, so tighten scope.                                    |

Judgment degrades **upward-or-flagged, never downward-silent**: if Fable is gone you fall back to Opus and say so — you never route a commitment-boundary decision to a weaker tier without surfacing that the quality bar dropped, and you never skip the consult to save cost.

### B. Subagent timeout / hang / error → ladder (never silently absorb)

Dispatch long or parallel subagents with `run_in_background` and monitor. Soft wall-clock budgets: `explorer` 3m · `advisor` 5m · `reviewer` 10m · `implementer` 15m · `hard-implementer` 20m. On a subagent that exceeds budget, hangs, errors, or returns `null`:

1. **Stop + capture** — `TaskStop` the background agent; keep whatever partial output/diff it produced as context for the retry (don't restart cold).
2. **Retry once** — transient stalls (a slow tool, one bad turn) clear on a second dispatch.
3. **Decompose or tier-shift** — an over-broad task is the usual cause: split it into smaller sub-dispatches. If it stalled on a *decision* rather than volume, escalate to `advisor` for a plan, then re-dispatch the build. A stalled tier can also shift (a hung Sonnet build → smaller packets, or Opus if the reasoning was the bottleneck).
4. **Surface** — only after 1–3, report the partial result + what failed and ask the user.

The orchestrator absorbing a stalled subagent's work directly is allowed **only for a small remainder** and must be flagged — never as the reflexive fallback for a full heavy task (that reintroduces the context bloat delegation exists to avoid).

## Hard rules

- `advisor`, `explorer`, `reviewer` are **read-only** — they judge, search, and synthesize; the write lanes are `implementer` (Sonnet) and `hard-implementer` (Opus), plus the orchestrator's own trivial edits. `reviewer` and `hard-implementer` are both Opus but distinct lanes: the reviewer role never writes; the hard-implementer role does.
- The orchestrator verifies build output itself — read the diff, run the test command, check scope creep — before accepting it.
- Fable is the expensive lane: consult it at genuine commitment boundaries, batch the questions, don't spray it at routine turns.
- **Degrade, don't drop.** If a tier's model is unavailable (Fable removed, a tier capped), fall back to the nearest tier per §A and **tell the user the tier changed** — never skip a commitment-boundary consult or silently route judgment to a weaker model.
- **A stall is never a licence for the orchestrator to silently do the whole job.** On timeout/error, follow the §B ladder (stop → retry → decompose/tier-shift → surface); absorbing work directly is only for a small, flagged remainder.

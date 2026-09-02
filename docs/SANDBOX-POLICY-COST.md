# What a sandbox policy costs

`sandbox: danger-full-access` and `approvalsReviewer: auto_review` are the two
settings that keep an unattended delegation cheap. Every other combination
spends the calling agent's context on approval round trips, and one of them
spends it for nothing.

The cost does not disappear when a policy tightens. It moves from Codex to the
agent that drives it, and the agent's context is the expensive half.

## The measurement

One audit prompt, `effort: high`, model `gpt-5.6-luna`, run five times against
this repository. Only the policy changed between runs.

Each run is named by its `sandbox`, `approvalPolicy` and `approvalsReviewer`:

- ① `read-only` · `never`
- ② `read-only` · `on-request` · `user`
- ③ `workspace-write` · `on-request` · `user`
- ④ `danger-full-access` · `on-request` · `user`
- ⑤ `read-only` · `on-request` · `auto_review`

| | ① | ② | ③ | ④ | ⑤ |
| --- | --- | --- | --- | --- | --- |
| Outcome | no answer | 8 findings, 1 false | 7 findings | 6 findings | 6 findings |
| Commands Codex ran | 6 | 79 | 76 | 42 | 48 |
| Mean command length | — | 96 chars | 119 chars | 235 chars | 167 chars |
| Approvals reaching the caller | — | 58 | 58 | 0 | 0 |
| **Codex tokens** | 115 202 | 2 217 349 | 2 839 500 | 5 193 750 | 3 915 311 |
| — reasoning | 1 029 | 9 723 | 8 768 | 12 812 | 11 210 |
| **Caller tokens** | 43 895 | 288 370 | 283 666 | 53 192 | 94 381 |
| Caller tool calls | 7 | 106 | 118 | 10 | 57 |
| Turn duration | 25 s | 835 s | 1 267 s | 611 s | 876 s |
| **Total tokens** | 159 097 | 2 505 719 | 3 123 166 | 5 246 942 | 4 009 692 |

## What the numbers say

**A policy that asks for approval makes Codex work in smaller pieces.** Under
`read-only` each command costs an approval round trip, so Codex issues 79
commands averaging 96 characters. Without a sandbox it packs reads into chains
and issues 42 commands averaging 235. The work is the same; the packaging is
not, and the packaging is what the token counts measure.

**`auto_review` moves the approval traffic without dropping the sandbox.**
Against run ②, which differs only in who answers approvals, the caller spends
a third of the tokens (288 370 → 94 381) and half the tool calls. Codex spends
77% more in exchange. No approval reaches the caller: a Codex subagent decides
each one and reports refusals through `progress.activity`.

**`workspace-write` loses on every axis.** It raised as many approvals as
`read-only`, spent 28% more Codex tokens, ran 52% longer, and found one finding
fewer. The write permission it grants goes unused by a read-only task.

**Approval traffic costs wall-clock time whoever answers it.** Runs ② and ⑤
took 835 s and 876 s. A subagent deciding an approval is no faster than a
caller deciding it — it is only cheaper for the caller's context.

**Finding quality does not follow token spend.** The cheapest working run (②)
produced the only false finding. Runs ④ and ⑤ each produced six findings with
none false, and each found something the other missed.

## Reading the first column

Run ① answered nothing, and the policy is not why. `approval_policy: never`
leaves no way to escalate, and a managed permission profile runs every command
under bubblewrap, which needs a user namespace. On a host that denies one —
inside a container, typically — every command dies with
`bwrap: No permissions to create a new namespace` before it starts. Where
bubblewrap works, `never` works.

This is what makes `on-request` the floor for a sandboxed run: an approval is
also the escape hatch when the sandbox itself cannot start.

## What this does not measure

One prompt, one model, one repository, one machine. A task that writes files
would use the permission `workspace-write` grants, and the ranking would
change. Caller tokens count a subagent's own context, not the orchestrator
turn that reads its report.

Codex token counts come from `total_token_usage` in the rollout log under
`~/.codex/sessions/`; command counts and lengths from its `CommandExecution`
items.

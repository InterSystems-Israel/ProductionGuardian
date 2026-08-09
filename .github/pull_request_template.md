<!--
Keep this short. The checklist exists to catch the three things that have actually
cost this project time, not to be ceremony.
-->

## What and why

<!-- One or two sentences. Link the issue or ADR if there is one. -->

## Verification

<!--
Paste the actual output, not a claim. "tests pass" is not evidence; the summary line
is. If something is unverified or failing, say which -- a green claim over a red build
costs the team more than the bug did.
-->

```
```

## Checklist

- [ ] Stayed inside my own area (`CONTRIBUTING.md` §2), or flagged the crossing explicitly
- [ ] No `contracts/` file edited as part of an implementation task
- [ ] Ran my area's typecheck / build / tests, and pasted the output above
- [ ] No invented data outside a declared fixtures directory
- [ ] No new dependency, or stated why and what it replaces

## If this touches `contracts/`

- [ ] `contracts/CHANGELOG.md` entry, dated, with the reason
- [ ] Consumer told what changes for them — and what does **not**
- [ ] `cd contracts && npm run validate` passes
- [ ] All three developers on the review (CODEOWNERS asks automatically)

## Scope

- [ ] Adds no capability from a later module — no fixing, root-cause, forecasting,
      single health score, report generation, or chat (root `CLAUDE.md` §2)

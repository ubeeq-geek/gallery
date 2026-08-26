# Frontend design-system adoption

The shared frontend system begins with `@gallery/design-system` and its isolated Storybook. Product capability configuration is presentational only: applications must still authorize every protected load and mutation on their own backend.

## Rules for new work

1. Use semantic CSS variables from `tokens.css`; do not introduce feature-specific brand colours or status colours.
2. Add accessible behavior to a primitive once, then compose it. Do not duplicate buttons, dialogs, field errors, or normalized status labels in feature code.
3. Keep provider vocabulary and requirements in provider flows. Pass stable, creator-safe view models to shared components rather than raw API payloads.
4. Represent each publication destination independently. A destination hold or failure must never imply deletion of the canonical Work.
5. Add deterministic Storybook fixtures for normal, loading, empty, restricted, degraded, failed, and reconciling states that the component supports. Never use credentials, real user media, internal moderation evidence, or random timestamps.
6. Verify keyboard use, narrow and wide layouts, reduced motion, long/localized content, and automated accessibility checks before adoption is complete.

## Component completion checklist

- [ ] Typed public props and events with documented surface ownership.
- [ ] Semantic/component tokens only, across every applicable product theme.
- [ ] Stories for supported state, permission, failure, density, and responsive cases.
- [ ] Unit or interaction coverage for non-trivial behavior.
- [ ] Automated accessibility check and manual keyboard review for complex controls.
- [ ] No app API client, secret, privileged response, or hidden runtime global dependency.
- [ ] Authority source, verification time, and safe next action are visible where material.
- [ ] Downstream visual baselines reviewed when shared tokens or behavior change.

Run `npm --workspace @gallery/storybook run storybook` for local review and `npm --workspace @gallery/storybook run build` for the deterministic CI artifact.

## Product configuration

Application shells must construct their browser-safe contract with `createProductConfig(productId, routes)` or validate serialized deployment input with `parseProductConfig`. Routes are explicit deployment input; shared defaults deliberately do not contain placeholder identity issuers. The parser checks presentation structure and rejects secret-shaped top-level keys, but successful parsing is not authorization and must never replace backend permission checks.

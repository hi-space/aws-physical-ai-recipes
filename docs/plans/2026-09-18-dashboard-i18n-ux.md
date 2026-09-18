# Dashboard i18n (ko/en) + UX pass — plan

**Goal:** every user-facing string in `dashboard/web` comes from a typed message catalog with Korean and English
variants; the locale is negotiated from the `pai-locale` cookie, then `Accept-Language`, and can be switched from the
sidebar without a reload. At the same time every page is reworked for information priority, plain terminology and
readability (larger type, more whitespace, collapsed secondary detail).

**Decisions (user, 2026-09-18):** browser-language auto-detect + sidebar toggle (cookie, no URL prefix); UX priorities =
in-page information density/priority, sidebar & terminology, type size/spacing; scope = all pages.

## Architecture

```
src/lib/i18n/
  define.ts            defineMessages({ en, ko }) — ko must have exactly en's keys (compile-time)
  index.ts             Locale, negotiateLocale, I18nProvider, useLocale, useSetLocale, useT(ns), translate(), useFormat()
  server.ts            resolveRequestLocale() from next/headers (root layout)
  messages/index.ts    catalog = { common, nav, overview, workflows, … }  (one module per page/component group)
```

- `useT('workflows')` returns `t(key, vars?)`; keys are typed from the `en` object; `{name}` placeholders.
- `DEFAULT_LOCALE = 'ko'` (product is Korean-first). Without a provider (unit tests) `useLocale()` falls back to
  `document.documentElement.lang` then `DEFAULT_LOCALE`, so existing render tests keep their Korean assertions.
- Locale switch writes `pai-locale` (1y, Path=/, SameSite=Lax) and updates `<html lang>`; `useFormat()` binds
  `ago/fmtTime/fmtDuration/fmtNum/fmtUsd/fmtBytes` to the locale (Korean: "3분 전", "1시간 6분").
- `StatusPill` shows a localized label for known workflow/k8s states (English = raw state).
- Server-returned texts (API error messages, builtin recipe descriptions) stay as they are in this pass; a follow-up can
  add `Accept-Language` negotiation to `/api/*`.
- Guard test: no Hangul literal is allowed in `src/components/**/*.tsx` or `src/app/**/*.tsx` outside
  `src/lib/i18n/messages`.

## UX rules applied to every page

1. `PageHeader`: title, one-sentence description, primary action(s) top-right. Destructive actions last, `danger`.
2. First screen answers the page's question (status/summary + the main table or DAG). Estimates, diagnostics and
   advanced settings go into a `Disclosure` (collapsed) or a tab.
3. One toolbar per entity for its actions; no action buttons floating between sections.
4. Tables ≤ 6 visible columns; secondary info as a muted second line. Empty state = title + hint + one CTA.
5. Type scale: body 14px, table 13px, captions 12px, headings 20px; controls 36px tall; card padding 16–20px.
6. Terminology: plain words first, AWS/K8s noun in parentheses only where the user must recognise it
   (e.g. "대기열 (Kueue)"). Sidebar: 4 groups — 홈 / 연구 / 클러스터 / 설정; unconfigured features are hidden.

## Work split

- **Core (main session):** i18n lib + catalog skeleton, root layout, Sidebar + language toggle, `ui/index.tsx`
  (typography, `Disclosure`, `Segmented`, localized primitives), `globals.css`, `format.ts`, `OverviewPage` as the
  reference conversion, i18n unit tests.
- **Parallel page groups (subagents), each owns its message modules and tests:**
  1. workflows: WorkflowsPage, WorkflowDetailPage, NewWorkflowPage, `components/workflows/*`
  2. data: DatasetsPage, DatasetDetailPage, ModelsPage, ExperimentsPage, StoragePage, `storage/S3Browser`
  3. cluster: ComputePage, QueuesPage, JobsPage, MetricsPage, UsagePage, `usage/*`, `compute/*`, `charts/*`
  4. admin-a: AdminPage, ProjectsPage, AccessPage, BackendsPage, ImageProfilesPage, ExecutionProfilesPanel
  5. admin-b: BuildsPage, WebhooksPage, EdgePage, PipelinesPage, PipelineExecutionPage, SessionsPage, `sessions/*`
- **Finish:** Hangul guard test, typecheck, unit suite, `next build`, e2e assertion updates, CDK deploy, screenshots in
  both locales, README + memory update, commit.

## Conversion brief (per page group)

Read first: `src/lib/i18n/index.ts`, `src/lib/i18n/messages/common.ts`, `src/lib/i18n/messages/overview.ts`,
`src/components/pages/OverviewPage.tsx` (reference conversion), `src/components/ui/index.tsx` (primitives incl.
`Disclosure`, `Segmented`, localized `StatusPill`).

1. **Messages.** Fill your namespace module(s) in `src/lib/i18n/messages/<ns>.ts` (already stubbed and registered).
   camelCase keys grouped by screen area; `{var}` placeholders; both locales complete (types enforce it). Reuse
   `common` for generic words (`tc('save')`, table heads, statuses) — **do not edit `common.ts`, `nav.ts`,
   `messages/index.ts`, `ui/index.tsx`, `format.ts`** (shared; other agents work in parallel). If you truly need a
   generic word that is missing, add it to your own namespace.
2. **Components.** `const t = useT('<ns>'); const tc = useT('common'); const { ago, fmtTime, fmtDuration, fmtNum, fmtUsd, fmtBytes } = useFormat();`
   Replace every user-visible literal (JSX text, `title=`, `placeholder=`, `aria-label`, toast/confirm/error strings,
   `<option>` labels, table heads, EmptyState/Spinner text). Non-hook helpers get the locale passed in or use
   `translate(locale, ns, key)`. Raw identifiers (IDs, ARNs, image URIs, k8s names, unit symbols) stay as they are.
   Status values render through `StatusPill`.
3. **Korean copy** stays close to the existing text (it was written on purpose); fix mixed-language sentences.
   **English copy** is plain product English, sentence case, no jargon dumps ("Runs", "Queue (Kueue)").
4. **UX.** Apply the rules in this document: header with primary action; the main table/status first; estimates,
   diagnostics, raw JSON/YAML, advanced settings in `Disclosure` (collapsed) or a tab; one toolbar per entity;
   destructive actions last as `variant="danger"` with `confirm()`; ≤ 6 table columns; `text-[10px]/text-[11px]`
   → `text-xs`, body copy `text-xs` → `text-sm`/`text-[13px]`; consistent `space-y-5` between sections.
   Do not change data contracts, API paths, query keys, or behaviour that tests rely on.
5. **Tests.** Update the tests for your files (unit `.test.ts` and `.browser.test.ts`); they render without a
   provider, so the default locale is Korean — assert the Korean strings you wrote (or use a regex accepting both).
   Verify: `npx tsc --noEmit`, `npx vitest run <your test files>`, and
   `grep -rnP "[\x{AC00}-\x{D7A3}]" <your tsx files>` must print nothing.
6. Work only in the shared working tree files listed for your group; several files already contain uncommitted
   changes from another session — keep them. Do not commit.

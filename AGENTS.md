# AGENTS.md

Guide for coding agents working on **Strata**, the Android-only Expo fork of Pulse Mobile at `https://github.com/oupadhyay/strata-mobile`. Lose It! food logs, Fitbit activity and weigh-ins arrive through read-only **Health Connect**. Intake/weight expenditure estimates and health scores run on the phone; data stays in local storage unless the owner explicitly exports it or uses an optional AI feature. There is no app server, account or Google sign-in.

The inherited Health Connect, storage and scoring architecture comes from **halo** (`~/personal/halo`, when available). Follow its architecture without overwriting Strata's deliberate nutrition/exercise changes. The UI retains Pulse's shells, styling and existing product copy; the launcher is **Strata Test**, package `io.github.oupadhyay.strata`. Background and migration history is in `docs/rewrite-plan.md`; Strata decisions are in `docs/design/spec.md` § Nutrition and the Strata sections of `docs/learning.md`.

## Repository and delivery

- Work from this repository's root. New Amp orbs clone Strata directly; older threads used a nested `strata-mobile/` checkout. Do not create another nested clone or apply their old patches without comparing current `origin/main`.
- `c5c130d` integrated completeness review, calibrated/provisional daily net, trends, weight goal, diagnostics and expanded exercise coverage. The earlier BMR-plus-HR daily-net implementation was superseded, not left unfinished. Preserve the current model contracts below.
- `AGENTS.md` is canonical; `CLAUDE.md` includes it. Update this file rather than adding a second agents guide.
- Keep personal health exports, credentials, SQLite files, generated diagnostics, local previews and disposable APKs out of Git. `/.amp/in/`, generated native folders and dependencies are ignored; dependency fixes in `patches/` are intentional tracked files. Review staged paths before committing.

## Expo has changed: do not trust your training data

Expo ships breaking changes every SDK release. APIs you remember are likely renamed, moved, or removed. Before writing any code that touches an Expo, EAS, or React Native API:

1. Read the major version of the `expo` package in `package.json` (SDK 57 today, React Native 0.86).
2. Fetch the matching versioned docs: `https://docs.expo.dev/versions/v<major>.0.0/`
3. For anything else, fetch https://docs.expo.dev/llms.txt, an index of all Expo docs with corrections to common LLM misconceptions. Follow its links to the specific page you need. Never answer from memory.

## Commands

| Command | What it does |
|---|---|
| `./.agents/setup` | Prepare Debian's default JDK (17 on Debian 12, 21 on Debian 13), SDK/build-tools 36, NDK 27.1.12297006, CMake 3.22.1 and frozen dependencies on x64; no APK build or server startup |
| `./scripts/build-test-apk.sh` | Build and verify a standalone ARM64 test APK with bounded Metro/native/R8/lint memory; never installs or publishes |
| `pnpm install --frozen-lockfile` | Install the committed dependencies and patches, using `package.json`'s pnpm version |
| `pnpm start` | Dev server (`expo start`) |
| `pnpm android` | `expo run:android`: build and run a development build on an emulator or a device (needs Android Studio) |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint` | ESLint |
| `pnpm test` | Vitest in Node (`src/**/*.test.ts`, `scripts/**/*.test.ts`) |
| `npx expo install <pkg>` | Add a dependency. Always use this instead of `pnpm add` for anything native: it picks the version that matches the SDK |
| `npx expo install --fix` | Fix package versions that do not match the SDK |
| `npx expo-doctor` | Diagnose dependency and config issues |
| `npx expo export --platform android --output-dir <tmp dir>` | Bundle check: Metro builds the Android bundle. Use a directory outside the repo and delete it after |
| `npx eas-cli@latest build --profile development` | Cloud development build (profiles in `eas.json`: `development`, `preview`, `production`) |

Run `pnpm typecheck && pnpm lint && pnpm test` before every commit. Run the bundle check when you change `babel.config.js`, `metro.config.js`, `app.json`, or add a dependency.

### Setup and Android build lessons

- CI uses Node 24; use the pnpm version in `package.json`. JS validation does not need Java or an Android SDK. If setup has not run, create the ignored `expo-env.d.ts` containing `/// <reference types="expo/types" />` before typechecking, as CI does; without it Reanimated CSS styles appear mistyped.
- Setup uses `default-jdk-headless` from the configured Debian repositories: Java 17 on Debian 12/bookworm and Java 21 on Debian 13/trixie. Do not request the removed trixie Java 17 package or repoint apt sources. `.agents/android-env` preserves a valid explicit `JAVA_HOME`; otherwise it resolves the installed `javac` symlink, replacing stale paths. Test activation in a fresh repository-root login shell, not only the setup process.
- The builder sources `.agents/android-env` and generates the ignored Android project with Expo. Gradle worker limits alone do not constrain Ninja or Metro: retain the script's CMake job pool, single Metro worker and separate bundle/source, R8 and assembly/lint heap budgets. Keep optimization, resource shrinking and vital lint enabled.
- Output is `.amp/in/artifacts/strata-test-<version>-arm64-v8a.apk`, with embedded Hermes and no Metro/EAS account required. The builder checks signature, 16 KiB ZIP alignment and archive integrity. It uses the template debug key for personal testing, not production signing or a store release.
- A phone update needs the same package and signer; install over the existing Strata Test app to preserve data. Do not uninstall, clear data or reset Health Connect permissions as a troubleshooting shortcut. No phone install, release or publication is implied by building an APK.

## Layout

```
app/          Expo Router routes: one file per screen, _layout.tsx files are navigators. Routes live in the root app/, not in src/.
src/
  health/     Health Connect: permissions, record → row mapping, sync, data check (halo)
  data/       the Store interface, the async expo-sqlite store, the in-memory store for tests, the demo seed (halo)
  core/       pure TypeScript: engine/ (the Pulse engine, from the reference study: every score the screens show), scoring and algorithms (halo's, kept for the extras listed in docs/engine-plan.md Phase 7)
  pipeline/   stage 1 and stage 2: imported rows to stored scores (halo)
  queries/    inherited view models plus fork-specific extras; nutrition.ts and nutritionExtras.ts own nutrition views
  nutrition/  calorie/macro target parsing and resolution; state/nutrition.ts persists target preferences
  lib/        time, yield (time slicing), format, bands, reasons, url and the UI catalogues
  state/      app.ts: boot, status, the sync run, the data version, the query and action contexts
  background/ shared sync + scoring, lock, WorkManager task, alerts and settings
  actions/    writes: journal, log, dashboard, profile, preferences, export, calendar
  screens/    the screens, built from src/ui; useScreen.ts is the view-model cache
  ui/         tokens, shells, kit, charts
  dev/        development screens (kit); the routes in app/dev/ load them in development builds only
plugins/      config plugins (withHighRefreshRate)
scripts/      release tooling
docs/         rewrite-plan.md, plan.md, design/spec.md, learning.md, onboarding.md, runbooks
```

## Rules

- **Health Connect only, Android only.** No Google sign-in, cloud health-data source or iOS config. The app asks for Health Connect read permissions only and never writes to Health Connect. Lose It! remains the food logger; do not add a new nutrition service to fill import gaps.
- **No auth.** No accounts, no login screen, no user ids.
- **Owner's own name and photo are fine.** The rule against storing a Google account's email, name or picture is about Google accounts. A display name and photo the owner types or picks (Settings › Profile) stay in the profile, the photo as a file in the app's document directory; neither leaves the phone.
- **Only `src/data` touches SQLite.** Everything else goes through the `Store` interface (`src/data/store.ts`). Tests use the in-memory store (`src/data/memory.ts`).
- **No I/O in `src/core`.** Pure TypeScript only: no database, no network, no clock reads, no React.
- **The reference study is the reference for `src/core/engine`.** The Pulse engine's kernels follow the study at `~/personal/pulse/docs/research/bevel/` (start at `pulse-gaps.md`), with the fixes in `docs/engine-plan.md`. Code, comments, copy, commits and docs call it the Pulse engine and never name the app the study describes; comments cite it as "reference study, `<doc>.md` § `<section>`".
- **halo is the inherited reference elsewhere.** Preserve its Store/pipeline boundaries in `src/health`, `src/data`, `src/pipeline`, `src/queries` and the old scoring/algorithm modules. Keep fork-specific additions separate where practical (such as `nutritionExtras.ts`). The committed Strata code, tests and documented model decisions govern nutrition and exercise behavior, not an upstream copy or an archived patch.
- **No secrets in logs.** Never log health-record bodies or keys. Optional AI-provider keys live only in `expo-secure-store`. The owner-requested Data check export is sensitive health data, not a fixture to commit.
- **Honest states.** Every nullable metric is `{ value, reason, provisional }`, using the reason codes in `src/lib/reasons.ts`. Never show a fabricated number. Where a source has no data for a card, hide the card or show its reason; never invent a value.
- **Scales.** Strain is a percent: 0 to 100 on most days, up to about 129; rings fill at 100 and labels show the real value. Recovery is 1 to 100, Stress and the Sleep Score 0 to 100, Energy Bank 1 to 100. Halo's Effort (0 to 100) still feeds halo's extras only. Recovery's `sleepPerf` is on [0, 1].
- **Causality.** A day's scores depend only on that day and earlier days. Baselines fold from earlier nights only. Never let a later night change history.
- **Scoring version.** A change to what the pipeline stores bumps `SCORING_VERSION` (`src/pipeline/types.ts`), which rescores the history. A change to the import mapping bumps `IMPORT_VERSION` (`src/health/sync.ts`), which re-imports the history window.
- **Long loops yield.** The import and the pipeline await `slice()` (`src/lib/yield.ts`) in long loops so taps and frames get through.
- **UI.** The look is the pulse PWA's. Build from the shells and kit in `src/ui`, using NativeWind classes and the tokens. Spec decisions and deviations live in `docs/design/spec.md`. A screen that needs a changed view-model field adapts its code, not its look.
- **Copy.** User-facing text goes through i18n keys (docs/i18n.md); no literal copy in components. It says Pulse, Pulse Age and Health Connect. Where the reference study and WHOOP (noop, `~/personal/noop`) name the same feature differently, the screens use WHOOP's name: Sleep Performance (the study's Sleep Score), Sleep Debt (Sleep Bank), Sleep Need (Sleep Needed), Strain Target (Target Strain), Training Load (Cardio Load), Stress Monitor (Stress). Biological Age is Pulse Age; Energy Bank keeps its name (WHOOP has none).
- **Shared files.** The `Store` interface, the UI tokens and the kit's exports change only in the orchestrating session, between waves. A stream that needs a change asks for it in its report.
- **No native edits.** `android/` is generated (Continuous Native Generation) and git-ignored. Never create or edit it by hand. Configure native behavior in `app.json` and config plugins.
- **Development builds.** Health Connect is a native module, so the app needs a development build (`pnpm android` or `npx eas-cli@latest build --profile development`), not Expo Go.
- **Prefer Expo modules** over third-party libraries. Docs: https://docs.expo.dev/versions/latest/index.md

## Nutrition and exercise contracts

- **Import one food source per local day.** `src/health/import.ts` prefers Lose It!, then MyFitnessPal, then one fallback origin; never sum mirrored device/logger records. Use local-day/DST boundaries, not UTC dates. Health Connect supplies intake, not another app's calorie/macro goals or Lose It!'s Done Logging state.
- **Known total is not complete intake.** The bridge maps absent energy to zero, so positive macros with missing/zero energy trigger `nutrition_missing_energy`. Keep known calories visible as partial; do not infer missing calories from macros or use an incomplete subtotal for expenditure/remaining food. Diagnose mismatches with the existing Settings → Data source → Data check's raw-versus-stored records, origins and timestamps before changing import arithmetic.
- **Review survives re-import.** Profile `nutrition.completeDays` overrides automatic missing-energy detection; `excludedDays` wins over confirmation. Use the shared `incompleteDay`/`intakeOf` policy across hero, charts, averages, health shortcut and model inputs. Review never rewrites imported values or creates an absent total.
- **Calculated daily net is intake minus whole-day intake/weight expenditure.** `src/core/algorithms/expenditure.ts` owns the causal fit: 28-day window, seven-day exponential half-life, seven weigh-ins spanning at least 14 complete elapsed intake intervals, latest weight at most seven days old. Today's food enters tomorrow's fit. Missing/excluded intake breaks the interval; reject fits outside 800–8,000 kcal/day rather than clamping. Held estimates are explicitly stale and do not supply fresh daily net. The 7,700 kcal/kg conversion is an approximation, not measured fat loss.
- **Early net is display-only.** Two weigh-ins spanning seven days can supply `preliminaryTdee` during initial calibration, labeled provisional/low confidence. It never feeds calibrated baselines, targets, remaining food, calibrated Energy balance bars or the fixed original plan. Neither daily-net series displays unfinished today, incomplete intake or missing inputs; explicit zero stays zero. Never add BMR, exercise or wearable calories to calculated whole-day expenditure.
- **Wearable net is a separate comparator:** intake − (estimated Mifflin–St Jeor BMR + Health Connect `active_calories`). `metrics.calories` is total burn and already includes rest. Do not add BMR to total burn, call the daily aggregate Fitbit-exclusive, or convert a discrepancy into extra food allowance. The BMR guard uses age 19–78, height and a preceding weight within 30 days.
- **Exercise energy is not TDEE.** `exerciseEnergy.ts` prioritizes eligible Keytel HR, named general/moderate Compendium METs, then minute-level wearable intervals without overlapping credit. HR is limited to steady cardio, 90–150 bpm, age 18–45 and 47–120 kg; a sample covers at most 60 seconds. METs require weight and age 19–59. Generic Activity/Racket sports/OTHER_WORKOUT does not identify a sport: follow wearable at 1×, not an invented MET or multiplier. HR availability, modeled minutes and total covered minutes are different quantities.
- **Compare gross exercise on the same basis.** Wearable total energy already includes resting energy; active-only fallback adds estimated 1-MET rest. Never turn hourly/daily energy totals into measured minute coverage. Import v10 persists original ≤60-second intervals, proportionally clipped to workouts, in nullable JSON `exercises.calorie_intervals`; source choice prefers the workout writer, then coverage, with stable ties. `Exercise.calories` remains the old active-only aggregate. Preserve migration and real SQLite round-trips, not just MemoryStore behavior.
- **Trends and goal are estimates.** Seven-/30-day net means compare equal completed calendar windows with both usable-day coverages; omit unknowns rather than zero-filling or backfilling calibration. HR scans stay seven days even when daily history is longer. Weight-goal ETA uses observed smoothed weight pace, not the calorie target: three weigh-ins spanning 14 days within 28, latest within seven; sparse/stale/near-flat/away states withhold ETA.
- **Keep storage responsibilities separate.** Calorie/macro preferences use `state/nutrition.ts` AsyncStorage (`pulse.nutrition.targets`); review dates, fixed original plan and optional `goalWeightKg` use the profile's SQLite JSON. Goal edits preserve review/plan fields and do not alter food targets; blank removes the goal. All weights are stored in kg and converted through `quantity` for display/input. Percentage macro splits resolve against the current calorie budget; gram overrides stay fixed.

## Git

- Use the `git` CLI only, never `gh`.
- Commit as `adityaongit`, email `74150665+adityaongit@users.noreply.github.com`. Check `git config user.email` before committing.
- Conventional commit messages, signed off (`git commit -s`).
- When pushing is authorized, fast-forward `origin/main` after validation; never force-push. Runtime/UI changes also need the owner's phone check; documentation-only changes need no replacement APK. Verify the remote head after pushing and state whether GitHub CI actually ran: no checks is not a pass. The tracked `.github/rulesets/main.json` is not evidence that GitHub enforces those settings.

## Testing

- Vitest runs in Node. Store, pipeline, health and query tests run on the in-memory store (`MemoryStore`), most over halo's 180-day demo seed (`seedDemo`) scored by `runPipeline`.
- Algorithms get golden-value or property tests beside the file. Queries and actions get tests on the in-memory store.
- Nutrition regression coverage lives in `src/core/algorithms/{expenditure,exerciseEnergy}.test.ts`, `src/health/import.test.ts` and `src/queries/calorieBalance.test.ts`; extend the owning tests. Exercise missing-vs-zero inputs, review precedence, causality, profile boundaries, overlap and midnight/DST clipping with asymmetric data.
- No local e2e and no device automation. The owner checks on a phone. Browser adapters can inspect actual components with synthetic data, but do not prove Android keyboard, touch, persistence or Health Connect behavior. Report local checks, APK verification, phone evidence and GitHub CI separately; coverage validation is not physiological calorie-accuracy validation.

## Docs

- Explanations, runbooks and guides are markdown in `docs/`. Use mermaid flowcharts for flows and architecture.
- Keep `docs/learning.md` current: when you make an Expo or React Native choice, add one short section.
- `docs/onboarding.md` describes the first run; `docs/rewrite-plan.md` the move to Health Connect and halo's engine.

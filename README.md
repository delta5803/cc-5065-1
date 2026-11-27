# Multi-Strategy Lighting Experiment

A self-contained, dependency-free implementation of a **multi-strategy direct
lighting integrator** with real HDR output, exposure-to-exposure light-table
history handling, and a browser experiment window.

Both sampling techniques estimate the *same* integral over the current
emitting zone:

```
I(x) = ∫_zone  L_e(y) · fr(x, wo→wi) · V(x,y) · G(x,y)  dA(y)
G(x,y) = |cosθ_x| |cosθ_y| / |y − x|²,   wi = (y − x)/|y − x|
```

* **Light technique (L)** — sample `y` uniformly (or as a mixture) on the
  emitter in **area** measure.
* **Material technique (M)** — sample `ω` from the BRDF mixture in
  **solid-angle** measure, trace to `y`, then convert its density to area
  measure before combining:

  ```
  p_M,area = p_ω · cosθ_y / |y − x|²
  ```

The MIS weights use the **balance heuristic in the common area measure**:

```
w_L = p_L / (p_L + p_M)      w_M = p_M / (p_L + p_M)
```

Zero densities are handled explicitly: if the other technique's density is
zero, the first receives full weight. Emission is always resolved against the
**current** exposure's bright zone, never a retained table.

## Sampling-probability interface

Direction sampling, probability density, and contribution assessment are
separate modules, joined by an explicit sampling record:

| Module | Responsibility |
| --- | --- |
| `src/measure.js` | The measure/event vocabulary: `AREA`, `SOLID_ANGLE`, `POINT_MASS`; `CONTINUOUS`, `DELTA`; `pdfOmegaToArea` / `pdfAreaToOmega` / `jacobianCosOverDist2`; `comparableByDensity`. One place defines what a measure is. |
| `src/probability.js` | The inspectable probability interface. A sampler hands back `{ measure, eventType, selectionProb, density }`; `misCombine` decides comparability and returns `{ weight, comparable, reason }`. |
| `src/brdf.js` | `materialEventProbabilities`, `sampleMaterial(..., { forceEvent })` — returns either a `CONTINUOUS` event (density in `SOLID_ANGLE`) or a `DELTA` event (`POINT_MASS`, density 0, selection probability only). |
| `src/integrator.js` | `sampleLightDirection` / `sampleMaterialDirection` (phase 1), then `assessLightContribution` / `assessMaterialContribution` (phases 2+3), then combine. |

The **discrete mirror lobe** (`deltaMix ∈ [0,1]`) gives the same shading point
both a *continuous diffuse/GGX density* and a *discrete (point-mass) reflection
event*. This is the case the interface exists for:

* A **continuous** event has a real density, is converted between measures with
  the Jacobian, and is divided by its density (times its selection probability)
  in the estimator.
* A **delta** event has **no density**. It carries a **selection probability**
  `q` and is divided by `q` only — **never** by a continuous density and never
  Jacobian-converted. `misCombine` returns full weight for a delta (it is not
  comparable to a continuous density) and `test_probability.js` checks that
  dividing a point mass by a continuous density, or applying the Jacobian to it,
  is biased.

Weights are computed from those explicit inputs; nothing is hidden behind a
fixed constant. The refactor is a **boundary on external behaviour**: for the
default `deltaMix = 0` scene the multi-strategy estimate is bit-identical to the
pre-refactor kernel (`tools/test_freeze.js` checks this against golden sums).

## What the code delivers

| Concern | Where | How |
| --- | --- | --- |
| Real HDR linear image | `src/integrator.js` `renderImage`, `src/display.js` | float buffers; tone map only at display |
| Move the bright/mask boundary between exposures | `ui/index.html`, `src/exposure.js` | two sliders set the bright rectangle; "Set new exposure" advances history |
| Weighting sample hit by the *same* exposure's light density | `src/integrator.js` `lightSample`/`materialSample` | proposes from `exposure.proposal`, never a stale table |
| Reweight old table only when it still covers the full support | `src/exposure.js` `advance` | `reweight-all` vs `drop-uncovered` vs `discard-history` |
| Never use a table that gives zero probability to new bright area | `src/exposure.js`, `src/lighttable.js` | `tableCoversZone`, `zoneCoveredBy`, `reweightTable` |
| Per-region energy vs per-region quadrature | `src/integrator.js` `buildRegions`, `quadrature`; UI table | split by overlap with retained zones; full total *and* each region shown |
| Same integration domain across measures | `src/integrator.js` `auditMeasures` | both techniques vs deterministic quadrature over the current zone |
| Area↔solid-angle Jacobian, visibility, zero pdf | `src/measure.js` (`pdfOmegaToArea`, `pdfAreaToOmega`), `tools/test_jacobian.js` | explicit conversion + exact round-trip test |
| Separate sampling / density / contribution | `src/integrator.js` `sampleLightDirection`, `sampleMaterialDirection`, `assessLightContribution`, `assessMaterialContribution` | phase 1 samples, phases 2+3 assess; the record carries `eventType`, `measure`, `selectionProb` |
| Inspectable selection probability vs direction density | `src/probability.js` `materialContinuousEvent`, `materialDeltaEvent`, `misCombine` | one interface; a delta is divided by selection probability only, never by a density |
| Simultaneous discrete + continuous reflection | `src/brdf.js` (`deltaMix`), `src/integrator.js` | mirror delta event and diffuse/GGX density at the same direction; separate renderings and combined estimate agree (`tools/test_probability.js`) |
| Not "average two images and call it done" | `src/integrator.js` | each technique normalised by its **own** sample count; MIS shares sum |
| Fixed seed sequence + high-sample reference | `src/rng.js` (sfc32), `tools/validate.js`, UI "reference overlay" | per-pixel deterministic streams; quadrature reference |
| Inspect a chosen light path's weight | UI "Selected light path" panel; record is emitted per probe pixel | shows `w`, `p_L`, `p_ω`, `p_M(area)`, `cosθ_y`, `dist`, contribution, reason |
| Vary light size, position and roughness | UI "Light board" + sphere sliders | rebuilds geometry |
| Visible run state + anomaly flags | UI "Event split / run health" panel; `ui/worker.js` `assessRunHealth` | lighting-image yes/no, noise measured, continuous vs discrete energy; warns on blank/non-finite image or a delta lobe that never reaches the emitter |
| Compare single vs combined strategy mean/variance/cost | UI "Run unbiasedness check"; `tools/validate.js` | several independent seeds, bias %, sd, RMSE, ms |
| UI launches and shows image + noise | `ui/index.html` | see below |

## Launch the window

There is **no build step and no npm install**. Node 16+ (for the static server)
and any modern browser.

```bash
# from the repository root
node tools/serve.js            # -> http://localhost:8080/
# or a custom port
node tools/serve.js 9000
```

Then open `http://localhost:8080/`. The entry page is `ui/index.html`; the
server maps `/` to it. The page loads ES modules from `src/` and
`ui/worker.js`, so it must be served over HTTP (not opened as `file://`).

### How to use it

1. **Start sampling** draws the current exposure with real sampling. The image
   is updated every pass; the metrics show mean linear luminance, relative
   noise (measured across independent passes, not on the tone-mapped picture),
   ms/pass and total samples.
2. **Estimator** buttons switch between `Combined (MIS)`, `Light only`,
   `Material only` — same seed so differences are the estimator, not luck.
3. **Move the boundary**: drag *Bright zone u0* / *u1* / *height v1* and click
   **Set new exposure boundary**. The **Proposal / decision** panel states
   exactly what happened to the old table (`reweight-all`, `drop-uncovered`,
   `discard-history`, `add-covering-component`) and the coverage of each
   proposal component.
4. **Light board** sliders change light size and position; sphere sliders change
   roughness/metallic/`deltaMix`. **Apply scene changes** rebuilds geometry
   (history resets, because a different board has a different parameterisation).
5. **Discrete mirror lobe** slider (`deltaMix`, 0–1) gives the sphere a
   point-mass reflection in addition to its continuous diffuse/GGX density. At
   `deltaMix > 0` the same shading point has both a continuous and a discrete
   event; the **Event split / run health** panel shows the energy each carries.
6. **Show reference overlay** paints the per-pixel relative error against the
   deterministic quadrature reference (blue = agree, red = disagree).
7. **Measure audit** runs both techniques against the quadrature over the same
   zone and reports each one's distance from the reference as a **z-score over
   12 pooled independent seeds** (raw % shown too). A large raw % with a small
   z is variance, not bias; the panel says which.
8. **Run unbiasedness check** runs 16 independent seeds at a 96×64 validation
   camera for all three strategies at two sample counts and prints bias, z
   (with the reference's own convergence error folded in) and RMSE. All rows
   within 3σ means consistent with unbiased at that sample count.
9. **Selected light path** — move the probe pixel sliders; the first recorded
   light and material samples at that pixel are listed with their MIS weight,
   `eventType`, `measure`, `selectionProb` and density conversion, including why
   a sample was rejected (masked, occluded, zero pdf, …).
10. **Event split / run health** — shows run state and flags anomalies: whether a
    lighting image was produced, whether noise was measured, continuous vs
    discrete (point-mass) energy and hit counts, and warnings for a blank or
    non-finite image, or a delta lobe that never reaches the emitter.

**The command line only aids multi-strategy lighting.** The interactive
multi-strategy lighting window is the graphical entry point — `node tools/serve.js`
then open `http://localhost:8080/` (see *Launch the window* above). The Node
scripts below are supporting evidence, not a substitute for the window.

## Headless verification

The same kernel runs in Node. These scripts are the evidence, not the UI:

```bash
node tools/validate.js        # reference, convergence, per-region, exposure transition
node tools/test_brdf.js       # BRDF sampler vs deterministic hemisphere integral
node tools/test_jacobian.js   # area<->solid-angle Jacobian round-trip + mass
node tools/test_freeze.js     # default-scene estimate bit-identical to pre-refactor kernel
node tools/test_probability.js # selection prob vs density split; discrete+continuous agreement
node tools/run_clean.js       # reruns the above in a pristine temp dir (no data files)
node tools/test_audit_bias.js # both techniques vs quadrature, mean ± se
node tools/test_policy.js     # grow/shrink/disjoint exposure sequences vs quadrature
node tools/test_worker.js     # exact UI worker message path in Node
node tools/browser_test.js    # real headless Chrome: drives the window end to end
```

`tools/validate.js` prints, for each strategy and sample count, the mean over
20 independent runs, its bias from the deterministic reference, the variance of
those means, and the RMSE, plus cost in ms. It also reports per-region energy
(sampler vs quadrature) for each exposure, so a whole-image mean that happens
to cancel cannot pass.

The reference is checked for convergence rather than assumed: `validate.js`
computes the shading sum at quadrature grids 128/192/256 and uses 256, printing
the 192→256 change (its own uncertainty). This matters because the visibility
step — the sphere occluding part of the emitter — makes low-grid quadrature
undershoot by several percent, which would otherwise flag a *correct* sampler
as biased.

## Layout

```
src/
  math.js        vectors, frames, reflection
  rng.js         sfc32 streams, per-pixel deterministic seeding
  scene.js       plane/sphere geometry, emission/mask control map, trace/visibility
  measure.js     measure/event vocabulary, area<->solid-angle Jacobian
  probability.js sampling-probability interface: events, selection prob, MIS combine
  brdf.js        Lambertian + GGX mixture (+ optional mirror delta), eval/sample/pdf
  lighttable.js  weighted rect-union tables, coverage, reweighting, proposal mixture
  exposure.js    exposure history controller and decision log
  integrator.js  phase-1 samplers, phase-2/3 assessors, MIS, regions, quadrature, audit
  display.js     tonemap and per-pixel error image
  setup.js       default scene/camera/exposures
ui/
  index.html     experiment window (event split / run health, discrete lobe slider)
  styles.css
  app.js         UI controller (all numbers/images come from the worker)
  worker.js      runs the kernel off the main thread; reports lobe split + run health
tools/
  serve.js       zero-dependency static server
  validate.js, test_*.js, debug_*.js, run_clean.js, browser_test.js
```

## Notes on honesty of the results

* Noise is measured on linear values across independent passes; the tonemap is
  display-only.
* **The deterministic reference is validated for convergence, not assumed.**
  `validate.js` compares quadrature at grids 128/192/256 and uses 256. The
  visibility step (sphere occluding the emitter) makes coarse grids undershoot
  by several percent; against an under-resolved reference a correct sampler
  looks biased. This was observed and fixed: an earlier grid-96 reference
  produced spurious "OUTLIER (5.6σ)" labels that disappeared once the reference
  converged.
* **The measure audit judges bias from the pooled mean over independent seeds.**
  Within a single run the light technique is heavy-tailed (one firefly can make
  a run's own variance tiny while that run is far off), so a within-run
  standard error is not trustworthy. `auditMeasures` runs 12 seeds and forms the
  standard error of their *mean*; a deviation that survives pooling is bias,
  variance is covered by the band. The UI prints a z-score and says "consistent
  with reference" or "inconclusive" rather than colouring a raw percentage as a
  failure — a light estimate can be 20% off at one spp and still be consistent
  (it converges as spp grows).
* **The UI's cumulative check runs on a 96×64 validation camera.** At 384×256
  the quadrature does not converge well even at high grids, so its own error
  would exceed the bias under test. The kernel, scene and exposure are identical;
  only the validation resolution differs, which does not affect unbiasedness.
  The reference's convergence uncertainty is folded into the z-score.
* The two Monte Carlo estimates are *not* compared to each other as a
  correctness proof, because their variances differ by orders of magnitude on
  glossy surfaces (the light technique is heavy-tailed there; the material
  technique is not). Each is compared to the deterministic quadrature.
* The light technique is unbiased but high variance near mirrors; the material
  technique is low variance but misses emitters outside the sampled lobe. MIS
  takes the better of the two per sample, which is why the combined variance is
  below either single technique in the cost-normalised tables.

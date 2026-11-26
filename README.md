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
| Area↔solid-angle Jacobian, visibility, zero pdf | `src/integrator.js` (`pdfOmegaToArea`, `pdfAreaToOmega`), `tools/test_jacobian.js` | explicit conversion + exact round-trip test |
| Not "average two images and call it done" | `src/integrator.js` | each technique normalised by its **own** sample count; MIS shares sum |
| Fixed seed sequence + high-sample reference | `src/rng.js` (sfc32), `tools/validate.js`, UI "reference overlay" | per-pixel deterministic streams; quadrature reference |
| Inspect a chosen light path's weight | UI "Selected light path" panel; record is emitted per probe pixel | shows `w`, `p_L`, `p_ω`, `p_M(area)`, `cosθ_y`, `dist`, contribution, reason |
| Vary light size and roughness | UI "Light board" + sphere roughness/metallic sliders | rebuilds geometry |
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
   roughness/metallic. **Apply scene changes** rebuilds geometry (history
   resets, because a different board has a different parameterisation).
5. **Show reference overlay** paints the per-pixel relative error against the
   deterministic quadrature reference (blue = agree, red = disagree).
6. **Measure audit** runs both techniques against the quadrature over the same
   zone and reports each one's distance from the reference as a **z-score over
   12 pooled independent seeds** (raw % shown too). A large raw % with a small
   z is variance, not bias; the panel says which.
7. **Run unbiasedness check** runs 16 independent seeds at a 96×64 validation
   camera for all three strategies at two sample counts and prints bias, z
   (with the reference's own convergence error folded in) and RMSE. All rows
   within 3σ means consistent with unbiased at that sample count.
8. **Selected light path** — move the probe pixel sliders; the first recorded
   light and material samples at that pixel are listed with their MIS weight and
   density conversion, including why a sample was rejected (masked, occluded,
   zero pdf, …).

## Headless verification

The same kernel runs in Node. These scripts are the evidence, not the UI:

```bash
node tools/validate.js        # reference, convergence, per-region, exposure transition
node tools/test_brdf.js       # BRDF sampler vs deterministic hemisphere integral
node tools/test_jacobian.js   # area<->solid-angle Jacobian round-trip + mass
node tools/test_audit_bias.js # both techniques vs quadrature, mean ± se
node tools/test_policy.js     # grow/shrink/disjoint exposure sequences vs quadrature
node tools/test_worker.js     # exact UI worker message path in Node
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
  brdf.js        Lambertian + GGX mixture, eval/sample/pdf in solid angle
  lighttable.js  weighted rect-union tables, coverage, reweighting, proposal mixture
  exposure.js    exposure history controller and decision log
  integrator.js  L and M techniques, MIS, measure conversion, regions, quadrature, audit
  display.js     tonemap and per-pixel error image
  setup.js       default scene/camera/exposures
ui/
  index.html     experiment window
  styles.css
  app.js         UI controller (all numbers/images come from the worker)
  worker.js      runs the kernel off the main thread
tools/
  serve.js       zero-dependency static server
  validate.js, test_*.js, debug_*.js
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

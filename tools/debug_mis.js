import { makeDefaultSetup } from '../src/setup.js';
import { lightSample, materialSample, makeShading } from '../src/integrator.js';
import { trace, planePoint, inRect } from '../src/scene.js';
import { evalBrdf, pdfBrdf } from '../src/brdf.js';
import { add, sub, dot, mulScalar, length } from '../src/math.js';
import { Rng } from '../src/rng.js';

const { scene, cam, controller } = makeDefaultSetup({ width: 96, height: 64 });
const exp = controller.exposureFor();
const board = scene.board;

const px = 48, py = 40;
const sx = ((px + 0.5) / cam.width) * 2 - 1;
const sy = 1 - ((py + 0.5) / cam.height) * 2;
const d = add(add(cam.forward, mulScalar(cam.right, sx * cam.halfW)), mulScalar(cam.up, sy * cam.halfH));
const rd = mulScalar(d, 1 / length(d));
const hit = trace(scene, cam.eye, rd, 1e-5);
const sh = makeShading(scene, hit, rd);

// Check the proposal density vs current table density.
console.log('proposal pdfAreaAt zone center:', exp.proposal.pdfAreaAt({u:0.4,v:0.5}));
console.log('1/zoneArea:', 1/exp.proposal.tables[0].worldArea, 'zone area', exp.proposal.tables[0].worldArea);
console.log('board area', board.area, 'zone', exp.zone);

// Light samples: distribution of weights and contributions MIS on/off.
for (const mis of [false, true]) {
  const rng = new Rng(1);
  let sum = 0, sumW = 0, n = 0, nz = 0;
  let sumPM = 0, sumPL = 0;
  for (let i = 0; i < 100000; i++) {
    const r = lightSample(exp, sh, rng, { mis });
    if (r.contribution.some(x => x !== 0)) nz++;
    sum += (r.contribution[0]+r.contribution[1]+r.contribution[2])/3;
    sumW += r.weight;
    sumPM += r.pM_area; sumPL += r.pL_area;
    n++;
  }
  console.log(`light mis=${mis} est=${(sum/n).toFixed(5)} nonzero=${nz} avgW=${(sumW/n).toFixed(4)} avgPL=${(sumPL/n).toExponential(3)} avgPM=${(sumPM/n).toExponential(3)}`);
}

// Material samples.
for (const mis of [false, true]) {
  const rng = new Rng(2);
  let sum = 0, sumW = 0, n = 0, nz = 0, sumPM = 0, sumPL = 0;
  for (let i = 0; i < 100000; i++) {
    const r = materialSample(exp, sh, rng, { mis });
    if (r.contribution.some(x => x !== 0)) nz++;
    sum += (r.contribution[0]+r.contribution[1]+r.contribution[2])/3;
    sumW += r.weight;
    sumPM += r.pM_area; sumPL += r.pL_area;
    n++;
  }
  console.log(`material mis=${mis} est=${(sum/n).toFixed(5)} nonzero=${nz} avgW=${(sumW/n).toFixed(4)} avgPM=${(sumPM/n).toExponential(3)} avgPL=${(sumPL/n).toExponential(3)}`);
}

// Assert: P_L (area) should equal 1/zoneArea for any point in zone.
// Sample many light samples and compare empirical hist to proposal.
const rng = new Rng(3);
let inZone = 0, tot = 200000;
const zone = exp.zone;
for (let i = 0; i < tot; i++) {
  const s = exp.proposal.sample(rng);
  if (inRect(s.uv, zone)) inZone++;
  // Check pdf equals 1/worldArea inside
  if (inRect(s.uv, zone)) {
    const expect = 1 / exp.proposal.tables[0].worldArea;
    if (Math.abs(s.pdfArea - expect) > 1e-12) { console.log('PDF MISMATCH', s.pdfArea, expect); break; }
  }
}
console.log('fraction light samples in zone:', inZone / tot, '(expect ~1)');

(() => {
/**
 * Token: a round token broken in two. At rest the halves lie apart,
 * each turned a little, over the dashed outline of the whole they came
 * from. The pointer's distance from the centre draws them back together;
 * when they meet, the seam lights and the four dots on each side of the
 * break pair up: the match is the proof. The slider is the rest gap.
 *
 * The pattern: a field. One continuous input (distance on the ground
 * plane, which never moves), two springs, one highlight.
 */
const { Cam, clamp, facing, fillet, fit, lerp, open, poly, proj, rad, ringAt, run, hull, unproj,
  spring, stepS, disposer, mk, place, pointer, register } = HL;

const R = 46, T = 8, B = 1.8, CORNER = 3.5, TURN = 8, BASE = -45;
const NEAR = 14, FAR = 78;           // world radius: fully fitted inside NEAR, fully apart beyond FAR
const DOTS = [-27, -9, 9, 27];       // along the seam
const CODE = [1, 0, 1, 1];           // which dots are struck: the same on both halves

/** A half-disc (x ≤ 0), as ring samples {u, v, nu, nv}, counter-clockwise, its two chord corners rounded. */
function halfRing() {
  const pts = [], n = 30;
  for (let k = 0; k <= n; k++) { const a = rad(lerp(90, 270, k / n)); pts.push([R * Math.cos(a), R * Math.sin(a)]); }
  // the arc's ends are the chord's corners; round just those two
  const rs = pts.map((_, i) => (i === 0 || i === n ? CORNER : 0));
  const out = fillet(pts, rs, 4).filter((p, i, all) => i === 0 || Math.hypot(p[0] - all[i - 1][0], p[1] - all[i - 1][1]) > 1e-6);
  return out.map((p, i) => {
    const a = out[(i + out.length - 1) % out.length], b = out[(i + 1) % out.length];
    const tx = b[0] - a[0], ty = b[1] - a[1], l = Math.hypot(tx, ty) || 1;
    return { u: p[0], v: p[1], nu: ty / l, nv: -tx / l };
  });
}

/** World position of local (u, v) on one half: mirrored for the right half, turned th about the seam's middle, shifted out by d along the break's normal, then the whole token turned so the break runs toward the viewer. */
function xf(side, th, d) {
  const c = Math.cos(rad(th)), s = Math.sin(rad(th)), cb = Math.cos(rad(BASE)), sb = Math.sin(rad(BASE));
  return (u, v) => {
    const x0 = -side * u, y0 = v;
    const x1 = x0 * c - y0 * s + side * d, y1 = x0 * s + y0 * c;
    return [x1 * cb - y1 * sb, x1 * sb + y1 * cb];
  };
}
function placeRing(ring, side, th, d, inset) {
  const f = xf(side, th, d), n = xf(side, th, 0), o = n(0, 0);
  return ring.map((q) => {
    const [u, v] = f(q.u - q.nu * inset, q.v - q.nv * inset);
    const [a, b] = n(q.nu, q.nv);
    return { u, v, nu: a - o[0], nv: b - o[1] };
  });
}

function mount({ stage, svg, read }, value) {
  const bag = disposer();
  let gapMax = value;

  // fitted to the widest rest pose (the slider's far end) so nothing leaves the frame
  const C = Cam(45, 0.5, 2.95);
  const ext = [];
  for (const side of [-1, 1]) for (const [u, v] of [[-R, 0], [0, -R], [0, R], [-R * 0.7, -R * 0.7], [-R * 0.7, R * 0.7]])
    for (const z of [0, T]) { const [x, y] = xf(side, -side * TURN, 18 + 2)(u, v); ext.push([x, y, z]); }
  fit(C, ext, 200, 168);
  const P = proj(C), front = facing(C);
  const base = halfRing();

  const g = mk("g", {}, svg);
  // the whole token's outline and its break, dashed guides on the ground, painted first
  const whole = [];
  for (let k = 0; k < 72; k++) { const a = (k / 72) * Math.PI * 2; whole.push(P(R * Math.cos(a), R * Math.sin(a), 0)); }
  mk("path", { d: poly(whole), class: "dash nf" }, g);
  const w0 = xf(1, 0, 0);
  mk("path", { d: open([P(...w0(0, -R), 0), P(...w0(0, R), 0)]), class: "dash nf" }, g);

  // far half (x < 0) first, then the near one
  const halves = [-1, 1].map((side) => {
    const grp = mk("g", {}, g);
    const sil = mk("path", { class: "sil" }, grp), cr = mk("path", { class: "nf lo" }, grp), seam = mk("path", { class: "nf" }, grp);
    const dots = DOTS.map((_, k) => mk("circle", { r: 1.25, class: "dot " + (CODE[k] ? "m" : "off") }, grp));
    return { side, sil, cr, seam, dots };
  });

  const gap = spring(gapMax), turn = spring(TURN);
  let drawn = "";
  function draw() {
    const key = gap.x.toFixed(2) + "|" + turn.x.toFixed(2);
    if (key === drawn) return;
    drawn = key;
    for (const h of halves) {
      const th = -h.side * turn.x, d = gap.x / 2;
      const ring = placeRing(base, h.side, th, d, 0), inner = placeRing(base, h.side, th, d, B);
      h.sil.setAttribute("d", poly(hull(ringAt(P, ring, T).concat(ringAt(P, ring, 0)))));
      h.cr.setAttribute("d", open(ringAt(P, run(inner, front), T)));
      // the break itself: the chord, on the top face
      const at = (u, v) => P(...xf(h.side, th, d)(u, v), T);
      h.seam.setAttribute("d", open([at(-B, -R + CORNER + 2), at(-B, R - CORNER - 2)]));
      h.dots.forEach((el, k) => place(el, at(-5.5, DOTS[k])));
    }
  }

  let fitted = false;
  function settle(f) {
    if (f === fitted) return;
    fitted = f;
    for (const h of halves) {
      h.seam.classList.toggle("hi", f);
      h.dots.forEach((el, k) => el.setAttribute("class", "dot" + (f ? (CODE[k] ? "" : " m") : (CODE[k] ? " m" : " off"))));
    }
    halves[1].seam.classList.toggle("hi", f || rest);
  }

  let rest = true;
  const B2 = register(stage, (dt) => {
    const a = stepS(gap, dt), b = stepS(turn, dt);
    draw();
    settle(gap.t < 0.5 && gap.x < 0.6);
    return a || b;
  });
  bag.add(B2.unregister);

  function aim(t) {
    gap.t = gapMax * t; turn.t = TURN * t;
    rest = false;
    if (!fitted) halves[1].seam.classList.remove("hi");
    read.textContent = gap.t < 0.5 ? "fit" : "gap " + gap.t.toFixed(1);
    B2.wake();
  }
  function leave() {
    gap.t = gapMax; turn.t = TURN; rest = true;
    halves[1].seam.classList.add("hi");
    read.textContent = "rest";
    B2.wake();
  }

  bag.add(pointer(stage, {
    move: ([sx, sy]) => {
      const [x, y] = unproj(C, sx, sy, 0);
      const d = Math.hypot(x, y);
      const t = clamp((d - NEAR) / (FAR - NEAR), 0, 1);
      aim(t * t * (3 - 2 * t));
    },
    leave,
  }));
  bag.add(() => svg.replaceChildren());

  draw();
  halves[1].seam.classList.add("hi");
  read.textContent = "rest";

  return {
    set: (v) => { gapMax = v; if (rest) { gap.t = v; B2.wake(); } },
    destroy: bag.dispose,
  };
}

hairline({
  name: "token",
  means: "A token broken in two: bring the pointer to its centre and the halves close until their marks pair up.",
  rules: [1, 3, 4, 5],
  range: [16, 26, 36],
  tour: [[90, 168], [150, 168], [200, 168], null],
  mount,
});
})();

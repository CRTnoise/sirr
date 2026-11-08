(() => {
/**
 * Faders: a console with six channel strips. At rest the caps sit at an
 * uneven curve, the loudest one lit. The pointer picks a strip by its slot
 * and drags a level along it; the neighbours lean the same way, less the
 * farther they are, like pulling an EQ curve. The slider is the reach.
 *
 * The pattern: a field over discrete parts. Hit test on the static slots,
 * a spring per cap, a falloff that reaches a floor.
 */
const { Cam, clamp, facing, fit, open, poly, proj, prism, rings, ringAt, unproj,
  spring, stepS, disposer, mk, put, solid, pointer, register } = HL;

const N = 6, W = 132, D = 76, T = 7, R0 = 6, B0 = 1.8;
const X0 = 16, DX = 20, Y0 = 13, Y1 = D - 13;      // slots run along y
const CAP_W = 6, CAP_D = 3.4, CAP_H = 7;
const REST = [0.34, 0.58, 0.46, 0.82, 0.38, 0.52];
const LOUD = 3;

function mount({ stage, svg, read }, value) {
  const bag = disposer();
  let reach = value;
  const C = Cam(45, 0.5, 2.35);
  fit(C, [[0, 0, 0], [W, D, 0], [W, 0, T + CAP_H], [0, D, T + CAP_H]], 200, 172);
  const P = proj(C), front = facing(C);

  const g = mk("g", {}, svg);
  // the console plate: a silhouette, its crease, and the six slots cut in its top
  const [outer, inner] = rings(0, 0, W, D, R0, B0);
  put(solid(g), prism(P, front, outer, inner, 0, T));
  const slots = [];
  for (let i = 0; i < N; i++) {
    const x = X0 + i * DX;
    mk("path", { d: poly([P(x - 0.9, Y0, T), P(x + 0.9, Y0, T), P(x + 0.9, Y1, T), P(x - 0.9, Y1, T)]), class: "nf lo" }, g);
    // tick marks at -∞, -30, -12, 0 along the left of each slot
    for (const t of [0, 0.5, 0.8, 1]) { const y = Y1 - t * (Y1 - Y0); mk("path", { d: open([P(x - 3.4, y, T), P(x - 2.2, y, T)]), class: "nf lo" }, g); }
    slots.push(x);
  }
  // caps, far to near (ascending x + y)
  const caps = REST.map((r, i) => {
    const s = solid(g);
    const grip = mk("path", { class: "nf lo" }, s.g);   // the grip line across the cap
    return { s, grip, sp: spring(r), x: slots[i] };
  });
  caps[LOUD].s.sil.classList.add("hi");

  let drawn = "";
  function draw() {
    const key = caps.map((c) => c.sp.x.toFixed(3)).join(",");
    if (key === drawn) return;
    drawn = key;
    for (const c of caps) {
      const y = Y1 - clamp(c.sp.x, 0, 1) * (Y1 - Y0);
      const [o, n] = rings(c.x - CAP_W, y - CAP_D, c.x + CAP_W, y + CAP_D, 1.4, 0.7);
      put(c.s, prism(P, front, o, n, T, T + CAP_H));
      c.grip.setAttribute("d", open([P(c.x - CAP_W + 1.6, y, T + CAP_H), P(c.x + CAP_W - 1.6, y, T + CAP_H)]));
    }
  }

  let act = -2;
  const B = register(stage, (dt) => {
    let moving = false;
    for (const c of caps) if (stepS(c.sp, dt)) moving = true;
    draw();
    return moving;
  });
  bag.add(B.unregister);

  const db = (v) => (v <= 0.02 ? "-inf" : Math.round(-60 + v * 60) + " dB");
  function aim(a, v) {
    caps.forEach((c, i) => {
      const d = Math.abs(i - a);
      const w = d === 0 ? 1 : Math.max(0, 1 - d / (reach + 0.5)) * 0.85;
      c.sp.t = clamp(REST[i] + (v - REST[i]) * w, 0, 1);
      c.s.sil.classList.toggle("hi", i === a);
    });
    act = a;
    read.textContent = "ch " + (a + 1) + " · " + db(v);
    B.wake();
  }
  function leave() {
    caps.forEach((c, i) => { c.sp.t = REST[i]; c.s.sil.classList.toggle("hi", i === LOUD); });
    act = -2;
    read.textContent = "rest";
    B.wake();
  }
  bag.add(pointer(stage, {
    move: ([sx, sy]) => {
      // hit test against the slots, which never move (rule 01)
      const [x, y] = unproj(C, sx, sy, T);
      const a = Math.round((x - X0) / DX);
      if (a < 0 || a >= N || Math.abs(x - slots[a]) > DX / 2 || y < Y0 - 10 || y > Y1 + 10) { if (act !== -2) leave(); return; }
      aim(a, clamp((Y1 - y) / (Y1 - Y0), 0, 1));
    },
    leave,
  }));
  bag.add(() => svg.replaceChildren());
  draw();
  read.textContent = "rest";
  return { set: (v) => { reach = v; }, destroy: bag.dispose };
}

hairline({
  name: "faders",
  means: "A console of six faders: the pointer pulls a level along a slot, and the neighbours lean after it.",
  rules: [1, 3, 5, 8],
  range: [0.5, 1.5, 3],
  tour: [[150, 150], [205, 175], [250, 200], null],
  mount,
});
})();

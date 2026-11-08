(() => {
/**
 * Mesh: five devices on a table, every one linked to every other by a
 * dashed line on the ground — no hub, no server in the middle. The device
 * nearest the pointer rises and its links draw solid: that is who it talks
 * to directly. At rest one device is up and lit. The slider is the lift.
 *
 * The pattern: one of many, picked on the ground plane (which never
 * moves), a spring per device, links that follow their ends.
 */
const { Cam, clamp, facing, fit, open, poly, proj, prism, rings, unproj,
  spring, stepS, disposer, mk, put, solid, pointer, register } = HL;

const N = 5, RAD = 58, TW = 13, TD = 9, TH = 5, SCREEN = 8;
const REST_LIFT = [6, 0, 2, 0, 1];
const START = 0;

function mount({ stage, svg, read }, value) {
  const bag = disposer();
  let lift = value;
  const C = Cam(45, 0.5, 2.25);
  const at = [...Array(N)].map((_, i) => {
    const a = (i / N) * Math.PI * 2 - Math.PI / 2;
    return [RAD * Math.cos(a), RAD * Math.sin(a)];
  });
  fit(C, at.flatMap(([x, y]) => [[x - TW, y - TD, 0], [x + TW, y + TD, TH + SCREEN + 22]]), 200, 168);
  const P = proj(C), front = facing(C);

  const g = mk("g", {}, svg);
  // links first, behind every device (rule 06)
  const links = [];
  for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) links.push({ i, j, el: mk("path", { class: "dash nf" }, g) });
  // devices, far to near by x + y
  const order = at.map((p, i) => i).sort((a, b) => (at[a][0] + at[a][1]) - (at[b][0] + at[b][1]));
  const dev = [];
  for (const i of order) {
    const grp = mk("g", {}, g);
    const lid = mk("path", {}, grp), base = solid(grp);   // lid first: the base's near edge covers its foot
    dev[i] = { base, lid, sp: spring(REST_LIFT[i]) };
  }

  let drawn = "";
  function draw() {
    const key = dev.map((d) => d.sp.x.toFixed(2)).join(",");
    if (key === drawn) return;
    drawn = key;
    dev.forEach((d, i) => {
      const [x, y] = at[i], z = Math.max(0, d.sp.x);
      const [o, n] = rings(x - TW, y - TD, x + TW, y + TD, 2.6, 1.2);
      put(d.base, prism(P, front, o, n, z, z + TH));
      // a laptop lid standing at the back edge: the device says what it is
      d.lid.setAttribute("d", poly([P(x - TW + 2, y - TD + 1, z + TH), P(x - TW + 2, y - TD - 2, z + TH + SCREEN + 4), P(x + TW - 2, y - TD - 2, z + TH + SCREEN + 4), P(x + TW - 2, y - TD + 1, z + TH)]));
    });
    for (const l of links) {
      const a = at[l.i], b = at[l.j];
      l.el.setAttribute("d", open([P(a[0], a[1], Math.max(0, dev[l.i].sp.x)), P(b[0], b[1], Math.max(0, dev[l.j].sp.x))]));
    }
  }

  const B = register(stage, (dt) => {
    let moving = false;
    for (const d of dev) if (stepS(d.sp, dt)) moving = true;
    draw();
    return moving;
  });
  bag.add(B.unregister);

  let act = null;
  function choose(a) {
    if (a === act) return;
    act = a;
    const lit = a === null ? START : a;
    dev.forEach((d, i) => {
      d.sp.t = a === null ? REST_LIFT[i] : (i === a ? lift : 0);
      d.base.sil.classList.toggle("hi", i === lit);
    });
    for (const l of links) l.el.setAttribute("class", (l.i === lit || l.j === lit) ? "nf" : "dash nf");
    read.textContent = a === null ? "rest" : "peer " + (a + 1) + " · " + (N - 1) + " links";
    B.wake();
  }
  bag.add(pointer(stage, {
    move: ([sx, sy]) => {
      const [x, y] = unproj(C, sx, sy, 0);
      let best = null, bd = 30;
      at.forEach(([px, py], i) => { const d = Math.hypot(px - x, py - y); if (d < bd) { bd = d; best = i; } });
      choose(best);
    },
    leave: () => choose(null),
  }));
  bag.add(() => svg.replaceChildren());
  act = 0; choose(null);
  draw();
  return { set: (v) => { lift = v; if (act !== null) { dev[act].sp.t = v; B.wake(); } }, destroy: bag.dispose };
}

hairline({
  name: "mesh",
  means: "Five devices, each linked straight to every other: the one nearest the pointer rises and its links draw solid.",
  rules: [1, 4, 5, 6],
  range: [8, 16, 24],
  tour: [[120, 150], [270, 140], [200, 230], null],
  mount,
});
})();

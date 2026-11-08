/**
 * Sirr — Audio device management
 * ═══════════════════════════════════════════════════════════════════
 * Enumerating input/output devices and switching between them without
 * dropping the call.
 *
 * ─── WHY THIS EXISTS ─────────────────────────────────────────────
 * Until now Sirr called getUserMedia({audio: true}) and took
 * whatever the OS considered the default input. On Windows that is
 * frequently "Stereo Mix" or a virtual loopback left enabled by some
 * other app, which captures the machine's own output instead of the
 * microphone. The caller hears their own desktop audio and has no way
 * to fix it from inside the app. That is the bug this closes.
 *
 * ─── LABELS AND PERMISSION ───────────────────────────────────────
 * enumerateDevices() returns entries with EMPTY labels until the page
 * holds a media permission. Before a call you get "Microphone 1",
 * "Microphone 2" and nothing else, which is useless for picking. So we
 * probe with a throwaway getUserMedia the first time the picker is
 * opened, then immediately stop the tracks.
 *
 * ─── deviceId 'default' vs a real id ─────────────────────────────
 * We deliberately store the real deviceId, not 'default'. 'default'
 * follows the OS, which is exactly the behaviour that caused the
 * problem. If a stored device disappears (headset unplugged) we fall
 * back to the system default and say so, rather than failing to open
 * the mic at all.
 */

import * as state from './state.js';

const dlog  = (...a) => console.log('[devices]', ...a);
const dwarn = (...a) => console.warn('[devices]', ...a);

let cache = { inputs: [], outputs: [], at: 0 };
let probed = false;
let watching = false;
let onChange = null;

/** Output selection needs setSinkId; not every build has it. */
export function canSelectOutput() {
  return typeof HTMLMediaElement !== 'undefined' &&
         typeof HTMLMediaElement.prototype.setSinkId === 'function';
}

/**
 * Ask for permission once so device labels become readable.
 * Harmless to call repeatedly — it no-ops after the first success.
 */
async function ensureLabels() {
  if (probed) return true;
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach(t => t.stop());
    probed = true;
    return true;
  } catch (e) {
    dwarn('label probe denied —', e?.name);
    return false;
  }
}

/**
 * @param {boolean} withLabels  probe for permission if labels are blank
 * @returns {Promise<{inputs:Array, outputs:Array, labelled:boolean}>}
 */
export async function list(withLabels = true) {
  try {
    let devs = await navigator.mediaDevices.enumerateDevices();
    let labelled = devs.some(d => d.kind.startsWith('audio') && d.label);

    if (!labelled && withLabels) {
      if (await ensureLabels()) {
        devs = await navigator.mediaDevices.enumerateDevices();
        labelled = devs.some(d => d.kind.startsWith('audio') && d.label);
      }
    }

    const norm = (d, i, kind) => ({
      id: d.deviceId,
      label: d.label || `${kind} ${i + 1}`,
      isDefault: d.deviceId === 'default' || d.deviceId === 'communications',
    });

    // 'default' and 'communications' are OS aliases that point at
    // whatever is current. We keep them visible but list real devices
    // first, because picking a real one is the point.
    const inputs = devs.filter(d => d.kind === 'audioinput')
                       .map((d, i) => norm(d, i, 'Microphone'));
    const outputs = devs.filter(d => d.kind === 'audiooutput')
                        .map((d, i) => norm(d, i, 'Speakers'));
    const sortReal = (a, b) => (a.isDefault ? 1 : 0) - (b.isDefault ? 1 : 0);
    inputs.sort(sortReal);
    outputs.sort(sortReal);

    cache = { inputs, outputs, at: Date.now() };
    return { inputs, outputs, labelled };
  } catch (e) {
    dwarn('enumerateDevices failed', e);
    return { inputs: [], outputs: [], labelled: false };
  }
}

export function cached() { return cache; }

/**
 * Watch for hardware changes — headset plugged or unplugged mid-call.
 * @param {Function} cb  called after the cache refreshes
 */
export function watch(cb) {
  onChange = cb;
  if (watching) return;
  watching = true;
  try {
    navigator.mediaDevices.addEventListener('devicechange', async () => {
      await list(false);
      dlog('device set changed —', cache.inputs.length, 'in,', cache.outputs.length, 'out');
      try { onChange?.(cache); } catch (e) {}
    });
  } catch (e) { dwarn('devicechange unavailable', e); }
}

// ─── selection ────────────────────────────────────────────────────
export function selectedInput()  { return state.state.audioInputId  || ''; }
export function selectedOutput() { return state.state.audioOutputId || ''; }

/**
 * Does the stored device still exist? A saved id that has vanished
 * must not be handed to getUserMedia with exact:, or it throws
 * OverconstrainedError and the user gets no microphone at all.
 */
export function inputAvailable(id) {
  if (!id) return true;
  return cache.inputs.some(d => d.id === id);
}

/** Constraint fragment for getUserMedia. */
export function inputConstraint() {
  const id = selectedInput();
  if (!id) return {};
  // `ideal` rather than `exact`: if the device went away we still get a
  // working microphone instead of an exception.
  return { deviceId: { ideal: id } };
}

/** Which device did we actually end up on? For UI confirmation. */
export function actualInputOf(stream) {
  try {
    const t = stream?.getAudioTracks?.()[0];
    if (!t) return null;
    const s = t.getSettings ? t.getSettings() : {};
    const match = cache.inputs.find(d => d.id === s.deviceId);
    return { id: s.deviceId || '', label: match?.label || t.label || 'Unknown' };
  } catch (e) { return null; }
}

/**
 * Route an <audio> element to the chosen output device.
 * Returns true if it actually moved.
 */
export async function applySinkTo(el) {
  const id = selectedOutput();
  if (!el || !canSelectOutput()) return false;
  // '' is how you route back to the system default. Skipping it
  // meant picking "System default" left audio on the old device.
  if (!id && !el.sinkId) return true;
  try { await el.setSinkId(id); return true; }
  catch (e) { dwarn('setSinkId failed', e?.message); return false; }
}

/**
 * Route an AudioContext (mesh playback) to the chosen output device.
 * AudioContext.setSinkId is newer than the element version, so this is
 * allowed to be unavailable while element routing still works.
 */
export async function applySinkToContext(ctx) {
  const id = selectedOutput();
  if (!ctx) return false;
  try {
    if (typeof ctx.setSinkId !== 'function') return false;
    if (!id && !ctx.sinkId) return true;
    await ctx.setSinkId(id);
    return true;
  } catch (e) { dwarn('ctx.setSinkId failed', e?.message); return false; }
}

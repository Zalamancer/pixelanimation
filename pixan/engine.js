/**
 * PixAn Engine — Compact Pixel Animation Format
 *
 * FORMAT SPEC:
 * {
 *   "name": "my_anim",
 *   "w": 8,          // width in pixels
 *   "h": 8,          // height in pixels
 *   "fps": 8,        // frames per second
 *   "palette": {
 *     ".": null,     // null = transparent
 *     "R": "#ff2244",
 *     "r": "#cc1133"
 *   },
 *   "frames": [
 *     ["..RR....", "..RRR...", ...],   // h rows of exactly w chars each
 *     ...
 *   ]
 * }
 *
 * COMPRESSED FORMAT (RLE):
 *   Set _rle: true, then rows use run-length encoding:
 *   "RRRR..RR" → "4R2.2R"
 */

const PixAn = (() => {

  // ─── Validation & Parsing ──────────────────────────────────────────────────

  function parse(input) {
    const d = typeof input === 'string' ? JSON.parse(input) : structuredClone(input);
    if (d._rle) decompress(d, true); // in-place
    _validate(d);
    return d;
  }

  function _validate(d) {
    const { w, h, palette, frames } = d;
    if (!w || !h || !palette || !Array.isArray(frames) || !frames.length)
      throw new Error('PixAn: missing required fields (w, h, palette, frames)');
    for (let fi = 0; fi < frames.length; fi++) {
      if (frames[fi].length !== h)
        throw new Error(`PixAn: frame ${fi} has ${frames[fi].length} rows, expected ${h}`);
      for (let ri = 0; ri < frames[fi].length; ri++) {
        if (frames[fi][ri].length !== w)
          throw new Error(`PixAn: frame ${fi} row ${ri} length=${frames[fi][ri].length}, expected ${w}`);
      }
    }
  }

  // ─── Rendering ─────────────────────────────────────────────────────────────

  function renderFrame(ctx, data, frameIdx, { scale = 1, bg = null, ox = 0, oy = 0 } = {}) {
    const frame   = data.frames[((frameIdx % data.frames.length) + data.frames.length) % data.frames.length];
    const palette = data.palette;

    if (bg) {
      ctx.fillStyle = bg;
      ctx.fillRect(ox, oy, data.w * scale, data.h * scale);
    } else {
      ctx.clearRect(ox, oy, data.w * scale, data.h * scale);
    }

    for (let y = 0; y < frame.length; y++) {
      const row = frame[y];
      for (let x = 0; x < row.length; x++) {
        const color = palette[row[x]];
        if (!color) continue;
        ctx.fillStyle = color;
        ctx.fillRect(ox + x * scale, oy + y * scale, scale, scale);
      }
    }
  }

  // ─── Player ────────────────────────────────────────────────────────────────

  class Player {
    constructor(canvas, data, opts = {}) {
      this.canvas     = canvas;
      this.ctx        = canvas.getContext('2d');
      this.opts       = { scale: 4, bg: null, ...opts };
      this.frameIndex = 0;
      this.playing    = false;
      this._rafId     = null;
      this._lastTs    = 0;
      this.onFrame    = null; // (frameIndex) => void
      this.load(data);
    }

    load(data) {
      this.data       = parse(data);
      this.frameIndex = 0;
      const s = this.opts.scale;
      this.canvas.width  = this.data.w * s;
      this.canvas.height = this.data.h * s;
      this.canvas.style.imageRendering = 'pixelated';
      this.canvas.style.imageRendering = 'crisp-edges';
      this.render();
      return this;
    }

    render() {
      renderFrame(this.ctx, this.data, this.frameIndex, this.opts);
      this.onFrame?.(this.frameIndex);
      return this;
    }

    _tick(ts) {
      if (!this.playing) return;
      const ms = 1000 / (this.data.fps || 8);
      if (ts - this._lastTs >= ms) {
        this.frameIndex = (this.frameIndex + 1) % this.data.frames.length;
        this.render();
        this._lastTs = ts;
      }
      this._rafId = requestAnimationFrame(t => this._tick(t));
    }

    play() {
      if (this.playing) return this;
      this.playing = true;
      this._rafId  = requestAnimationFrame(t => { this._lastTs = t; this._tick(t); });
      return this;
    }

    pause() {
      this.playing = false;
      cancelAnimationFrame(this._rafId);
      return this;
    }

    toggle()  { return this.playing ? this.pause() : this.play(); }
    seek(n)   { this.frameIndex = ((n % this.data.frames.length) + this.data.frames.length) % this.data.frames.length; return this.render(); }
    next()    { return this.seek(this.frameIndex + 1); }
    prev()    { return this.seek(this.frameIndex - 1); }
    destroy() { this.pause(); }
  }

  // ─── RLE Compression ───────────────────────────────────────────────────────

  function compress(data) {
    return {
      ...data,
      _rle: true,
      frames: data.frames.map(frame =>
        frame.map(row => {
          let out = '', i = 0;
          while (i < row.length) {
            const c = row[i], s = i;
            while (i < row.length && row[i] === c) i++;
            const n = i - s;
            out += n > 1 ? n + c : c;
          }
          return out;
        })
      )
    };
  }

  function decompress(data, inPlace = false) {
    const out = inPlace ? data : { ...data };
    out._rle = undefined;
    out.frames = data.frames.map(frame =>
      frame.map(row => {
        let result = '', i = 0;
        while (i < row.length) {
          let ns = '';
          while (i < row.length && row[i] >= '0' && row[i] <= '9') ns += row[i++];
          if (i < row.length) result += row[i++].repeat(ns ? +ns : 1);
        }
        return result;
      })
    );
    if (inPlace) { data.frames = out.frames; delete data._rle; }
    return out;
  }

  // ─── Export ────────────────────────────────────────────────────────────────

  function exportFramePNGs(data, { scale = 4, bg = null } = {}) {
    const c = Object.assign(document.createElement('canvas'), {
      width:  data.w * scale,
      height: data.h * scale
    });
    const ctx = c.getContext('2d');
    return data.frames.map((_, i) => {
      renderFrame(ctx, data, i, { scale, bg });
      return c.toDataURL('image/png');
    });
  }

  function sizeReport(data) {
    const raw = JSON.stringify(data).length;
    const rle = JSON.stringify(compress(data)).length;
    return { raw, rle, ratio: ((1 - rle / raw) * 100).toFixed(1) + '%' };
  }

  // ─── Claude API System Prompt ───────────────────────────────────────────────

  const CLAUDE_SYSTEM = `\
You are a pixel art animation generator. Output animations in PixAn JSON format ONLY.

FORMAT:
{
  "name": "descriptive_snake_case_name",
  "w": <width 8-24>,
  "h": <height 8-24>,
  "fps": <4-16>,
  "palette": {
    ".": null,
    "<single_char>": "<#hexcolor>",
    ...more colors
  },
  "frames": [
    ["<exactly_w_chars>", ...exactly_h_rows],
    ...2-8 frames total
  ]
}

RULES:
- Every row string must be EXACTLY w characters
- Every frame must have EXACTLY h rows
- "." is always transparent (null)
- Use single characters for palette keys — letters or symbols, never digits
- Choose expressive, distinct colors
- Create smooth looping animation (2-8 frames)
- Output ONLY the raw JSON object — no markdown fences, no explanation
- Double-check row lengths before outputting`;

  // ─── Public API ────────────────────────────────────────────────────────────

  return { parse, renderFrame, Player, compress, decompress, exportFramePNGs, sizeReport, CLAUDE_SYSTEM };

})();

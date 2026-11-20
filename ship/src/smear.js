import {
  NodeMaterial,
  NodeUpdateType,
  QuadMesh,
  RenderTarget,
  RendererUtils,
  TempNode,
  Vector2,
} from 'three/webgpu';
import {
  Fn,
  abs,
  convertToTexture,
  float,
  fract,
  max,
  mix,
  passTexture,
  sin,
  step,
  texture,
  uniform,
  uv,
  vec2,
} from 'three/tsl';

// The most rectangles at full strength. The shader checks all of them, so
// this is a fixed count. TUNE.smear.rects sets how many are in use.
const MAX_RECTS = 16;

// The brightest value that still counts as black for `clearBlack`.
const BLACK = 0.03;

const _size = new Vector2();
const _quad = new QuadMesh();
let _state;

/**
 * Pixel smear: a feedback effect, like a copy and paste in a loop.
 *
 * Each frame, random rectangles inside an area of the image copy the last
 * output frame back onto the image, moved by a few pixels in one direction.
 * Inside a rectangle, the content moves again on each frame, and new pixels
 * come in from its back edge. Thus the image smears in that direction. Outside
 * the rectangles, the image is the current frame. The rectangles can overlap.
 * They stay in place until main.js changes `seed`, which it does only when
 * the pointer enters a tile.
 *
 * The uniforms in `params`:
 * - `strength` (0 to 1): 0 is off. Above 0, all the rectangles are in use.
 * - `pulse` (0 or 1): 1 moves the pixels on this frame, 0 holds them. main.js
 *   sets it at an even rhythm, on a share of the frames equal to the
 *   strength. Thus more strength gives a faster smear, and the step stays
 *   whole pixels.
 * - `direction` (vec2, unit length, in uv): the direction of the smear.
 * - `centre`, `half` (vec2, uv): the area that the rectangles stay inside.
 * - `step`: the step in pixels on a frame with a pulse.
 * - `rects`: the number of rectangles, up to 16.
 * - `size` (0 to 1): the largest rectangle, as a share of the area.
 * - `seed`: change it to move the rectangles.
 * - `clearBlack` (0 or 1): with 1, black pixels in the moved copy are
 *   transparent. The current frame shows through them, so only the bright
 *   pixels leave trails.
 */
export function createSmearParams() {
  return {
    strength: uniform(0),
    pulse: uniform(0),
    direction: uniform(new Vector2(1, 0)),
    centre: uniform(new Vector2(0.5, 0.5)),
    half: uniform(new Vector2(0.35, 0.35)),
    step: uniform(3),
    rects: uniform(8),
    size: uniform(0.5),
    seed: uniform(0),
    clearBlack: uniform(0),
  };
}

class SmearNode extends TempNode {
  constructor(textureNode, params) {
    super('vec4');
    this.textureNode = textureNode;
    this.params = params;
    this._outRT = new RenderTarget(1, 1, { depthBuffer: false });
    this._oldRT = new RenderTarget(1, 1, { depthBuffer: false });
    this._outNode = passTexture(this, this._outRT.texture);
    this._oldNode = texture(this._oldRT.texture);
    this._texel = uniform(new Vector2(1, 1));
    this._material = null;
    this.updateBeforeType = NodeUpdateType.FRAME;
  }

  updateBefore({ renderer }) {
    _state = RendererUtils.resetRendererState(renderer, _state);

    const type = this.textureNode.value.type;
    this._outRT.texture.type = type;
    this._oldRT.texture.type = type;
    renderer.getDrawingBufferSize(_size);
    this._outRT.setSize(_size.x, _size.y);
    this._oldRT.setSize(_size.x, _size.y);
    this._texel.value.set(1 / _size.x, 1 / _size.y);

    this._outNode.value = this._outRT.texture;
    this._oldNode.value = this._oldRT.texture;

    _quad.material = this._material;
    renderer.setRenderTarget(this._outRT);
    _quad.render(renderer);

    // This frame's output is the next frame's "last frame".
    [this._oldRT, this._outRT] = [this._outRT, this._oldRT];

    RendererUtils.restoreRendererState(renderer, _state);
  }

  setup(builder) {
    const { textureNode, params } = this;
    const old = this._oldNode;
    old.uvNode = textureNode.uvNode || uv();

    // A random value in [0, 1) for each input.
    const hash = (x) => fract(sin(x.mul(12.9898)).mul(43758.5453));

    const smear = Fn(() => {
      const p = uv();
      const current = textureNode.sample(p);

      let inside = float(0);
      for (let k = 0; k < MAX_RECTS; k++) {
        const s = params.seed.mul(31.7).add(k * 7.13);
        // The rectangle's centre, anywhere in the area.
        const c = params.centre.add(
          vec2(hash(s.add(0.1)), hash(s.add(0.2))).mul(2).sub(1).mul(params.half),
        );
        // Its half size, from a tenth of the largest size up to the largest.
        const h = params.half.mul(params.size).mul(
          vec2(hash(s.add(0.3)), hash(s.add(0.4))).mul(0.9).add(0.1),
        );
        const d = abs(p.sub(c));
        const inRect = step(d.x, h.x).mul(step(d.y, h.y));
        // Rectangle k is in use while k is below `rects`.
        const used = step(float(k + 0.5), params.rects);
        inside = max(inside, inRect.mul(used));
      }

      // On a frame without a pulse, the rectangles hold the last frame, so
      // the smear stays but does not grow.
      const shift = params.direction.mul(this._texel).mul(params.step.mul(params.pulse));
      const moved = old.sample(p.sub(shift));
      const on = step(float(0.001), params.strength);
      // A moved pixel counts as black below this brightness. With clearBlack,
      // such a pixel does not cover the current frame.
      const lit = step(float(BLACK), max(moved.r, max(moved.g, moved.b)));
      const cover = mix(float(1), lit, params.clearBlack);
      return mix(current, moved, inside.mul(on).mul(cover));
    });

    const material = this._material || (this._material = new NodeMaterial());
    material.name = 'Smear';
    material.fragmentNode = smear();

    builder.getNodeProperties(this).textureNode = textureNode;
    return this._outNode;
  }

  dispose() {
    this._outRT.dispose();
    this._oldRT.dispose();
    this._material?.dispose();
  }
}

export const smear = (node, params) => new SmearNode(convertToTexture(node), params);

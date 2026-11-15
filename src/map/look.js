/**
 * How the 3D map looks: a sky, a light that comes over the viewer's shoulder, and thin dark outlines
 * round buildings and other shapes – like an architect's model. Settings in CONFIG.look.
 *
 * The light: Cesium lights shapes from the sun, which leaves the walls facing away from it all in the
 * same dark shade, and changes as the camera turns. Here the light always comes from behind the
 * viewer, from the left and from above, whichever way the camera looks: roofs are the brightest,
 * the walls facing the viewer a step darker, the side walls darker still.
 *
 * The outlines: where the depth of the picture bends (a roof meets a wall, a building stands in front
 * of the street), the colour is darkened. Cesium keeps the depth as a logarithm, so one threshold fits
 * near and far. Far away (hillsides) the bends of the ground itself would show as scratches, so the
 * outlines fade out with distance. They cost about 3 ms per frame on an integrated-graphics laptop
 * (docs/PERFORMANCE.md); each quality preset can switch them off.
 */
import { Cesium, toRadians } from './cesium.js';

const OUTLINES_SHADER = `
uniform sampler2D colorTexture;
uniform sampler2D depthTexture;
uniform float threshold;
uniform float darken;
uniform float fadeFromM;
uniform float fadeToM;
in vec2 v_textureCoordinates;

float depthAt(vec2 offsetPx) {
  return texture(depthTexture, v_textureCoordinates + offsetPx / czm_viewport.zw).r;
}

void main() {
  vec4 color = texture(colorTexture, v_textureCoordinates);
  float here = depthAt(vec2(0.0));
  float bend = abs(depthAt(vec2(1.0, 0.0)) + depthAt(vec2(-1.0, 0.0)) + depthAt(vec2(0.0, 1.0)) + depthAt(vec2(0.0, -1.0)) - 4.0 * here);
  // The logarithmic depth back into metres from the camera.
  float distanceM = exp2(here * czm_log2FarDepthFromNearPlusOne) - 1.0 + czm_currentFrustum.x;
  float edge = smoothstep(threshold, threshold * 4.0, bend)
    * step(here, 0.9999) // not against the empty sky
    * (1.0 - smoothstep(fadeFromM, fadeToM, distanceM));
  out_FragColor = vec4(mix(color.rgb, color.rgb * (1.0 - darken), edge), color.a);
}`;

/**
 * @param {object} viewer
 * @param {{ sky: boolean, light: { aroundDegrees: number, downDegrees: number, brightness: number },
 *   outlines: { threshold: number, darken: number, fadeFromM: number, fadeToM: number } }} look  CONFIG.look
 * @param {{ outlines: boolean }} preset  the quality preset (outlines on or off on this device)
 */
export function applyLook(viewer, look, preset) {
  const { scene } = viewer;

  if (look.sky) {
    scene.skyAtmosphere = new Cesium.SkyAtmosphere();
    scene.skyAtmosphere.show = true;
  }

  const { aroundDegrees, downDegrees, brightness } = look.light;
  const light = new Cesium.DirectionalLight({
    direction: new Cesium.Cartesian3(0, 0, -1),
    // Cesium caps the strength of a light at 1, so a softer light is a grey one.
    color: new Cesium.Color(brightness, brightness, brightness, 1),
  });
  scene.light = light;

  let outlines;
  if (preset.outlines && Cesium.PostProcessStageLibrary.isEdgeDetectionSupported(scene)) {
    outlines = scene.postProcessStages.add(new Cesium.PostProcessStage({ name: 'outlines', fragmentShader: OUTLINES_SHADER, uniforms: { ...look.outlines } }));
  }

  const enu = new Cesium.Matrix4();
  const rotation = new Cesium.Matrix3();
  const local = new Cesium.Cartesian3();
  const down = toRadians(downDegrees);
  scene.preRender.addEventListener(() => {
    const in3d = scene.mode === Cesium.SceneMode.SCENE3D;
    // The flat map keeps no depth worth outlining.
    if (outlines) outlines.enabled = in3d;
    if (!in3d) return;
    // Over the viewer's left shoulder: the way the camera looks, turned a little to the right, and down.
    const { camera } = scene;
    const azimuth = camera.heading + toRadians(aroundDegrees);
    local.x = Math.sin(azimuth) * Math.cos(down);
    local.y = Math.cos(azimuth) * Math.cos(down);
    local.z = -Math.sin(down);
    Cesium.Transforms.eastNorthUpToFixedFrame(camera.positionWC, undefined, enu);
    Cesium.Matrix4.getMatrix3(enu, rotation);
    Cesium.Matrix3.multiplyByVector(rotation, local, light.direction);
    Cesium.Cartesian3.normalize(light.direction, light.direction);
  });

  return { outlines };
}

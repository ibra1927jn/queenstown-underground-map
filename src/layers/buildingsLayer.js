/**
 * Buildings layer: every building with its walls and its roof (flat, gable or hip), at the
 * heights the council measured from LiDAR where it has them; coloured by kind (residential,
 * commercial…); the light of src/map/look.js shades roofs and walls. In the underground view they
 * turn to glass, so the pipes under them show.
 *
 * Data: data/<zone>/buildings.geojson – made by scripts/data/convert-buildings.mjs (council
 * outlines and heights, OpenStreetMap for the kinds). Shapes: buildingShapes.js.
 * Each zone becomes ONE batched Cesium primitive, which keeps thousands of
 * buildings fast to draw.
 */
import { Cesium } from '../map/cesium.js';
import { buildingGeometry } from './buildingShapes.js';
import { renderUntil } from '../map/render.js';
import { fetchJson } from '../util/http.js';
import { createZoneContent } from './zoneContent.js';
import { groundPositions, groundRanges } from './groundHeights.js';

const LAYER_ID = 'buildings';

/** The roof (the eaves of a pitched roof) is never lower than this above the highest ground point under the building. */
const MIN_ROOF_ABOVE_GROUND_M = 2.5;
/** A pitched roof rises at least this much from the eaves to the ridge. */
const MIN_ROOF_RISE_M = 0.5;
/** Roofs are drawn this much darker than the walls (0: the light alone shades them, see src/map/look.js). */
const ROOF_SHADE = 0;

const HEIGHT_SOURCE_NOTE = {
  lidar: "Measured by the council from LiDAR (laser survey from the air)",
  height: 'Mapped height (OpenStreetMap)',
  levels: 'From the mapped number of levels (OpenStreetMap)',
  estimate: 'Typical for this kind and size of building',
};

const ROOF_NAME = { flat: 'Flat', gable: 'Gable (two slopes)', hip: 'Hip (four slopes)' };

const KIND_SOURCE_NOTE = { landuse: ' (from the land use around it)', size: ' (from its size)', unknown: '' };

const capitalise = (text) => text.charAt(0).toUpperCase() + text.slice(1);
const humanise = (osmValue) => capitalise(String(osmValue).replaceAll('_', ' '));

export function createBuildingsLayer({ viewer, sampleGround, dataPath, settings }) {
  const { scene } = viewer;
  const kinds = new Map(settings.kinds.map((kind) => [kind.id, kind]));
  const fallbackKind = settings.kinds.at(-1);

  let visible = true;
  let suspended = false; // hidden for a while by the excavation view, whatever the layers panel says
  let highlighted; // { id, color } of the selected building

  // Shading gives the blocks depth in 3D; seen from straight above (2D) plain colours read better.
  // Glass: Cesium's own drawing of a coloured shape, made see-through (the underground view).
  const glassShader = `in vec3 v_positionEC;
in vec3 v_normalEC;
in vec4 v_color;
void main() {
  vec3 positionToEyeEC = -v_positionEC;
  vec3 normalEC = normalize(v_normalEC);
#ifdef FACE_FORWARD
  normalEC = faceforward(normalEC, vec3(0.0, 0.0, 1.0), -normalEC);
#endif
  vec4 color = czm_gammaCorrect(v_color);
  czm_materialInput materialInput;
  materialInput.normalEC = normalEC;
  materialInput.positionToEyeEC = positionToEyeEC;
  czm_material material = czm_getDefaultMaterial(materialInput);
  material.diffuse = color.rgb;
  material.alpha = color.a * ${settings.glassOpacity.toFixed(3)};
  out_FragColor = czm_phong(normalize(positionToEyeEC), material, czm_lightDirectionEC);
}`;
  const appearances = {
    '3d': new Cesium.PerInstanceColorAppearance({ translucent: false, closed: true }),
    '2d': new Cesium.PerInstanceColorAppearance({ flat: true, translucent: false, closed: true }),
    glass: new Cesium.PerInstanceColorAppearance({ translucent: true, closed: true, fragmentShaderSource: glassShader }),
  };
  let viewMode = '3d';
  let glass = false;
  const appearanceNow = () => (glass && viewMode === '3d' ? appearances.glass : appearances[viewMode]);

  const colorOf = (feature) => Cesium.Color.fromCssColorString((kinds.get(feature.properties.kind) ?? fallbackKind).color);
  const roofColorOf = (feature) => colorOf(feature).darken(ROOF_SHADE, new Cesium.Color());

  /** Walls and roof of every building, standing on the sampled ground under its outline. */
  function buildInstances(zone, features, ground, idsOf) {
    const instances = [];
    features.forEach((feature, index) => {
      const [outer, ...holes] = feature.geometry.coordinates;
      // Skip outlines that are not real areas, and buildings whose ground height is unknown
      // (an elevation tile failed to download): better missing than floating or buried.
      if (outer.length < 4 || !ground[index]) return;
      const { lowest, highest, mean: meanGround } = ground[index];
      const p = feature.properties;
      // Heights are above the ground under the building; on a slope the roof keeps clear of the high side.
      const pitched = (p.roof === 'gable' || p.roof === 'hip') && p.eave > 0;
      const eave = Math.max(meanGround + (pitched ? p.eave : p.height), highest + MIN_ROOF_ABOVE_GROUND_M);
      const ridge = pitched ? Math.max(meanGround + p.height, eave + MIN_ROOF_RISE_M) : eave;
      const shape = buildingGeometry([outer, ...holes], { base: lowest - settings.foundationDepthM, eave, ridge, roof: pitched ? p.roof : 'flat' });
      if (!shape) return;

      const ids = [];
      for (const [part, geometry, color] of [
        ['walls', shape.walls, colorOf(feature)],
        ['roof', shape.roof, roofColorOf(feature)],
      ]) {
        if (!geometry) continue;
        const id = { layer: LAYER_ID, zone: zone.id, index, part };
        ids.push(id);
        instances.push(new Cesium.GeometryInstance({ id, geometry, attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(color) } }));
      }
      idsOf.set(index, ids);
    });
    return instances;
  }

  /** Loads one zone: returns { hasData, features, primitive } (see zoneContent.js). */
  async function loadZone(zone, isWanted) {
    const collection = await fetchJson(`${dataPath}/${zone.id}/buildings.geojson`, { optional: true });
    const features = (collection?.features ?? []).filter((feature) => feature.geometry?.type === 'Polygon');
    const content = { hasData: collection !== null, features, primitive: undefined, idsOf: new Map() };
    if (features.length === 0 || !isWanted()) return content;

    // The ground under every outline (lowest, average, highest): stored in the file, or else looked up from the terrain.
    const ground = await groundRanges(
      features.map((feature) => ({ stored: feature.properties.ground, lonLat: groundPositions(feature.geometry) })),
      sampleGround,
    );
    for (const { properties } of features) delete properties.ground; // only needed to get here
    if (!isWanted()) return content;

    const instances = buildInstances(zone, features, ground, content.idsOf);
    if (instances.length === 0) return content;

    content.primitive = scene.primitives.add(
      new Cesium.Primitive({ geometryInstances: instances, appearance: appearanceNow(), show: visible && !suspended }),
    );
    // The 3D shapes are built in the background; wait until they are on screen.
    // (A hidden primitive is not built at all until it is shown, so there is nothing to wait for then.)
    await renderUntil(scene, () => content.primitive.ready || !isWanted() || !content.primitive.show);
    return content;
  }

  function disposeZone(content) {
    if (highlighted && zones.get(highlighted.zone) === undefined) highlighted = undefined;
    if (content.primitive) scene.primitives.remove(content.primitive); // also frees its GPU memory
    scene.requestRender();
  }

  const zones = createZoneContent({ load: loadZone, dispose: disposeZone });

  function setVisible(next) {
    visible = next;
    for (const content of zones.all()) if (content.primitive) content.primitive.show = visible && !suspended;
    scene.requestRender();
  }

  /** Hides the buildings for a while (the excavation view), without touching the layers panel. */
  function setSuspended(next) {
    suspended = next;
    setVisible(visible);
  }

  /** Called when the map switches between '2d' and '3d'. */
  function setViewMode(mode) {
    viewMode = mode;
    for (const content of zones.all()) if (content.primitive) content.primitive.appearance = appearanceNow();
    scene.requestRender();
  }

  /** Buildings as glass (the underground view: the pipes under them show) or solid again. */
  function setGlass(next) {
    if (glass === Boolean(next)) return;
    glass = Boolean(next);
    setViewMode(viewMode);
  }

  /** Colours one building (walls and roof) as "selected", or clears the selection with `undefined`. */
  function highlight(id) {
    const paint = (target, selected) => {
      const content = zones.get(target.zone);
      const feature = content?.features[target.index];
      if (!content?.primitive?.ready || !feature) return;
      for (const part of content.idsOf.get(target.index) ?? []) {
        const attributes = content.primitive.getGeometryInstanceAttributes(part);
        const color = selected ? Cesium.Color.fromCssColorString(settings.highlightColor) : part.part === 'roof' ? roofColorOf(feature) : colorOf(feature);
        if (attributes) attributes.color = Cesium.ColorGeometryInstanceAttribute.toValue(selected && part.part === 'roof' ? color.darken(0.15, new Cesium.Color()) : color);
      }
    };

    if (highlighted) paint(highlighted, false);
    highlighted = undefined;

    if (id && zones.get(id.zone)?.features[id.index]) {
      highlighted = { zone: id.zone, index: id.index };
      paint(highlighted, true);
    }
    scene.requestRender();
  }

  /** Plain-language description of a picked building for the details panel. */
  function describe(id) {
    const feature = zones.get(id.zone)?.features[id.index];
    if (!feature) return undefined;
    const { name, kind, kindFrom, type, use, height, heightFrom, eave, roof, levels, area, osm, qldc } = feature.properties;
    const kindLabel = (kinds.get(kind) ?? fallbackKind).label;
    const measured = heightFrom === 'lidar';

    return {
      title: name ?? (type ? humanise(type) : 'Building'),
      subtitle: `Building · ${kindLabel}${KIND_SOURCE_NOTE[kindFrom] ?? ''}`,
      rows: [
        { label: 'Use', value: use ? humanise(use) : undefined },
        { label: roof && roof !== 'flat' ? 'Height to the ridge' : 'Height', value: `${height} m`, tag: measured ? 'measured' : 'estimate' },
        { label: 'Height to the eaves', value: eave ? `${eave} m` : undefined },
        { label: 'Roof', value: measured ? ROOF_NAME[roof] : undefined },
        { label: 'Levels', value: levels },
        { label: 'Footprint', value: `${area.toLocaleString('en-NZ')} m²` },
        { label: 'Height basis', value: HEIGHT_SOURCE_NOTE[heightFrom] },
        { label: 'Source', value: [qldc ? `QLDC building ${qldc}` : undefined, osm ? `OpenStreetMap ${osm}` : undefined].filter(Boolean).join(' · ') },
      ],
    };
  }

  return {
    id: LAYER_ID,
    label: 'Buildings',
    legend: settings.kinds.map(({ label, color }) => ({ label, color })),
    get visible() {
      return visible;
    },
    loadZone: zones.load,
    unloadZone: zones.unload,
    setVisible,
    setSuspended,
    setViewMode,
    setGlass,
    /** Loaded after the networks (see src/zones/zoneLayers.js): on a slow connection the pipes come first. */
    wave: 2,
    highlight,
    describe,
    /** Short status text for a loaded zone, e.g. "1,958 buildings". */
    summary(zoneId) {
      const content = zones.get(zoneId);
      if (!content) return undefined;
      return content.hasData ? `${content.features.length.toLocaleString('en-NZ')} buildings` : 'no building data yet';
    },
  };
}

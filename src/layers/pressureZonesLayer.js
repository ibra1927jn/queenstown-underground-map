/**
 * The pressure zones of the water supply: the areas fed at one pressure (from one reservoir or
 * pressure-reducing valve). Each is a see-through colour on the ground with its name; tap one for
 * its name and code. Off until switched on in the layers panel.
 *
 * Data: data/water-pressure-zones.geojson (one file for the district) – made by
 * scripts/data/convert-qldc-networks.mjs from the council's "Water Supply Pressure Zones".
 */
import { Cesium } from '../map/cesium.js';
import { fetchJson } from '../util/http.js';

const LAYER_ID = 'pressure-zones';

/** Soft colours that tell neighbouring zones apart. */
const PALETTE = ['#4dabf7', '#69db7c', '#ffa94d', '#da77f2', '#38d9a9', '#ff8787', '#a9e34b', '#748ffc', '#ffd43b', '#63e6be'];

export function createPressureZonesLayer({ viewer, dataPath, settings }) {
  const { scene } = viewer;
  let visible = false;
  let suspended = false;
  let loading;
  let content; // { features, fill, labels }
  let highlighted; // index of the selected zone
  const idsOf = new Map(); // index -> the ids of its parts (a zone can be in several pieces)

  const colourOf = (index) => Cesium.Color.fromCssColorString(PALETTE[index % PALETTE.length]);

  async function load() {
    const collection = await fetchJson(`${dataPath}/water-pressure-zones.geojson`, { optional: true });
    const features = collection?.features ?? [];
    const instances = [];
    const labels = new Cesium.LabelCollection({ scene }); // the scene: the labels sit on the ground (heightReference)
    features.forEach((feature, index) => {
      const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
      let biggest;
      for (const polygon of polygons) {
        const [outer, ...holes] = polygon.map((ring) => Cesium.Cartesian3.fromDegreesArray(ring.slice(0, -1).flat()));
        if (outer.length < 3) continue;
        const id = { layer: LAYER_ID, index };
        idsOf.set(index, [...(idsOf.get(index) ?? []), id]);
        instances.push(
          new Cesium.GeometryInstance({
            id,
            geometry: new Cesium.PolygonGeometry({ polygonHierarchy: new Cesium.PolygonHierarchy(outer, holes.map((hole) => new Cesium.PolygonHierarchy(hole))) }),
            attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(colourOf(index).withAlpha(settings.fillAlpha)) },
          }),
        );
        if (!biggest || polygon[0].length > biggest.length) biggest = polygon[0];
      }
      if (biggest && feature.properties.name) {
        const lon = biggest.reduce((sum, p) => sum + p[0], 0) / biggest.length;
        const lat = biggest.reduce((sum, p) => sum + p[1], 0) / biggest.length;
        labels.add({
          id: { layer: LAYER_ID, index },
          position: Cesium.Cartesian3.fromDegrees(lon, lat, 0),
          text: feature.properties.name,
          font: '600 13px system-ui, sans-serif',
          fillColor: Cesium.Color.fromCssColorString('#13232f'),
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, settings.labelsWithinM),
        });
      }
    });
    const fill = instances.length
      ? scene.primitives.add(new Cesium.GroundPrimitive({ geometryInstances: instances, classificationType: Cesium.ClassificationType.TERRAIN, show: visible && !suspended }))
      : undefined;
    scene.primitives.add(labels);
    labels.show = visible && !suspended;
    content = { features, fill, labels };
    scene.requestRender();
  }

  function apply() {
    const on = visible && !suspended;
    if (on && !content && !loading) loading = load().catch((error) => console.error('Pressure zones could not be loaded', error));
    if (content) {
      if (content.fill) content.fill.show = on;
      content.labels.show = on;
    }
    scene.requestRender();
  }

  function highlight(id) {
    const paint = (index, selected) => {
      if (!content?.fill?.ready) return;
      const color = selected ? Cesium.Color.fromCssColorString(settings.highlightColor).withAlpha(0.45) : colourOf(index).withAlpha(settings.fillAlpha);
      for (const id of idsOf.get(index) ?? []) {
        const attributes = content.fill.getGeometryInstanceAttributes(id);
        if (attributes) attributes.color = Cesium.ColorGeometryInstanceAttribute.toValue(color);
      }
    };
    if (highlighted !== undefined) paint(highlighted, false);
    highlighted = id?.index;
    if (highlighted !== undefined) paint(highlighted, true);
    scene.requestRender();
  }
  return {
    id: LAYER_ID,
    label: 'Water pressure zones',
    legend: [{ label: 'One colour per zone (fed at one pressure)', color: PALETTE[0] }],
    get visible() {
      return visible;
    },
    loadZone: async () => {},
    unloadZone: () => {},
    setVisible(next) {
      visible = next;
      apply();
    },
    setSuspended(next) {
      suspended = next;
      apply();
    },
    highlight,
    describe(id) {
      const feature = content?.features[id.index];
      if (!feature) return undefined;
      return {
        title: feature.properties.name ?? 'Pressure zone',
        subtitle: 'Water supply · pressure zone',
        rows: [{ label: 'Council code', value: feature.properties.code }],
        note: 'The area fed at one pressure, from one reservoir or pressure-reducing valve, as the council records it.',
      };
    },
    summary: () => undefined,
  };
}

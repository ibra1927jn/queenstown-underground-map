/**
 * Zones: the map is split into areas (Queenstown Central, Frankton, Wanaka…)
 * and data files are loaded one zone at a time. The list lives in
 * data/zones.json and is shared with the data-preparation scripts.
 *
 * A zone: { id, name, group, bbox: [west, south, east, north], center: [lon, lat], view?: {...} }
 */
import { fetchJson } from '../util/http.js';

export async function loadZones(dataPath) {
  const { zones } = await fetchJson(`${dataPath}/zones.json`);
  if (!Array.isArray(zones) || zones.length === 0) throw new Error('zones.json has no zones');

  for (const zone of zones) {
    const box = zone.bbox;
    const boxIsValid = Array.isArray(box) && box.length === 4 && box.every(Number.isFinite) && box[0] < box[2] && box[1] < box[3];
    if (!zone.id || !zone.name || !zone.group || !boxIsValid) {
      throw new Error(`zones.json: zone "${zone.id ?? zone.name ?? '?'}" needs an id, a name, a group and a bbox [west, south, east, north]`);
    }
  }
  return zones;
}

/** The zone whose box contains the point, if any. */
export function zoneAt(zones, lon, lat) {
  return zones.find(({ bbox: [west, south, east, north] }) => lon >= west && lon < east && lat >= south && lat < north);
}

/** [lon, lat] the camera should look at for a zone. */
export function zoneCentre(zone) {
  if (zone.center) return zone.center;
  const [west, south, east, north] = zone.bbox;
  return [(west + east) / 2, (south + north) / 2];
}

/** Zones grouped for the selector: [{ group: 'Queenstown', zones: [...] }, …] in file order. */
export function groupZones(zones) {
  const groups = [];
  for (const zone of zones) {
    let entry = groups.find((candidate) => candidate.group === zone.group);
    if (!entry) groups.push((entry = { group: zone.group, zones: [] }));
    entry.zones.push(zone);
  }
  return groups;
}

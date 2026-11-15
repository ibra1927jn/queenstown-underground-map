/**
 * The details cards of the electricity layer (src/layers/networkLayer.js asks for them): power lines
 * and cables, substations, transmission towers, transformers and streetlights.
 *
 * Data: data/<zone>/power.geojson and power-detail.geojson, made by scripts/data/convert-power.mjs.
 * Heights of overhead wires and depths of cables are not recorded anywhere public: the figures shown
 * are typical ones for the voltage, and say so.
 */

const SOURCE = {
  transpower: 'Transpower New Zealand open data (CC BY 4.0)',
  osm: 'OpenStreetMap (© OpenStreetMap contributors, ODbL)',
  plan: 'Queenstown Lakes District Plan (council)',
  streetlights: "The council's streetlights (RAMM; indicative only)",
};

const DIG_WARNING = 'Approximate – never dig based on this map; always check beforeUdig.';

const voltageWords = (kV) => (kV === undefined ? undefined : kV < 1 ? `${Math.round(kV * 1000)} V` : `${kV} kV`);

/** A power line, cable or District Plan route. */
export function describePowerLine(p) {
  const what = p.kind === 'cable' ? 'cable in the ground' : p.kind === 'overhead' ? 'overhead line' : 'route';
  const rows = [
    { label: 'Name', value: p.name },
    { label: 'Voltage', value: voltageWords(p.voltage) ?? 'Not recorded' },
    { label: 'Operator', value: p.operator },
    { label: 'Reference', value: p.ref },
    { label: 'Length here', value: p.length ? `${p.length.toLocaleString('en-NZ')} m` : undefined },
  ];
  if (p.kind === 'overhead') rows.push({ label: 'Wires above the ground', value: `About ${p.aboveGroundM} m`, tag: 'estimate' });
  if (p.kind === 'cable') {
    rows.push(
      { label: 'Cover', value: `About ${p.depth.at[0].toFixed(1)} m`, tag: 'estimate' },
      { label: 'Cover basis', value: 'typical for a cable of this voltage in New Zealand – the real depth is not public' },
    );
  }
  rows.push({ label: 'Source', value: SOURCE[p.source] });
  const notes = {
    overhead: 'Drawn in the air at a height typical for the voltage. ',
    cable: 'Cover: ground to the top of the cable. Most of the underground network (the cables in the streets) is not public and not on this map. ',
    route: `${p.note ?? ''} `,
  };
  return { title: p.type, subtitle: `Electricity · ${what}`, rows, note: notes[p.kind] + DIG_WARNING };
}

/** A substation, tower, transformer or streetlight. */
export function describePowerAsset(p) {
  if (p.kind === 'streetlight') {
    return {
      title: 'Streetlight',
      subtitle: `Street lighting${p.owner ? ` · ${p.owner}` : ''}`,
      rows: [
        { label: 'Street', value: p.street },
        { label: 'Pole owner', value: p.owner },
        { label: 'Light owner', value: p.lightOwner !== p.owner ? p.lightOwner : undefined },
        { label: 'Light', value: p.light },
        { label: 'Lamp', value: p.lamp },
        { label: 'Pole', value: p.pole },
        { label: 'Mounting height', value: p.heightM ? `${p.heightM} m` : undefined },
        { label: 'Installed', value: p.year },
        { label: 'Source', value: SOURCE.streetlights },
      ],
      note: "From the council's road asset database: indicative only. The cable feeding it runs underground and is not on this map.",
    };
  }
  if (p.kind === 'substation') {
    return {
      title: p.name ?? p.planName ?? p.type,
      subtitle: `Electricity · ${p.type.toLowerCase()}`,
      rows: [
        { label: 'Kind', value: p.name || p.planName ? p.type : undefined },
        { label: 'Operator', value: p.operator },
        { label: 'Voltages', value: p.voltages },
        { label: 'Fed from the grid at', value: p.gxp },
        { label: 'District Plan name', value: p.planName && p.planName !== p.name ? p.planName : undefined },
        { label: 'Reference', value: p.ref },
        { label: 'Source', value: [SOURCE[p.source], p.alsoIn === 'plan' ? SOURCE.plan : undefined].filter(Boolean).join('; ') },
      ],
      note: p.outline ? 'The outline on the map is the site as mapped.' : undefined,
    };
  }
  if (p.kind === 'tower') {
    return {
      title: p.type,
      subtitle: 'Electricity · national grid structure',
      rows: [
        { label: 'Reference', value: p.ref },
        { label: 'Operator', value: p.operator },
        { label: 'Source', value: SOURCE[p.source] },
      ],
      note: 'A tower or pole of a transmission line of the national grid.',
    };
  }
  return {
    title: p.name ?? p.type,
    subtitle: `Electricity · ${String(p.type).toLowerCase()}`,
    rows: [
      { label: 'Operator', value: p.operator },
      { label: 'Voltages', value: p.voltages },
      { label: 'Source', value: SOURCE[p.source] },
    ],
  };
}

/**
 * "Stop the flow": what the panel says. From an answer of src/util/sewerStop.js – where to plug a sewer
 * and pump round, or which pumps to stop and which valves stand either side – every sentence, every line
 * of a list and where its mark goes on the map, as plain data:
 *
 *   panel = { summary, notes, lines, sections, foot }
 *     summary   the sentence in bold under the name of the pipe
 *     notes     [{ text, flag?, soft? }] sentences under it; flag: a caution; soft: a remark in small print
 *     lines     the main list: where to plug and pump round to, or the pumps to stop
 *     sections  [{ heading, open, hint?, notes?, lines?, steps? }] under it; open: false is folded away;
 *               steps: a numbered list of things to do
 *     foot      what the answer is worked out from, and what it leaves out
 *   line = { key, badge, look, title, words, flags, note?, at?, cannotUse?, canUse?, wontClose?, closes? }
 *     key       names the line; its mark on the map carries the same key
 *     badge     what stands in its round badge: a number, P, S, D, ?…
 *     look      which colours (CONFIG.sewerStop.badges): 'plug' | 'to' | 'station' | 'check' | 'open' | 'plain' | 'failed'
 *     at        [lon, lat]: the line gets a mark there, and a "Show" button
 *     cannotUse manholes (indexes): a "Can't use" button; canUse: a manhole to take back
 *     wontClose a valve (index): a "Won't close" button; closes: a valve to take back
 *
 * The view (src/tools/sewerStopView.js) only draws this, so the words can be checked without a browser
 * (tests/sewerWords.test.mjs). The sentences are those of the design
 * (docs/designs/2026-11-15-shut-the-sewer.md, "Words on screen"), which also lists what must never be
 * said: that a sewer is shut, that a plug makes anything safe, that a valve is open, closed or holding,
 * a time until overflow, the estimate of the flow as a measurement.
 *
 * Pure: plain data in and out.
 */
import { STOP_DEFAULTS, junctionPlace } from './sewerStop.js';

/** What the sentences are written with, besides what the answers are worked out with (STOP_DEFAULTS). */
const WORD_DEFAULTS = {
  peoplePerConnection: 3, // QLDC's design figures: the litres of a connection a day are those of this many people
  wellHours: 9, // QLDC's code: a new pump station stores at least this many hours of average dry-weather flow
  shortBreakM: 10, // a removed main no longer than this, crossed by an answer, is said as a break in the map
  namedPoints: 6, // of the points walked past, this many are named; the rest are counted
};

// ---- Numbers and names ---------------------------------------------------------------------------

const number = (n) => n.toLocaleString('en-NZ');
const count = (n, one, many = `${one}s`) => `${number(n)} ${n === 1 ? one : many}`;
const countOrNo = (n, one, many) => (n ? count(n, one, many) : `no ${one}`);
const metres = (m) => (m >= 10000 ? `${Math.round(m / 1000)} km` : m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);
const oneDecimal = (value) => value.toLocaleString('en-NZ', { maximumFractionDigits: 1 });
const sentence = (text) => text.charAt(0).toUpperCase() + text.slice(1);
const lowerFirst = (text) => text.charAt(0).toLowerCase() + text.slice(1);
/** 'a' or 'an' before a number, as it is read out: an 80 mm pipe, a 100 mm pipe. */
const aOrAn = (n) => (/^(8\d*|11|18)$/.test(String(Math.round(n))) ? 'an' : 'a');
/** A material as the council names it, in the middle of a sentence: 'Polyethylene (PE100)' is 'polyethylene', 'PVC' stays 'PVC'. */
const materialName = (material) => material.replace(/ \(.*$/, '').replace(/\b[A-Z][a-z]+\b/g, (word) => word.toLowerCase());
/** 'a', 'a and b', 'a, b and c'. */
const listed = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
const dotted = (parts) => parts.filter(Boolean).join(' · ');

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** '2026-05-22' as 'May 2026'. */
const monthOf = (date) => `${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;

/** What kind of structure a manhole record is, in a word: 'manhole', 'lamphole', 'chamber'… */
const structureOf = (hole) => hole.type.replace(/ \(.*$/, '').toLowerCase();
const holeName = (network, h) => `${structureOf(network.manholes[h])} ${network.manholes[h].id}`;
/** 'manhole 101194', or 'manhole 101194 or 101195' for the two recorded at one spot. */
const holesName = (network, holes) => `${structureOf(network.manholes[holes[0]])} ${holes.map((h) => network.manholes[h].id).join(' or ')}`;
const stationName = (network, s) => `${network.stations[s].name} pump station`;
const plantName = (network, p) => `the ${network.plants[p].name} treatment plant`;
/** How deep a manhole or a valve is: as a figure only where the council records it – otherwise it is that of the pipes there, or a typical one. */
const holeDepth = (hole) => (Number.isFinite(hole.depth) ? (hole.depthFrom === 'rec' ? `${hole.depth.toFixed(1)} m deep` : `about ${hole.depth.toFixed(1)} m deep (estimate)`) : undefined);
const holeWhere = (hole) => dotted([hole.street ?? 'Street not recorded', holeDepth(hole)]);
/** A junction named by what stands there: a manhole, else its street, else nothing but "here". */
const junctionName = (network, manholes, street, otherwise = 'here') => (manholes?.length ? holeName(network, manholes[0]) : street ? `a pipe junction with no manhole, ${street}` : otherwise);
const placeOf = (network, junction, manholes) => (manholes?.length ? network.manholes[manholes[0]].at : junctionPlace(network, junction));

// ---- Valves --------------------------------------------------------------------------------------

const POSITION = {
  open: 'Recorded open',
  closed: 'Recorded closed – that is the record, not proof',
};
const SIDE = { pumps: 'towards the pumps', discharge: 'towards the discharge', branch: 'on a branch' };

/** A valve as a line of a list: what it is, where, what the council records of it. */
function valveLine(network, v, { key, badge, look, where, flags = [], more = {} }) {
  const valve = network.valves[v];
  return {
    key,
    badge,
    look,
    title: dotted([valve.type, valve.diameter ? `${valve.diameter} mm` : undefined]),
    words: [
      dotted([valve.street ?? 'Street not recorded', holeDepth(valve), where]),
      POSITION[valve.position] ?? 'Open or closed: not recorded',
      valve.type === 'Valve' && !valve.role ? 'The council does not say what kind of valve this is' : undefined,
    ].filter(Boolean),
    flags: [valve.joint && !valve.pipeNotKnown ? 'At a joint of three pipes: check which one this valve is on.' : undefined, ...flags].filter(Boolean),
    note: valve.note,
    at: valve.at,
    ...more,
  };
}

/** 'valve × 8, non-return valve × 3': the valves recorded at a pump station, by kind. */
function valveKinds(network, valves) {
  const kinds = new Map();
  for (const v of valves) {
    const kind = network.valves[v].type.replace(/ \(.*$/, '').toLowerCase();
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  }
  return listed([...kinds].map(([kind, n]) => (n > 1 ? `${n} × ${kind}` : kind)));
}

// ---- Points walked past --------------------------------------------------------------------------

/** The cautions about the points a search walked past before it found a manhole that can take a plug. */
function passedFlags(network, passed, o) {
  if (!passed.length) return [];
  const junctions = passed.filter((point) => point.manhole === undefined).length;
  const names = passed.filter((point) => point.manhole !== undefined).map((point) => `${holeName(network, point.manhole)}${point.cannotUse ? ' (can’t use)' : ''}`);
  if (junctions) names.push(junctions === 1 ? 'a pipe junction with no manhole' : `${junctions} pipe junctions with no manhole`);
  const shown = names.length > o.namedPoints ? [...names.slice(0, o.namedPoints), `${names.length - o.namedPoints} more`] : names;
  return [
    `Past ${count(passed.length, 'point')} that cannot take a plug: ${listed(shown)}.`,
    ...passed.filter((point) => point.mayBeManhole).map((point) => `${sentence(holeName(network, point.manhole))} is recorded ${network.manholes[point.manhole].diameter} mm wide: it may be a manhole – check.`),
  ];
}
/** What pumps into a pressure system, by name ('Park St pump station', 'a pump with no record'), and whether it is one thing. */
function feedersOf(network, system) {
  const { sources } = network.systems[system];
  const unrecorded = sources.filter((source) => source.outlet !== undefined && network.outlets[source.outlet].kind === 'pump').length;
  const names = [...sources.filter((source) => source.station !== undefined).map((source) => stationName(network, source.station)), unrecorded === 1 ? 'a pump with no record' : unrecorded ? `${unrecorded} pumps with no record` : undefined].filter(Boolean);
  return { names, one: names.length === 1 && unrecorded < 2 };
}
const twoHolesFlag = (network, holes) => (holes.length > 1 ? `Two manholes are recorded at this spot (${holes.map((h) => network.manholes[h].id).join(' and ')}): check which is on this pipe.` : undefined);

// ---- The way on ----------------------------------------------------------------------------------

/** Where a pumped main lets go, after "discharges": 'at manhole 202367', 'into Norfolk Street pump station'… */
function dischargesAt(network, discharge) {
  if (discharge.kind === 'station') return `into ${stationName(network, discharge.station)}`;
  if (discharge.kind === 'plant') return `at ${plantName(network, discharge.plant)}`;
  if (discharge.kind === 'leaves') return 'outside the mapped area';
  if (discharge.kind === 'nowhere') return 'nowhere the map shows';
  return discharge.manholes.length ? `at ${holeName(network, discharge.manholes[0])}` : discharge.street ? `at ${discharge.street}` : 'at a pipe junction with no manhole';
}

/** The council's main that carries on where the map ends (the map leaves it out: its middle is outside the zones). */
const carriesOn = (beyond) => `the council's ${beyond.diameter ? `${beyond.diameter} mm ` : ''}pumped main carries on ${metres(beyond.lengthM)} beyond it; where it ends is not in the data`;
const leavesWords = (beyond) => (beyond ? `out of the mapped area: ${carriesOn(beyond)}` : 'out of the mapped area');

/** Why the map shows no way on from a place. */
function noWayReason(network, why) {
  if (why.reason === 'nothing') return 'nothing is recorded beyond it';
  if (why.reason === 'near') return `it ends ${oneDecimal(why.nearM)} m from another main`;
  if (why.reason === 'noMain') return `it ends at ${stationName(network, why.station)}, which has no pumped main in use on the map`;
  if (why.reason === 'inside') return `it ends inside ${why.name} (${why.note ?? 'not in use'})`;
  if (why.reason === 'private') return "it is a private network, and its treatment is not in the council's data";
  if (why.reason === 'mainEnds') return `the pumped main just ends${why.street ? ` at ${why.street}` : ''}`;
  if (why.reason === 'noDischarge') return 'the pump there has no pumped main that leads anywhere on the map';
  if (why.reason === 'loop') return 'the way comes back to a pump already passed';
  return 'the pipes here are on no way down on the map';
}

/**
 * Where it drains to, in one line: the first pump station with the distance to it, then pump after pump
 * to the treatment plant, out of the mapped area, or to where the map shows no way on, with the reason.
 * @param {object} way  the way on of an answer (`wayOn` of sewerStop.js)
 * @param {{ lead?: string, skipStation?: number }} [options]  lead: how the line starts ('Drains to');
 *   skipStation: a station already named (the one a pumped main discharges into) is not named again
 * @returns {string[]} one sentence, or two when the way ends with no way on
 */
export function wayWords(network, way, { lead = 'Drains to', skipStation } = {}) {
  const stops = [];
  let sewerM; // of sewer before the next stop
  for (const step of way.steps) {
    if (step.kind === 'sewer') {
      sewerM = step.lengthM;
      continue;
    }
    // The distance is given to the first stop only: the place the crew has to know of.
    const below = !stops.length && sewerM ? `, ${metres(sewerM)} below` : '';
    if (step.kind === 'station') {
      if (!(step.station === skipStation && !stops.length)) stops.push(`${stationName(network, step.station)}${step.inferred === 'againstRecord' ? ' (taken as the pump of its main, against its record)' : step.inferred ? ' (taken as the pump of its main: not recorded)' : ''}${below}`);
    } else {
      const where = junctionName(network, step.manholes, step.street, 'a pipe junction');
      const what = step.kind === 'pump' ? `a pump that is not on the map at ${where}` : `a pumped main it joins at ${where}`;
      stops.push(`${what}${below}${step.discharge ? `; ${step.kind === 'pump' ? 'its pumped main' : 'it'} discharges ${dischargesAt(network, step.discharge)}` : ''}`);
    }
    sewerM = undefined;
  }
  const straight = !stops.length && sewerM ? `, ${metres(sewerM)} below` : '';
  // (A pump with no record, or a pumped main the sewers join, has already said where it discharges: the plant is named once.)
  const last = way.steps.at(-1);
  const saidAlready = (last?.kind === 'pump' || last?.kind === 'joins') && last.discharge?.kind === 'plant';
  if (way.end === 'plant' && !saidAlready) stops.push(`${plantName(network, way.plant)}${straight}`);
  // A way that runs out of the map by gravity does not exist today; the words would still be right.
  const out = way.end === 'leaves' ? leavesWords(way.beyond) : undefined;
  const first = way.steps.find((step) => step.kind !== 'sewer');
  const start = lead === 'Drains to' && first && first.kind !== 'station' ? 'Runs to' : lead;
  const parts = [];
  if (stops.length) parts.push(`${start} ${[...stops, out].filter(Boolean).join(', then ')}.`);
  else if (out) parts.push(`${lead === 'Drains to' ? 'Runs' : lead} ${out}.`);
  if (way.end === 'none') {
    const hole = way.why.manholes?.length ? holeName(network, way.why.manholes[0]) : undefined;
    const from = straight ? `${hole ?? 'the end of the sewers'}${straight}` : (hole ?? (stops.length ? 'there' : 'here'));
    parts.push(`The map shows no way on from ${from}: ${noWayReason(network, way.why)}.`);
  }
  return parts;
}

// ---- Doubts --------------------------------------------------------------------------------------

const WHERE = { pipe: 'this pipe', stretch: 'on the stretch', upstream: 'upstream', main: 'on the way to the discharge', way: 'on the way on' };
const WHERE_PUMPED = { ...WHERE, pipe: 'this main', upstream: 'upstream of the pumps' };

/** A doubt the data holds about an answer, as a name and a sentence. */
function doubtWords(network, doubt, o) {
  const at = (manholes, otherwise = 'a pipe junction with no manhole') => (manholes?.length ? holeName(network, manholes[0]) : otherwise);
  if (doubt.kind === 'link') {
    const link = network.links[doubt.link];
    const length = link.lengthM < 0.1 ? 'a few centimetres' : `${oneDecimal(link.lengthM)} m`;
    if (link.kind === 'gap') return ['A break in the map', `The map has a break of ${length} here. Taken as joined.`];
    if (link.kind === 'short') return ['A vent or bypass pipe', `A short vent or bypass pipe (${link.id}, ${length}) joins the pipes here: taken as part of the way.`];
    const recorded = link.kind === 'removed' ? 'removed' : 'not in use';
    if (link.lengthM <= o.shortBreakM) return ['A break in the map', `The map has a break of ${length} here; the pipe between is recorded as ${recorded} (${link.id}). Taken as joined.`];
    return [`A main recorded as ${recorded}`, `From ${at(network.junctions[link.a].manholes, 'here')} the only way on is a main the council records as ${recorded} (${link.id}). The tool carries on where it ended – newer pipes may run differently.`];
  }
  if (doubt.kind === 'against') return ['Taken against its record', `The council's record of main ${doubt.id} says it runs the other way – check.`];
  if (doubt.kind === 'noDirection') {
    const n = doubt.ids.length;
    return ['No direction recorded', `${count(n, 'pipe')} on the way ${n === 1 ? 'has' : 'have'} no direction in the council's record; ${n === 1 ? 'it is' : 'they are'} taken to run on.`];
  }
  if (doubt.kind === 'split') return ['Two ways out of a manhole', `At ${at(doubt.manholes)} the record lets sewage leave two ways; the larger pipe${doubt.diameter ? ` (${doubt.diameter} mm)` : ''} is followed.`];
  if (doubt.kind === 'otherWayAbove') return ['Two ways out of a manhole', `At ${at(doubt.manholes)} the record lets sewage leave two ways, and the one the tool follows from there leads elsewhere. What is above it is counted as arriving here all the same: it may not come this way.`];
  if (doubt.kind === 'otherWay') return ['Another way out', `${sentence(at(doubt.manholes))} has another way out on the map – the pipe the tool follows from it. What arrives there may not come towards the work; it is counted as arriving all the same.`];
  if (doubt.kind === 'beside') return ['Beside a pump station', `${sentence(at(doubt.manholes, 'the end of the sewer'))} is ${oneDecimal(doubt.metres)} m from ${stationName(network, doubt.station)}: taken as its inlet.`];
  if (doubt.kind === 'pumpNotOnMap') return ['A pump with no record', `The sewers end at ${at(doubt.manholes)} ${doubt.gapM ? `and a pumped main starts ${oneDecimal(doubt.gapM)} m away` : 'where a pumped main starts'}: a pump with no record. Find it on site.`];
  if (doubt.kind === 'inferredPump' && doubt.how === 'againstRecord') return ['A pump against the record of its main', `${sentence(stationName(network, doubt.station))} is taken as the pump of its main although the council records that main as running into it: nothing else on the map feeds it. Check which way it runs.`];
  if (doubt.kind === 'inferredPump') return ['A pump the record does not name', `${sentence(stationName(network, doubt.station))} is taken as the pump of its main: it has no other pumped main, and the record does not say which way this one runs.`];
  if (doubt.kind === 'inflow') return ['From outside the mapped area', 'A pumped main comes in from outside the mapped area: what it brings is not counted.'];
  if (doubt.kind === 'deadEnd') return ['A branch that just ends', `By the council's record this pipe runs to a dead end${doubt.street ? ` at ${doubt.street}` : ''}, and the map shows nothing beyond it. Where it discharges is given for the main it branches from.`];
  if (doubt.kind === 'closedValve') return ['A valve recorded closed on the way', `Valve ${doubt.id} is recorded closed, and the map shows no way from the pump to where it discharges but past it. That is the record, not proof: check the valve, and where the pump really discharges.`];
  return ['A pumped main that leads nowhere', 'The pumped main of the pump with no record leads nowhere on the map.'];
}

/** The doubts as a section of the panel: each is also a "?" on the map. */
function doubtSection(network, { kind, doubts }, o) {
  if (!doubts.length) return undefined;
  return {
    heading: 'To check – “?” on the map',
    open: true,
    // (True of every answer of the district since the code review: tests/sewerStop.test.mjs and the audit of the
    // stretches hold what is counted against everything the record lets arrive.)
    hint: 'Where the council’s data is broken or in doubt, the tool counts more to arrive and more pumps to stop rather than fewer, and says so here. What the map does not hold at all – a main that comes in from outside the mapped area – it cannot count: that is said as “at least”.',
    lines: doubts.map((doubt, n) => {
      const [name, text] = doubtWords(network, doubt, o);
      return { key: `q${n}`, badge: '?', look: 'check', title: `${name} – ${(kind === 'pumped' ? WHERE_PUMPED : WHERE)[doubt.where] ?? doubt.where}`, words: [text], flags: [], at: doubt.at };
    }),
  };
}

// ---- What the practice research verified ---------------------------------------------------------

const ONLY_THE_OWNER = 'Only the network owner and its authorised agents may work on the sewers (QLDC; from 1 July 2027 Alpine Waters).';

const BEFORE_PLUG = {
  heading: 'Before you plug',
  steps: [
    ONLY_THE_OWNER,
    'Work out how long the pipes upstream can hold the flow before it spills, and keep at least 2 hours in hand. Avoid rain and the morning and evening peaks.',
    'Tell the properties that join the stretch: their sewage has nowhere to go and can back up.',
    'In a road, footpath or berm: a Corridor Access Request with a traffic management plan, approved by QLDC, before lids are lifted.',
    'A manhole is a confined space. Do not go in if a plug pole will do; otherwise test the air from outside, entry permit, stand-by person, rescue plan.',
    'Fix the plug so it cannot move. Inflate it and watch its gauge from outside the manhole, out of line with the pipe: every 15 minutes until steady, then every hour. Its rating is on its label.',
    'An inflatable plug is not protection for anyone working downstream of it.',
    'Standby pump or sucker truck on site; never leave the pumping unattended. Watch the level above the plug: if it keeps rising, take the plug out and let the flow through.',
    'At the end: let the water behind the plug go before deflating it, and leave nothing in the sewer – about half of QLDC’s sewer overflows come from things left or put in the pipes.',
  ],
};
const BEFORE_PUMPS = {
  heading: 'Before you stop the pumps',
  steps: [
    ONLY_THE_OWNER,
    'Agree the stop with whoever runs the station’s SCADA. Stop every pump, duty and standby, and padlock its isolator off.',
    'Close the pump discharge valves and the valve after the flow meter, where the station has them. Do not count on a non-return valve to hold.',
    'Know the well level and how fast it rises, and have tankers or a bypass sized for it, before you start. Stations upstream keep filling this one unless they are held too.',
    'Sewage that has stood in a pipe for hours is septic: gas monitor at the excavation.',
  ],
};
const BEFORE_VALVES = {
  heading: 'Before you close the valves',
  steps: [
    `${ONLY_THE_OWNER} The pump and tank on each property are the owner’s.`,
    'Close the line valves and the valve in the boundary kit of each property that pumps into the stretch. A pump that tries to run against a closed valve stops by itself.',
    'Tell the residents to use little water: each tank is built to hold about a day of normal use (750 litres for a standard household) and its alarm sounds if it fills.',
    'Before reopening, flush with clean water from a flushing point if you can.',
  ],
};
const before = (list) => ({ ...list, open: false });
const ifItEscapes = ({ phones }) => ({
  heading: 'If sewage escapes',
  open: false,
  notes: [
    {
      text: `Stop the source, hold it back, keep it out of stormwater drains and keep people away. Call QLDC – Queenstown ${phones.queenstown}, Wanaka ${phones.wanaka}, 24 hours – and, if it reaches or may reach water, the Otago Regional Council pollution hotline ${phones.pollution} (24 hours). No consent for sewer overflows is known: QLDC’s application was refused in 2019.`,
    },
  ],
});

/** What the answers are worked out from, and what they leave out: the foot of the panel. */
export const footWords = (network) =>
  `From the council's official open data only${network.dataOf ? `, last edited in ${monthOf(network.dataOf)}` : ''}. Not included: pipes laid since then (the council's test data), pump stations outside the mapped zones or with no record, and the valves inside pump stations.`;

// ---- A pipe the tool does not follow -------------------------------------------------------------

const NOT_THE_FLOW = { 'Vent pipe': 'a vent pipe', 'Outfall or bypass pipe': 'an outfall or bypass pipe' };
const recordedTwice = (ids) => `This pipe is recorded twice in the council's data (${ids.join(' and ')}).`;

/**
 * What the panel says of a tapped pipe that gets no answer.
 * @param {object} network
 * @param {object | undefined} tap  from `pieceAt`: undefined (the pipe is not in the network), or kind
 *   'pipework' | 'leavesStation'
 * @param {{ type?: string, source?: string }} pipe  what the map knows of the tapped pipe (source 'newer':
 *   from the council's newer test data)
 */
export function notFollowedPanel(network, tap, pipe = {}) {
  const panel = { notes: [], lines: [], sections: [], foot: footWords(network) };
  const twice = tap?.recordedTwice ? [{ text: recordedTwice(tap.recordedTwice) }] : [];
  // (A station's pipework can run round by a point just outside its outline: "inside it" is only said of the plant.)
  if (tap?.kind === 'pipework') return { ...panel, summary: tap.station !== undefined ? `This pipe is part of the pipework of ${stationName(network, tap.station)}: the tool does not follow a station's own pipes.` : 'This pipe is part of the pipework of the treatment plant: the tool does not follow pipes inside it.', notes: twice };
  if (tap?.kind === 'leavesStation') return { ...panel, summary: `This pipe starts at ${stationName(network, tap.station)}: it is recorded as leaving the station by gravity (an overflow or a bypass). The tool does not follow it.`, notes: twice };
  if (pipe.source === 'newer') return { ...panel, summary: "This pipe is not in the council's official data yet (it is in its newer test data), so the tool cannot follow it." };
  if (NOT_THE_FLOW[pipe.type]) return { ...panel, summary: `This is recorded as ${NOT_THE_FLOW[pipe.type]}: it carries air or overflow, not the day's flow. The tool does not follow it.` };
  // 'Main' is what is left of the council's catch-all type; anything else should not get here.
  return { ...panel, summary: pipe.type === 'Main' ? 'The council’s record does not say what kind of pipe this is (“Main”): the tool does not follow it.' : 'This pipe is not in the sewer network the tool works from, so it cannot follow it.' };
}

// ---- A gravity sewer -----------------------------------------------------------------------------

/** What the figures of a catchment leave out, or count though it may go another way: cautions under them. */
const catchmentFlags = (up) => [up.inflow.length ? 'At least: part of what is upstream is not on the map.' : undefined, up.otherWays.length ? bothWaysWords(up.otherWays.length) : undefined].filter(Boolean);

/** What is counted upstream includes what may go another way: a manhole up there has two ways out. */
const bothWaysWords = (n) => `Counted with what may go another way: at ${count(n, 'point')} upstream the record lets sewage leave two ways, and what is above ${n === 1 ? 'it' : 'them'} is counted here too (see “To check”).`;

/** "About 22 litres a second on an average dry day…": the estimate, labelled as one. */
function estimateWords(estimate, o) {
  // Under a litre a second the figures are easier to picture by the minute.
  const perMinute = estimate.averageLps < 1;
  const figure = (lps) => {
    const value = perMinute ? lps * 60 : lps;
    return oneDecimal(value >= 10 ? Math.round(value) : value);
  };
  const perPerson = Math.round(o.litresPerConnectionDay / o.peoplePerConnection);
  const average = figure(estimate.averageLps);
  return `About ${average} ${average === '1' ? 'litre' : 'litres'} a ${perMinute ? 'minute' : 'second'} on an average dry day, about ${figure(estimate.peakLps)} at the daily peak; more in rain. An estimate from QLDC's design figures (${perPerson} litres a person a day, ${o.peoplePerConnection} people per connection) – not a measurement. A hotel, apartment block or business on one connection counts as one home, so the real flow can be much higher.`;
}

function gravityPanel(network, answer, state, o) {
  const { manholes, stations, outlets } = network;
  const { pipe } = answer;
  const notes = [];
  const after = [before(BEFORE_PLUG), ifItEscapes(o)];
  if (pipe.recordedTwice) notes.push({ text: recordedTwice(pipe.recordedTwice) });
  if (pipe.owner === 'private') notes.push({ text: "Private sewer (not the council's)." });
  const cannotUse = [...(state.cannotUse ?? [])];
  const cannotUseSection = {
    heading: 'Can’t use',
    open: true,
    lines: cannotUse.map((h) => ({ key: `x${h}`, badge: '!', look: 'failed', title: sentence(holeName(network, h)), words: [holeWhere(manholes[h])], flags: [], at: manholes[h].at, canUse: h })),
  };

  if (answer.direction === 'unknown') {
    // On no way down and with no direction recorded: all that can be shown is the manholes at its two ends.
    const lines = answer.ends.flatMap(({ manholes: holes }) => holes).map((h) => ({ key: `e${h}`, badge: 'M', look: 'check', title: sentence(holeName(network, h)), words: [holeWhere(manholes[h])], flags: [], at: manholes[h].at, cannotUse: [h] }));
    if (!lines.length) notes.push({ text: 'No manhole that can take a plug is recorded at either end.', flag: true });
    return { summary: 'Which way this pipe runs cannot be told: the manholes at its two ends are shown.', notes, lines, sections: [cannotUseSection, ...after] };
  }

  const { plugs, pumpTo, stretch, arriving, way } = answer;
  const facility = pumpTo.station !== undefined ? stationName(network, pumpTo.station) : pumpTo.plant !== undefined ? plantName(network, pumpTo.plant) : undefined;

  // Where the plugs go, manhole by manhole: two pipes to plug at one manhole are one place.
  const places = [];
  for (const plug of plugs) {
    const place = places.find((found) => found.junction === plug.junction);
    if (place) place.plugs.push(plug);
    else places.push({ junction: plug.junction, manholes: plug.manholes, plugs: [plug] });
  }

  // The sentence in bold: how many plugs, and where to pump round to.
  const plugWords = plugs.length ? `Plug at ${count(places.length, 'manhole')}${plugs.length > places.length ? ` (${count(plugs.length, 'pipe')})` : ''}` : answer.pumps.length ? 'No sewer joins above this stretch on the map, so there is nothing to plug – but a pump discharges into it (S)' : 'Nothing joins above this stretch on the map: no plug is needed upstream';
  const toWords = pumpTo.manholes ? `pump round to ${holesName(network, pumpTo.manholes)}` : pumpTo.none ? 'no manhole is on the map below the work to pump round to' : `the stretch runs straight into ${facility}: there is no manhole to pump round to before it`;
  const summary = `Gravity sewer: the flow is held back with plugs, not valves. ${plugs.length && pumpTo.manholes ? `${plugWords} and ${toWords}` : `${plugWords}. ${sentence(toWords)}`}.`;

  notes.push({ text: `Stretch: ${metres(stretch.lengthM)}. ${stretch.connections ? `${count(stretch.connections, 'property connection')} ${stretch.connections === 1 ? 'joins' : 'join'} it: ${stretch.connections === 1 ? 'it keeps' : 'they keep'} discharging into it.` : 'No property connection joins it on the map.'}` });
  if (answer.direction === 'inferred') {
    const towards = network.junctions[answer.lower].manholes?.length ? holeName(network, network.junctions[answer.lower].manholes[0]) : (facility ?? 'the lower end of the stretch (P)');
    notes.push({ text: `The council's record does not say which way this pipe runs. From the pipes round it, it runs towards ${towards}.`, flag: true });
  }
  const highRisk = [answer.flags.bigPipe ? `Pipe larger than ${o.bigPipeMm} mm` : undefined, answer.flags.pumpStationUpstream ? 'pump station upstream' : undefined].filter(Boolean);
  if (highRisk.length) notes.push({ text: `${sentence(highRisk.join(' and '))} – other New Zealand councils treat plugging these as high-risk work (Christchurch asks for a written permit).`, flag: true });
  if (answer.limited) notes.push({ text: `Very many branches: the search stopped at ${count(plugs.length, 'plug')}.`, flag: true });
  for (const v of stretch.valves) {
    const valve = network.valves[v];
    notes.push({ text: `A valve is recorded on this sewer (${valve.type.toLowerCase()}, ${(POSITION[valve.position] ?? 'open or closed: not recorded').toLowerCase()}): it may hold the flow – check.`, flag: true });
  }
  if (pumpTo.none) for (const text of passedFlags(network, pumpTo.passed, o)) notes.push({ text: `Below the work: ${text.charAt(0).toLowerCase()}${text.slice(1)}`, flag: true });

  // Where to plug, numbered by manhole – one line and one mark each: above the work first, then the
  // branches that join below it.
  const whereOf = (plug) => (plug.branch ? `Branch: joins the stretch ${metres(plug.branch.joinsM)} below the work` : plug.distanceM < 0.5 ? 'At the tapped point' : `${metres(plug.distanceM)} above the work`);
  const flagsOf = (plug) => [
    plug.pipe !== undefined && !plug.diameter ? 'Pipe size not recorded.' : undefined,
    plug.link !== undefined ? 'The map does not draw the pipe from here to the stretch (see “To check”).' : undefined,
    twoHolesFlag(network, plug.manholes),
    ...passedFlags(network, plug.passed, o),
    plug.otherWay !== undefined ? 'This manhole has another way out on the map: what arrives here may not come towards the work.' : undefined,
    plug.junction === pumpTo.junction ? 'On the map the pipe leaves this manhole and comes back to it: the plug and the place to pump round to are at the same manhole.' : undefined,
  ];
  const lines = places.map((place, n) => {
    const hole = manholes[place.manholes[0]];
    const [first] = place.plugs;
    const several = place.plugs.length > 1;
    const named = sentence(holesName(network, place.manholes));
    return {
      key: `p${n}`,
      badge: String(n + 1),
      look: 'plug',
      title: several
        ? `${named} – plug ${place.plugs.length} pipes towards the work (${listed(place.plugs.map((plug) => (plug.diameter ? `${plug.diameter} mm` : 'size not recorded')))})`
        : `${named} – plug the ${first.diameter ? `${first.diameter} mm ` : ''}pipe towards the work`,
      words: [holeWhere(hole), ...(several ? place.plugs.map((plug) => `The ${plug.diameter ? `${plug.diameter} mm ` : ''}pipe: ${lowerFirst(whereOf(plug))}`) : [whereOf(first)])],
      flags: [...new Set(place.plugs.flatMap(flagsOf).filter(Boolean))],
      at: hole.at,
      cannotUse: place.manholes,
    };
  });
  // Where to pump round to.
  const belowWork = `${metres(pumpTo.distanceM)} below the work`;
  if (pumpTo.manholes) {
    const hole = manholes[pumpTo.manholes[0]];
    lines.push({
      key: 'to',
      badge: 'P',
      look: 'to',
      title: `Pump round to ${holesName(network, pumpTo.manholes)}`,
      words: [dotted([holeWhere(hole), belowWork]), facility ? `${pumpTo.station !== undefined ? 'The inlet manhole of' : 'Inside'} ${facility}` : undefined].filter(Boolean),
      flags: [twoHolesFlag(network, pumpTo.manholes), ...passedFlags(network, pumpTo.passed, o)].filter(Boolean),
      at: hole.at,
      cannotUse: pumpTo.manholes,
    });
  } else if (facility) {
    lines.push({ key: 'to', badge: pumpTo.station !== undefined ? 'S' : '→', look: pumpTo.station !== undefined ? 'station' : 'to', title: sentence(facility), words: [`The stretch runs straight into it, ${belowWork}`], flags: passedFlags(network, pumpTo.passed, o), at: junctionPlace(network, pumpTo.junction) });
  }
  // What pumps into the stretch itself. (A second main of pumps that are all named already – it ends
  // beside the first – gets no line of its own.)
  const namedHere = (source) => answer.pumps.some((pump) => (source.station !== undefined ? pump.station === source.station : pump.outlet === source.outlet));
  answer.pumps.forEach((pump, n) => {
    if (pump.system !== undefined && network.systems[pump.system].sources.length && network.systems[pump.system].sources.every(namedHere)) return;
    if (pump.station !== undefined) lines.push({ key: `in${n}`, badge: 'S', look: 'station', title: `${stationName(network, pump.station)} pumps into this stretch`, words: ['Stop it or allow for it.'], flags: stations[pump.station].owner === 'private' ? ['Private.'] : [], at: stations[pump.station].at });
    else if (pump.outlet !== undefined && outlets[pump.outlet].kind === 'pump') lines.push({ key: `in${n}`, badge: 'S', look: 'check', title: 'A pump with no record pumps into this stretch', words: ['Find it, and stop it or allow for it.'], flags: [], at: junctionPlace(network, outlets[pump.outlet].junction) });
    else if (pump.outlet !== undefined) lines.push({ key: `in${n}`, badge: 'S', look: 'check', title: 'A pumped main that sewers join discharges into this stretch', words: ['What they bring keeps coming.'], flags: [], at: junctionPlace(network, pump.junction) });
    else {
      // A pressure system, at a place that is no pump's own discharge: a second main beside the first, or
      // a pressure sewer with no pump station.
      const { names, one } = feedersOf(network, pump.system);
      const properties = pump.connections ? `${count(pump.connections, 'property pumps', 'properties pump')} into it, each with its own pump: they keep pumping unless someone closes their boundary kits.` : undefined;
      if (names.length) lines.push({ key: `in${n}`, badge: 'S', look: 'check', title: 'A pumped main discharges into this stretch', words: [`${sentence(listed(names))} ${one ? 'pumps' : 'pump'} into that main: stop ${one ? 'it' : 'them'} or allow for ${one ? 'it' : 'them'}.`, properties].filter(Boolean), flags: [], at: junctionPlace(network, pump.junction) });
      else lines.push({ key: `in${n}`, badge: 'S', look: 'check', title: 'A pressure sewer discharges into this stretch', words: [properties ?? 'The map shows no property that pumps into it.'], flags: [], at: junctionPlace(network, pump.junction) });
    }
  });

  // What keeps arriving: above the plugs, and through what pumps into the stretch itself.
  const keeps = [];
  const { above, into } = arriving;
  const figures = (part) => `${metres(part.sewerM)} of sewer and ${countOrNo(part.connections, 'property connection')}${part.pumpedConnections ? `, ${number(part.pumpedConnections)} of them pumped` : ''}`;
  if (arriving.nothing) keeps.push({ text: 'Nothing joins above on the map.' });
  else {
    if (!answer.pumps.length || above.sewerM || above.pumpedM || above.connections) keeps.push({ text: `From upstream: ${figures(above)}.` });
    if (answer.pumps.length) keeps.push({ text: `Pumped into the stretch itself (S): what drains to those pumps, ${figures(into)}. No plug holds it back.` });
    const names = arriving.stations.map((s) => stations[s].name);
    if (names.length) keeps.push({ text: names.length === 1 ? `A pump station upstream pumps into it in bursts: ${names[0]}. Stop it or allow for it.` : `Pump stations upstream pump into it in bursts: ${listed(names)}. Stop them or allow for them.` });
    if (arriving.pumps.length) keeps.push({ text: `${count(arriving.pumps.length, 'pump')} with no record upstream.` });
  }
  // The estimate is for everything that drains to the work; where that is more than the figure "from upstream", it says of what.
  if (answer.estimate.connections) {
    const parts = [[above.connections, 'above the plugs'], [into.connections, 'behind what is pumped into the stretch'], [stretch.connections, 'on the stretch itself']].filter(([n]) => n);
    if (parts.length > 1) keeps.push({ text: `The estimate is for ${count(answer.estimate.connections, 'property connection')}: ${listed(parts.map(([n, where]) => `${number(n)} ${where}`))}.` });
    else if (!above.connections) keeps.push({ text: `The estimate is for the ${count(answer.estimate.connections, 'property connection')} ${parts[0][1]}.` });
    keeps.push({ text: estimateWords(answer.estimate, o) });
  }
  for (const text of catchmentFlags(arriving)) keeps.push({ text, flag: true });
  keeps.push({ text: 'Pump stations outside the mapped zones are not listed.', soft: true });

  const drains = wayWords(network, way).map((text) => ({ text }));
  if (way.doubts.filter((doubt) => doubt.kind === 'against').length >= 2) drains.push({ text: 'The map does not show for certain where this goes.', flag: true });

  return {
    summary,
    notes,
    lines,
    sections: [
      cannotUseSection,
      { heading: 'What keeps arriving', open: true, notes: keeps },
      { heading: 'Where it drains to', open: true, notes: drains },
      doubtSection(network, answer, o),
      ...after,
    ],
  };
}

// ---- A pumped main -------------------------------------------------------------------------------

const HOW = {
  through: 'pumps through this pipe',
  sameSystem: 'on the same pumped system: its pressure reaches this pipe',
  mayPump: 'may pump into it – the record does not say which way this main runs',
};

/** A station taken as the pump of a main whose record does not say so: why. */
const INFERRED = {
  noDirection: 'taken as the pump: it has no other pumped main (not recorded)',
  againstRecord: 'taken as the pump although its main is recorded as running into it: nothing else on the map feeds that main',
};

/** Sewers that end on a pumped main: how what they bring stands to the tapped pipe. */
const HOW_JOINED = {
  through: 'What they bring comes through this pipe.',
  sameSystem: 'On the same pumped system: its pressure reaches this pipe.',
  mayPump: 'What they bring may come through this pipe – the record does not say which way this main runs.',
};

/** "While it is stopped it receives…": what arrives at a pump station while it is stopped. */
function receivesWords(network, receives) {
  const feeders = [...receives.own.stations.map((s) => network.stations[s].name), receives.own.pumps.length ? `${count(receives.own.pumps.length, 'pump')} with no record` : undefined].filter(Boolean);
  if (!receives.own.sewerM && !receives.own.connections && !feeders.length) return 'While it is stopped: the map shows nothing arriving at it.';
  const one = receives.own.stations.length + receives.own.pumps.length === 1;
  const own = `While it is stopped it receives: ${metres(receives.own.sewerM)} of sewer and ${countOrNo(receives.own.connections, 'connection')}`;
  if (!feeders.length) return `${own}.`;
  // With the catchments of the pumps upstream, when they are more than its own.
  const all = receives.sewerM > receives.own.sewerM || receives.connections > receives.own.connections ? ` (with all they bring: ${metres(receives.sewerM)} and ${count(receives.connections, 'connection')})` : '';
  return `${own} of its own; ${listed(feeders)} ${one ? 'keeps' : 'keep'} pumping into it unless ${one ? 'it is' : 'they are'} held too${all}.`;
}

function pressurePanel(network, answer, state, o) {
  const { valves, stations } = network;
  const { pipe, stretch } = answer;
  const lowPressure = answer.systemKind === 'lowPressure';
  const notes = [];

  if (pipe.recordedTwice) notes.push({ text: recordedTwice(pipe.recordedTwice) });
  if (pipe.small) notes.push({ text: `Recorded as a ${pipe.type.toLowerCase()}, but ${pipe.diameter ? `${aOrAn(pipe.diameter)} ${pipe.diameter} mm` : 'a'} ${materialName(pipe.small)} pipe: taken as a pumped pipe – no manholes to plug.` });
  else if (pipe.stub) notes.push({ text: 'A short pipe off a pumped main (to a valve or a chamber): answered as the pumped main.' });
  else if (pipe.link) notes.push({ text: 'A short pipe that joins two pumped mains: taken as part of the pumped main.' });
  if (pipe.owner === 'private') notes.push({ text: lowPressure ? "A private pumped line (not the council's)." : "Private (not the council's)." });
  notes.push({ text: `Stretch: ${metres(stretch.lengthM)}, as far as the valves, pumps and ends found.` });

  const properties = stretch.connections + answer.behind.connections;
  if (lowPressure) {
    const behind = answer.behind.cannotBeTold
      ? 'which properties are behind it cannot be told – the map does not show where this main discharges'
      : answer.behind.connections
        ? `${number(answer.behind.connections)} more ${answer.behind.connections === 1 ? 'is' : 'are'} behind it and pump${answer.behind.connections === 1 ? 's' : ''} through it`
        : 'none is behind it on the map';
    notes.push({ text: `${stretch.connections ? `${count(stretch.connections, 'property pumps', 'properties pump')} straight into this stretch` : 'No property pumps straight into this stretch on the map'}; ${behind}.` });
    const kits = stretch.kits + answer.behind.kits;
    if (properties) notes.push({ text: `Boundary kits recorded here: ${number(kits)} for ${count(properties, 'pumped property', 'pumped properties')}. Every pumped property has one at its boundary${kits < properties ? '; the others are not on the map' : ''}.` });
    if (answer.block.over) notes.push({ text: `${count(answer.block.properties, 'property is', 'properties are')} behind these valves; QLDC's standard keeps a block to ${answer.block.limit}.`, flag: true });
  } else if (answer.onSystem.connections) {
    notes.push({ text: `${count(answer.onSystem.connections, 'property pumps', 'properties pump')} straight into this main (${countOrNo(answer.onSystem.kits, 'boundary kit')} recorded): stopping the ${answer.stations.length ? 'station' : 'pump'} does not stop them.`, flag: true });
  }
  if (!lowPressure && !answer.stations.length && !answer.pumps.length && !answer.joins.length) notes.push({ text: 'The map shows no pump that feeds this main: find what does before working on it.', flag: true });
  notes.push({ text: 'Treat the pipe as full and under pressure after the pumps stop: sewage can come from either side when it is opened.', flag: true });

  // The pumps to stop: those that pump through the tapped pipe first.
  const lines = answer.stations.map((entry) => {
    const station = stations[entry.station];
    return {
      key: `s${entry.station}`,
      badge: 'S',
      look: 'station',
      title: `Stop the pumps: ${station.name}`,
      words: [
        dotted([entry.street, INFERRED[entry.inferred] ?? HOW[entry.how]]),
        entry.valves.length === 1
          ? `1 ${valveKinds(network, entry.valves)} is recorded at this station.`
          : entry.valves.length
            ? `Valves recorded at this station: ${valveKinds(network, entry.valves)}.`
            : "No valve is recorded at this station – the pump and meter valves inside a station are usually not on the council's map.",
        receivesWords(network, entry.receives),
      ],
      flags: [station.owner === 'private' ? 'Private.' : undefined, ...catchmentFlags(entry.receives)].filter(Boolean),
      at: station.at,
    };
  });
  for (const entry of answer.pumps) {
    lines.push({
      key: `o${entry.outlet}`,
      badge: 'S',
      look: 'check',
      title: `A pump with no record feeds this main at ${junctionName(network, entry.manholes, entry.street)}`,
      words: ['Find it and stop it.', HOW[entry.how]],
      flags: entry.nowhere ? ['Its pumped main leads nowhere on the map.'] : [],
      at: placeOf(network, entry.junction, entry.manholes),
    });
  }
  // Where sewers end on a main of this system and it carries them on: what they bring keeps coming, and
  // the pump stations that pump into those sewers are pumps of this main in all but name.
  const named = new Set(answer.stations.map((entry) => entry.station));
  for (const entry of answer.joins) {
    const { receives } = entry;
    lines.push({
      key: `j${entry.outlet}`,
      badge: 'S',
      look: 'check',
      title: `Sewers join this main at ${junctionName(network, entry.manholes, entry.street)}`,
      words: [HOW_JOINED[entry.how], `They bring ${metres(receives.sewerM)} of sewer and ${countOrNo(receives.connections, 'connection')}: it keeps coming unless what feeds them is held.`],
      flags: catchmentFlags(receives),
      at: placeOf(network, entry.junction, entry.manholes),
    });
    for (const s of receives.own.stations) {
      if (named.has(s)) continue;
      named.add(s);
      lines.push({ key: `j${entry.outlet}s${s}`, badge: 'S', look: 'station', title: `${stationName(network, s)} pumps into those sewers`, words: ['Stop it or allow for it.'], flags: stations[s].owner === 'private' ? ['Private.'] : [], at: stations[s].at });
    }
    for (const k of receives.own.pumps) lines.push({ key: `j${entry.outlet}o${k}`, badge: 'S', look: 'check', title: 'A pump with no record pumps into those sewers', words: ['Find it, and stop it or allow for it.'], flags: [], at: junctionPlace(network, network.outlets[k].junction) });
  }

  // The valves either side, nearest first; those with nothing behind them apart.
  const spot = (v) => `${valves[v].piece}:${valves[v].alongM}`;
  const sameSpot = (v) => answer.valves.map((entry) => entry.valve).filter((other) => other !== v && spot(other) === spot(v));
  const asLine = (entry, more) =>
    valveLine(network, entry.valve, {
      where: `${SIDE[entry.side]}, ${entry.distanceM < 0.5 ? 'at the tapped point' : `${metres(entry.distanceM)} from the work`}`,
      flags: sameSpot(entry.valve).map((other) => `Another valve is recorded at this same spot (${valves[other].id}): both are listed.`),
      ...more,
    });
  const needed = answer.valves.filter((entry) => entry.needed);
  const notNeeded = answer.valves.filter((entry) => !entry.needed);
  const noValve = answer.valves.length === 0 ? '' : answer.noLineValve.pumps && answer.noLineValve.discharge ? ' towards the pumps or towards the discharge' : answer.noLineValve.pumps ? ' towards the pumps' : answer.noLineValve.discharge ? ' towards the discharge' : undefined;
  const valveNotes = noValve === undefined ? [] : [{ text: `No line valve is recorded on this main${noValve}. ${lowPressure ? 'Close the boundary kits of the properties, or their pumps keep reaching this pipe.' : 'Stop the pumps; the pipe stays full.'}`, flag: true }];
  const wontClose = [...(state.wontClose ?? [])];

  // Where it lets go, and the way on from there.
  const outLines = answer.discharges.map((discharge, n) => {
    const line = { key: `out${n}`, badge: '→', look: 'to', flags: [], at: placeOf(network, discharge.junction, discharge.manholes) };
    if (discharge.kind === 'nowhere') return { ...line, badge: '?', look: 'check', title: 'The map does not show where this main discharges', words: [`It just ends${discharge.street ? ` at ${discharge.street}` : ''}.`] };
    if (discharge.kind === 'leaves') return { ...line, title: 'The mapped area ends here', words: [discharge.beyond ? `${sentence(carriesOn(discharge.beyond))}.` : 'Where the main goes from here is not in the data.'] };
    const title = discharge.kind === 'station' ? `Discharges into ${stationName(network, discharge.station)}` : discharge.kind === 'plant' ? `Discharges at ${plantName(network, discharge.plant)}` : discharge.manholes.length ? `Discharges into ${holeName(network, discharge.manholes[0])}` : 'Discharges at a pipe junction with no manhole';
    return { ...line, title, words: [discharge.kind === 'gravity' ? discharge.street : undefined, ...(discharge.kind === 'plant' ? [] : wayWords(network, discharge.way, { lead: 'Then', skipStation: discharge.station }))].filter(Boolean) };
  });
  const outNotes = [];
  if (!answer.discharges.length) outNotes.push({ text: 'The map does not show where this main discharges.', flag: true });
  if (answer.discharges.some((discharge) => discharge.way.doubts.filter((doubt) => doubt.kind === 'against').length >= 2)) outNotes.push({ text: 'The map does not show for certain where this goes.', flag: true });

  const wellNote = answer.stations.length
    ? `Sewage collects in the station's well. QLDC's code asks new stations for at least ${o.wellHours} hours of average dry-weather flow (about ${oneDecimal(o.wellHours / o.peakFactor)} hours at the daily peak); older and large stations may have less. ${answer.stations.length === 1 ? "This station's real storage" : 'The real storage of these stations'} is not in the data: read the level on site.`
    : undefined;

  return {
    summary: lowPressure
      ? 'Low-pressure sewer: each property here has its own pump. To work on this pipe, close the valves either side of it and the boundary kits of the properties that pump into it.'
      : 'Pumped main (rising main). To work on it, stop and lock out the pumps that feed it – closing a valve does not stop a pump.',
    notes,
    lines,
    sections: [
      wellNote ? { heading: 'While a station is stopped', open: true, notes: [{ text: wellNote }] } : undefined,
      { heading: 'Valves on the main either side', open: true, notes: valveNotes, lines: needed.map((entry, n) => asLine(entry, { key: `v${entry.valve}`, badge: String(n + 1), look: 'plug', more: { wontClose: entry.valve } })) },
      { heading: 'Won’t close', open: true, lines: wontClose.map((v) => valveLine(network, v, { key: `w${v}`, badge: '!', look: 'failed', more: { closes: v } })) },
      {
        heading: `${count(answer.atJoints.length, 'valve')} at a joint – which pipe ${answer.atJoints.length === 1 ? 'it is' : 'they are'} on is not known`,
        open: true,
        hint: 'Recorded where pipes of different sizes meet, with no size of their own: the tool cannot tell which pipe each is on, and does not end the stretch at it. One of them may be a valve to close.',
        lines: answer.atJoints.map((v) => valveLine(network, v, { key: `a${v}`, badge: 'V', look: 'check' })),
      },
      {
        heading: `${count(notNeeded.length, 'valve')} with nothing behind ${notNeeded.length === 1 ? 'it' : 'them'} on the map`,
        open: false,
        hint: 'They end the stretch, but the map shows no pump, discharge or property beyond them.',
        lines: notNeeded.map((entry) => asLine(entry, { key: `v${entry.valve}`, badge: '–', look: 'open' })),
      },
      {
        heading: `${count(answer.inside.length, 'line valve')} the mains are joined round`,
        open: false,
        hint: 'On the map the pipes are joined round these valves, so they do not end the stretch.',
        lines: answer.inside.map((v) => valveLine(network, v, { key: `i${v}`, badge: '=', look: 'plain' })),
      },
      answer.drains.length
        ? { heading: `To drain it: ${count(answer.drains.length, 'scour or flushing valve')} recorded on this stretch`, open: false, lines: answer.drains.map((v) => valveLine(network, v, { key: `d${v}`, badge: 'D', look: 'open' })) }
        : { heading: 'To drain it', open: true, notes: [{ text: 'No drain valve is recorded on this stretch.' }] },
      answer.air.length || answer.nonReturn.length
        ? { heading: 'Air and non-return valves', open: true, notes: [{ text: `Air valves on this stretch: ${answer.air.length}. Non-return valves: ${answer.nonReturn.length}${answer.nonReturn.length ? ' – do not count on one to hold' : ''}.` }] }
        : undefined,
      { heading: `${count(answer.others.length, 'other valve')} recorded on this stretch`, open: false, hint: 'Not line valves, drains, air or non-return valves: a bypass, for instance.', lines: answer.others.map((v) => valveLine(network, v, { key: `u${v}`, badge: '•', look: 'plain' })) },
      {
        heading: 'On the map near here, but on no pipe',
        open: true,
        hint: 'The tool cannot tell which pipe these valves are on – one of them may be one to close.',
        lines: answer.nearby.map((v) => valveLine(network, v, { key: `n${v}`, badge: 'V', look: 'check' })),
      },
      { heading: 'Where it discharges', open: true, notes: outNotes, lines: outLines },
      doubtSection(network, answer, o),
      before(lowPressure ? BEFORE_VALVES : BEFORE_PUMPS),
      ifItEscapes(o),
    ],
  };
}

// ---- The panel -----------------------------------------------------------------------------------

/**
 * What the panel says of an answer.
 * @param {object} network  data/wastewater-stop.json, read with `unpackSewerNetwork`
 * @param {object} answer  of `stopGravity` or `stopPressure`
 * @param {{ cannotUse?: Iterable<number>, wontClose?: Iterable<number> }} state  the manholes the crew cannot
 *   use and the valves that will not close, as given to the answer: each is listed, to be taken back
 * @param {object} settings  CONFIG.sewerStop: phones { queenstown, wanaka, pollution }, and any of
 *   litresPerConnectionDay, peoplePerConnection, peakFactor, bigPipeMm
 * @returns {object} the panel (see the top of this file); sections with nothing in them are left out
 */
export function answerPanel(network, answer, state, settings) {
  const o = { ...STOP_DEFAULTS, ...WORD_DEFAULTS, ...settings };
  const panel = answer.kind === 'gravity' ? gravityPanel(network, answer, state, o) : pressurePanel(network, answer, state, o);
  const filled = (section) => section && (section.lines?.length || section.notes?.length || section.steps?.length);
  return { ...panel, sections: panel.sections.filter(filled), foot: footWords(network) };
}

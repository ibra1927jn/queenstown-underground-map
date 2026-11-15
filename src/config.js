/**
 * Settings of the demo, all in one place.
 */
export const CONFIG = {
  /** Folder with zones.json and the per-zone data files. */
  dataPath: 'data',

  /** Zone shown when the page opens. */
  startZone: 'queenstown-central',

  /** How many zones stay in memory; older ones are unloaded to keep phones responsive. */
  maxLoadedZones: 2,

  /**
   * Rendering quality: how sharp the map is drawn against how smoothly it moves and how much
   * memory it needs. One preset for computers, one for phones (see src/map/quality.js and
   * src/map/viewer.js for what each setting does, docs/PERFORMANCE.md for the measurements).
   */
  quality: {
    desktop: {
      pixelRatios: [1.5, 1.25, 1], // device pixels per CSS pixel while moving: the first, then lower if frames arrive late
      stillPixelRatio: 3, // when the map stands still: the full density of the screen (up to this)
      antialiasSamples: 1, // 1 = off; 4 smooths edges but, at high resolution, tripled the cost of every frame
      smoothEdges: true, // FXAA: a cheap smoothing of jagged edges, done once over the finished image
      imageryAnisotropy: 8, // sharpness of the map image at grazing angles (1-16)
      outlines: true, // thin dark outlines round buildings and shapes (CONFIG.look): about 3 ms per frame on a laptop
    },
    phone: {
      pixelRatios: [1.5, 1.25, 1],
      stillPixelRatio: 3,
      antialiasSamples: 1,
      smoothEdges: true,
      imageryAnisotropy: 4,
      outlines: true, // not yet tried on a real phone: switch off here if the map moves slowly
    },
    /** When to step the resolution down: more than `slowShare` of `sampleFrames` frames slower than `slowFrameMs`. */
    governor: { slowFrameMs: 24, slowShare: 0.3, sampleFrames: 60 },
  },

  /** How the 3D map looks: like an architect's model (src/map/look.js). */
  look: {
    sky: true, // a sky with a glow at the horizon instead of a flat colour
    // The light shines the way the camera looks, turned this many degrees to the right – so it comes over
    // the viewer's left shoulder – from this many degrees above the horizon, this bright (0-1; Cesium caps a light at 1).
    light: { aroundDegrees: 35, downDegrees: 50, brightness: 0.8 },
    // Outlines where the depth of the picture bends: how sharp a bend counts (in the logarithmic depth),
    // how much darker the outline is, and the distances over which they fade out.
    outlines: { threshold: 0.0001, darken: 0.5, fadeFromM: 1200, fadeToM: 2500 },
  },

  /** How the map responds to mouse, touch, keys and the on-screen buttons (src/map/controls.js). */
  controls: {
    maxTiltDegrees: 75, // 0 = straight down, 90 = level with the horizon (which draws far more terrain)
    minDistanceM: 25, // lowest the camera flies above the ground, and so the closest it gets looking straight down
    maxDistanceM: 150_000, // farthest: the whole district and its surroundings
    inertia: 0.93, // how long the map keeps gliding after a flick (0 to 1)
    zoomInertia: 0.85,
    // One "step" is one press of a button or a key:
    zoomStep: 2, // + or - halves or doubles the width of the view
    turnStepDegrees: 30,
    tiltStepDegrees: 12,
    keyboardPanShare: 0.2, // an arrow key moves the map by this share of the view's width
    stepSeconds: 0.3, // how long the glide of one step lasts
    heldKeyStepsPerSecond: 3, // pace while a key is held down
  },

  /**
   * Elevation for the 3D relief. Sources are tried in this order; all are free
   * and need no account or key. "Terrarium" tiles are images whose colours
   * encode heights – see src/map/terrain.js.
   */
  terrain: {
    sources: [
      {
        name: 'LINZ 1 m LiDAR (via Mapterhorn)',
        url: 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp',
        tileSize: 512,
        maxZoom: 15, // 1.7 m per pixel here; zoom 16 exists (0.8 m) but is four times the download
        credit:
          'Terrain: <a href="https://mapterhorn.com/attribution" target="_blank" rel="noopener">Mapterhorn</a> – Toitū Te Whenua LINZ (CC BY 4.0), Copernicus GLO-30',
      },
      {
        name: 'LINZ 8 m DEM (AWS Terrain Tiles)',
        url: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
        tileSize: 256,
        maxZoom: 15,
        credit:
          'Terrain: Mapzen / AWS Terrain Tiles – New Zealand terrain data Copyright 2011 Crown copyright (c) Land Information New Zealand and the New Zealand Government (All rights reserved)',
      },
    ],
    /** A tile over Queenstown [zoom, x, y], used to check that a source answers. */
    probeTile: [12, 3966, 2623],
    /** Decoded elevation tiles kept in memory (about 1 MB each for 512-px tiles). */
    cachedTiles: { phone: 24, desktop: 64 },
  },

  /**
   * Aerial photos as the background (src/map/baseMap.js): Toitū Te Whenua LINZ Basemaps.
   * They need a key (README, "Keys"); without one the switch is not shown.
   *
   * `photos`: the surveys there are over the district, with the year they were finished (a survey
   * flown over several years counts from its last). `covers`: 'all', or the side of the district
   * it was flown over; `partial`: it has gaps on that side, so the survey before it is drawn
   * underneath. Checked tile by tile over the 13 zones on 13 November 2026.
   * `maximumLevel`: the zoom level that matches the survey's detail (deeper levels are the same picture enlarged).
   */
  aerial: {
    tiles: 'https://basemaps.linz.govt.nz/v1/tiles/{layer}/WebMercatorQuad/{z}/{x}/{y}.webp?api={key}',
    credit:
      'Aerial photos: <a href="https://basemaps.linz.govt.nz/" target="_blank" rel="noopener">Toitū Te Whenua LINZ</a> and partners, ' +
      '<a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a>',
    /** The newest photos of every place, in one layer. */
    latest: { layer: 'aerial', label: 'latest (2022–2026)', maximumLevel: 20 },
    latestFromYear: 2026, // from this year on the timeline shows `latest`
    /** The two sides of the district, as [west, south, east, north]. */
    sides: { queenstown: [168.45, -45.25, 168.99, -44.85], wanaka: [168.99, -44.85, 169.4, -44.55] },
    photos: [
      { year: 1983, label: '1983', layer: 'otago-sn8180-1983-0.75m', covers: 'all', maximumLevel: 17 },
      { year: 1984, label: '1984', layer: 'otago-sn8436-1984-0.64m', covers: 'all', maximumLevel: 18 },
      { year: 1988, label: '1988', layer: 'southland-otago-sn8996-1988-0.75m', covers: 'queenstown', partial: true, maximumLevel: 17 }, // not Arrowtown, Jack's Point
      { year: 2001, label: '2001', layer: 'otago-snc25055-2001-0.75m', covers: 'queenstown', maximumLevel: 17 },
      { year: 2003, label: '2003', layer: 'otago-snc12780-2003-0.64m', covers: 'wanaka', maximumLevel: 18 },
      { year: 2011, label: '2005–2011', layer: 'otago-2005-2011-0.75m', covers: 'all', maximumLevel: 17 },
      { year: 2019, label: '2017–2019', layer: 'otago-2017-2019-0.3m', covers: 'all', maximumLevel: 19 },
      { year: 2021, label: '2021', layer: 'queenstown-2021-0.1m', covers: 'queenstown', partial: true, maximumLevel: 20 }, // the towns, not all their edges
      { year: 2023, label: '2022–2023', layer: 'queenstown-lakes-2022-2023-0.1m', covers: 'wanaka', partial: true, maximumLevel: 20 },
    ],
    /** The photos a little paler than they are, so the pipes stand out on them. */
    look: { saturation: 0.8, brightness: 1.05, contrast: 0.9 },
    swapMs: 1500, // the photos being replaced stay this long under the new ones, while those arrive
  },

  /** Camera used when flying to a zone in 3D (a zone can override these in zones.json → "view"). */
  view: {
    headingDegrees: 20,
    pitchDegrees: -32,
    spanMetres: 2600, // width of ground visible on arrival
    typicalGroundM: 330, // ground height assumed until the real one has been looked up
    /** Upright phone screens show a narrow strip: look down more steeply, at a smaller area. */
    phone: { pitchDegrees: -50, spanMetres: 1800 },
  },

  /** Council water networks (src/layers/networkLayer.js), drawn on the ground. */
  networks: {
    list: [
      { id: 'water', label: 'Water supply', color: '#1864ab' },
      { id: 'wastewater', label: 'Wastewater', color: '#c92a2a' },
      { id: 'stormwater', label: 'Stormwater', color: '#2b8a3e' },
      // Electricity (scripts/data/convert-power.mjs): the open data there is – overhead lines, a few cables,
      // substations, the national grid, streetlights. Lines take the colour of their kind.
      {
        id: 'power',
        label: 'Electricity and streetlights',
        color: '#f08c00',
        kind: 'power',
        updates: false, // no newer-database file
        colors: { overhead: '#f08c00', cable: '#d9480f', route: '#ffc078' },
      },
      // No data of its own: the pipes and cables added by hand that are none of the networks above (telecom, gas…).
      { id: 'other', label: 'Other pipes and cables', color: '#862e9c', noFiles: true },
      // Not a network: the bores and wells of the regional council (points only), shown the same way.
      { id: 'bores', label: 'Bores and monitoring sites', color: '#0c8599', pointsOnly: true },
      // The council's test dataset (no licence stated): measuring instruments and pumps, grouped per place.
      { id: 'instruments', label: 'Instruments and pumps (council test data)', color: '#7048e8', pointsOnly: true },
    ],
    added: { dashPx: 11, gapPx: 6 }, // pipes added by hand (src/tools/addedPipesTool.js) are drawn dashed: so much line, so much gap
    privateLighten: 0.5, // private pipes: the network colour mixed with this much white
    disusedColor: '#868e96',
    highlightColor: '#ffd43b',
    shaftColor: '#5c6b77', // underground view: the shafts from the surface down to manholes, valves and hydrants
    widthPx: { largeMain: 5, main: 3.5, lateral: 1.5, shaft: 2.5, fittingShaft: 1.5 }, // line width on screen, whatever the zoom
    /**
     * Manholes, valves and hydrants: dots of `px` pixels, drawn when the camera is closer than
     * `withinM` to them. Without a `color` the dot takes the colour of its network.
     */
    /**
     * Point assets on the map: a symbol each (src/layers/assetIcons.js) on a disc of `color`
     * (none: the network's own), drawn in `ink` (default white), shown within `withinM` of the camera.
     */
    assets: {
      manhole: { withinM: 350 },
      valve: { color: '#0b2e59', withinM: 350 }, // a normally closed valve has a hollow symbol
      toby: { color: '#74c0fc', ink: '#0b2e59', withinM: 150 }, // property shut-off valves: many and small
      hydrant: { color: '#fcc419', ink: '#13232f', withinM: 500 }, // yellow, like the marker posts
      // The rest only close up (there are many).
      fitting: { withinM: 150 }, // tees, bends, junctions, end caps…
      networkValve: { withinM: 250 }, // valves of the wastewater and stormwater networks
      meter: { color: '#ced4da', ink: '#0b2e59', withinM: 150 },
      backflow: { color: '#0ca678', withinM: 600 },
      inlet: { color: '#495057', withinM: 200 }, // road gullies: dark, like their grates
      outlet: { withinM: 1200 },
      device: { color: '#b2f2bb', ink: '#1b4d26', withinM: 250 }, // soakpits and the like
      facility: { withinM: 8000 }, // pump stations, reservoirs, treatment plants: seen from afar
      bore: { color: '#0c8599', withinM: 3000 }, // groundwater bores (regional council)
      monitoring: { color: '#0b7285', withinM: 20000 }, // river, lake, groundwater monitoring sites: few, seen from afar
      instrument: { withinM: 2500 }, // flow meters, level and pressure sensors, analysers… (disc in their network's colour)
      machine: { withinM: 1200 }, // pumps and other machinery
      substation: { color: '#d9480f', withinM: 20000 }, // electricity: few, seen from afar
      tower: { color: '#495057', withinM: 4000 }, // towers of the national grid
      transformer: { color: '#f08c00', withinM: 1500 },
      streetlight: { color: '#343a40', ink: '#ffd43b', withinM: 200 }, // many: close up only
    },
    stackedIconRingPx: 15, // symbols recorded at the same place fan out on a ring this far from it
    symbolScale: { nearM: 80, farM: 500, far: 0.6 }, // symbols full size up to nearM away, shrinking to this share at farM
    // "Flow direction": arrows on the mains whose upper end the data supports, one per everyM of pipe,
    // shown closer than withinM; a pipe shorter than minPipeM carries none.
    flow: { everyM: 60, withinM: 450, sizePx: 20, minPipeM: 6 },
    // Instruments, pumps, substations and the symbols of facilities are inside buildings (pump stations, plants):
    // within this distance their symbols show through the 3D blocks.
    throughBuildings: { kinds: ['instrument', 'machine', 'facility', 'substation', 'transformer'], withinM: 900 },
    facilityFillAlpha: 0.28, // the outline of a facility is filled with its network colour, this see-through
    /** The pressure zones of the water supply (src/layers/pressureZonesLayer.js). */
    pressureZones: { fillAlpha: 0.22, labelsWithinM: 12000, highlightColor: '#ffd43b' },
    /** By year installed (src/ui/yearsControl.js): colours by decade, newest brightest; no yellow (that marks the selected pipe). */
    years: {
      bins: [
        { to: 1979, label: 'Before 1980', color: '#6f42c1' },
        { to: 1999, label: '1980–1999', color: '#3b6fb6' },
        { to: 2009, label: '2000–2009', color: '#2a9d8f' },
        { to: 2019, label: '2010–2019', color: '#7cb518' },
        { to: 9999, label: '2020 on', color: '#f76707' },
      ],
      unknownColor: '#adb5bd',
      first: 1960, // the slider starts here (a few dozen pipes are older)
      last: 2026, // and ends here: the newest pipes in the council's data
      playStepMs: 280, // ▶ moves on one year this often
    },
    /** Point assets drawn as a shaft down to their depth in the underground view (the others are buried fittings). */
    shaftKinds: ['manhole', 'valve', 'hydrant', 'inlet', 'device', 'bore'],
    assetLiftM: 0.3, // dots a little above the pipes, so they sit on top of them
    selectedIconGrow: 1.35, // a selected symbol is drawn this much bigger (and yellow)
    largeMainMm: 300, // mains this wide or wider are drawn as "large"
    liftM: 0.8, // seen from above, lines are drawn this far above the ground so the terrain does not cover them
    layerGapM: 0.2, // and each network this much above the next, so they do not flicker where they overlap
    followGroundEveryM: 10, // the ground height is looked up at least this often along a pipe
    lateralsWithinM: 1500, // property connections are drawn only when the camera is closer than this to them
    credit:
      'Pipes and buildings: <a href="https://www.qldc.govt.nz/" target="_blank" rel="noopener">Queenstown Lakes District Council</a>, ' +
      '<a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a>, modified (depths derived or estimated, roofs drawn from measured heights) • ' +
      'Bores and monitoring sites: <a href="https://www.orc.govt.nz/" target="_blank" rel="noopener">Otago Regional Council</a>, CC BY 4.0 • ' +
      'Instruments, pumps and pipes added since May 2026: QLDC test dataset, no licence stated • ' +
      'Electricity: <a href="https://data-transpower.opendata.arcgis.com/" target="_blank" rel="noopener">Transpower</a> (CC BY 4.0), © OpenStreetMap contributors (ODbL), QLDC District Plan; streetlights: QLDC • ' +
      'Addresses: <a href="https://data.linz.govt.nz/layer/123113-nz-addresses/" target="_blank" rel="noopener">Toitū Te Whenua LINZ</a>, CC BY 4.0',
  },

  /** Pipes and cables added by hand (src/tools/addedPipesTool.js): kept in the browser of this device only. */
  added: {
    storageKey: 'alze-underground:added-pipes', // where the browser keeps them
    fileLimitBytes: 5_000_000, // a copy file bigger than this is not read
    viewPitchDegrees: -60, // going to a pipe of the list
    viewSpanM: [80, 600], // …shows the whole pipe, between this little and this much ground
  },

  /** "Find a street or address" (src/tools/addressFinder.js; addresses of Toitū Te Whenua LINZ in data/addresses.json). */
  search: {
    results: 8, // at most this many are listed
    addressSpanM: 140, // the view shows this much round an address…
    streetSpanM: 380, // …and this much round a street
    viewPitchDegrees: -55,
    pinColor: '#0a6c80',
  },

  /** "Cut the water" (src/tools/shutoffView.js): which valves to close to leave a water main without water. */
  shutoff: {
    cutColor: '#f76707', // the mains left without water
    startColor: '#ffd43b', // the stretch that was tapped
    alsoColor: '#ffc078', // branches that lose water through the cut (no valve of theirs needs closing)
    valveColor: '#c92a2a', // the badges of the valves to close
    lineWidthPx: 7,
    badgePx: 30,
    minViewSpanM: 120, // the view shows at least this much round the cut…
    valveViewSpanM: 60, // …and this much round a valve picked from the list
    viewPitchDegrees: -60,
    sheetShiftShare: 0.45, // on a phone the panel covers the bottom: the view moves up by this share of its width
    atStationM: 40, // tapped this close to a pump station or reservoir on the cut: the work is likely at the station
    // QLDC's Land Development and Subdivision Code of Practice, Table 6-6: most connections in one shut-off area
    connectionLimits: [
      { upToMm: 150, connections: 40 },
      { upToMm: 300, connections: 100 },
      { upToMm: Infinity, connections: 150 },
    ],
  },

  /** The excavation view (src/tools/excavationView.js): a pit dug where you look. */
  excavation: {
    sideM: { desktop: 24, phone: 16 }, // the pit is square, this wide
    minDepthM: 2.5, // dug at least this deep…
    maxDepthM: 8, // …and at most this deep (deep enough for the deepest pipe or manhole in it)
    depthShareOfSide: 0.35, // depths are stretched until the pit is at least this deep compared with its side…
    maxStretch: 3, // …but never more than this (in steps of a half)
    minPipeRadiusM: 0.05, // pipes keep their real size (stretched like the depths), but never thinner than this
    manholeRadiusM: 0.525, // a manhole of unknown size: the usual 1050 mm chamber
    alignWithinM: 25, // a main this close to the middle of the screen lines the pit up with the street
    labelsWithinM: 70, // labels show when the camera is closer than this
    labelsThroughWallsM: 0, // 0: walls hide the labels behind them
    labelPiecesLongerThanM: 3, // pieces of pipe at least this long in the pit get a depth label
    fittingLabelsWithinM: 35, // labels of fittings, meters, gullies… show only when the camera is closer than this
    viewRangeShare: { desktop: 1.75, phone: 1.85 }, // first view: this many pit widths away…
    viewAimPastShare: { desktop: 0.12, phone: 0.12 }, // …aiming this share of a width past the middle (the message on top takes room, so the pit sits lower)…
    viewPitchDegrees: -38, // …looking down at this angle
    closestM: 3, // how close the camera may get to the middle of the pit
  },

  /** The open-ground view (src/tools/openGroundView.js): real shapes round where you look, on the whole map. */
  openGround: {
    radiusM: { desktop: 150, phone: 90 }, // shapes are drawn this far round where you look, at most…
    radiusPerRange: 1.2, // …and no further than this many times the distance to the camera (what is in view)…
    minRadiusM: 40, // …but at least this far
    maxRangeM: 700, // from further away than this nothing is built: the shapes would be thinner than the lines
    rebuildShare: 0.35, // built again once the view has moved this share of the radius
    detailWithinM: 60, // fittings, meters, tobies and labels only this close to the middle
    followGroundEveryM: 10, // pipes are cut into pieces this long, each at the height of its own ground
    maxPieces: 5000, // more pieces of pipe than this: a smaller area is drawn
    tubeSides: 10, // how round tubes…
    slices: 16, // …and manholes are drawn (the pit uses 16 and 28)
    groundOpacity: 0.12, // the ground near the camera: more see-through than in the underground view
    undersideColor: '#cbbba3', // light sand under the opened ground: the shapes and their outlines read best on it
    photos: true, // shows the aerial photos meanwhile (if there is a key), and the street map again after
    buildTimeoutMs: 20_000,
    /** The camera goes round the place in the middle of the screen (360°, also from below the ground). */
    orbit: {
      closestM: 4, // how close it may get to the place…
      farthestM: 1500, // …and how far
      highestPitchDegrees: 70, // from below: looking up at this angle at most (90 would be straight up)
      turnStepDegrees: 30, // the round buttons: turn this much…
      tiltStepDegrees: 15, // …lean over or under this much…
      zoomFactor: 1.6, // …get this many times closer or further
      stepSeconds: 0.35,
      moveSeconds: 0.6, // a double tap: the glide to the new place
      backAboveFromDegrees: -8, // leaving the open ground from below (or nearly level) the camera comes back above…
      backAbovePitchDegrees: -35, // …looking down at this angle
    },
    /** "Face-on": a straight cut through the ground, looked at from in front. */
    face: {
      widthM: { desktop: 60, phone: 24 }, // the cut is this wide at first (or as wide as what was in view, if less)…
      minWidthM: 12, // …and between this…
      maxWidthM: { desktop: 240, phone: 120 }, // …and this, with + and −
      zoomFactor: 1.6, // + and − make it this many times narrower or wider
      backM: 20, // everything up to this far behind the cut is drawn (the choices are in index.html)
      slideShare: 0.5, // the turn buttons slide the cut along by this share of its width
      wallStepM: 2, // the top of the earth wall follows the ground this often
      pitchDegrees: -6, // looked at a little from above, so the floor and the top of the wall show
      rangeShare: 1.05, // the camera stands where the cut just fits across the screen, times this
      apronShare: 1.4, // the floor (and the ground taken away) carries on this many times that distance in front of the cut
      labelsUpToWidthM: 80, // a wider cut shows its labels only close up (they would pile up)
    },
  },

  /** The long section of a pipe (src/tools/profileView.js). */
  profile: {
    maxRunM: 400, // the run goes on from the picked pipe until it is this long…
    maxPipes: 16, // …or has this many pipes…
    maxTurnDegrees: 60, // …or the pipe that carries on turns more than this
    stepM: 4, // the ground and the depth are read this often along the run
    assetWithinM: 0.75, // manholes, valves… this close to the run are on it
    glowPx: 11, // on the map: the run is marked with a line this wide, behind the pipes…
    glowLiftM: 0.7, // …this far above the ground
  },

  /** The underground view (src/map/undergroundView.js): how see-through the ground is. */
  underground: {
    groundOpacityNear: 0.25, // close to the camera, mostly see-through…
    groundOpacityFar: 0.85, // …far away, nearly solid, so the landscape still reads
    nearM: 300,
    farM: 6000,
    terrainDetail: 4, // the see-through ground is drawn twice: a little coarser keeps it at 60 frames per second
    undersideColor: '#6b5a48', // the ground seen through or from below: soil
  },

  buildings: {
    /** How far (m) the walls continue below the lowest ground point, so slopes never leave a gap. */
    foundationDepthM: 1.5,
    highlightColor: '#ffd43b',
    glassOpacity: 0.2, // the underground view: buildings as glass, this solid (0-1), so the pipes under them show
    kinds: [
      // Light, calm colours, like an architect's model: the pipes and the aerial photo stand out.
      { id: 'residential', label: 'Residential', color: '#e6e1d8' },
      { id: 'commercial', label: 'Commercial', color: '#e4d9ca' },
      { id: 'industrial', label: 'Industrial', color: '#d5d7df' },
      { id: 'community', label: 'Community', color: '#d6e2d2' },
      { id: 'outbuilding', label: 'Sheds, garages', color: '#dadada' },
      { id: 'other', label: 'Not classified', color: '#e1e3e6' },
    ],
  },
};

// The 2027 AISC Student Steel Bridge Competition layout and rules (rules published Sept 8, 2026).
// This is what a new project starts with. Everything here is editable in the app, and a new
// year's layout can be added to the shared library (library/sites) without changing code.
//
// Site plan (DWG 1), inches. x runs west → east, y runs north → south. 60'-0" × 15'-0" overall:
//   west staging yard 5'  | west construction zone 15' (footing 2' in) + riverbank 2' |
//   river 7' | east construction zone 5' (footing at the river) | transportation zone 14' |
//   east staging yard 12'

export const RULES_2027 = {
  year: '2027',
  source: 'AISC SSBC 2027 Rules, published September 8, 2026',
  box: [42, 6, 4], // 8.2.2.2: every member fits a 3'-6" × 6" × 4" box (10.2.4: same for tools)
  maxBuilders: 6, // 10.2.2
  maxAssemblyMembers: 3, // glossary + 10.3.7: an assembly is 2 or 3 members
  assemblyIn: 'staging', // 10.3.7.2: assemblies are created only in a staging yard
  timeLimitMin: 30, // 10.8.1: over 30 minutes counts as 180
  haltMin: 45, // 10.8.2: construction is halted at 45 minutes
  costPerBuilderMin: 172500, // 6.2.5 construction cost, $ per builder-minute
  crewFactor: 0.8, // 6.2.5 γ = 0.80 with 4 or more builders
  crewFactorMinBuilders: 4,
  penaltyPerMin: 325000, // 6.2.5, $ per minute of time penalties
  returnToStaging: true, // 10.9.1: builders end in a staging yard
};

const FT = 12;

export function site2027() {
  return {
    name: '2027 official layout',
    year: '2027',
    notes: 'From the Site Plan Diagram (DWG 1) of the 2027 rules. The transportation zone may be shortened by the host to fit local conditions (note 2). Check aisc.org/ssbc for clarifications.',
    width: 60 * FT,
    depth: 15 * FT,
    cell: 6,
    zones: [
      { id: 'z-wsy', name: 'West staging yard', type: 'staging', x: 0, y: 0, w: 5 * FT, h: 15 * FT },
      { id: 'z-wsy-tools', name: 'Tools (west)', type: 'tools', x: 0, y: 0, w: 2 * FT, h: 8 * FT },
      { id: 'z-wsy-nb', name: 'Nuts & bolts (west)', type: 'hardware', x: 0, y: 8 * FT, w: 2 * FT, h: 7 * FT },
      { id: 'z-wsy-b', name: 'Builders (west)', type: 'builders', x: 2 * FT, y: 0, w: 3 * FT, h: 15 * FT },
      { id: 'z-wcz', name: 'West construction zone', type: 'construction', x: 5 * FT, y: 0, w: 15 * FT, h: 15 * FT },
      { id: 'z-wft', name: 'West footing', type: 'footing', x: 7 * FT, y: 5 * FT, w: 1 * FT, h: 5 * FT },
      { id: 'z-bank', name: 'Riverbank', type: 'riverbank', x: 20 * FT, y: 0, w: 2 * FT, h: 15 * FT },
      { id: 'z-river', name: 'River', type: 'nogo', x: 22 * FT, y: 0, w: 7 * FT, h: 15 * FT },
      { id: 'z-ecz', name: 'East construction zone', type: 'construction', x: 29 * FT, y: 0, w: 5 * FT, h: 15 * FT },
      { id: 'z-eft', name: 'East footing', type: 'footing', x: 29 * FT, y: 5 * FT, w: 1 * FT, h: 5 * FT },
      { id: 'z-tz', name: 'Transportation zone', type: 'transport', x: 34 * FT, y: 0, w: 14 * FT, h: 15 * FT },
      { id: 'z-esy', name: 'East staging yard', type: 'staging', x: 48 * FT, y: 0, w: 12 * FT, h: 15 * FT },
      { id: 'z-esy-m', name: 'Members', type: 'members', x: 48 * FT, y: 0, w: 12 * FT, h: 8 * FT },
      { id: 'z-esy-b', name: 'Builders (east)', type: 'builders', x: 48 * FT, y: 8 * FT, w: 4 * FT, h: 7 * FT },
      { id: 'z-esy-nb', name: 'Nuts & bolts (east)', type: 'hardware', x: 52 * FT, y: 8 * FT, w: 2 * FT, h: 7 * FT },
      { id: 'z-esy-tools', name: 'Tools (east)', type: 'tools', x: 54 * FT, y: 8 * FT, w: 6 * FT, h: 7 * FT },
    ],
    // Bridge x = 0 at the outer (west) edge of the west footing; truss A on the north side.
    bridge: { x: 7 * FT, y: 6 * FT, rotation: 0 },
    staging: {},
    rules: { ...RULES_2027 },
  };
}

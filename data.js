/*
 * Statische gegevens voor de Social Hub bezorgshift in Den Haag.
 *
 * Bron: briefing-PDF "Brieven posten - Social Hubs DEN HAAG" + RadiusMapper-kaart
 *   https://radiusmapper.com/shared/QEbz7dTSpG
 *
 * LET OP: het gebied (AREA_POLYGON) is een SCHATTING die uit de PDF-kaart is
 * overgetrokken. De exacte grens komt uit RadiusMapper. Pas de coördinaten hier
 * aan zodra de officiële grens bekend is — de rest van de app werkt er automatisch
 * mee (straten worden live uit OpenStreetMap gehaald binnen deze polygon).
 */

// Startlocatie: The Social Hub, Hoefkade 9, 2526 BN Den Haag.
// Geschatte coördinaat; de app probeert dit bij het laden te verfijnen via Nominatim.
const HUB = {
  name: 'The Social Hub — Hoefkade 9',
  lat: 52.07266,
  lng: 4.32007,
};

// Geschat bezorggebied (overgetrokken van de blauwe PDF-kaart), met de klok mee.
// [lat, lng] paren. Globaal: Stationsbuurt + randen van Centrum/Rivierenbuurt/Laakhaven.
const AREA_POLYGON = [
  [52.0793, 4.3175], // N  – Spui / Amare
  [52.0796, 4.3232], // N  – richting Stationsplein
  [52.0793, 4.3268], // NE – Rivierenbuurt
  [52.0772, 4.3304], // E  – Maasstraat / Wateringkade
  [52.0742, 4.3316], // E  – Wateringkade-zuid
  [52.0708, 4.3300], // SE – Neherkade
  [52.0682, 4.3268], // SE – Laakhaven-Oost
  [52.0668, 4.3222], // S  – The Hague University
  [52.0672, 4.3170], // S  – MegaStores
  [52.0686, 4.3138], // SW – Hooftskade-zuid
  [52.0716, 4.3116], // W  – Hooftskade / Boekhorststraat
  [52.0748, 4.3114], // W  – Boekhorststraat-noord
  [52.0775, 4.3136], // NW – Zuidwal
  [52.0788, 4.3152], // NW – richting Spui
];

/*
 * Rode straten — NIET doen (uit de PDF-bijlage "Rode straten NIET doen").
 * Dit is mijn BESTE LEZING van de kaart; nog niet 100% zeker omdat niet elke
 * straatnaam leesbaar was. Ze worden rood getoond, in de "NIET doen"-lijst gezet
 * en NIET meegeteld in de voortgang. Markeer status: 'confirmed' zodra geverifieerd.
 *
 * Je kunt in de app elke straat met één klik als "NIET doen" markeren of vrijgeven,
 * dus deze lijst is slechts een startpunt.
 */
const EXCLUDED_DEFAULTS = [
  { name: 'Huijgenspark', status: 'maybe', note: 'Rode lus rond het park — waarschijnlijk NIET bezorgen.' },
  { name: 'Oranjelaan', status: 'maybe', note: 'Rode lijn langs Oranjelaan — waarschijnlijk NIET.' },
  { name: 'Oranjeplein', status: 'maybe', note: 'Bij de hub rood gemarkeerd — controleren.' },
  { name: 'Stationsweg', status: 'maybe', note: 'Deels rood nabij de hub — controleren.' },
];

/*
 * Indicatieve "rode zones" uit de bijlage, overgetrokken van de RadiusMapper-screenshot.
 * Deze worden als rode REFERENTIE-laag op de echte kaart getekend (gestippeld). Ze
 * veranderen NIET automatisch de status van een straat — dat zou tot gemiste adressen
 * kunnen leiden. Gebruik ze als visuele hulp: vergelijk met de echte straatnamen en
 * klik straten aan om ze op "NIET doen" te zetten.
 * Coördinaten zijn schattingen; pas gerust aan.
 */
const RED_REFERENCE_ZONES = [
  {
    label: 'Huijgenspark e.o.',
    polygon: [
      [52.0739, 4.3209],
      [52.0749, 4.3214],
      [52.0758, 4.3250],
      [52.0751, 4.3262],
      [52.0741, 4.3251],
      [52.0735, 4.3224],
    ],
  },
  {
    label: 'Zijstraten Stationsweg ↔ Oranjeplein',
    polygon: [
      [52.0736, 4.3160],
      [52.0741, 4.3186],
      [52.0726, 4.3201],
      [52.0718, 4.3192],
      [52.0721, 4.3168],
      [52.0729, 4.3158],
    ],
  },
  {
    label: 'Blok ten zuiden van de hub',
    polygon: [
      [52.0721, 4.3196],
      [52.0725, 4.3212],
      [52.0716, 4.3216],
      [52.0712, 4.3201],
    ],
  },
];

// Welke OSM-wegtypen tellen als "bezorgbare straat".
const DELIVERABLE_HIGHWAYS = [
  'residential',
  'living_street',
  'unclassified',
  'pedestrian',
  'tertiary',
  'secondary',
];

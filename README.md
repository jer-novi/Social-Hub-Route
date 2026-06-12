# Social Hub Routeplanner — Den Haag

Web-app om de **bezorgshift vanaf The Social Hub (Hoefkade 9, Den Haag)** uit te
voeren: zie het toegewezen gebied op een echte kaart, loop een logische route
vanaf de hub, en vink elke straat nauwkeurig af. Gebouwd met **open source**:
[Leaflet](https://leafletjs.com/) + [OpenStreetMap](https://www.openstreetmap.org/)
+ de [Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API). Geen
accounts, geen API-keys, geen backend — alles draait in de browser en wordt
lokaal opgeslagen.

## Functies

- 🗺️ **Echte kaart** met alle straten binnen het bezorggebied (live uit OSM).
- 🧭 **Logische looproute** vanaf de hub (nearest-neighbour-volgorde, genummerd).
- ✅ **Afvinken per straat** met drie statussen:
  - **Alles bezorgd** (alle nummers gedaan)
  - **Deels** — vul bezorgde bereiken in: *van nr X t/m nr Y*, met **+ extra bereik**
  - **Niks bezorgd hier** (bv. alleen NEE-stickers)
- ⛔ **NIET-doen-lijst** (rode straten uit de briefing) apart, niet meegeteld in
  de voortgang. De rode zones uit de bijlage staan als **referentielaag** op de
  kaart; klik een straat aan om hem zelf op NIET-doen te zetten of vrij te geven.
- ➕ **Handmatig straten toevoegen/verwijderen** naast het voorgevulde gebied.
- 🔗 **Lijst ↔ kaart synchroon**: klik een straat in de lijst om hem op de kaart te
  tonen, of klik op de kaart om naar de lijst te springen.
- ↕️ **Looprichting** huisnummers (laag ➜ hoog of hoog ➜ laag) + nummerbereik.
- 💾 Voortgang blijft bewaard (localStorage), ook offline (OSM-cache).
- 📭 Herinnering: alleen bezorgen bij **JA/JA** of **geen sticker**.

## Lokaal draaien

Open `index.html` in een browser (of serveer de map statisch):

```bash
python3 -m http.server 8000   # daarna http://localhost:8000
```

## Deploy (GitHub Pages)

`.github/workflows/deploy.yml` publiceert de site automatisch. Eenmalig instellen:

1. Repo → **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Push naar `main` (of deze branch) triggert de deploy; de URL verschijnt in de
   Actions-run en op de Pages-instellingenpagina
   (`https://jer-novi.github.io/Social-Hub-Route/`).

## Gegevens & nauwkeurigheid

De gegevens staan in [`data.js`](./data.js) en zijn makkelijk aan te passen:

- `HUB` — startlocatie (wordt bij laden verfijnd via Nominatim).
- `AREA_POLYGON` — het bezorggebied, **overgetrokken van de PDF/RadiusMapper-kaart**
  (een schatting). Pas de coördinaten aan voor een exacte grens; de straten worden
  automatisch opnieuw binnen de polygon opgehaald.
- `RED_REFERENCE_ZONES` — indicatieve rode zones uit de bijlage (alleen visueel).
- `EXCLUDED_DEFAULTS` — voorgevulde NIET-doen-straten (best guess uit de kaart).

> ⚠️ Het gebied en de rode straten zijn een interpretatie van de aangeleverde
> kaarten. De klant heeft controle-adressen — **mis geen adressen**. Verifieer de
> grens en de NIET-doen-straten met de officiële RadiusMapper-kaart en pas waar
> nodig aan (één klik per straat).

## Review van het eerdere raamwerk (PR #1, GitHub Copilot)

Het Copilot-raamwerk had goede ideeën (afvinken, lijst↔kaart-synchronisatie,
richtingschakelaar), maar:

- de "kaart" was een **nep CSS-grid** i.p.v. een echte kaart → vervangen door Leaflet/OSM;
- de straten en de radius (1,5 km) waren **verzonnen placeholders** → vervangen door
  het echte gebied + live OSM-data;
- er was **geen NIET-doen-overzicht** en **geen route-volgorde** → beide toegevoegd.

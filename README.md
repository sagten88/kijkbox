# Kijkbox

Je eigen IPTV-website met accounts. Werkt op telefoon, tablet en laptop.

## Starten

1. Dubbelklik op **Start Kijkbox.bat**.
2. Open `http://localhost:3000` op deze pc.
3. Maak het beheerdersaccount aan. De installatiecode staat in het zwarte venster.
4. Ga naar **Account** en voeg onder **Bron toevoegen** je IPTV-bron toe.

Laat het zwarte venster open: de site draait zolang dat openstaat.

## Op je telefoon of iPad

Het zwarte venster toont bij **Op je thuisnetwerk** een adres, bijvoorbeeld `http://192.168.1.50:3000`.
Open dat adres op je telefoon of iPad, op dezelfde wifi.

- **Lukt verbinden niet?** Windows Firewall blokkeert de site dan waarschijnlijk. Sta Node.js toe op
  privénetwerken wanneer Windows daarom vraagt. Staat je wifi op "Openbaar", zet die dan op "Privé".
- **Als app op je beginscherm:** kies op iPhone/iPad in Safari **Deel > Zet op beginscherm**,
  op Android in Chrome **Toevoegen aan startscherm**.

## Bronnen

| Type | Wat je nodig hebt |
| --- | --- |
| Xtream | Server-adres, gebruikersnaam en wachtwoord van je provider |
| M3U-link | Link naar een afspeellijst |
| M3U-bestand | Een `.m3u`-bestand, of de inhoud geplakt |
| Losse stream | Een naam en een link naar één stream (`.m3u8`, `.ts`, `.mp4`, enzovoort) |

Bij Xtream is **MPEG-TS** het aanbevolen streamformaat. Dat gebruikt één doorlopende verbinding. HLS-links van
Xtream-providers zijn vaak maar kort geldig, waardoor een stream na een halve minuut kan vastlopen of foutcode 509 krijgt.

Valt een live-verbinding weg, dan start de server hem vanzelf opnieuw. Je ziet dan een kort hapertje.

De tv-gids wordt bij Xtream automatisch opgehaald. Bij M3U gebruikt de site de gids-link uit de afspeellijst,
of de link die je onder **Meer opties** invult. Zenders moeten een `tvg-id` hebben dat in de gids voorkomt.

Bronnen en de tv-gids worden elke nacht om 04:00 vanzelf bijgewerkt (ander uur: zet `REFRESH_HOUR`). Stond de server op dat moment uit, dan gebeurt het zodra hij weer draait. Bij Instellingen → Bronnen zie je wanneer de laatste en de volgende update is. Lukt een update niet, dan probeert hij het elk uur opnieuw.

## Tv-app (Google TV / Android TV)

`tv-app/` bevat een kleine Android-app die de site schermvullend opent in een tv-weergave voor de afstandsbediening.
De app voegt `KijkboxTV` toe aan de browsernaam; met `?tv` achter het adres zie je dezelfde weergave in een gewone browser.

- **Koppelen:** de tv toont een code. Vul die op je telefoon in onder **Account > Tv koppelen**.
- **Serveradres:** bij de eerste start vraagt de app het adres van je server (bijvoorbeeld `192.168.1.50:3000` of
  `https://tv.jouwdomein.nl`). Wijzigen kan later via **Account > Serveradres van de app wijzigen**, de Menu-toets, of
  het foutscherm als de server niet bereikbaar is.
- **Bouwen:** `powershell -ExecutionPolicy Bypass -File tv-app\build.ps1 -Version 3`. Verhoog het versienummer bij elke nieuwe build.
- **Installeren:** `adb connect <ip-van-tv>:5555` en daarna `adb install -r tv-app\kijkbox-tv.apk`. Het adres kan meteen
  mee: `adb shell am start -n nl.agtenhosting.kijkbox/.MainActivity --es server <adres>`.
- **Ondertekenen:** `tv-app\signing\` bevat de sleutel. Bewaar die goed: een update moet met dezelfde sleutel ondertekend zijn.
- **Updates:** veranderingen aan de site komen vanzelf op de tv. Een nieuwe APK is alleen nodig als `tv-app/` verandert.

## Filteren op land

Bij Live en in de Gids kies je een land, met Nederland bovenaan. De site haalt het land uit de naam van de groep,
bijvoorbeeld `┃NL┃ Sport`, `[NL] Sport` of `NL | Sport`. Groepen zonder landcode staan onder **Overig**. Je keuze wordt per
apparaat onthouden. Landnamen staan in `server/countries.js`; een onbekende code verschijnt gewoon als die code.

Bij Films en Series kan dat ook. Standaard staan daar alle landen aan; zoeken zet dan Nederlandse versies bovenaan,
Engelstalige daarna en de rest daaronder.

## Weergave

- **Eén kaart per titel:** dezelfde film of serie in meerdere talen staat als één kaart (met "x talen"). Op de pagina
  van de titel kies je de versie; Nederlands is de standaard, daarna Engels. Bij een land- of categoriekeuze zie je
  gewoon alle versies van dat land.
- **Sorteren** bij Films en Series: nieuw toegevoegd, releasejaar, beoordeling of A–Z.
- **Achtergrondbeeld** op de pagina van een film of serie, en een uitgelichte film bovenaan Home (als de provider
  een breed beeld meegeeft).
- **Live als tegels:** knop naast het zoekveld, met wat er nu en straks op is.
- Onder **Account**, per account: kleurthema, weergave (donker, licht of OLED-zwart) en **Verbergen** van landen en
  categorieën die je nooit kijkt. Op de tv ook de tekstgrootte (per tv).

## Profielen op de tv

Bij het opstarten toont de tv-app **Wie kijkt er?** met de accounts die op die tv zijn aangemeld. Met de **+** meld je
er een account bij aan (via de koppelcode). Met **Account afmelden** haal je een account van de tv af (twee keer OK);
het account zelf blijft bestaan. Wie zijn wachtwoord wijzigt, wordt op alle andere tv's afgemeld.

## Ondertitels

Bij films en afleveringen staat in de speler een knop **CC**. Die wisselt tussen uit, **NL** en **EN**; de keuze wordt
per apparaat onthouden. De ondertitels komen van [OpenSubtitles](https://www.opensubtitles.com):

1. Maak daar een gratis account en vraag een API-sleutel aan (bij "API consumers").
2. Vul als beheerder in Kijkbox bij **Instellingen > Ondertitels** de sleutel in, en je gebruikersnaam en wachtwoord van
   OpenSubtitles. Met account mag je meer ondertitels per dag downloaden. Het wachtwoord wordt versleuteld opgeslagen.

Kijkbox zoekt op het TMDB-nummer dat de provider meegeeft, en anders op titel en jaar. Machinevertalingen komen
achteraan. Een gedownloade ondertitel wordt bewaard in `subtitles/` in de datamap, dus opnieuw kijken kost geen download.

## Accounts

- **Beheerder:** beheert bronnen en accounts.
- **Kijker:** kan alleen kijken. Heeft eigen favorieten en eigen "verder kijken".

Je maakt accounts aan onder **Account > Accounts**. Zelf registreren kan niet. Onder **Account** kiest iedereen ook een
eigen kleurthema; geel is de standaard.

## Goed om te weten

- **Bronnen zijn gedeeld.** Elk account ziet dezelfde zenders en films.
- **Verbindingen:** alle streams lopen via deze pc. Veel providers staan maar 1 of 2 verbindingen tegelijk toe.
  Kijken twee mensen naar verschillende zenders, dan telt dat als twee verbindingen.
- **Omzetten kost rekenkracht.** Streams in HEVC worden door de pc omgezet naar H.264. `MAX_FFMPEG`
  (standaard 4) bepaalt hoeveel streams tegelijk omgezet of herverpakt mogen worden.
- **Omgezette films (`.mkv`, `.avi`):** spoelen kan alleen binnen het deel dat al is verwerkt.
- **Beveiliging thuis:** het adres begint met `http`, dus je wachtwoord gaat onversleuteld over je wifi.
  Gebruik de site zo alleen op je eigen netwerk. Stel hem niet open via port forwarding op je router.
- **Back-up:** de map `data` bevat alles: accounts, bronnen (met provider-wachtwoorden) en favorieten.
  Deel die map niet.

## Op Proxmox (installatiescript)

Installeren gaat met één regel in de shell van de Proxmox-host; zie de repository
[kijkbox-installer](https://github.com/sagten88/kijkbox-installer). Het script maakt een Debian 13-container,
zet Kijkbox erin en stelt updates in. Elke server krijgt een eigen sleutel die deze (privé-)repository alleen mag
**lezen**; de beheerder voegt die toe als *deploy key*:

```bash
gh repo deploy-key add sleutel.pub --repo sagten88/kijkbox --title "naam van de server"
```

| Wat | Waar |
| --- | --- |
| Website | `/opt/kijkbox` |
| Broncode (git, voor updates) | `/opt/kijkbox-src` |
| Gegevens (accounts, bronnen, favorieten) | `/var/lib/kijkbox` |
| Instellingen (`PORT`, `TRUST_PROXY`, …) | `/etc/kijkbox/kijkbox.env` |
| Service | `kijkbox` |

**Alleen thuisnetwerk.** Een nieuwe installatie weigert verzoeken van adressen op internet. Voor gebruik buiten huis
zet je een reverse proxy met https ervoor en vul je bij **Instellingen > Netwerk** het IP-adres van die proxy in
(of `TRUST_PROXY` in het env-bestand; dat gaat voor). `ALLOW_PUBLIC=true` zet de controle helemaal uit.

### Updates

- Een nieuwe versie is een **git-tag** (`v1.2.0`) met een **handtekening** van de uitgever. Servers installeren
  alleen tags waarvan de handtekening klopt met `/etc/kijkbox/allowed_signers`.
- `kijkbox-update` (als root in de container) zoekt, controleert en installeert. Het bouwt de nieuwe versie naast de
  oude, wisselt pas om als niemand kijkt, en zet de oude terug als de nieuwe niet start.
- Elke nacht wordt gecontroleerd (`kijkbox-update.timer`). Automatisch installeren zet je aan bij
  **Instellingen > Updates**; daar staat ook de knop om een update met de hand te installeren.

```bash
kijkbox-update status
```

```bash
kijkbox-update install
```

**Een versie uitbrengen** (uitgever, op de pc met de ondertekensleutel `~/.ssh/kijkbox_release`):

1. Verhoog `version` in `package.json` en commit.
2. Maak een ondertekende tag met een korte beschrijving; die verschijnt bij Instellingen > Updates:

```bash
git tag -s v1.1.0 -m "Kijkbox 1.1.0" -m "- Wat er nieuw is"
```

```bash
git push origin main --tags
```

Handige commando's in de container:

```bash
systemctl status kijkbox
```

```bash
systemctl restart kijkbox
```

```bash
journalctl -u kijkbox -f
```

Maak een back-up van de container in Proxmox, want daar staan nu al je gegevens.

## Verhuizen naar een VPS

Op de VPS is Docker nodig, plus een domeinnaam die naar de server wijst.

1. Kopieer deze map naar de server, inclusief `data` als je je accounts wilt houden.
2. Zet je domein in de `Caddyfile`.
3. Start de site:

```bash
docker compose up -d --build
```

Caddy regelt HTTPS automatisch. De Docker-bestanden zijn nog niet getest; zie ze als startpunt.

## Instellingen

Stel deze omgevingsvariabelen in vóór het starten:

| Naam | Standaard | Betekenis |
| --- | --- | --- |
| `PORT` | `3000` | Poort van de site |
| `HOST` | `0.0.0.0` | Netwerkadres waarop de site luistert |
| `DATA_DIR` | `./data` | Map voor de database |
| `MAX_FFMPEG` | `4` | Maximaal aantal streams tegelijk via FFmpeg |
| `TRUST_PROXY` | uit | IP-adres van je reverse proxy (kan ook bij Instellingen > Netwerk) |
| `ALLOW_PUBLIC` | uit | Ook verzoeken van buiten het thuisnetwerk toestaan, zonder reverse proxy |
| `REFRESH_HOUR` | `4` | Uur (0–23) waarop playlists en tv-gids elke nacht worden bijgewerkt |
| `ALLOW_PRIVATE_MEDIA` | uit | Bronnen op je thuisnetwerk toestaan, zoals een tv-ontvanger of NAS |
| `ALLOW_LOCAL_MEDIA` | uit | Bronnen op deze pc toestaan |
| `UPSTREAM_USER_AGENT` | VLC | Hoe de site zich bij de provider voordoet |

## Testen

```bash
npm test
```

`npm run mock` start een nep-provider met testbeeld op poort 8899. Start de site daarvoor met `ALLOW_LOCAL_MEDIA=true`.

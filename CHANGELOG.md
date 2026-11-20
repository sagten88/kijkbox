# Wat is er nieuw

Alle versies van Kijkbox, de nieuwste bovenaan. Dezelfde tekst zie je na een update in Kijkbox zelf.

## 1.7.0 (2026-11-20)

- Kijkbox is openbaar: iedereen kan het installeren, zonder toegang aan te vragen. Het installatiescript staat nu in deze repository.
- Updates komen voortaan via https uit de openbare repository. Bestaande servers stappen vanzelf over; alleen versies met een geldige handtekening worden geïnstalleerd, zoals altijd.
- Docker: kant-en-klaar image voor amd64 en arm64 (ghcr.io/sagten88/kijkbox), een docker-compose.yml voor thuis en een variant met https via Caddy.
- Strengere beveiliging: grote verzoeken worden pas na inloggen gelezen, en de adrescontrole voor ffmpeg is strenger.
- Onder het inlogscherm en onderaan Instellingen staat wie Kijkbox maakt en waar de broncode staat.
- Tv-app 1.4: het adresveld is ook op TCL-tv's goed leesbaar.
- Licentie: AGPL-3.0-or-later.

## 1.6.0 (2026-11-16)

- Nieuw: films en afleveringen downloaden om offline te kijken (niet op de tv). Kijkbox maakt er een mp4 van; daarna "Opslaan op dit apparaat". De beheerder kan het aan- of uitzetten bij Instellingen > Server.
- Grote afleveringen lopen niet meer na anderhalve minuut vast: de server zet ze nu om op de schijf in plaats van in een kleine geheugenmap.

## 1.5.11 (2026-11-16)

- Ondertitels lopen na spoelen of verder kijken weer precies gelijk met het beeld.
- Tv: met pijltje omhoog kies je de tijdbalk en spoel je met links/rechts naar een plek; OK om erheen te gaan.

## 1.5.10 (2026-11-13)

- "Nieuw wachtwoord" bij een account werkt altijd en toont het wachtwoord in een venster midden in beeld.
- Tijdelijke wachtwoorden zijn makkelijker: twee gewone woorden en een getal, zoals peerkat92.

## 1.5.9 (2026-11-13)

- Valt de verbinding met de provider tijdens een film of aflevering weg, dan laadt Kijkbox vanzelf verder vanaf waar je was in plaats van vast te lopen.
- Lukt dat steeds niet, dan krijg je een melding: misschien kijkt er op een ander apparaat nog iemand.

## 1.5.8 (2026-11-13)

- Na een lange pauze speelt een film of aflevering gewoon verder in plaats van na 10 seconden te stoppen.
- Wel geluid maar zwart beeld: Kijkbox zet de video dan vanzelf om.
- Tablet: na één tik blijft de balk weer staan.

## 1.5.7 (2026-11-12)

- Breekt je provider de verbinding tijdens het kijken af, dan laadt Kijkbox verder vanaf waar je was, in plaats van al na een paar seconden naar de volgende aflevering te willen.

## 1.5.6 (2026-11-11)

- Beeld-in-beeld: in de app op het beginscherm van de iPhone staat Apple het niet toe, daar is de knop nu weg. In Safari werkt het wel.
- De knoppen rechtsboven in de speler zijn beter leesbaar op een licht beeld.
- Geen grijs vlakje meer achter een aangetikte knop op de telefoon.

## 1.5.5 (2026-11-11)

- Rustigere speler als je de telefoon rechtop houdt: knoppen boven, in het midden en onder verdeeld.
- Geen dubbele ondertitelknop meer op de telefoon.
- Beeld-in-beeld op de iPhone: de melding laat tijdelijk zien wat er gebeurde.

## 1.5.4 (2026-11-11)

- Beeld-in-beeld op de iPhone werkt via de manier van Apple zelf; lukt het niet, dan krijg je een melding.
- De AirPlay-knop is terug in de speler (zichtbaar als er een Apple TV of AirPlay-speaker is).

## 1.5.3 (2026-11-10)

- Pauze blijft op pauze: live-tv ging op de tv soms na 10 seconden vanzelf verder.
- Volumeschuif op de computer (het volume wordt onthouden).
- Grote afspeel-/pauzeknop in het midden bij films en series.
- Het kruisje rechtsboven verdwijnt tijdens het afspelen; één tik haalt het terug.
- Volledig scherm in de browser zonder vaste balk onder het beeld.

## 1.5.2 (2026-11-10)

- Liggend kijken op de iPhone: het hele beeld past weer op het scherm en de ondertitels blijven zichtbaar.

## 1.5.1 (2026-11-10)

- Home begint nu met een begroeting, zoals "Goedemorgen, Sem", met de datum. Het uitgelichte blok bovenaan is weg.

## 1.5.0 (2026-11-10)

- Nieuwe speler op computer, telefoon en iPhone, met eigen knoppen: tijdbalk, 10 en 30 seconden spoelen, ondertitels, volgende aflevering, beeld-in-beeld en volledig scherm.
- Op de telefoon: tik om de knoppen te tonen, dubbeltik links of rechts om 10 seconden te spoelen.
- Je ziet meteen hoe lang een film of aflevering duurt, en je kunt overal naartoe spoelen, ook verder dan wat al geladen is (dat duurt dan een paar seconden).
- Is een aflevering afgelopen, dan begint na 10 seconden vanzelf de volgende. Annuleren kan.

## 1.4.7 (2026-11-09)

- Spoelen met 30 seconden: op de tv in de balk onder het beeld, op computer en telefoon met de nieuwe knoppen onder de speler.

## 1.4.6 (2026-11-09)

- Alleen de beheerder kan op de tv het serveradres van de app wijzigen.
- Op de tv springt de cursor niet meer omhoog na het kiezen van een profielfoto, achtergrond of stijl.

## 1.4.5 (2026-11-09)

- "Nu controleren" of "Update installeren" blijft niet meer hangen als er op dat moment al een update bezig is.

## 1.4.4 (2026-11-09)

- Live en de Gids onthouden de categorie die je had gekozen, ook als je de app afsluit en weer opent.

## 1.4.3 (2026-11-09)

- Op de tv begint Home meteen bij Verder kijken: geen updatemelding en geen uitgelichte film meer bovenaan.
- Na een update laadt de tv-app de nieuwe versie vanzelf zodra er niets speelt.

## 1.4.2 (2026-11-09)

- Op de telefoon schuift de pagina niet meer per ongeluk opzij als je naar beneden scrolt.

## 1.4.1 (2026-11-09)

- De achtergrondpatronen zijn duidelijker te zien.
- Glas is nu de standaardachtergrond. Liever rustig? Kies bij Instellingen > Weergave > Achtergrond voor Effen.

## 1.4.0 (2026-11-09)

- Nieuw bij Instellingen > Weergave: achtergrondpatronen (stippen, raster, strepen, golven, sterren, bubbels, hoogtelijnen en noorderlicht). Ze kleuren mee met de kleur van je profiel.
- De kant-en-klare stijlen Bioscoop, Speels, Retro en Glas hebben nu ook een eigen patroon.

## 1.3.1 (2026-11-09)

- Films en series waar je mee bezig bent hebben een play-knop op de poster: daarmee kijk je meteen verder. Klik je naast de knop, dan zie je de details.
- Op de tv: druk op de play-toets van de afstandsbediening om meteen verder te kijken.

## 1.3.0 (2026-11-09)

- Terugkijken: in de Gids kies je een dag en klik je op een uitzending die al geweest is. Zenders die dat kunnen hebben een terugkijk-icoon.
- Bij wat nu op tv is kun je op "Vanaf begin" drukken.
- Hoe ver je terug kunt, bepaalt je provider (meestal 1 tot 3 dagen). Na de update leest Kijkbox de zenders en gids meteen opnieuw in; dat duurt een paar minuten.

## 1.2.2 (2026-11-09)

- Tv-weergave: met omlaag kom je in het menu nu van Series bij Account.

## 1.2.1 (2026-11-09)

- Na een update zie je de nieuwe versie meteen, ook als er een reverse proxy of Cloudflare tussen zit die bestanden bewaart.

## 1.2.0 (2026-11-09)

- Kies een profielfoto (12 figuurtjes) bij Instellingen > Weergave. De achtergrond is de kleur van je account, en je ziet hem linksboven in het menu.
- Eigen stijl: kies hoe hoeken, knoppen, letters, posters en de achtergrond eruitzien, of neem een kant-en-klare stijl (Bioscoop, Speels, Retro, Glas). Ook een eigen kleur kan nu.
- Instellingen zijn opgedeeld in onderdelen, zodat je alles sneller vindt.
- Nieuwe accounts krijgen een tijdelijk wachtwoord. Bij de eerste keer inloggen kies je zelf een wachtwoord.
- Pijltjes bij Nieuwe releases en Aanbevolen om met de muis door de rij te bladeren.
- Stond Kijkbox open tijdens een update, dan zie je nu een melding om de pagina te vernieuwen.

## 1.1.0 (2026-11-09)

- Lijsten met films, series en favorieten laden flink sneller.
- Elke nacht wordt er automatisch een back-up gemaakt. Bij Instellingen > Back-ups kun je die downloaden of terugzetten.
- Ondertitels die in een film zelf zitten, worden nu ook getoond (eerst die, anders OpenSubtitles).
- Nieuw voor beheerders: Instellingen > Status laat zien wie wat kijkt, hoe druk de server is en hoeveel verbindingen je provider telt.
- Een live-zender start sneller als de provider even "bezet" geeft.

## 1.0.3 (2026-11-09)

- Na een update zie je op Home wat er nieuw is.
- Heb je een paar versies overgeslagen, dan zie je bij Instellingen > Updates de wijzigingen van al die versies.

## 1.0.2 (2026-11-09)

- De tv-app is te downloaden op <adres-van-je-server>/tv.apk, om te installeren met de app Downloader op je Google TV. Bij Account > Tv koppelen staat het adres.

## 1.0.1 (2026-11-09)

- Het Updates-blok en het Netwerk-blok bij Instellingen worden weer goed getoond.

## 1.0.0 (2026-11-09)

- Eerste versie met installatiescript voor Proxmox, updates via Instellingen > Updates en een tv-app (1.3) waarin je het serveradres zelf instelt.


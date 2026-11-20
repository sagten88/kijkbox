# Kijkbox tv-app installeren op een Google TV of Android TV, vanaf een Windows-pc.
# Uitvoeren in PowerShell (geen beheerder nodig):
#
#   irm https://raw.githubusercontent.com/sagten88/kijkbox/main/install-tv-app.ps1 | iex
#
# Op de tv moet eerst "Ontwikkelaarsopties" en "USB-foutopsporing" (of "Draadloze foutopsporing")
# aan staan; zie de uitleg op https://github.com/sagten88/kijkbox#tv-app-installeren
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$package = 'nl.agtenhosting.kijkbox'
$fallbackApk = 'https://github.com/sagten88/kijkbox/releases/latest/download/kijkbox-tv.apk'
$work = Join-Path $env:LOCALAPPDATA 'Kijkbox'
New-Item -ItemType Directory -Force $work | Out-Null

function Say([string]$text) { Write-Host "`n==> $text" -ForegroundColor Yellow }
function Fail([string]$text) { Write-Host "`nFout: $text" -ForegroundColor Red; throw $text }

Write-Host @'

  Kijkbox tv-app installeren
  --------------------------
  Zorg dat de tv aan staat en op hetzelfde netwerk zit als deze pc.

'@

# ---- ADB (het programma van Google om apps op een Android-apparaat te zetten)
$adb = (Get-Command adb -ErrorAction SilentlyContinue).Source
if (-not $adb) {
  $adb = Join-Path $work 'platform-tools\adb.exe'
  if (-not (Test-Path $adb)) {
    Say 'ADB downloaden (Android platform-tools van Google)'
    $zip = Join-Path $work 'platform-tools.zip'
    Invoke-WebRequest -UseBasicParsing 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip' -OutFile $zip
    Expand-Archive -Path $zip -DestinationPath $work -Force
    Remove-Item $zip
  }
}
function Adb { & $adb @args 2>&1 | ForEach-Object { "$_" } }
Adb start-server | Out-Null

# ---- Verbinden met de tv
$tv = (Read-Host 'IP-adres van de tv (bijvoorbeeld 192.168.1.55)').Trim()
if (-not $tv) { Fail 'geen IP-adres ingevuld.' }
$target = if ($tv -match ':\d+$') { $tv } else { "${tv}:5555" }

Say "Verbinden met $target"
$result = (Adb connect $target) -join ' '
if ($result -notmatch 'connected') {
  Write-Host @'

Verbinden lukt niet. Op nieuwere tv's (Android 11 en hoger) moet je eerst koppelen:
  Instellingen > Systeem > Ontwikkelaarsopties > Draadloze foutopsporing > Apparaat koppelen met koppelingscode.
De tv toont dan een IP-adres met poort en een code van 6 cijfers.
'@
  $pairAt = (Read-Host 'IP-adres en poort voor koppelen (bijvoorbeeld 192.168.1.55:37123), of Enter om te stoppen').Trim()
  if (-not $pairAt) { Fail 'niet verbonden met de tv.' }
  $code = (Read-Host 'Koppelingscode van de tv').Trim()
  Write-Host ((Adb pair $pairAt $code) -join ' ')
  $target = (Read-Host 'IP-adres en poort onder "Draadloze foutopsporing" (dus niet die van het koppelen)').Trim()
  $result = (Adb connect $target) -join ' '
  if ($result -notmatch 'connected') { Fail "verbinden met $target lukte niet: $result" }
}

# De tv vraagt de eerste keer of deze pc mag verbinden.
for ($i = 0; $i -lt 30; $i++) {
  $state = ((Adb -s $target get-state) -join ' ').Trim()
  if ($state -eq 'device') { break }
  if ($i -eq 0) { Write-Host "`nKijk op de tv: kies 'Altijd toestaan vanaf deze computer' en dan 'Toestaan'." -ForegroundColor Cyan }
  Start-Sleep 2
}
if ($state -ne 'device') { Fail 'de tv heeft de verbinding niet toegestaan.' }
$model = ((Adb -s $target shell getprop ro.product.model) -join '').Trim()
Write-Host "Verbonden met: $model"

# ---- Kijkbox-server en de app ophalen
$server = (Read-Host "`nAdres van je Kijkbox-server (bijvoorbeeld 192.168.1.50:3000 of https://tv.voorbeeld.nl)").Trim().TrimEnd('/')
if (-not $server) { Fail 'geen serveradres ingevuld.' }
$serverUrl = if ($server -match '^https?://') { $server } else { "http://$server" }

Say 'Tv-app ophalen'
$apk = Join-Path $work 'kijkbox-tv.apk'
try {
  Invoke-WebRequest -UseBasicParsing "$serverUrl/tv.apk" -OutFile $apk -TimeoutSec 20
  Write-Host "Van je eigen server ($serverUrl)"
} catch {
  Invoke-WebRequest -UseBasicParsing $fallbackApk -OutFile $apk
  Write-Host 'Van GitHub (je server gaf de app niet; controleer of het adres klopt)'
}

Say 'Installeren op de tv'
$install = (Adb -s $target install -r $apk) -join ' '
if ($install -notmatch 'Success') { Fail "installeren mislukte: $install" }
Write-Host 'Geinstalleerd.'

# Het serveradres meteen meegeven, zodat je het niet met de afstandsbediening hoeft te typen.
Adb -s $target shell am start -n "$package/.MainActivity" --es server $serverUrl | Out-Null
Adb disconnect $target | Out-Null

Write-Host @"

  Klaar! Kijkbox staat op de tv ($model) en opent met $serverUrl.
  Koppel de tv met je account: de tv toont een code; vul die op je telefoon in bij
  Account > Tv koppelen. Je vindt de app daarna ook in het appmenu van de tv.

  Ontwikkelaarsopties mogen daarna weer uit (Instellingen > Systeem > Ontwikkelaarsopties).
  Laat ze aan als je later updates van de tv-app op dezelfde manier wilt installeren.

"@ -ForegroundColor Green

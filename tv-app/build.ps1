# Bouwt kijkbox-tv.apk zonder Gradle: aapt2 (resources), javac + d8 (code), zipalign en apksigner.
# Gebruik: powershell -ExecutionPolicy Bypass -File tv-app\build.ps1 [-Version 2]
param([int]$Version = 1)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem, System.Drawing

$root = $PSScriptRoot
$sdk = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
$bt = Join-Path $sdk 'build-tools\34.0.0'
$androidJar = Join-Path $sdk 'platforms\android-34\android.jar'
$jdk = (Get-ChildItem 'C:\Program Files\Microsoft' -Directory -Filter 'jdk-17*' | Select-Object -First 1).FullName
$env:JAVA_HOME = $jdk
$env:Path = "$jdk\bin;$env:Path"
$out = Join-Path $root 'build'
$res = Join-Path $out 'res'
Remove-Item $out -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force "$res\drawable", "$out\classes", "$out\dex" | Out-Null

function Invoke-Tool([string]$exe, [string[]]$arguments) {
  & $exe @arguments
  if ($LASTEXITCODE -ne 0) { throw "$([IO.Path]::GetFileName($exe)) faalde ($LASTEXITCODE)" }
}

# ---- Pictogram en banner (de banner verschijnt in het appmenu van Google TV)
function New-Png([int]$w, [int]$h, [string]$path, [bool]$withText) {
  $bmp = New-Object Drawing.Bitmap $w, $h
  $g = [Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'; $g.TextRenderingHint = 'AntiAliasGridFit'
  $amber = [Drawing.ColorTranslator]::FromHtml('#f2b632'); $ink = [Drawing.ColorTranslator]::FromHtml('#101216')
  $g.Clear($(if ($withText) { $ink } else { $amber }))
  $s = [Math]::Min($w, $h) * $(if ($withText) { 0.62 } else { 1.0 })
  $x0 = $(if ($withText) { $h * 0.19 } else { 0 }); $y0 = ($h - $s) / 2
  if ($withText) { $g.FillRectangle((New-Object Drawing.SolidBrush $amber), [float]$x0, [float]$y0, [float]$s, [float]$s) }
  $k = $s / 512
  $g.FillRectangle((New-Object Drawing.SolidBrush $ink), [float]($x0 + 96 * $k), [float]($y0 + 136 * $k), [float](320 * $k), [float](240 * $k))
  $pts = [Drawing.PointF[]]@(
    (New-Object Drawing.PointF ([float]($x0 + 216 * $k)), ([float]($y0 + 202 * $k))),
    (New-Object Drawing.PointF ([float]($x0 + 216 * $k)), ([float]($y0 + 310 * $k))),
    (New-Object Drawing.PointF ([float]($x0 + 308 * $k)), ([float]($y0 + 256 * $k))))
  $g.FillPolygon((New-Object Drawing.SolidBrush $amber), $pts)
  if ($withText) {
    $font = New-Object Drawing.Font 'Segoe UI', ([float]($h * 0.22)), ([Drawing.FontStyle]::Bold), ([Drawing.GraphicsUnit]::Pixel)
    $g.DrawString('Kijkbox', $font, (New-Object Drawing.SolidBrush ([Drawing.Color]::White)), [float]($x0 + $s + $h * 0.1), [float]($h * 0.34))
  }
  $bmp.Save($path, [Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose()
}
New-Png 192 192 "$res\drawable\icon.png" $false
New-Png 320 180 "$res\drawable\banner.png" $true

# ---- Resources en manifest
Invoke-Tool "$bt\aapt2.exe" @('compile', '--dir', $res, '-o', "$out\res.zip")
Invoke-Tool "$bt\aapt2.exe" @('link', '-o', "$out\base.apk", '-I', $androidJar, '--manifest', "$root\AndroidManifest.xml",
  '--min-sdk-version', '24', '--target-sdk-version', '34', '--version-code', "$Version", '--version-name', "1.$Version", "$out\res.zip")

# ---- Code
$sources = Get-ChildItem "$root\src" -Recurse -Filter *.java | ForEach-Object FullName
Invoke-Tool 'javac' (@('-source', '8', '-target', '8', '-Xlint:-options', '-encoding', 'UTF-8', '-classpath', $androidJar, '-d', "$out\classes") + $sources)
$classes = Get-ChildItem "$out\classes" -Recurse -Filter *.class | ForEach-Object FullName
Invoke-Tool "$bt\d8.bat" (@('--release', '--min-api', '24', '--lib', $androidJar, '--output', "$out\dex") + $classes)

# ---- classes.dex in de apk zetten
$zip = [IO.Compression.ZipFile]::Open("$out\base.apk", 'Update')
[IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, "$out\dex\classes.dex", 'classes.dex') | Out-Null
$zip.Dispose()

# ---- Uitlijnen en ondertekenen. Bewaar de sleutel: updates moeten met dezelfde sleutel ondertekend zijn.
$signing = Join-Path $root 'signing'
$keystore = Join-Path $signing 'kijkbox.keystore'
$passFile = Join-Path $signing 'password.txt'
if (-not (Test-Path $keystore)) {
  New-Item -ItemType Directory -Force $signing | Out-Null
  $pass = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
  [IO.File]::WriteAllText($passFile, $pass)
  Invoke-Tool 'keytool' @('-genkeypair', '-keystore', $keystore, '-alias', 'kijkbox', '-keyalg', 'RSA', '-keysize', '3072',
    '-validity', '10000', '-storepass', $pass, '-keypass', $pass, '-dname', 'CN=Kijkbox')
}
$pass = [IO.File]::ReadAllText($passFile).Trim()
Invoke-Tool "$bt\zipalign.exe" @('-f', '-p', '4', "$out\base.apk", "$out\aligned.apk")
Invoke-Tool "$bt\apksigner.bat" @('sign', '--ks', $keystore, '--ks-pass', "pass:$pass", '--out', "$root\kijkbox-tv.apk", "$out\aligned.apk")
Invoke-Tool "$bt\apksigner.bat" @('verify', "$root\kijkbox-tv.apk")
"klaar: $root\kijkbox-tv.apk ($([Math]::Round((Get-Item "$root\kijkbox-tv.apk").Length / 1KB)) KB, versie 1.$Version)"

# Gera o .zip para enviar à Chrome Web Store / Edge Add-ons em dist\.
# Uso: powershell -ExecutionPolicy Bypass -File scripts\build.ps1
# Usa System.IO.Compression (e não Compress-Archive) para gravar caminhos com "/",
# que é o que a loja espera.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem

$root = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content (Join-Path $root 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $manifest.version

$files = @('manifest.json', 'content.js', 'content.css', 'popup.html', 'popup.js',
           'icons/16.png', 'icons/48.png', 'icons/128.png')
foreach ($f in $files) {
    if (-not (Test-Path (Join-Path $root $f))) {
        throw "Arquivo ausente: $f (rode scripts\make-images.ps1 para gerar os ícones)"
    }
}

$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Force $dist | Out-Null
$zipPath = Join-Path $dist "quantopus-exporter-$version.zip"
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

$zip = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($f in $files) {
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $zip, (Join-Path $root $f), $f, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
} finally {
    $zip.Dispose()
}

Write-Host "Pacote gerado: $zipPath (versão $version)"
$check = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
try { $check.Entries | ForEach-Object { Write-Host "  $($_.FullName)  ($($_.Length) bytes)" } } finally { $check.Dispose() }

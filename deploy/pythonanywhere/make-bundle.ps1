# Builds kudsi-shop.zip for the PythonAnywhere "Files -> Upload" route.
# Excludes the local database, secrets and caches.
#
#   powershell -ExecutionPolicy Bypass -File deploy\pythonanywhere\make-bundle.ps1
#
# Upload the zip to /home/<username>/ on PythonAnywhere, then follow README.md.

param(
    [string]$OutFile = "$PSScriptRoot\..\..\kudsi-shop.zip"
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path "$PSScriptRoot\..\..").Path
$out = [System.IO.Path]::GetFullPath($OutFile)
$staging = Join-Path $env:TEMP ("kudsi-bundle-" + [guid]::NewGuid().ToString("N"))

$skipDirs = @(".git", ".dist", "data", "__pycache__", ".venv", "venv", "deploy")
$skipFiles = @(".env", "*.pyc", "*.log", "kudsi-shop.zip")

New-Item -ItemType Directory -Path $staging -Force | Out-Null
$target = Join-Path $staging "kudsi-shop"
New-Item -ItemType Directory -Path $target -Force | Out-Null

Get-ChildItem -Path $root -Force | ForEach-Object {
    if ($_.PSIsContainer) {
        if ($skipDirs -notcontains $_.Name) {
            Copy-Item $_.FullName -Destination $target -Recurse -Force
        }
    } else {
        $skip = $false
        foreach ($pattern in $skipFiles) {
            if ($_.Name -like $pattern) { $skip = $true }
        }
        if (-not $skip) { Copy-Item $_.FullName -Destination $target -Force }
    }
}

# Ship the deployment guide and WSGI file inside the zip.
Copy-Item $PSScriptRoot -Destination (Join-Path $target "deploy") -Recurse -Force

if (Test-Path $out) { Remove-Item $out -Force }
Compress-Archive -Path $target -DestinationPath $out -CompressionLevel Optimal

Remove-Item $staging -Recurse -Force

$size = [math]::Round((Get-Item $out).Length / 1MB, 2)
Write-Host ""
Write-Host "Bundle ready: $out ($size MB)"
Write-Host "Upload it to /home/<username>/ on PythonAnywhere, then read deploy/pythonanywhere/README.md"

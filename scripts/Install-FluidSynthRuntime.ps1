[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$version = '2.5.7'
$archiveName = "fluidsynth-v$version-win10-x64-cpp11.zip"
$archiveUri = "https://github.com/FluidSynth/fluidsynth/releases/download/v$version/$archiveName"
$licenseUri = "https://raw.githubusercontent.com/FluidSynth/fluidsynth/v$version/LICENSE"
$expectedSha256 = 'fd40c259c56afd6c9ed02ca6c543f896524ade2e3eada28894df7839794f24c9'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtimeRoot = [System.IO.Path]::GetFullPath(
  (Join-Path $projectRoot "engine\bin\fluidsynth\$version")
)
$expectedRuntimeParent = [System.IO.Path]::GetFullPath(
  (Join-Path $projectRoot 'engine\bin\fluidsynth')
)

if (
  -not $runtimeRoot.StartsWith(
    $expectedRuntimeParent + [System.IO.Path]::DirectorySeparatorChar,
    [System.StringComparison]::OrdinalIgnoreCase
  )
) {
  throw 'FluidSynth runtime target escaped the expected Engine directory.'
}

$requiredFiles = @(
  'fluidsynth.exe',
  'libfluidsynth-3.dll',
  'sndfile.dll',
  'SDL3.dll',
  'LICENSE.txt',
  'SOURCE.txt'
)
$existingFiles = @(
  $requiredFiles |
    Where-Object { Test-Path -LiteralPath (Join-Path $runtimeRoot $_) -PathType Leaf }
)

if ($existingFiles.Count -eq $requiredFiles.Count) {
  $versionOutput = & (Join-Path $runtimeRoot 'fluidsynth.exe') --version 2>&1

  if (
    $LASTEXITCODE -ne 0 -or
    ($versionOutput -join "`n") -notmatch "FluidSynth runtime version $version"
  ) {
    throw "Existing FluidSynth runtime at $runtimeRoot failed version verification."
  }

  Write-Output "FluidSynth $version runtime already verified: $runtimeRoot"
  exit 0
}

if (Test-Path -LiteralPath $runtimeRoot) {
  throw "Incomplete FluidSynth runtime already exists at $runtimeRoot. Remove or recover it explicitly before reinstalling."
}

$temporaryRoot = Join-Path (
  [System.IO.Path]::GetTempPath()
) "humstudio-fluidsynth-$([Guid]::NewGuid().ToString('N'))"
$archivePath = Join-Path $temporaryRoot $archiveName
$extractRoot = Join-Path $temporaryRoot 'extracted'
$licensePath = Join-Path $temporaryRoot 'LICENSE.txt'
$stagingRoot = Join-Path (
  Split-Path -Parent $runtimeRoot
) ".staging-$version-$([Guid]::NewGuid().ToString('N'))"

try {
  New-Item -ItemType Directory -Path $temporaryRoot | Out-Null
  Invoke-WebRequest -Uri $archiveUri -OutFile $archivePath
  $actualSha256 = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()

  if ($actualSha256 -ne $expectedSha256) {
    throw "FluidSynth archive SHA-256 mismatch. Expected $expectedSha256, received $actualSha256."
  }

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [System.IO.Compression.ZipFile]::OpenRead($archivePath)

  try {
    $canonicalExtractRoot = [System.IO.Path]::GetFullPath(
      $extractRoot + [System.IO.Path]::DirectorySeparatorChar
    )

    foreach ($entry in $archive.Entries) {
      $entryTarget = [System.IO.Path]::GetFullPath(
        (Join-Path $extractRoot $entry.FullName)
      )

      if (
        -not $entryTarget.StartsWith(
          $canonicalExtractRoot,
          [System.StringComparison]::OrdinalIgnoreCase
        )
      ) {
        throw "FluidSynth archive contains an unsafe path: $($entry.FullName)"
      }
    }
  }
  finally {
    $archive.Dispose()
  }

  Expand-Archive -LiteralPath $archivePath -DestinationPath $extractRoot
  Invoke-WebRequest -Uri $licenseUri -OutFile $licensePath
  New-Item -ItemType Directory -Path $stagingRoot | Out-Null
  $archiveBin = Join-Path $extractRoot "$($archiveName.Substring(0, $archiveName.Length - 4))\bin"

  foreach ($fileName in @('fluidsynth.exe', 'libfluidsynth-3.dll', 'sndfile.dll', 'SDL3.dll')) {
    Copy-Item -LiteralPath (Join-Path $archiveBin $fileName) -Destination $stagingRoot
  }

  Copy-Item -LiteralPath $licensePath -Destination (Join-Path $stagingRoot 'LICENSE.txt')
  @(
    "FluidSynth $version",
    "Official release: https://github.com/FluidSynth/fluidsynth/releases/tag/v$version",
    "Archive: $archiveUri",
    "SHA-256: $expectedSha256",
    "License source: $licenseUri",
    'Installed locally for ElpisDAW. Runtime files are excluded from Git.'
  ) | Set-Content -LiteralPath (Join-Path $stagingRoot 'SOURCE.txt') -Encoding UTF8
  New-Item -ItemType Directory -Path (Split-Path -Parent $runtimeRoot) -Force | Out-Null
  Move-Item -LiteralPath $stagingRoot -Destination $runtimeRoot

  $versionOutput = & (Join-Path $runtimeRoot 'fluidsynth.exe') --version 2>&1

  if (
    $LASTEXITCODE -ne 0 -or
    ($versionOutput -join "`n") -notmatch "FluidSynth runtime version $version"
  ) {
    throw "Installed FluidSynth runtime failed version verification at $runtimeRoot."
  }

  Write-Output "FluidSynth $version runtime installed and verified: $runtimeRoot"
}
finally {
  if (Test-Path -LiteralPath $stagingRoot) {
    Remove-Item -LiteralPath $stagingRoot -Recurse -Force
  }

  if (Test-Path -LiteralPath $temporaryRoot) {
    Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
  }
}

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$version = '2.5.7'
$archiveName = "fluidsynth-v$version-win10-x64-cpp11.zip"
$archiveUri = "https://github.com/FluidSynth/fluidsynth/releases/download/v$version/$archiveName"
$expectedSha256 = 'fd40c259c56afd6c9ed02ca6c543f896524ade2e3eada28894df7839794f24c9'
$libSndFileArchiveUri = 'https://github.com/libsndfile/libsndfile/releases/download/1.2.2/libsndfile-1.2.2-win64.zip'
$libSndFileArchiveSha256 = '2173935c0c1ed13cf627951d34483f9d405ead2eb473190461c42ba220643a3f'
$licenseRecords = @(
  [PSCustomObject]@{
    FileName = 'LICENSE.txt'
    Uri = "https://raw.githubusercontent.com/FluidSynth/fluidsynth/v$version/LICENSE"
    Sha256 = '20e50fe7aae3e56378ebf0417d9de904f55a0e61e4df315333e632a4d3555d95'
  },
  [PSCustomObject]@{
    FileName = 'LICENSE.libsndfile.txt'
    Uri = 'https://raw.githubusercontent.com/libsndfile/libsndfile/1.2.2/COPYING'
    Sha256 = 'ad01ea5cd2755f6048383c8d54c88459cd6fcb17757c5c8892f8c5ea060f6140'
  }
)
$runtimeFileSha256 = [ordered]@{
  'fluidsynth.exe' = 'e81f4cd3aad2a1d5b0ecc148ec74a6f24905ae74fc6d7fa8520c64f90173ace5'
  'libfluidsynth-3.dll' = 'c2f060eb258d028dfece0ce62cdfeda12de40feba50df2642df544ce28d16230'
  'sndfile.dll' = '4e3bd2de8e1485110eaebef8e1239471f73d608773831c323bf528e05645655e'
  'LICENSE.txt' = '20e50fe7aae3e56378ebf0417d9de904f55a0e61e4df315333e632a4d3555d95'
  'LICENSE.libsndfile.txt' = 'ad01ea5cd2755f6048383c8d54c88459cd6fcb17757c5c8892f8c5ea060f6140'
}

function Assert-RuntimeFileHashes {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Root
  )

  foreach ($entry in $runtimeFileSha256.GetEnumerator()) {
    $filePath = Join-Path $Root $entry.Key
    $actualFileSha256 = (Get-FileHash -LiteralPath $filePath -Algorithm SHA256).Hash.ToLowerInvariant()

    if ($actualFileSha256 -ne $entry.Value) {
      throw "FluidSynth runtime file $($entry.Key) failed SHA-256 verification."
    }
  }
}

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
  'LICENSE.txt',
  'LICENSE.libsndfile.txt',
  'SOURCE.txt'
)
$existingFiles = @(
  $requiredFiles |
    Where-Object { Test-Path -LiteralPath (Join-Path $runtimeRoot $_) -PathType Leaf }
)

if ($existingFiles.Count -eq $requiredFiles.Count) {
  Assert-RuntimeFileHashes -Root $runtimeRoot
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
  New-Item -ItemType Directory -Path $stagingRoot | Out-Null
  $archiveBin = Join-Path $extractRoot "$($archiveName.Substring(0, $archiveName.Length - 4))\bin"

  foreach ($fileName in @('fluidsynth.exe', 'libfluidsynth-3.dll', 'sndfile.dll')) {
    Copy-Item -LiteralPath (Join-Path $archiveBin $fileName) -Destination $stagingRoot
  }

  foreach ($licenseRecord in $licenseRecords) {
    $licensePath = Join-Path $temporaryRoot $licenseRecord.FileName
    Invoke-WebRequest -Uri $licenseRecord.Uri -OutFile $licensePath
    $actualLicenseSha256 = (Get-FileHash -LiteralPath $licensePath -Algorithm SHA256).Hash.ToLowerInvariant()

    if ($actualLicenseSha256 -ne $licenseRecord.Sha256) {
      throw "FluidSynth runtime license $($licenseRecord.FileName) failed SHA-256 verification."
    }

    Copy-Item -LiteralPath $licensePath -Destination $stagingRoot
  }

  @(
    "FluidSynth $version",
    "Official release: https://github.com/FluidSynth/fluidsynth/releases/tag/v$version",
    "Archive: $archiveUri",
    "SHA-256: $expectedSha256",
    "FluidSynth license: $($licenseRecords[0].Uri)",
    "FluidSynth license SHA-256: $($licenseRecords[0].Sha256)",
    'libsndfile 1.2.2',
    "libsndfile archive: $libSndFileArchiveUri",
    "libsndfile archive SHA-256: $libSndFileArchiveSha256",
    "libsndfile license: $($licenseRecords[1].Uri)",
    "libsndfile license SHA-256: $($licenseRecords[1].Sha256)",
    'SDL3.dll excluded: the official MSVC build disables SDL3 and the installed FluidSynth binaries do not import it.',
    'Installed locally for ElpisDAW. Runtime files are excluded from Git.'
  ) | Set-Content -LiteralPath (Join-Path $stagingRoot 'SOURCE.txt') -Encoding UTF8

  Assert-RuntimeFileHashes -Root $stagingRoot
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

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$sourcePath = Join-Path $projectRoot 'engine\windows\HumStudio.FluidSynthLiveHost.cs'
$runtimeDirectory = Join-Path $projectRoot 'engine\bin\fluidsynth\2.5.7'
$outputPath = Join-Path $runtimeDirectory 'HumStudio.FluidSynthLiveHost.exe'

if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
  throw "FluidSynth Live Host source was not found at $sourcePath"
}

if (-not (Test-Path -LiteralPath (Join-Path $runtimeDirectory 'libfluidsynth-3.dll') -PathType Leaf)) {
  throw 'FluidSynth runtime must be installed before building FluidSynth Live Host.'
}

if (Test-Path -LiteralPath $outputPath -PathType Leaf) {
  $sourceLastWriteTime = (Get-Item -LiteralPath $sourcePath).LastWriteTimeUtc
  $outputLastWriteTime = (Get-Item -LiteralPath $outputPath).LastWriteTimeUtc

  if ($outputLastWriteTime -ge $sourceLastWriteTime) {
    Write-Output "FluidSynth Live Host ready: $outputPath"
    return
  }
}

$compilerCandidates = @(
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
)
$compilerPath = $compilerCandidates |
  Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
  Select-Object -First 1

if (-not $compilerPath) {
  throw 'The Windows .NET Framework C# compiler is required to build FluidSynth Live Host.'
}

& $compilerPath `
  /nologo `
  /target:exe `
  /optimize+ `
  /platform:x64 `
  /reference:System.dll `
  "/out:$outputPath" `
  $sourcePath

if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $outputPath -PathType Leaf)) {
  throw "FluidSynth Live Host compilation failed with exit code $LASTEXITCODE."
}

Write-Output "FluidSynth Live Host ready: $outputPath"

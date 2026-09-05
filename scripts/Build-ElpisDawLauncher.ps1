[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$launcherSourcePath = Join-Path $projectRoot 'engine\windows\ElpisDAW.Launcher.cs'
$manifestSourcePath = Join-Path $projectRoot 'engine\windows\ElpisDAW.ReleaseManifest.cs'
$outputDirectory = Join-Path $projectRoot 'engine\bin'
$outputPath = Join-Path $outputDirectory 'ElpisDAW.exe'
$compilerCandidates = @(
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
)
$compilerPath = $compilerCandidates |
  Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
  Select-Object -First 1

if (-not $compilerPath) {
  throw 'The Windows .NET Framework C# compiler is required to build ElpisDAW.exe.'
}

foreach ($sourcePath in @($launcherSourcePath, $manifestSourcePath)) {
  if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
    throw "ElpisDAW launcher source was not found at $sourcePath"
  }
}

New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null

& $compilerPath `
  /nologo `
  /target:winexe `
  /optimize+ `
  /platform:x64 `
  /warnaserror+ `
  /reference:System.dll `
  /reference:System.Core.dll `
  /reference:System.Drawing.dll `
  /reference:System.Web.Extensions.dll `
  /reference:System.Windows.Forms.dll `
  "/out:$outputPath" `
  $launcherSourcePath `
  $manifestSourcePath

if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $outputPath -PathType Leaf)) {
  throw "ElpisDAW launcher compilation failed with exit code $LASTEXITCODE."
}

Write-Output "ElpisDAW launcher ready: $outputPath"

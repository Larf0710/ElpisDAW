[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$sourcePath = Join-Path $projectRoot 'engine\windows\HumStudio.DirectoryPicker.cs'
$outputDirectory = Join-Path $projectRoot 'engine\bin'
$outputPath = Join-Path $outputDirectory 'HumStudio.DirectoryPicker.exe'
$compilerCandidates = @(
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
)
$compilerPath = $compilerCandidates |
  Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
  Select-Object -First 1

if (-not $compilerPath) {
  throw 'The Windows .NET Framework C# compiler is required to build the native directory picker.'
}

if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
  throw "Directory picker source was not found at $sourcePath"
}

New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null

& $compilerPath `
  /nologo `
  /target:winexe `
  /optimize+ `
  /platform:anycpu `
  /reference:System.dll `
  /reference:System.Drawing.dll `
  /reference:System.Windows.Forms.dll `
  "/out:$outputPath" `
  $sourcePath

if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $outputPath -PathType Leaf)) {
  throw "Directory picker compilation failed with exit code $LASTEXITCODE."
}

Write-Output "Windows directory picker ready: $outputPath"

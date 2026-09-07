[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$sourcePath = Join-Path $projectRoot 'engine\windows\HumStudio.DirectoryPicker.cs'
$iconPath = Join-Path $projectRoot 'assets\branding\ElpisDAW.ico'
$outputDirectory = Join-Path $projectRoot 'engine\bin'
$outputPath = Join-Path $outputDirectory 'HumStudio.DirectoryPicker.exe'
$programFilesX86 = [Environment]::GetFolderPath(
  [Environment+SpecialFolder]::ProgramFilesX86
)
$vswherePath = Join-Path $programFilesX86 'Microsoft Visual Studio\Installer\vswhere.exe'
$compilerCandidates = @()

if (Test-Path -LiteralPath $vswherePath -PathType Leaf) {
  $compilerCandidates += & $vswherePath `
    -latest `
    -products * `
    -requires Microsoft.Component.MSBuild `
    -find 'MSBuild\**\Bin\Roslyn\csc.exe'
}

$compilerCandidates += @(
  (Join-Path $programFilesX86 'Microsoft Visual Studio\2022\BuildTools\MSBuild\Current\Bin\Roslyn\csc.exe'),
  (Join-Path $programFilesX86 'Microsoft Visual Studio\2022\Enterprise\MSBuild\Current\Bin\Roslyn\csc.exe'),
  (Join-Path $programFilesX86 'Microsoft Visual Studio\2022\Professional\MSBuild\Current\Bin\Roslyn\csc.exe'),
  (Join-Path $programFilesX86 'Microsoft Visual Studio\2022\Community\MSBuild\Current\Bin\Roslyn\csc.exe')
)
$compilerPath = $compilerCandidates |
  Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
  Select-Object -First 1

if (-not $compilerPath) {
  throw 'The Visual Studio Roslyn C# compiler is required to build the native directory picker deterministically.'
}

if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
  throw "Directory picker source was not found at $sourcePath"
}

if (-not (Test-Path -LiteralPath $iconPath -PathType Leaf)) {
  throw "ElpisDAW Windows icon was not found at $iconPath"
}

New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null

& $compilerPath `
  /nologo `
  /target:winexe `
  /optimize+ `
  /deterministic+ `
  /platform:anycpu `
  "/win32icon:$iconPath" `
  "/pathmap:$projectRoot=/_/HumStudio" `
  /reference:System.dll `
  /reference:System.Drawing.dll `
  /reference:System.Windows.Forms.dll `
  "/out:$outputPath" `
  $sourcePath

if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $outputPath -PathType Leaf)) {
  throw "Directory picker compilation failed with exit code $LASTEXITCODE."
}

Write-Output "Windows directory picker ready: $outputPath"

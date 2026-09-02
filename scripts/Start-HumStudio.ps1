[CmdletBinding()]
param(
  [ValidateRange(1, 65535)]
  [int]$EnginePort = 43120,

  [ValidateRange(1, 65535)]
  [int]$UiPort = 5173,

  [string]$NodePath,

  [string]$PnpmPath,

  [string]$AiCacheRoot = [System.IO.Path]::Combine(
    [System.Environment]::GetFolderPath('LocalApplicationData'),
    'ElpisDAW',
    'AI_CACHE'
  ),

  [switch]$NoOpen,

  [switch]$Headless
)

$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$engineProcess = $null
$uiProcess = $null

function Resolve-HumStudioExecutable {
  param(
    [string]$ExplicitPath,
    [string]$CommandName,
    [string]$FallbackPath
  )

  if ($ExplicitPath) {
    $resolvedExplicitPath = [System.IO.Path]::GetFullPath($ExplicitPath)

    if (-not (Test-Path -LiteralPath $resolvedExplicitPath -PathType Leaf)) {
      throw "$CommandName was not found at $resolvedExplicitPath"
    }

    return $resolvedExplicitPath
  }

  $command = Get-Command $CommandName -ErrorAction SilentlyContinue | Select-Object -First 1

  if ($command) {
    return $command.Source
  }

  if ($FallbackPath -and (Test-Path -LiteralPath $FallbackPath -PathType Leaf)) {
    return $FallbackPath
  }

  throw "$CommandName was not found. Pass its full path to the Launcher."
}

function New-HumStudioLaunchToken {
  $bytes = New-Object byte[] 32
  $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()

  try {
    $generator.GetBytes($bytes)
  }
  finally {
    $generator.Dispose()
  }

  return -join ($bytes | ForEach-Object { $_.ToString('x2') })
}

function Wait-HumStudioEndpoint {
  param(
    [string]$Uri,
    [hashtable]$Headers,
    [System.Diagnostics.Process]$Process,
    [string]$Label,
    [int]$TimeoutSeconds = 25
  )

  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)

  while ([DateTime]::UtcNow -lt $deadline) {
    if ($Process.HasExited) {
      throw "$Label exited with code $($Process.ExitCode)."
    }

    try {
      $response = Invoke-WebRequest -Uri $Uri -Headers $Headers -UseBasicParsing -TimeoutSec 2

      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300) {
        return
      }
    }
    catch {
      Start-Sleep -Milliseconds 250
    }
  }

  throw "$Label did not become ready within $TimeoutSeconds seconds."
}

function Test-HumStudioUiOrigin {
  param([string]$Origin)

  try {
    $response = Invoke-WebRequest -Uri $Origin -UseBasicParsing -TimeoutSec 1
    return $response.StatusCode -eq 200 -and $response.Content -match '<title>ElpisDAW</title>'
  }
  catch {
    return $false
  }
}

function Test-HumStudioTcpPortAvailable {
  param([int]$Port)

  $listener = [System.Net.Sockets.TcpListener]::new(
    [System.Net.IPAddress]::Loopback,
    $Port
  )

  try {
    $listener.Start()
    return $true
  }
  catch [System.Net.Sockets.SocketException] {
    return $false
  }
  finally {
    $listener.Stop()
  }
}

function Resolve-HumStudioEnginePort {
  param(
    [int]$PreferredPort,
    [int]$MaximumAttempts = 32
  )

  for ($offset = 0; $offset -lt $MaximumAttempts; $offset += 1) {
    $candidatePort = $PreferredPort + $offset

    if ($candidatePort -gt 65535) {
      break
    }

    if (Test-HumStudioTcpPortAvailable -Port $candidatePort) {
      return $candidatePort
    }
  }

  throw "No available Local Engine port was found from $PreferredPort."
}

function Stop-HumStudioProcess {
  param([System.Diagnostics.Process]$Process)

  if ($Process -and -not $Process.HasExited) {
    Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
  }
}

$runtimeRoot = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies'
$resolvedNodePath = Resolve-HumStudioExecutable `
  -ExplicitPath $NodePath `
  -CommandName 'node.exe' `
  -FallbackPath (Join-Path $runtimeRoot 'node\bin\node.exe')
$resolvedPnpmPath = Resolve-HumStudioExecutable `
  -ExplicitPath $PnpmPath `
  -CommandName 'pnpm.cmd' `
  -FallbackPath (Join-Path $runtimeRoot 'bin\fallback\pnpm.cmd')
$defaultSoundFontInstaller = Join-Path $projectRoot 'scripts\Install-DefaultSoundFont.mjs'

if (-not (Test-Path -LiteralPath $defaultSoundFontInstaller -PathType Leaf)) {
  throw "Default SoundFont installer was not found at $defaultSoundFontInstaller"
}

Write-Output 'Default SoundFont: CHECKING.'
$defaultSoundFontJson = & $resolvedNodePath `
  $defaultSoundFontInstaller `
  '--allow-unavailable'

if ($LASTEXITCODE -ne 0) {
  Write-Warning 'Default SoundFont installation failed; licensed custom Project SoundFonts remain available.'
}
else {
  $defaultSoundFont = $defaultSoundFontJson | ConvertFrom-Json

  if ($defaultSoundFont.status -eq 'READY') {
    Write-Output "Default SoundFont: READY ($($defaultSoundFont.displayName))."
  }
  elseif ($defaultSoundFont.status -eq 'INSTALLED') {
    Write-Output "Default SoundFont: INSTALLED ($($defaultSoundFont.displayName))."
  }
  elseif ($defaultSoundFont.status -eq 'UNAVAILABLE') {
    Write-Warning $defaultSoundFont.message
  }
  else {
    Write-Warning 'Default SoundFont installer returned an unsupported status.'
  }
}

$aceStepRuntimeResolver = Join-Path $projectRoot 'scripts\Resolve-HumStudioAceStepRuntime.mjs'

if (-not (Test-Path -LiteralPath $aceStepRuntimeResolver -PathType Leaf)) {
  throw "ACE-Step runtime resolver was not found at $aceStepRuntimeResolver"
}

$aceStepRuntimeJson = & $resolvedNodePath `
  $aceStepRuntimeResolver `
  '--ai-cache-root' `
  $AiCacheRoot

if ($LASTEXITCODE -ne 0) {
  throw 'ACE-Step runtime resolution failed.'
}

$aceStepRuntime = $aceStepRuntimeJson | ConvertFrom-Json

if ($aceStepRuntime.status -eq 'configured') {
  Write-Output "ACE-Step runtime: READY ($($aceStepRuntime.source))."
}
elseif ($aceStepRuntime.status -eq 'unavailable') {
  Write-Warning $aceStepRuntime.message
}
else {
  throw 'ACE-Step runtime resolver returned an unsupported status.'
}

$directoryPickerBuildScript = Join-Path $projectRoot 'scripts\Build-WindowsDirectoryPicker.ps1'

& $directoryPickerBuildScript

$fluidSynthLiveHostBuildScript = Join-Path $projectRoot 'scripts\Build-FluidSynthLiveHost.ps1'
$fluidSynthLibraryPath = Join-Path $projectRoot 'engine\bin\fluidsynth\2.5.7\libfluidsynth-3.dll'

if (Test-Path -LiteralPath $fluidSynthLibraryPath -PathType Leaf) {
  & $fluidSynthLiveHostBuildScript
}
else {
  Write-Warning 'FluidSynth Live Host is unavailable until the FluidSynth runtime is installed.'
}

$requestedEnginePort = $EnginePort
$EnginePort = Resolve-HumStudioEnginePort -PreferredPort $requestedEnginePort
$engineOrigin = "http://127.0.0.1:$EnginePort"
$uiOrigin = "http://127.0.0.1:$UiPort"

if ($EnginePort -ne $requestedEnginePort) {
  Write-Output "Local Engine port $requestedEnginePort is busy; using $EnginePort."
}

$token = New-HumStudioLaunchToken

$previousToken = [Environment]::GetEnvironmentVariable('HUMSTUDIO_ENGINE_TOKEN', 'Process')
$previousEnginePort = [Environment]::GetEnvironmentVariable('HUMSTUDIO_ENGINE_PORT', 'Process')
$previousUiOrigin = [Environment]::GetEnvironmentVariable('HUMSTUDIO_UI_ORIGIN', 'Process')
$previousAceStepPython = [Environment]::GetEnvironmentVariable(
  'HUMSTUDIO_ACE_STEP_PYTHON',
  'Process'
)
$previousAceStepCheckpointsRoot = [Environment]::GetEnvironmentVariable(
  'HUMSTUDIO_ACE_STEP_CHECKPOINTS_ROOT',
  'Process'
)
$reuseExistingUi = Test-HumStudioUiOrigin -Origin $uiOrigin

try {
  [Environment]::SetEnvironmentVariable('HUMSTUDIO_ENGINE_TOKEN', $token, 'Process')
  [Environment]::SetEnvironmentVariable('HUMSTUDIO_ENGINE_PORT', $EnginePort.ToString(), 'Process')
  [Environment]::SetEnvironmentVariable('HUMSTUDIO_UI_ORIGIN', $uiOrigin, 'Process')

  if ($aceStepRuntime.status -eq 'configured') {
    [Environment]::SetEnvironmentVariable(
      'HUMSTUDIO_ACE_STEP_PYTHON',
      $aceStepRuntime.pythonPath,
      'Process'
    )
    [Environment]::SetEnvironmentVariable(
      'HUMSTUDIO_ACE_STEP_CHECKPOINTS_ROOT',
      $aceStepRuntime.checkpointsRootPath,
      'Process'
    )
  }

  $engineProcess = Start-Process `
    -FilePath $resolvedNodePath `
    -ArgumentList 'engine/server.mjs' `
    -WorkingDirectory $projectRoot `
    -WindowStyle $(if ($Headless) { 'Hidden' } else { 'Normal' }) `
    -PassThru
}
finally {
  [Environment]::SetEnvironmentVariable('HUMSTUDIO_ENGINE_TOKEN', $previousToken, 'Process')
  [Environment]::SetEnvironmentVariable('HUMSTUDIO_ENGINE_PORT', $previousEnginePort, 'Process')
  [Environment]::SetEnvironmentVariable('HUMSTUDIO_UI_ORIGIN', $previousUiOrigin, 'Process')
  [Environment]::SetEnvironmentVariable(
    'HUMSTUDIO_ACE_STEP_PYTHON',
    $previousAceStepPython,
    'Process'
  )
  [Environment]::SetEnvironmentVariable(
    'HUMSTUDIO_ACE_STEP_CHECKPOINTS_ROOT',
    $previousAceStepCheckpointsRoot,
    'Process'
  )
}

try {
  Wait-HumStudioEndpoint `
    -Uri "$engineOrigin/api/v1/health" `
    -Headers @{ 'Origin' = $uiOrigin; 'x-humstudio-engine-token' = $token } `
    -Process $engineProcess `
    -Label 'Local Engine'

  if (-not $reuseExistingUi) {
    $uiProcess = Start-Process `
      -FilePath $resolvedPnpmPath `
      -ArgumentList @('dev', '--host', '127.0.0.1', '--port', $UiPort.ToString(), '--strictPort') `
      -WorkingDirectory $projectRoot `
      -WindowStyle Hidden `
      -PassThru

    Wait-HumStudioEndpoint `
      -Uri $uiOrigin `
      -Headers @{} `
      -Process $uiProcess `
      -Label 'ElpisDAW UI'
  }

  $launchUrl = "$uiOrigin/#engineBaseUrl=$([Uri]::EscapeDataString($engineOrigin))&engineToken=$([Uri]::EscapeDataString($token))"

  if (-not $NoOpen) {
    Start-Process $launchUrl
  }

  Write-Output 'ElpisDAW Launcher ready.'
  Write-Output "ENGINE_PID=$($engineProcess.Id)"
  Write-Output $(if ($reuseExistingUi) { 'UI_PID=REUSED' } else { "UI_PID=$($uiProcess.Id)" })
  Write-Output "UI_ORIGIN=$uiOrigin"
  Write-Output 'Launch token: active in process memory only.'
}
catch {
  Stop-HumStudioProcess -Process $uiProcess
  Stop-HumStudioProcess -Process $engineProcess
  throw
}

$ErrorActionPreference = 'Stop'

$ProjectDir = Split-Path -Parent $PSScriptRoot
$VbsPath = Join-Path $ProjectDir 'Start Control Tower.vbs'
$IconPath = Join-Path $ProjectDir 'assets\control-tower.ico'
$MakeIcons = Join-Path $PSScriptRoot 'make-icons.js'

if (-not (Test-Path $VbsPath)) {
    throw "Mangler launcher: $VbsPath"
}

$NodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
$NodeExe = if ($NodeCmd) { $NodeCmd.Source } else {
    @(
        (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
    ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
}

if ($NodeExe -and (Test-Path $MakeIcons)) {
    & $NodeExe $MakeIcons $IconPath | Out-Null
}

$Shell = New-Object -ComObject WScript.Shell
$DesktopDir = @($Shell.SpecialFolders('Desktop'), [Environment]::GetFolderPath('Desktop'), (Join-Path $env:USERPROFILE 'Desktop')) | Where-Object { $_ } | Select-Object -First 1
$ProgramsDir = @($Shell.SpecialFolders('Programs'), [Environment]::GetFolderPath('Programs'), (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs')) | Where-Object { $_ } | Select-Object -First 1

$Targets = @()
if ($DesktopDir) { $Targets += Join-Path $DesktopDir 'Control Tower.lnk' }
if ($ProgramsDir) { $Targets += Join-Path $ProgramsDir 'Control Tower.lnk' }

foreach ($lnkPath in $Targets) {
    $parent = Split-Path -Parent $lnkPath
    if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    $sc = $Shell.CreateShortcut($lnkPath)
    $sc.TargetPath = 'wscript.exe'
    $sc.Arguments = "`"$VbsPath`""
    $sc.WorkingDirectory = $ProjectDir
    if (Test-Path $IconPath) { $sc.IconLocation = "$IconPath,0" }
    $sc.Description = 'Start Control Tower uden terminalvindue'
    $sc.Save()
    Write-Output "Oprettede genvej: $lnkPath"
}

Write-Output ""
Write-Output "F$([char]0x00E6)rdig! Du kan nu starte Control Tower fra Skrivebordet eller Start-menuen."
Write-Output "Tip: N$([char]0x00E5)r Control Tower k$([char]0x00F8)rer, ligger det ved uret i systembakken (venstreklik = $([char]0x00E5)bn, h$([char]0x00F8)jreklik = menu/afslut)."

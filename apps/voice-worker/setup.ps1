# Shared, external voice runtime; run from the V6 worktree root.
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
if ([IO.Path]::GetFullPath((Get-Location).Path) -ne $root) { throw 'Run from the V6 worktree root.' }
$storage = $env:VOICE_HOME
if (-not $storage) { $storage = Join-Path $env:LOCALAPPDATA 'ABUD-FUN-OS/voice' }
$storage = [IO.Path]::GetFullPath($storage)
if ($storage.TrimEnd('\', '/') -eq $root.TrimEnd('\', '/') -or $storage.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'VOICE_HOME must be outside the repository.'
}
$env:VOICE_HOME = $storage
$basePython = $null
if (Get-Command py -ErrorAction SilentlyContinue) {
    try {
        $candidate = & py -3.11 -c 'import sys; print(sys.executable)'
        if ($LASTEXITCODE -eq 0) { $basePython = $candidate }
    } catch { $basePython = $null }
}
if (-not $basePython -and (Get-Command uv -ErrorAction SilentlyContinue)) {
    $candidate = & uv python find 3.11
    if ($LASTEXITCODE -eq 0) { $basePython = $candidate }
}
if (-not $basePython) { throw 'Python 3.11 required: install with uv python install 3.11 or register py -3.11.' }
$python = Join-Path $storage 'venv/Scripts/python.exe'
if (-not (Test-Path $python)) {
    & $basePython -I -m venv (Join-Path $storage 'venv')
    if ($LASTEXITCODE -ne 0) { throw 'Venv creation failed.' }
}
if (Get-Command uv -ErrorAction SilentlyContinue) {
    uv pip install --python $python -r (Join-Path $PSScriptRoot 'requirements.txt') --extra-index-url https://download.pytorch.org/whl/cu124
} else {
    & $python -I -m pip install -r (Join-Path $PSScriptRoot 'requirements.txt') --extra-index-url https://download.pytorch.org/whl/cu124
}
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
& $python -I (Join-Path $PSScriptRoot 'download_models.py')
if ($LASTEXITCODE -ne 0) { throw 'Model download failed.' }

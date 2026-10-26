param([string]$Python = "python")
$ErrorActionPreference = "Stop"
$voiceHome = if ($env:ABUD_LIVE_VOICE_HOME) { $env:ABUD_LIVE_VOICE_HOME } else { Join-Path $env:LOCALAPPDATA "ABUD-FUN-OS\realtime-voice" }
$venv = Join-Path $voiceHome "venv"
$model = Join-Path $voiceHome "kemetone"
New-Item -ItemType Directory -Force -Path $voiceHome | Out-Null
$runtimePython = Join-Path $venv "Scripts\python.exe"
if (Get-Command uv -ErrorAction SilentlyContinue) {
  if (-not (Test-Path $runtimePython)) { uv venv --python 3.11 $venv }
  uv pip install --python $runtimePython "torch==2.6.0+cu124" --index-url https://download.pytorch.org/whl/cu124
  if ($LASTEXITCODE -ne 0) { throw "PyTorch installation failed" }
  uv pip install --python $runtimePython -r (Join-Path $PSScriptRoot "requirements.txt")
} else {
  if (-not (Test-Path $runtimePython)) { & $Python -m venv $venv }
  & $runtimePython -m pip install "torch==2.6.0+cu124" --index-url https://download.pytorch.org/whl/cu124
  if ($LASTEXITCODE -ne 0) { throw "PyTorch installation failed" }
  & $runtimePython -m pip install -r (Join-Path $PSScriptRoot "requirements.txt")
}
if ($LASTEXITCODE -ne 0) { throw "Python dependencies failed" }
& $runtimePython -c "from huggingface_hub import snapshot_download; import sys; snapshot_download(repo_id='Rabe3/kemetone', local_dir=sys.argv[1], allow_patterns=['config.json','kemetone.pth','voices/kemetone.pt','kemetone/**'])" $model
if ($LASTEXITCODE -ne 0) { throw "Model download failed" }
Write-Output "KemeTone ready at $voiceHome"

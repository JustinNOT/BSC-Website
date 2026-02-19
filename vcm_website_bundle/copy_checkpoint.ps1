# Copy the V/A model checkpoint from Git-LA into this bundle.
# Run from the Git-LA repo root, e.g.:
#   cd "c:\Users\JT2ju\OneDrive\Desktop\Github\Lin\Fourth Stage - Redemption\Git-LA"
#   .\vcm_website_bundle\copy_checkpoint.ps1

$GitLARoot = Split-Path -Parent $PSScriptRoot
$src = Join-Path $GitLARoot "checkpoints\va_late_fusion_speech_emotion.joblib"
$destDir = Join-Path $PSScriptRoot "checkpoints"
$dest = Join-Path $destDir "va_late_fusion_speech_emotion.joblib"

if (-not (Test-Path $src)) {
    Write-Error "Checkpoint not found: $src (run from Git-LA repo root)"
    exit 1
}
if (-not (Test-Path $destDir)) {
    New-Item -ItemType Directory -Path $destDir -Force
}
Copy-Item -Path $src -Destination $dest -Force
Write-Host "Copied checkpoint to: $dest"

$names = @('addSprite2D','updateSprite2D','removeSprite2D','setSprite2DFrame','playSprite2DClip','stopSprite2DClip','addAnchoredSprite','updateAnchoredSprite','removeAnchoredSprite','setAnchoredSpriteFrame','playAnchoredSpriteClip','stopAnchoredSpriteClip','addBillboardSprite','updateBillboardSprite','removeBillboardSprite','setBillboardSpriteFrame','playBillboardSpriteClip','stopBillboardSpriteClip')
$files = @(
  'lab/src/lite/scene29.ts',
  'lab/src/lite/scene30.ts',
  'lab/src/lite/scene31.ts',
  'lab/src/lite/scene32.ts',
  'lab/src/lite/scene33.ts',
  'lab/src/lite/scene34.ts',
  'lab/src/lite/scene35.ts',
  'lab/src/lite/scene36.ts',
  'lab/src/lite/scene37.ts',
  'lab/src/lite/scene38.ts',
  'tests/unit/sprite-2d-layer.test.ts',
  'tests/unit/sprite-pick-2d.test.ts',
  'tests/unit/sprite-pick-anchored.test.ts',
  'tests/unit/sprite-anchored-pack.test.ts',
  'tests/unit/sprite-billboard-pack.test.ts'
)
foreach ($f in $files) {
  if (-not (Test-Path $f)) { Write-Host "MISSING: $f"; continue }
  $c = Get-Content $f -Raw
  foreach ($n in $names) {
    $pattern = '\b' + $n + '\b(?!Index)'
    $c = [regex]::Replace($c, $pattern, ($n + 'Index'))
  }
  Set-Content -Path $f -NoNewline -Value $c
  Write-Host "OK: $f"
}

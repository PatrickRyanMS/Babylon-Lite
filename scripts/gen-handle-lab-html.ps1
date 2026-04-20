$tmpl = '<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>__TITLE__</title>
  <style>html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:#000;}canvas{width:100%;height:100%;display:block;}</style>
</head>
<body>
  <canvas id="renderCanvas" width="1280" height="720"></canvas>
  __LOADER__<script type="module" src="__SRC__"></script>
</body>
</html>
'
foreach ($n in 39,40,41) {
  $variants = @(
    @{ file = "scene$n.html";            src = "/src/lite/scene$n.ts"; title = "Scene $n (Lite handle API)";        loader = '<script src="/loader.js"></script>' },
    @{ file = "babylon-ref-scene$n.html"; src = "/src/bjs/scene$n.ts";  title = "Reference Scene $n (BJS)";          loader = '' },
    @{ file = "bundle-scene$n.html";     src = "/bundle/scene$n.js";   title = "Bundle Scene $n (Lite handle API)"; loader = '<script src="/loader.js"></script>' },
    @{ file = "bundle-bjs-scene$n.html"; src = "/bundle/bjs-scene$n.js"; title = "Bundle Scene $n (BJS)";            loader = '' }
  )
  foreach ($v in $variants) {
    $html = $tmpl.Replace('__TITLE__', $v.title).Replace('__SRC__', $v.src).Replace('__LOADER__', $v.loader)
    $p = "lab/$($v.file)"
    Set-Content -Path $p -NoNewline -Value $html
    Write-Host "wrote $p"
  }
}

# Локальний сервер для перевірки тренажера на Windows без встановлення програм.
# Запуск: двічі клацніть start-local.bat (або в PowerShell: powershell -ExecutionPolicy Bypass -File start-local.ps1)
$port = 8000
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$mime = @{ '.html'='text/html; charset=utf-8'; '.js'='application/javascript; charset=utf-8'; '.css'='text/css; charset=utf-8';
           '.json'='application/json'; '.wasm'='application/wasm'; '.zip'='application/zip'; '.png'='image/png'; '.md'='text/plain; charset=utf-8' }
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$port/")
$listener.Start()
Write-Host "Тренажер доступний за адресою http://localhost:$port/  (закрийте це вікно, щоб зупинити сервер)"
Start-Process "http://localhost:$port/index.html"
while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $path = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath.TrimStart('/'))
  if ($path -eq '') { $path = 'index.html' }
  $file = Join-Path $root $path
  if ((Test-Path $file -PathType Leaf) -and ([IO.Path]::GetFullPath($file).StartsWith($root))) {
    $bytes = [IO.File]::ReadAllBytes($file)
    $ext = [IO.Path]::GetExtension($file).ToLower()
    $ctx.Response.ContentType = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
    $ctx.Response.ContentLength64 = $bytes.Length
    $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
  } else { $ctx.Response.StatusCode = 404 }
  $ctx.Response.Close()
}

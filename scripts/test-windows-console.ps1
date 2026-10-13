$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$output = Join-Path ([IO.Path]::GetTempPath()) ('quaymesh-native-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $output | Out-Null
try {
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    $library = Join-Path $root 'apps\native\windows\libs\net48\Microsoft.Web.WebView2.Core.dll'
    $binary = Join-Path $output 'ConsoleSessionStoreTests.exe'
    & $compiler /nologo /target:exe /platform:x64 "/out:$binary" /reference:System.dll /reference:System.Core.dll /reference:System.Security.dll /reference:System.Web.Extensions.dll "/reference:$library" (Join-Path $root 'apps\native\windows\src\BrowserSessionStore.cs') (Join-Path $root 'test\windows\ConsoleSessionStoreTests.cs')
    if ($LASTEXITCODE -ne 0) { throw 'Native test compilation failed' }
    Copy-Item $library $output
    & $binary
    if ($LASTEXITCODE -ne 0) { throw 'Native session checks failed' }
    $expected = [IO.File]::ReadAllBytes((Join-Path $root 'app.ico'))
    $actual = [IO.File]::ReadAllBytes((Join-Path $root 'components\windows-x64\app.ico'))
    if ([Convert]::ToBase64String($expected) -ne [Convert]::ToBase64String($actual)) { throw 'Published icon differs from app.ico' }
    Write-Output 'Published Windows icon matches app.ico'
} finally { Remove-Item $output -Recurse -Force }

param([Parameter(Mandatory=$true)][string]$FontPath, [Parameter(Mandatory=$true)][string]$ExpectedHash)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Font-SHA256([string]$FilePath) {
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hasher.ComputeHash([IO.File]::ReadAllBytes($FilePath)))).Replace('-','').ToLowerInvariant() } finally { $hasher.Dispose() }
}
$source = (Resolve-Path -LiteralPath $FontPath).Path
if ($ExpectedHash -notmatch '^[a-f0-9]{64}$' -or (Font-SHA256 $source) -ne $ExpectedHash) { throw 'Font hash validation failed.' }
if ([IO.Path]::GetExtension($source).ToLowerInvariant() -ne '.ttf') { throw 'Only the verified TTF font pack is supported.' }
Add-Type -AssemblyName System.Drawing
$privateFonts = New-Object System.Drawing.Text.PrivateFontCollection
try {
    $privateFonts.AddFontFile($source)
    if ($privateFonts.Families.Count -ne 1) { throw 'Expected one font family.' }
    $familyName = $privateFonts.Families[0].GetName(1033)
} finally { $privateFonts.Dispose() }
$fontDirectory = Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\Fonts'
[IO.Directory]::CreateDirectory($fontDirectory) | Out-Null
$destination = Join-Path $fontDirectory ('NARRAFORM-' + $ExpectedHash + '.ttf')
if (-not [IO.File]::Exists($destination) -or (Font-SHA256 $destination) -ne $ExpectedHash) {
    [IO.File]::Copy($source, $destination, $true)
}
$fontRegistry = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Software\Microsoft\Windows NT\CurrentVersion\Fonts')
try { $fontRegistry.SetValue(('NARRAFORM ' + $familyName + ' (TrueType)'), $destination, [Microsoft.Win32.RegistryValueKind]::String) } finally { $fontRegistry.Dispose() }
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class NarraformOpenFont {
    [DllImport("gdi32.dll", CharSet=CharSet.Unicode)]
    public static extern int AddFontResourceEx(string file, uint flags, IntPtr reserved);
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern IntPtr SendMessageTimeout(IntPtr window, uint msg, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
}
'@
$added = [NarraformOpenFont]::AddFontResourceEx($destination, 0, [IntPtr]::Zero)
if ($added -eq 0) { throw 'Windows could not activate the font. The verified file is retained for retry.' }
$broadcastResult = [IntPtr]::Zero
[NarraformOpenFont]::SendMessageTimeout([IntPtr]0xffff, 0x001d, [IntPtr]::Zero, [IntPtr]::Zero, 2, 1000, [ref]$broadcastResult) | Out-Null
@{family=$familyName; status='installed'; scope='current-user'} | ConvertTo-Json -Compress

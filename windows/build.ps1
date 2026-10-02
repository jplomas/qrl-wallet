Param(
    [ValidateSet('Release', 'Debug')]
    [string]$Configuration = 'Release'
)

$ErrorActionPreference = 'Stop'
$Root = Resolve-Path (Join-Path $PSScriptRoot '..')
$Dist = Join-Path $Root '.native/.dist/windows'

New-Item -ItemType Directory -Force -Path $Dist | Out-Null

dotnet publish (Join-Path $PSScriptRoot 'QRLWallet/QRLWallet.csproj') `
    -c $Configuration `
    -r win-x64 `
    --self-contained false `
    -o $Dist

Write-Host "Built $Dist"

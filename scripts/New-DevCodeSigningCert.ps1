<#
  Creates (once) a SELF-SIGNED code-signing certificate for development and testing the signing pipeline.
  Production builds must be signed with a certificate from a trusted CA (see docs/RELEASING.md); Windows and
  SmartScreen will not trust this one. Prints the certificate thumbprint.
#>
param([string]$Subject = 'CN=Viro Dev Code Signing')
$cert = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert | Where-Object { $_.Subject -eq $Subject -and $_.NotAfter -gt (Get-Date).AddDays(7) } | Select-Object -First 1
if (-not $cert) {
  $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject $Subject -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 `
          -CertStoreLocation Cert:\CurrentUser\My -NotAfter (Get-Date).AddYears(2)
}
$cert.Thumbprint

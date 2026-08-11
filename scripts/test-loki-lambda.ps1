param(
  [string]$FunctionName = 'grafana-alert-lambda',
  [string]$StackName = 'grafana-alert-lambda',
  [string]$Region = 'us-east-1',
  [string]$Job = 'example-app',
  [ValidateSet('loki', 'slack-preview', 'history')]
  [string]$Diagnostic = 'loki',
  [int]$Days = 7,
  [string]$WebhookUrl = '',
  [switch]$UseLambdaInvoke,
  [string]$Profile = ''
)

$ErrorActionPreference = 'Stop'

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$DeployDir = Join-Path $Root '.deploy'
$eventFile = Join-Path $DeployDir 'loki-test-event.json'
$responseFile = Join-Path $DeployDir 'loki-test-response.json'

function Get-AwsArgs {
  param([string[]]$BaseArgs)
  if ($Profile) {
    return @('--profile', $Profile) + $BaseArgs
  }
  return $BaseArgs
}

function Get-StackWebhookUrl {
  try {
    $output = & aws @((Get-AwsArgs @(
      'cloudformation', 'describe-stacks',
      '--stack-name', $StackName,
      '--region', $Region,
      '--query', "Stacks[0].Outputs[?OutputKey=='WebhookUrl'].OutputValue",
      '--output', 'text'
    )))
    if ($LASTEXITCODE -eq 0 -and $output.Trim()) {
      return $output.Trim()
    }
  } catch {
    return $null
  }
  return $null
}

function Get-DiagnosticBody {
  if ($Diagnostic -eq 'history') {
    return @{
      diagnostic = $Diagnostic
      days = $Days
    }
  }

  return @{
    diagnostic = $Diagnostic
    job = $Job
    alertname = 'Example Loki Error Alert'
    errorCount = 8
    filename = '/var/lib/docker/containers/example/container.log'
  }
}

function Show-DiagnosticResponse {
  param($Response)

  if ($Response -is [string]) {
    try {
      $Response = $Response | ConvertFrom-Json
    } catch {
      Write-Host $Response
      return
    }
  }

  $inner = $Response
  if ($Response.body) {
    $inner = $Response.body | ConvertFrom-Json
  }

  if ($inner.slackMessage) {
    Write-Host ''
    Write-Host '--- Slack message preview ---' -ForegroundColor Cyan
    Write-Host $inner.slackMessage
    Write-Host '--- End preview ---' -ForegroundColor Cyan
    Write-Host ''
  }

  $inner | ConvertTo-Json -Depth 6

  if ($inner.message -match 'Unsupported alert status') {
    Write-Host ''
    Write-Host 'The deployed Lambda does not include diagnostic mode yet.' -ForegroundColor Yellow
    Write-Host 'Run: npm run deploy' -ForegroundColor Yellow
  }
}

function Invoke-LambdaDiagnostic {
  $payload = @{
    version = '2.0'
    routeKey = 'POST /grafana/webhook'
    rawPath = '/grafana/webhook'
    rawQueryString = ''
    headers = @{
      'content-type' = 'application/json'
    }
    requestContext = @{
      http = @{
        method = 'POST'
        path = '/grafana/webhook'
      }
    }
    isBase64Encoded = $false
    body = (Get-DiagnosticBody | ConvertTo-Json -Compress)
  } | ConvertTo-Json -Depth 6 -Compress

  New-Item -ItemType Directory -Force -Path $DeployDir | Out-Null
  $utf8NoBom = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($eventFile, $payload, $utf8NoBom)

  Write-Host "Invoking Lambda directly: $FunctionName"

  $awsArgs = @(
    'lambda', 'invoke',
    '--function-name', $FunctionName,
    '--region', $Region,
    '--payload', "file://$($eventFile -replace '\\', '/')",
    '--cli-binary-format', 'raw-in-base64-out',
    $responseFile
  )

  & aws @((Get-AwsArgs $awsArgs))
  if ($LASTEXITCODE -ne 0) {
    throw "Lambda invoke failed with exit code $LASTEXITCODE"
  }

  if (-not (Test-Path $responseFile)) {
    throw "Lambda invoke did not create response file: $responseFile"
  }

  Get-Content $responseFile -Raw | ForEach-Object { Show-DiagnosticResponse -Response $_ }

  Write-Host ''
  Write-Host 'CloudWatch logs:'
  Write-Host "  aws logs tail /aws/lambda/$FunctionName --since 5m --region $Region"
}

function Invoke-WebhookDiagnostic {
  param([string]$Url)

  Write-Host "Calling webhook: $Url"
  $body = (Get-DiagnosticBody | ConvertTo-Json -Compress)

  $response = Invoke-RestMethod -Method Post -Uri $Url -ContentType 'application/json' -Body $body
  Show-DiagnosticResponse -Response $response
}

Write-Host "Running $Diagnostic diagnostic from Lambda..."
Write-Host "Job: $Job"

if (-not $WebhookUrl) {
  $WebhookUrl = Get-StackWebhookUrl
  if ($WebhookUrl) {
    Write-Host "Resolved webhook URL from stack: $WebhookUrl"
  }
}

if ($UseLambdaInvoke -or -not $WebhookUrl) {
  Invoke-LambdaDiagnostic
  exit 0
}

try {
  Invoke-WebhookDiagnostic -Url $WebhookUrl
} catch {
  Write-Host ''
  Write-Host "Webhook call failed: $($_.Exception.Message)" -ForegroundColor Yellow
  Write-Host 'Falling back to direct Lambda invoke via AWS CLI...' -ForegroundColor Yellow
  Write-Host ''
  Invoke-LambdaDiagnostic
}

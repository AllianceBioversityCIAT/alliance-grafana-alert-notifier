param(
  [ValidateSet('package', 'stack', 'deploy', 'all')]
  [string]$Action = 'deploy',

  [string]$StackName = 'grafana-alert-lambda',
  [string]$FunctionName = 'grafana-alert-lambda',
  [string]$Region = 'us-east-1',
  [string]$SecretName = '',
  [string]$RoutePath = '/grafana/webhook',
  [ValidateSet('dev', 'test', 'staging', 'prod')]
  [string]$Environment = 'dev',
  [int]$Timeout = 45,
  [int]$MemorySize = 256,
  # Empty by default: the template derives grafana-alert-history-<environment>.
  # Set this only to point a stack at a table name of your own choosing.
  [string]$HistoryTableName = '',
  [string]$ZipPath = '',
  [string]$Profile = '',
  [string]$TemplateFile = '',
  [string]$ParametersFile = ''
)

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

if (-not $TemplateFile) {
  $TemplateFile = Join-Path $Root 'infra/cloudformation/template.yaml'
}

if (-not $ParametersFile) {
  $ParametersFile = Join-Path $Root 'infra/cloudformation/parameters.json'
}

function Get-AwsCliArgs {
  param([string[]]$BaseArgs)
  if ($Profile) {
    return @('--profile', $Profile) + $BaseArgs
  }
  return $BaseArgs
}

function Invoke-Aws {
  param([string[]]$CommandArgs)

  $previousErrorAction = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'

  try {
    $output = & aws @((Get-AwsCliArgs -BaseArgs ($CommandArgs + @('--region', $Region)))) 2>&1
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorAction
  }

  if ($exitCode -ne 0) {
    $message = ($output | Out-String).Trim()
    if (-not $message) {
      $message = "AWS CLI command failed: aws $($CommandArgs -join ' ')"
    }
    throw $message
  }

  if ($output) {
    return ($output | Out-String).Trim()
  }

  return $null
}

function Invoke-AwsJson {
  param([string[]]$CommandArgs)
  $output = Invoke-Aws -CommandArgs $CommandArgs
  if ($output) {
    return $output | ConvertFrom-Json
  }
  return $null
}

function Build-Package {
  Write-Host 'Building and packaging Lambda...'

  # npm writes notices to stderr; with $ErrorActionPreference=Stop that can abort the script.
  $previousErrorAction = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $buildOutput = & npm run package 2>&1
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorAction
  }

  $buildText = ($buildOutput | ForEach-Object { "$_" }) -join [Environment]::NewLine
  if ($exitCode -ne 0) {
    if ($buildText) {
      Write-Host $buildText
    }
    throw 'Package build failed.'
  }

  if ($buildText) {
    Write-Host $buildText
  }

  $resolvedZip = if ($ZipPath) { $ZipPath } else { Join-Path $Root 'grafana-alert-lambda.zip' }
  if (-not (Test-Path $resolvedZip)) {
    throw "Zip file not found: $resolvedZip"
  }

  return (Resolve-Path $resolvedZip).Path
}

function Normalize-ZipPath {
  param([string]$Path)
  return $Path.Trim() -replace '\\', '/'
}

function Show-StackFailureEvents {
  Write-Host ''
  Write-Host 'Recent CloudFormation failure events:' -ForegroundColor Red

  try {
    $events = Invoke-AwsJson @(
      'cloudformation', 'describe-stack-events',
      '--stack-name', $StackName,
      '--max-items', '8'
    )

    foreach ($event in $events) {
      if ($event.ResourceStatus -match 'FAILED') {
        Write-Host ("[{0}] {1}: {2}" -f $event.LogicalResourceId, $event.ResourceStatus, $event.ResourceStatusReason)
      }
    }
  } catch {
    Write-Host 'Could not read stack events. Run:'
    Write-Host "  aws cloudformation describe-stack-events --stack-name $StackName --region $Region"
  }

  Write-Host ''
  Write-Host 'If the stack is in ROLLBACK_COMPLETE, delete it before retrying:'
  Write-Host "  aws cloudformation delete-stack --stack-name $StackName --region $Region"
  Write-Host ''
  Write-Host 'If a previous manual deploy left an orphaned IAM role, delete it first:'
  Write-Host '  aws iam delete-role --role-name grafana-alert-lambda-role'
}

function Get-DefaultSecretName {
  return 'grafana-alert/env'
}

function Get-CurrentLambdaSecretName {
  try {
    $current = Invoke-Aws @(
      'lambda', 'get-function-configuration',
      '--function-name', $FunctionName,
      '--query', 'Environment.Variables.ALERTING_SECRET_NAME',
      '--output', 'text'
    )

    if ($LASTEXITCODE -eq 0 -and $current -and $current.Trim() -and $current.Trim() -ne 'None') {
      return $current.Trim()
    }
  } catch {
    return $null
  }

  return $null
}

function Resolve-SecretName {
  param([switch]$ForStackDeploy)

  if ($SecretName) {
    return $SecretName
  }

  if (-not $ForStackDeploy) {
    $existing = Get-CurrentLambdaSecretName
    if ($existing) {
      Write-Host "Preserving existing Lambda secret name: $existing"
      return $existing
    }
  }

  $default = Get-DefaultSecretName
  Write-Host "Using default secret name: $default"
  return $default
}

function Deploy-Stack {
  $script:SecretName = Resolve-SecretName -ForStackDeploy

  if (-not (Test-Path $TemplateFile)) {
    throw "CloudFormation template not found: $TemplateFile"
  }

  $templatePath = (Resolve-Path $TemplateFile).Path -replace '\\', '/'
  Write-Host "Deploying CloudFormation stack: $StackName"

  $commandArgs = @(
    'cloudformation', 'deploy',
    '--stack-name', $StackName,
    '--template-file', $templatePath,
    '--capabilities', 'CAPABILITY_IAM',
    '--parameter-overrides',
    "SecretName=$SecretName",
    "FunctionName=$FunctionName",
    "RoutePath=$RoutePath",
    "Environment=$Environment",
    "LambdaTimeout=$Timeout",
    "LambdaMemorySize=$MemorySize"
  )

  # Passing an empty override would make the CLI drop the parameter rather than
  # send an empty string, so only send it when the caller chose a name.
  if ($HistoryTableName) {
    $commandArgs += "HistoryTableName=$HistoryTableName"
  }

  $commandArgs += @(
    '--no-fail-on-empty-changeset'
  )

  try {
    Invoke-Aws -CommandArgs $commandArgs | Out-Null
  } catch {
    Show-StackFailureEvents
    throw
  }

  $outputs = Invoke-AwsJson @(
    'cloudformation', 'describe-stacks',
    '--stack-name', $StackName,
    '--query', 'Stacks[0].Outputs'
  )

  Write-Host ''
  Write-Host 'CloudFormation stack deployed successfully.'
  foreach ($output in $outputs) {
    Write-Host ("  {0}: {1}" -f $output.OutputKey, $output.OutputValue)
  }
}

function Wait-LambdaUpdated {
  Write-Host "Waiting for Lambda update to finish: $FunctionName"
  Invoke-Aws @(
    'lambda', 'wait', 'function-updated',
    '--function-name', $FunctionName
  ) | Out-Null
}

function Build-LambdaEnvironmentArgument {
  return "Variables={ALERTING_SECRET_NAME=$SecretName}"
}

function Invoke-LambdaConfigurationUpdate {
  $maxAttempts = 6
  $delaySeconds = 5
  $environment = Build-LambdaEnvironmentArgument

  for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
    try {
      Invoke-Aws @(
        'lambda', 'update-function-configuration',
        '--function-name', $FunctionName,
        '--runtime', 'nodejs20.x',
        '--handler', 'dist/handler.handler',
        '--timeout', "$Timeout",
        '--memory-size', "$MemorySize",
        '--environment', $environment
      ) | Out-Null
      return
    } catch {
      $errorText = if ($_.Exception) { $_.Exception.Message } else { "$_" }
      if ($errorText -notmatch 'ResourceConflictException' -or $attempt -eq $maxAttempts) {
        throw
      }

      Write-Host "Lambda is still updating. Retrying configuration in $delaySeconds seconds ($attempt/$maxAttempts)..."
      Start-Sleep -Seconds $delaySeconds
      Wait-LambdaUpdated
    }
  }
}

function Deploy-LambdaCode {
  param([string]$ZipFile)

  $zipPath = Normalize-ZipPath -Path $ZipFile
  Write-Host "Uploading Lambda code: $FunctionName"
  Write-Host "Zip file: $zipPath"

  Invoke-Aws @(
    'lambda', 'update-function-code',
    '--function-name', $FunctionName,
    '--zip-file', "fileb://$zipPath"
  ) | Out-Null

  Wait-LambdaUpdated

  $script:SecretName = Resolve-SecretName

  Write-Host 'Updating Lambda configuration...'
  Invoke-LambdaConfigurationUpdate

  Write-Host "Lambda code deployed: $FunctionName"
}

function Show-WebhookUrl {
  try {
    $outputs = Invoke-AwsJson @(
      'cloudformation', 'describe-stacks',
      '--stack-name', $StackName,
      '--query', 'Stacks[0].Outputs'
    )

    $webhook = $outputs | Where-Object { $_.OutputKey -eq 'WebhookUrl' } | Select-Object -First 1
    if ($webhook) {
      Write-Host ''
      Write-Host "Grafana webhook URL: $($webhook.OutputValue)"
    }
  } catch {
    Write-Host 'Stack outputs not available yet. Deploy the stack first with npm run deploy:stack.'
  }
}

switch ($Action) {
  'package' {
    $zip = Build-Package
    Write-Host "Package created: $zip"
  }
  'stack' {
    Deploy-Stack
  }
  'deploy' {
    $zip = Build-Package
    Deploy-LambdaCode -ZipFile $zip
    Show-WebhookUrl
  }
  'all' {
    Deploy-Stack
    $zip = Build-Package
    Deploy-LambdaCode -ZipFile $zip
    Show-WebhookUrl
  }
}

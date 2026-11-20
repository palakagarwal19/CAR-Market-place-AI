[CmdletBinding()]
param(
  [string]$Region = "ap-south-1",
  [string]$StackName = "vehiql-marketplace",
  [ValidateSet("t8i.micro", "t8i.small")]
  [string]$AppInstanceType = "t8i.micro"
)

$ErrorActionPreference = "Stop"
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$templatePath = Join-Path $PSScriptRoot "aws-stack.yaml"
$tempFiles = [System.Collections.Generic.List[string]]::new()

function Invoke-Aws {
  param(
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [switch]$AllowFailure
  )

  try {
    $result = & aws --no-cli-pager @Arguments 2>&1
    $exitCode = $LASTEXITCODE
  }
  catch {
    $result = $_.ToString()
    $exitCode = if ($LASTEXITCODE -ne 0) { $LASTEXITCODE } else { 1 }
  }
  if ($exitCode -ne 0) {
    if ($AllowFailure) {
      return $null
    }
    $details = ($result | Out-String).Trim()
    throw "AWS CLI operation '$($Arguments[0]) $($Arguments[1])' failed. $details"
  }
  return $result
}

function Get-StackOutputs {
  param([string]$Name, [string]$AwsRegion)

  $json = (Invoke-Aws -Arguments @(
    "cloudformation", "describe-stacks", "--stack-name", $Name,
    "--region", $AwsRegion, "--query", "Stacks[0].Outputs", "--output", "json"
  )) -join "`n"
  $outputs = @{}
  foreach ($item in (ConvertFrom-Json -InputObject $json)) {
    $outputs[$item.OutputKey] = $item.OutputValue
  }
  return $outputs
}

function Set-SecureParameter {
  param(
    [string]$Name,
    [string]$Value,
    [string]$Description,
    [string]$AwsRegion
  )

  $inputPath = Join-Path $env:TEMP ("vehiql-parameter-" + [guid]::NewGuid().ToString("N") + ".json")
  $tempFiles.Add($inputPath)
  $request = @{
    Name        = $Name
    Value       = $Value
    Type        = "SecureString"
    Description = $Description
    Overwrite   = $true
  } | ConvertTo-Json
  [System.IO.File]::WriteAllText(
    $inputPath,
    $request,
    [System.Text.UTF8Encoding]::new($false)
  )
  Invoke-Aws -Arguments @(
    "ssm", "put-parameter", "--cli-input-json", "file://$inputPath",
    "--region", $AwsRegion
  ) | Out-Null
}

function New-DeploymentArchive {
  param([string]$Root, [string]$Destination)

  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $files = & git -C $Root ls-files --cached --others --exclude-standard
  if ($LASTEXITCODE -ne 0) {
    throw "Could not enumerate repository files for deployment."
  }

  $archive = [System.IO.Compression.ZipFile]::Open(
    $Destination,
    [System.IO.Compression.ZipArchiveMode]::Create
  )
  try {
    foreach ($relativePath in $files) {
      $normalizedPath = $relativePath.Replace("\", "/")
      $fileName = [System.IO.Path]::GetFileName($normalizedPath)
      if (($fileName -like ".env*" -and $fileName -ne ".env.example") -or
        $normalizedPath -match "^public/cars/") {
        continue
      }

      $fullPath = Join-Path $Root $normalizedPath
      if (Test-Path -LiteralPath $fullPath -PathType Leaf) {
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
          $archive,
          $fullPath,
          $normalizedPath,
          [System.IO.Compression.CompressionLevel]::Optimal
        ) | Out-Null
      }
    }
  }
  finally {
    $archive.Dispose()
  }
}

try {
  if (-not (Get-Command aws -ErrorAction SilentlyContinue)) {
    throw "Install and configure the AWS CLI before deploying."
  }
  if (-not (Test-Path -LiteralPath (Join-Path $repositoryRoot ".env"))) {
    throw "The local .env file is required to copy the existing database."
  }
  if (-not (Test-Path -LiteralPath $templatePath)) {
    throw "CloudFormation template not found: $templatePath"
  }

  & node "--env-file=$(Join-Path $repositoryRoot '.env')" -e `
    'if (!process.env.DATABASE_URL) process.exit(1)'
  if ($LASTEXITCODE -ne 0) {
    throw "The local .env file must contain DATABASE_URL."
  }

  $sourceDatabaseUrl = & node "--env-file=$(Join-Path $repositoryRoot '.env')" -e `
    'process.stdout.write(process.env.DATABASE_URL || String())'
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($sourceDatabaseUrl)) {
    throw "Could not read the source DATABASE_URL from the local .env file."
  }

  $accountId = (Invoke-Aws -Arguments @(
    "sts", "get-caller-identity", "--query", "Account", "--output", "text"
  )).Trim()
  $existingStack = (Invoke-Aws -Arguments @(
    "cloudformation", "list-stacks", "--region", $Region,
    "--query", "StackSummaries[?StackName=='$StackName' && StackStatus!='DELETE_COMPLETE'].StackStatus | [0]",
    "--output", "text"
  )).Trim()
  if ($existingStack -eq "ROLLBACK_COMPLETE") {
    Write-Host "Removing the rolled-back application-only stack before retrying."
    Invoke-Aws -Arguments @(
      "cloudformation", "delete-stack", "--stack-name", $StackName, "--region", $Region
    ) | Out-Null
    Invoke-Aws -Arguments @(
      "cloudformation", "wait", "stack-delete-complete",
      "--stack-name", $StackName, "--region", $Region
    ) | Out-Null
    $existingStack = "None"
  }
  if (-not [string]::IsNullOrWhiteSpace($existingStack) -and $existingStack -ne "None") {
    throw "CloudFormation stack '$StackName' already exists with status '$existingStack'; refusing to overwrite it."
  }

  $vpcId = (Invoke-Aws -Arguments @(
    "ec2", "describe-vpcs", "--filters", "Name=isDefault,Values=true",
    "--region", $Region, "--query", "Vpcs[0].VpcId", "--output", "text"
  )).Trim()
  if ([string]::IsNullOrWhiteSpace($vpcId) -or $vpcId -eq "None") {
    throw "No default VPC was found in $Region."
  }

  $appSubnetId = $null
  foreach ($zone in @("${Region}c", "${Region}a", "${Region}b")) {
    $candidateSubnet = (Invoke-Aws -Arguments @(
      "ec2", "describe-subnets", "--filters", "Name=vpc-id,Values=$vpcId",
      "--region", $Region, "--query",
      "Subnets[?AvailabilityZone=='$zone'].SubnetId | [0]", "--output", "text"
    )).Trim()
    if (-not [string]::IsNullOrWhiteSpace($candidateSubnet) -and $candidateSubnet -ne "None") {
      $appSubnetId = $candidateSubnet
      break
    }
  }
  if ([string]::IsNullOrWhiteSpace($appSubnetId) -or $appSubnetId -eq "None") {
    throw "No application subnet was found in the VPC."
  }

  $bucketName = "vehiql-$accountId-$Region"
  Invoke-Aws -Arguments @(
    "s3api", "head-bucket", "--bucket", $bucketName, "--region", $Region
  ) | Out-Null

  $databaseStatus = (Invoke-Aws -Arguments @(
    "rds", "describe-db-instances", "--db-instance-identifier", "vehiql-postgres",
    "--region", $Region, "--query", "DBInstances[0].DBInstanceStatus", "--output", "text"
  )).Trim()
  if ($databaseStatus -ne "available") {
    throw "The restored RDS instance is not available."
  }
  $databaseEndpoint = (Invoke-Aws -Arguments @(
    "rds", "describe-db-instances", "--db-instance-identifier", "vehiql-postgres",
    "--region", $Region, "--query", "DBInstances[0].Endpoint.Address", "--output", "text"
  )).Trim()
  $databaseSecurityGroupId = (Invoke-Aws -Arguments @(
    "rds", "describe-db-instances", "--db-instance-identifier", "vehiql-postgres",
    "--region", $Region, "--query", "DBInstances[0].VpcSecurityGroups[0].VpcSecurityGroupId",
    "--output", "text"
  )).Trim()
  $databaseVpcId = (Invoke-Aws -Arguments @(
    "ec2", "describe-security-groups", "--group-ids", $databaseSecurityGroupId,
    "--region", $Region, "--query", "SecurityGroups[0].VpcId", "--output", "text"
  )).Trim()
  if ($databaseVpcId -ne $vpcId) {
    throw "The restored database is not in the default VPC."
  }
  $databaseCredentialsJson = Invoke-Aws -Arguments @(
    "ssm", "get-parameter", "--name", "/vehiql/restored-db-credentials",
    "--with-decryption", "--region", $Region,
    "--query", "Parameter.Value", "--output", "text"
  )
  $databaseSecret = ConvertFrom-Json -InputObject ($databaseCredentialsJson -join "`n")
  if ($databaseSecret.host -ne $databaseEndpoint -or
    [string]::IsNullOrWhiteSpace($databaseSecurityGroupId)) {
    throw "The encrypted RDS credentials do not match the restored database."
  }

  $commonParameters = @(
    "VpcId=$vpcId",
    "AppSubnetId=$appSubnetId",
    "ExistingImageBucketName=$bucketName",
    "ExistingDatabaseSecurityGroupId=$databaseSecurityGroupId",
    "ExistingDatabaseEndpoint=$databaseEndpoint",
    "AppInstanceType=$AppInstanceType"
  )
  Write-Host "Creating AWS stack '$StackName' in $Region."
  Invoke-Aws -Arguments (@(
    "cloudformation", "deploy", "--template-file", $templatePath,
    "--stack-name", $StackName, "--capabilities", "CAPABILITY_NAMED_IAM",
    "--region", $Region, "--no-fail-on-empty-changeset",
    "--parameter-overrides"
  ) + $commonParameters) | Out-Null

  $outputs = Get-StackOutputs -Name $StackName -AwsRegion $Region
  $applicationUrl = $outputs.ApplicationUrl.TrimEnd("/")

  $databaseUser = [uri]::EscapeDataString([string]$databaseSecret.username)
  $databasePassword = [uri]::EscapeDataString([string]$databaseSecret.password)
  $databaseName = [uri]::EscapeDataString([string]$databaseSecret.dbname)
  $databaseUrl = "postgresql://${databaseUser}:${databasePassword}@$($databaseSecret.host):$($databaseSecret.port)/$databaseName?sslmode=require"
  $authSecret = (& node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))").Trim()
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($authSecret)) {
    throw "Could not generate the application auth secret."
  }
  $demoEmail = "demo-$([guid]::NewGuid().ToString('N').Substring(0, 8))@example.test"
  $demoPassword = (& node -e "process.stdout.write(require('crypto').randomBytes(24).toString('base64url'))").Trim()
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($demoPassword)) {
    throw "Could not generate the temporary demo login password."
  }

  $appEnvironment = @(
    "DATABASE_URL=$databaseUrl"
    "DIRECT_URL=$databaseUrl"
    "AWS_REGION=$Region"
    "S3_BUCKET=$($outputs.ImageBucketName)"
    "NEXT_PUBLIC_S3_BUCKET=$($outputs.ImageBucketName)"
    "AUTH_SECRET=$authSecret"
    "AUTH_URL=$applicationUrl"
    "AUTH_TRUST_HOST=true"
    "DEMO_LOGIN_EMAIL=$demoEmail"
    "DEMO_LOGIN_PASSWORD=$demoPassword"
    "BEDROCK_MODEL_ID=amazon.nova-lite-v1:0"
  ) -join "`n"

  Set-SecureParameter -Name "/vehiql/app-env" -Value $appEnvironment `
    -Description "Vehiql application environment" -AwsRegion $Region
  Set-SecureParameter -Name "/vehiql/source-database-url" -Value $sourceDatabaseUrl `
    -Description "Temporary source URL for the guarded one-time migration" -AwsRegion $Region

  $carsPath = Join-Path $repositoryRoot "public\cars"
  Write-Host "Copying existing car images to the private S3 bucket."
  Invoke-Aws -Arguments @(
    "s3", "sync", $carsPath, "s3://$bucketName/cars",
    "--region", $Region, "--only-show-errors"
  ) | Out-Null

  $archivePath = Join-Path $env:TEMP ("vehiql-deploy-" + [guid]::NewGuid().ToString("N") + ".zip")
  $tempFiles.Add($archivePath)
  New-DeploymentArchive -Root $repositoryRoot -Destination $archivePath
  $artifactKey = "deploy/$([guid]::NewGuid().ToString('N')).zip"
  Invoke-Aws -Arguments @(
    "s3", "cp", $archivePath, "s3://$bucketName/$artifactKey",
    "--region", $Region, "--only-show-errors"
  ) | Out-Null

  $instanceId = $outputs.ApplicationInstanceId
  Write-Host "Waiting for the Ubuntu instance to register with Systems Manager."
  $instanceOnline = $false
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    $pingStatus = Invoke-Aws -AllowFailure -Arguments @(
      "ssm", "describe-instance-information",
      "--filters", "Key=InstanceIds,Values=$instanceId", "--region", $Region,
      "--query", "InstanceInformationList[0].PingStatus", "--output", "text"
    )
    if ($pingStatus -eq "Online") {
      $instanceOnline = $true
      break
    }
    Start-Sleep -Seconds 15
  }
  if (-not $instanceOnline) {
    throw "The Ubuntu instance did not become available in Systems Manager."
  }

  $commands = @(
    "set -eu",
    "cloud-init status --wait",
    "export AWS_DEFAULT_REGION='$Region'",
    "mkdir -p /opt/vehiql /etc/vehiql",
    "aws s3 cp 's3://$bucketName/$artifactKey' /tmp/vehiql-deploy.zip --only-show-errors",
    "unzip -o -q /tmp/vehiql-deploy.zip -d /opt/vehiql",
    "aws ssm get-parameter --name /vehiql/app-env --with-decryption --query Parameter.Value --output text > /etc/vehiql/app.env",
    "chmod 640 /etc/vehiql/app.env",
    "chown root:ubuntu /etc/vehiql/app.env",
    "aws ssm get-parameter --name /vehiql/source-database-url --with-decryption --query Parameter.Value --output text > /etc/vehiql/source-db-url",
    "chmod 600 /etc/vehiql/source-db-url",
    "chown ubuntu:ubuntu /etc/vehiql/source-db-url",
    "chown -R ubuntu:ubuntu /opt/vehiql",
    "runuser -u ubuntu -- bash -c 'set -eu; export PATH=/snap/bin:`$PATH; set -a; . /etc/vehiql/app.env; set +a; cd /opt/vehiql; npm ci; npx prisma generate; npx prisma migrate deploy; export SOURCE_DATABASE_URL=`"`$(cat /etc/vehiql/source-db-url)`"; export TARGET_DATABASE_URL=`"`$DATABASE_URL`"; npm run migrate:aws; npm run build'",
    "rm -f /etc/vehiql/source-db-url",
    "systemctl enable --now vehiql",
    "for attempt in `$(seq 1 36); do if curl -fsS http://127.0.0.1:3000/api/auth/providers >/dev/null; then exit 0; fi; sleep 5; done; exit 1"
  )
  $commandPath = Join-Path $env:TEMP ("vehiql-command-" + [guid]::NewGuid().ToString("N") + ".json")
  $tempFiles.Add($commandPath)
  $commandRequest = @{
    InstanceIds  = @($instanceId)
    DocumentName = "AWS-RunShellScript"
    Comment      = "Install Vehiql, copy and verify existing data, then start the application"
    Parameters   = @{ commands = $commands }
  } | ConvertTo-Json -Depth 5
  [System.IO.File]::WriteAllText(
    $commandPath,
    $commandRequest,
    [System.Text.UTF8Encoding]::new($false)
  )
  $commandId = (Invoke-Aws -Arguments @(
    "ssm", "send-command", "--cli-input-json", "file://$commandPath",
    "--region", $Region, "--query", "Command.CommandId", "--output", "text"
  )).Trim()
  Write-Host "Installing the app and migrating data through Systems Manager."

  $commandStatus = "InProgress"
  for ($attempt = 0; $attempt -lt 120; $attempt++) {
    Start-Sleep -Seconds 15
    $commandStatus = Invoke-Aws -AllowFailure -Arguments @(
      "ssm", "get-command-invocation", "--command-id", $commandId,
      "--instance-id", $instanceId, "--region", $Region,
      "--query", "Status", "--output", "text"
    )
    if ($commandStatus -and $commandStatus -notin @("InProgress", "Pending", "Delayed")) {
      break
    }
  }
  if ($commandStatus -ne "Success") {
    $details = Invoke-Aws -AllowFailure -Arguments @(
      "ssm", "get-command-invocation", "--command-id", $commandId,
      "--instance-id", $instanceId, "--region", $Region,
      "--query", "StandardErrorContent", "--output", "text"
    )
    throw "EC2 deployment failed with status '$commandStatus'. $details"
  }

  $response = Invoke-WebRequest -Uri $applicationUrl -UseBasicParsing -TimeoutSec 30
  if ($response.StatusCode -lt 200 -or $response.StatusCode -ge 400) {
    throw "The deployed site returned HTTP $($response.StatusCode)."
  }
  Invoke-Aws -Arguments @(
    "ssm", "delete-parameter", "--name", "/vehiql/source-database-url",
    "--region", $Region
  ) | Out-Null
  Write-Host "Deployment succeeded: $applicationUrl"
  Write-Host "Temporary demo email: $demoEmail"
  Write-Host "Temporary demo password: $demoPassword"
  Write-Warning "HTTP is unencrypted; use these disposable credentials only."
}
finally {
  foreach ($path in $tempFiles) {
    if (Test-Path -LiteralPath $path) {
      Remove-Item -LiteralPath $path -Force
    }
  }
}

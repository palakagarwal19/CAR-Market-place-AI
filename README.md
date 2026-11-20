# Vehiql AI Car Marketplace

Vehiql is a Next.js car marketplace. Users can browse listings, save cars, and
book test drives. The admin area manages listings and marketplace settings.
Amazon Bedrock provides image analysis for car listings.

## AWS services and what they do

| AWS service | How this project uses it |
| --- | --- |
| **Amazon EC2** | Runs the production Next.js app on Ubuntu 24.04, instance type `t8i.micro`. A static Elastic IP provides the public address. |
| **Amazon RDS for PostgreSQL** | Stores users, cars, favorites, dealership details, working hours, and test-drive bookings. The database is private and is reused rather than recreated by the app stack. |
| **Amazon S3** | Stores car images in the existing private bucket. The bucket is not made public. |
| **Amazon Bedrock** | Analyzes uploaded car images with model `amazon.nova-lite-v1:0`. |
| **AWS Systems Manager (SSM)** | Uses Run Command to install and operate the app without opening SSH. Parameter Store holds encrypted app settings and the one-time source database URL. |
| **AWS Identity and Access Management (IAM)** | Gives the EC2 instance a role with limited access to the app's S3 objects, SSM settings, and Bedrock. No static AWS keys are installed on EC2. |
| **AWS CloudFormation** | Creates the app-only stack: EC2, Elastic IP, IAM role/profile, app security group, and the RDS ingress rule for the app. |
| **Amazon Virtual Private Cloud (VPC)** | Keeps EC2 and the private RDS instance in the same VPC. The security group permits PostgreSQL traffic from the app security group only. |

### Services intentionally not used

- **CloudFront is not part of this deployment.** The app is served directly over
  HTTP on port `3000`.
- The existing **Cognito user pool is left untouched but unused**. This demo
  uses a single generated Auth.js credentials account because Cognito's hosted
  OAuth flow requires an HTTPS callback.

The main runtime services are EC2, RDS, S3, Bedrock, and Systems Manager. IAM,
CloudFormation, and VPC are used to authorize and provision them.

## Request and data flow

1. A browser opens the EC2 Elastic IP on port `3000`.
2. Next.js reads and writes marketplace records in the private RDS database.
3. Uploaded images are written to S3. For image display, the app's
   `/api/images/...` route reads from the private bucket using the EC2 role.
4. Image-analysis requests go from the app to Amazon Bedrock.
5. Systems Manager supplies runtime configuration and sends deployment commands
   to EC2.

The RDS endpoint is not exposed to the internet. Only the app security group is
allowed to connect to its PostgreSQL port.

## HTTP demo login and security

This is a temporary course-project setup. The deployment script creates one
random demo email and password and prints them after a successful deployment.
The sign-in and sign-up pages both use this shared demo account; self-service
registration is disabled. The account has normal user permissions, not admin
permissions.

**HTTP does not encrypt passwords, session cookies, or other traffic.** Anyone
able to observe the network could capture or alter it. Use only the generated
disposable credentials; never use a real or reused password. Do not use this
configuration for production. A production deployment needs HTTPS and a
production identity provider.

## Prerequisites

- Windows PowerShell, Git, Node.js 22, and the AWS CLI.
- AWS CLI credentials for the account and `ap-south-1` region. The identity
  needs CloudFormation permissions plus permissions for the EC2, IAM, SSM,
  RDS, and S3 operations performed by the script.
- The existing private RDS instance `vehiql-postgres` and its SecureString
  parameter `/vehiql/restored-db-credentials`.
- The existing private S3 bucket named `vehiql-<account-id>-ap-south-1`.
- A local `.env` file containing the **source** `DATABASE_URL`. The deployment
  script reads it but does not overwrite it.
- Amazon Bedrock model access enabled in `ap-south-1`.

Check which AWS identity the CLI will use:

```powershell
aws sts get-caller-identity
```

CloudFront account verification is not needed for this HTTP deployment.
CloudFormation is still used to create the app stack; it is separate from
CloudFront.

## Deploy to AWS

From the repository root, run:

```powershell
.\infra\deploy-aws.ps1 -AppInstanceType t8i.micro
```

The script performs these steps:

1. Checks the source database URL, account, VPC/subnet, RDS, S3 bucket, and
   encrypted RDS credentials.
2. Creates the `vehiql-marketplace` CloudFormation stack. It selects a Mumbai
   subnet and creates the EC2 instance, Elastic IP, IAM role, security groups,
   and database ingress.
3. Opens TCP port `3000` to the internet for the HTTP demo. The Next.js app
   listens directly on that port.
4. Stores app configuration as the encrypted SSM parameter
   `/vehiql/app-env`, syncs `public/cars` to the private S3 bucket, and uploads
   the application archive to S3.
5. Uses SSM Run Command to install dependencies on Ubuntu, apply Prisma
   migrations, copy and verify database records, build the app, and start its
   systemd service.
6. Checks the public HTTP endpoint, deletes the temporary
   `/vehiql/source-database-url` parameter, and prints the demo login.

The application URL and EC2 instance ID are also CloudFormation stack outputs.
The deployment script does not create, replace, or delete the RDS instance or
the image bucket. It leaves the local source `.env` unchanged.

## Database and image migration

The deployment runs Prisma migrations and then
`scripts/migrate-data-to-aws.mjs` from EC2, which can reach the private RDS
instance. The copy script:

- refuses to copy when source and target resolve to the same database;
- refuses to overwrite a non-empty target;
- copies Prisma-managed records in a transaction; and
- verifies both row counts and record contents after copying.

If the target database is non-empty or verification fails, deployment stops.
Do not empty or reset the target to work around that guard; inspect and back up
both databases first. Keep the source database unchanged until the AWS copy and
deployed app have been checked.

The deployment syncs files from `public/cars` to the S3 `cars/` prefix. Existing
`/cars/...` image paths are routed through `/api/images/...`; new uploads are
stored in S3 and also displayed through this API route. The bucket remains
private, and the app role can access only its `cars/` and `deploy/` object
prefixes.

## Configuration and local development

Copy `.env.example` to `.env.local` for local work and fill in the required
values. Do not commit credentials. Local AWS SDK calls use the AWS CLI
credential chain; on EC2, the instance role provides permissions instead of
static keys.

Install dependencies and start the development server:

```powershell
npm install
npx prisma generate
npm run dev
```

The app's AWS settings include `AWS_REGION`, `S3_BUCKET`, `AUTH_SECRET`,
`AUTH_URL`, `DEMO_LOGIN_EMAIL`, `DEMO_LOGIN_PASSWORD`, and
`BEDROCK_MODEL_ID`. On EC2, the values are read from `/vehiql/app-env`; avoid
printing the entire SecureString because it also contains database credentials.

The default Bedrock model is `amazon.nova-lite-v1:0`. It can be changed with
`BEDROCK_MODEL_ID`, provided the model is enabled in the selected region.

## Monitoring, costs, and cleanup

The demo has public HTTP access and can incur charges. Review EC2 hours, the
16-GiB EBS volume, the Elastic IP/public IPv4, RDS, S3 storage/requests, and
Bedrock usage. Free-tier eligibility does not guarantee a zero bill; budget
alerts are notifications, not a spending cap.

Useful checks:

```powershell
aws cloudformation describe-stacks --stack-name vehiql-marketplace --region ap-south-1
aws ssm describe-instance-information --region ap-south-1
```

Deleting the `vehiql-marketplace` stack terminates the app EC2 instance and
releases its Elastic IP, IAM role/profile, and app security group. It removes
the database ingress rule created for that app. It does **not** delete the
existing RDS instance, S3 bucket, or Cognito pool. Those retained services can
continue to incur charges and must be managed separately.

## Course-team AWS access

`infra/team-access.yaml` provisions four **IAM Identity Center permission sets**
for individual team members. These are AWS-console/CLI permissions, not
marketplace login accounts, and they are not long-lived IAM users or access
keys. The template creates permission sets only; an administrator must create
or invite each person's Identity Center identity and assign one permission set
to that person in the AWS console.

| Permission set | Suggested presentation contribution | AWS access |
| --- | --- | --- |
| `vehiql-dev1-infrastructure` | EC2, VPC, Elastic IP, security groups, CloudFormation | Inspect compute/network resources and the app stack; start, stop, or reboot only the app instance. No network or stack changes. |
| `vehiql-dev2-database` | RDS, S3, database connectivity | View RDS/network metadata; list, read, and upload objects under `cars/`. No database login or credentials. |
| `vehiql-dev3-ai` | Bedrock, S3, Parameter Store | Invoke `amazon.nova-lite-v1:0`, access `cars/` images, and inspect Parameter Store metadata. Parameter values remain inaccessible. |
| `vehiql-dev4-operations` | SSM, CloudWatch, CloudFormation, scoped IAM | View SSM instance status, CloudWatch metrics/alarms, the app stack, and the app role's IAM policies. No shell, stack updates, or IAM changes. |

These are deliberately limited to safe read/operate actions. The existing
database uses a stored password, not IAM database authentication; granting
database credentials would expose sensitive data. The SSM parameters contain
the database URL and Auth.js secrets, so Dev 3 can inspect parameter metadata
but cannot read or change values. Dev 1 and Dev 4 cannot deploy or update
CloudFormation. Use an administrator for deployments and sensitive maintenance;
do not broaden these policies with `iam:*`, unrestricted `iam:PassRole`, SSM
shell/command access, or access to secret parameter values.

Before provisioning, enable IAM Identity Center for the AWS account. The
currently configured CLI identity was the account root user, and the account
did not yet have an Identity Center instance. Do not use root for routine
administration; reauthenticate with a dedicated administrator identity that is
authorized to manage CloudFormation and IAM Identity Center. The template
expects the Identity Center instance ARN, current app stack's image bucket,
and EC2 instance ID:

```powershell
$identityCenterArn = aws sso-admin list-instances --region ap-south-1 --query "Instances[0].InstanceArn" --output text
$appStack = aws cloudformation describe-stacks --stack-name vehiql-marketplace --region ap-south-1 --output json | ConvertFrom-Json
$bucketName = ($appStack.Stacks[0].Outputs | Where-Object OutputKey -eq "ImageBucketName").OutputValue
$instanceId = ($appStack.Stacks[0].Outputs | Where-Object OutputKey -eq "ApplicationInstanceId").OutputValue

aws cloudformation deploy `
  --template-file .\infra\team-access.yaml `
  --stack-name vehiql-team-access `
  --region ap-south-1 `
  --parameter-overrides "IdentityCenterInstanceArn=$identityCenterArn" "ExistingImageBucketName=$bucketName" "ApplicationInstanceId=$instanceId"
```

Then in **IAM Identity Center → Users**, add/invite the four team members
(including your own identity). In **AWS accounts → Assign users or groups**,
choose the AWS account and assign one matching permission set per person.
Enable MFA for all members. Do not send passwords, access keys, or the database
URL in chat.

To remove these permissions later, first remove the four account assignments
in IAM Identity Center, then delete the `vehiql-team-access` CloudFormation
stack. This access stack does not own or modify the marketplace's EC2, RDS, or
S3 resources.

## Demo listings and image attribution

The Kaggle image dataset has attribution and licensing information in
`public/cars/demo-kaggle/ATTRIBUTION.txt`. After adding the licensed images,
import the repeatable demo records with:

```powershell
node --env-file=.env prisma/seed-demo-cars.mjs
```

These are illustrative test listings, not verified vehicles for sale.

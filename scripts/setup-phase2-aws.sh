#!/bin/bash
# ============================================================
# Phase 2 AWS Setup Script
# Sets up: Lambda, S3, CloudWatch Subscription Filter, SNS, Filebeat
# Run: bash setup-phase2-aws.sh your@email.com +91XXXXXXXXXX
# ============================================================
set -e

EMAIL=${1:-"you@example.com"}
PHONE=${2:-""}         # E.164 format: +91XXXXXXXXXX
REGION="us-east-1"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
LAMBDA_ROLE="arn:aws:iam::${ACCOUNT_ID}:role/lambda-log-processor"
S3_BUCKET="log-monitor-processed-${ACCOUNT_ID}"
SNS_TOPIC="log-monitor-alerts"
LOG_GROUP="/log-monitor/app"

echo "=============================="
echo " Phase 2 AWS Infrastructure"
echo "=============================="
echo "Account : $ACCOUNT_ID | Region: $REGION"
echo ""

# ── 1. S3 bucket for processed logs ──────────────────────────────────────
echo "[1/7] Creating S3 bucket: $S3_BUCKET"
aws s3api create-bucket \
  --bucket "$S3_BUCKET" \
  --region "$REGION" \
  --create-bucket-configuration LocationConstraint="$REGION" 2>/dev/null || echo "   Bucket exists"

aws s3api put-bucket-lifecycle-configuration \
  --bucket "$S3_BUCKET" \
  --lifecycle-configuration '{
    "Rules": [{
      "Id": "ExpireOldLogs",
      "Status": "Enabled",
      "Filter": {"Prefix": "logs/"},
      "Expiration": {"Days": 90}
    }]
  }'
echo "   ✅ S3 bucket ready with 90-day lifecycle"

# ── 2. IAM role for Lambda ───────────────────────────────────────────────
echo "[2/7] Creating Lambda IAM role..."
aws iam create-role \
  --role-name lambda-log-processor \
  --assume-role-policy-document '{
    "Version":"2012-10-17",
    "Statement":[{
      "Effect":"Allow",
      "Principal":{"Service":"lambda.amazonaws.com"},
      "Action":"sts:AssumeRole"
    }]
  }' 2>/dev/null || echo "   Role exists"

aws iam attach-role-policy \
  --role-name lambda-log-processor \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole

aws iam put-role-policy \
  --role-name lambda-log-processor \
  --policy-name LogProcessorPolicy \
  --policy-document "{
    \"Version\":\"2012-10-17\",
    \"Statement\":[
      {\"Effect\":\"Allow\",\"Action\":[\"s3:PutObject\"],\"Resource\":\"arn:aws:s3:::${S3_BUCKET}/*\"},
      {\"Effect\":\"Allow\",\"Action\":[\"sns:Publish\"],\"Resource\":\"*\"},
      {\"Effect\":\"Allow\",\"Action\":[\"logs:CreateLogGroup\",\"logs:CreateLogStream\",\"logs:PutLogEvents\"],\"Resource\":\"*\"}
    ]
  }"
echo "   ✅ IAM role configured"
sleep 5  # role propagation

# ── 3. Deploy Lambda function ────────────────────────────────────────────
echo "[3/7] Deploying Lambda function..."
cd lambda/
npm install --production 2>/dev/null || true
zip -r lambda.zip index.js node_modules/ 2>/dev/null

SNS_ARN="arn:aws:sns:${REGION}:${ACCOUNT_ID}:${SNS_TOPIC}"

aws lambda create-function \
  --function-name log-processor \
  --runtime nodejs20.x \
  --handler index.handler \
  --role "$LAMBDA_ROLE" \
  --zip-file fileb://lambda.zip \
  --timeout 30 \
  --memory-size 256 \
  --environment "Variables={SNS_TOPIC_ARN=${SNS_ARN},S3_BUCKET=${S3_BUCKET},ERROR_LIMIT=5}" \
  --region "$REGION" 2>/dev/null || \
aws lambda update-function-code \
  --function-name log-processor \
  --zip-file fileb://lambda.zip \
  --region "$REGION"

LAMBDA_ARN=$(aws lambda get-function \
  --function-name log-processor \
  --query 'Configuration.FunctionArn' --output text)
echo "   ✅ Lambda ARN: $LAMBDA_ARN"

# ── 4. SNS topic + subscriptions ─────────────────────────────────────────
echo "[4/7] Setting up SNS..."
TOPIC_ARN=$(aws sns create-topic \
  --name "$SNS_TOPIC" \
  --region "$REGION" \
  --query TopicArn --output text)

aws sns subscribe --topic-arn "$TOPIC_ARN" --protocol email \
  --notification-endpoint "$EMAIL" --region "$REGION"
echo "   ✉️  Email subscription → $EMAIL"

if [ -n "$PHONE" ]; then
  aws sns subscribe --topic-arn "$TOPIC_ARN" --protocol sms \
    --notification-endpoint "$PHONE" --region "$REGION"
  echo "   📱 SMS subscription → $PHONE"
fi

# ── 5. CloudWatch log group + subscription filter → Lambda ───────────────
echo "[5/7] Wiring CloudWatch → Lambda..."
aws logs create-log-group --log-group-name "$LOG_GROUP" --region "$REGION" 2>/dev/null || true
aws logs put-retention-policy --log-group-name "$LOG_GROUP" \
  --retention-in-days 30 --region "$REGION"

aws lambda add-permission \
  --function-name log-processor \
  --statement-id AllowCWLogs \
  --action lambda:InvokeFunction \
  --principal logs.amazonaws.com \
  --source-arn "arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:${LOG_GROUP}:*" \
  --region "$REGION" 2>/dev/null || true

aws logs put-subscription-filter \
  --log-group-name "$LOG_GROUP" \
  --filter-name  "AllLogs" \
  --filter-pattern "" \
  --destination-arn "$LAMBDA_ARN" \
  --region "$REGION"
echo "   ✅ CW → Lambda subscription active"

# ── 6. Metric filters + alarms ───────────────────────────────────────────
echo "[6/7] Creating metric filters + alarms..."
for LEVEL in ERROR WARN; do
  aws logs put-metric-filter \
    --log-group-name "$LOG_GROUP" \
    --filter-name  "${LEVEL}Count" \
    --filter-pattern "{ \$.level = \"${LEVEL}\" }" \
    --metric-transformations \
      "metricName=${LEVEL}Count,metricNamespace=LogMonitor,metricValue=1,defaultValue=0" \
    --region "$REGION"
done

aws cloudwatch put-metric-alarm \
  --alarm-name "LogMonitor-HighErrorRate" \
  --metric-name ErrorCount --namespace LogMonitor --statistic Sum \
  --period 300 --evaluation-periods 1 --threshold 5 \
  --comparison-operator GreaterThanOrEqualToThreshold \
  --alarm-actions "$TOPIC_ARN" --ok-actions "$TOPIC_ARN" \
  --treat-missing-data notBreaching --region "$REGION"
echo "   ✅ CloudWatch alarm: LogMonitor-HighErrorRate"

# ── 7. Install Filebeat on EC2 ────────────────────────────────────────────
echo "[7/7] Installing Filebeat..."
if ! command -v filebeat &>/dev/null; then
  wget -qO - https://artifacts.elastic.co/GPG-KEY-elasticsearch | sudo apt-key add -
  echo "deb https://artifacts.elastic.co/packages/8.x/apt stable main" | \
    sudo tee /etc/apt/sources.list.d/elastic-8.x.list
  sudo apt-get update -y && sudo apt-get install filebeat -y
fi

sudo cp filebeat/filebeat.yml /etc/filebeat/filebeat.yml
sudo systemctl enable filebeat
sudo systemctl restart filebeat
echo "   ✅ Filebeat running"

echo ""
echo "✅ Phase 2 AWS infrastructure deployed!"
echo "   SNS Topic    : $TOPIC_ARN"
echo "   S3 Bucket    : s3://$S3_BUCKET"
echo "   Lambda       : $LAMBDA_ARN"
echo "   Log Group    : $LOG_GROUP"
echo ""
echo "   Set in alertSystem.js:"
echo "   export AWS_SNS_TOPIC_ARN=$TOPIC_ARN"
echo ""
echo "   Dashboard URL:"
echo "   https://${REGION}.console.aws.amazon.com/cloudwatch/home#dashboards"

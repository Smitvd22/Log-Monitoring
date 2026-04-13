#!/bin/bash
# ============================================================
# AWS CloudWatch + SNS Alert Setup
# Prerequisites: AWS CLI configured, IAM permissions for CW + SNS
# Usage: bash setup-aws-alerts.sh YOUR_EMAIL
# ============================================================

EMAIL=${1:-"you@example.com"}
REGION="us-east-1"
LOG_GROUP="/log-monitor/app"
SNS_TOPIC="log-monitor-alerts"
ALARM_PREFIX="LogMonitor"

echo "Setting up CloudWatch Metrics, SNS, and Alarms..."
echo "Email: $EMAIL | Region: $REGION"

# ── 1. Create SNS topic ───────────────────────────────────────────────────
echo "[1/5] Creating SNS topic..."
TOPIC_ARN=$(aws sns create-topic \
  --name "$SNS_TOPIC" \
  --region "$REGION" \
  --query 'TopicArn' --output text)

echo "   Topic ARN: $TOPIC_ARN"

# Subscribe email
aws sns subscribe \
  --topic-arn "$TOPIC_ARN" \
  --protocol email \
  --notification-endpoint "$EMAIL" \
  --region "$REGION"

echo "   ✉️  Subscription confirmation sent to $EMAIL"

# ── 2. Create log group ───────────────────────────────────────────────────
echo "[2/5] Creating CloudWatch log group..."
aws logs create-log-group \
  --log-group-name "$LOG_GROUP" \
  --region "$REGION" 2>/dev/null || echo "   Log group already exists."

aws logs put-retention-policy \
  --log-group-name "$LOG_GROUP" \
  --retention-in-days 14 \
  --region "$REGION"

# ── 3. Metric filter: count ERROR entries ─────────────────────────────────
echo "[3/5] Creating metric filters..."

aws logs put-metric-filter \
  --log-group-name "$LOG_GROUP" \
  --filter-name  "ErrorCount" \
  --filter-pattern '{ $.level = "ERROR" }' \
  --metric-transformations \
    metricName=ErrorCount,metricNamespace=LogMonitor,metricValue=1,defaultValue=0 \
  --region "$REGION"

aws logs put-metric-filter \
  --log-group-name "$LOG_GROUP" \
  --filter-name  "WarnCount" \
  --filter-pattern '{ $.level = "WARN" }' \
  --metric-transformations \
    metricName=WarnCount,metricNamespace=LogMonitor,metricValue=1,defaultValue=0 \
  --region "$REGION"

# ── 4. CloudWatch Alarms ──────────────────────────────────────────────────
echo "[4/5] Creating CloudWatch Alarms..."

# Alarm: > 5 errors in 5 minutes
aws cloudwatch put-metric-alarm \
  --alarm-name          "${ALARM_PREFIX}-HighErrorCount" \
  --alarm-description   "More than 5 ERROR logs in 5 minutes" \
  --metric-name         ErrorCount \
  --namespace           LogMonitor \
  --statistic           Sum \
  --period              300 \
  --evaluation-periods  1 \
  --threshold           5 \
  --comparison-operator GreaterThanOrEqualToThreshold \
  --alarm-actions       "$TOPIC_ARN" \
  --ok-actions          "$TOPIC_ARN" \
  --treat-missing-data  notBreaching \
  --region "$REGION"

# Alarm: > 10 warnings in 5 minutes
aws cloudwatch put-metric-alarm \
  --alarm-name          "${ALARM_PREFIX}-HighWarnCount" \
  --alarm-description   "More than 10 WARN logs in 5 minutes" \
  --metric-name         WarnCount \
  --namespace           LogMonitor \
  --statistic           Sum \
  --period              300 \
  --evaluation-periods  1 \
  --threshold           10 \
  --comparison-operator GreaterThanOrEqualToThreshold \
  --alarm-actions       "$TOPIC_ARN" \
  --treat-missing-data  notBreaching \
  --region "$REGION"

# ── 5. Create CloudWatch Dashboard ───────────────────────────────────────
echo "[5/5] Creating CloudWatch Dashboard..."

aws cloudwatch put-dashboard \
  --dashboard-name "LogMonitorDashboard" \
  --dashboard-body '{
    "widgets": [
      {
        "type": "metric",
        "properties": {
          "title": "Error Count (5 min)",
          "metrics": [["LogMonitor", "ErrorCount"]],
          "period": 300, "stat": "Sum", "view": "timeSeries"
        }
      },
      {
        "type": "metric",
        "properties": {
          "title": "Warning Count (5 min)",
          "metrics": [["LogMonitor", "WarnCount"]],
          "period": 300, "stat": "Sum", "view": "timeSeries"
        }
      },
      {
        "type": "log",
        "properties": {
          "title": "Recent ERROR Logs",
          "query": "SOURCE '\''/log-monitor/app'\'' | fields @timestamp, message | filter level = '\''ERROR'\'' | sort @timestamp desc | limit 20",
          "region": "'$REGION'"
        }
      }
    ]
  }' \
  --region "$REGION"

echo ""
echo "✅ AWS Alert setup complete!"
echo "   SNS Topic ARN : $TOPIC_ARN"
echo "   Dashboard     : https://${REGION}.console.aws.amazon.com/cloudwatch/home#dashboards:name=LogMonitorDashboard"
echo "   Alarms        : https://${REGION}.console.aws.amazon.com/cloudwatch/home#alarmsV2:"
echo ""
echo "   Export for alertSystem.js:"
echo "   export AWS_SNS_TOPIC_ARN=$TOPIC_ARN"

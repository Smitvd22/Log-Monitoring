#!/bin/bash
# ============================================================
# Phase 1 AWS Deployment Script
# Tested on: Ubuntu 22.04 LTS (EC2 t2.micro)
# Run as: bash deploy-aws.sh
# ============================================================

set -e  # exit on any error

echo "======================================"
echo " Log Monitor — Phase 1 AWS Deploy"
echo "======================================"

# ── 1. System update ──────────────────────────────────────────────────────
echo "[1/7] Updating system packages..."
sudo apt-get update -y
sudo apt-get upgrade -y

# ── 2. Install Node.js 20 ────────────────────────────────────────────────
echo "[2/7] Installing Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

echo "   Node $(node -v) | npm $(npm -v)"

# ── 3. Install PM2 (process manager) ─────────────────────────────────────
echo "[3/7] Installing PM2..."
sudo npm install -g pm2

# ── 4. Clone / copy project ───────────────────────────────────────────────
echo "[4/7] Setting up project..."
PROJECT_DIR="/home/ubuntu/log-monitor"
mkdir -p "$PROJECT_DIR"

# If running from a git repo, clone it:
# git clone https://github.com/YOUR_USER/log-monitor.git "$PROJECT_DIR"
# Otherwise, copy local files:
# scp -r ./backend ec2-user@YOUR_EC2_IP:$PROJECT_DIR/

cd "$PROJECT_DIR/backend"
npm install --production

mkdir -p logs

# ── 5. Start with PM2 ────────────────────────────────────────────────────
echo "[5/7] Starting services with PM2..."
pm2 start src/app.js       --name log-monitor-api  --time
pm2 start src/logGenerator.js --name log-generator  --time
pm2 start src/alertSystem.js  --name log-alerter    --time
pm2 save
pm2 startup | tail -1 | sudo bash   # enable PM2 on reboot

echo ""
pm2 list

# ── 6. Configure AWS CloudWatch agent (optional) ─────────────────────────
echo "[6/7] Configuring CloudWatch log shipping..."
# Ensure EC2 role has: CloudWatchAgentServerPolicy

if command -v amazon-cloudwatch-agent-ctl &>/dev/null; then
  cat > /tmp/cw-config.json <<EOF
{
  "logs": {
    "logs_collected": {
      "files": {
        "collect_list": [
          {
            "file_path"       : "$PROJECT_DIR/backend/logs/app.log",
            "log_group_name"  : "/log-monitor/app",
            "log_stream_name" : "{instance_id}",
            "timestamp_format": "%Y-%m-%dT%H:%M:%S"
          }
        ]
      }
    }
  }
}
EOF
  sudo amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s -c file:/tmp/cw-config.json
  echo "   CloudWatch agent configured."
else
  echo "   CloudWatch agent not installed — skipping. See README for setup."
fi

# ── 7. Configure AWS SNS (optional — set env vars first) ─────────────────
echo "[7/7] SNS configuration..."
echo "   Set these environment variables in /etc/environment or .env:"
echo "   AWS_SNS_TOPIC_ARN=arn:aws:sns:us-east-1:ACCOUNT_ID:log-alerts"
echo "   AWS_DEFAULT_REGION=us-east-1"
echo ""
echo "   Then in alertSystem.js, uncomment the snsAlert() function"
echo "   and install: npm install @aws-sdk/client-sns"

echo ""
echo "✅ Deployment complete!"
echo "   API running at: http://$(curl -s http://169.254.169.254/latest/meta-data/public-ipv4):3000"
echo "   PM2 dashboard : pm2 monit"
echo "   Logs          : pm2 logs log-monitor-api"

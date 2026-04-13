# ============================================================
# Phase 3 — Terraform AWS Infrastructure
# Creates: VPC, EC2 Auto Scaling Group, ALB, CloudWatch,
#          Lambda, S3, SNS, IAM, Security Groups
# Usage:
#   terraform init
#   terraform plan -var="alert_email=you@example.com"
#   terraform apply -var="alert_email=you@example.com"
# ============================================================

terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
  required_version = ">= 1.5"
}

provider "aws" {
  region = var.aws_region
}

# ── Variables ─────────────────────────────────────────────────────────────
variable "aws_region"   { default = "us-east-1" }
variable "app_name"     { default = "log-monitor" }
variable "alert_email"  { default = "you@example.com" }
variable "instance_type"{ default = "t3.small" }
variable "min_size"     { default = 1 }
variable "max_size"     { default = 5 }
variable "desired"      { default = 2 }

# ── Data sources ──────────────────────────────────────────────────────────
data "aws_availability_zones" "available" { state = "available" }
data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical
  filter { name = "name"                values = ["ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"] }
  filter { name = "virtualization-type" values = ["hvm"] }
}

# ── VPC ───────────────────────────────────────────────────────────────────
resource "aws_vpc" "main" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_hostnames = true
  tags = { Name = "${var.app_name}-vpc" }
}

resource "aws_internet_gateway" "igw" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${var.app_name}-igw" }
}

resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.0.${count.index}.0/24"
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = true
  tags = { Name = "${var.app_name}-public-${count.index}" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route { cidr_block = "0.0.0.0/0"; gateway_id = aws_internet_gateway.igw.id }
  tags   = { Name = "${var.app_name}-rt" }
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# ── Security Groups ───────────────────────────────────────────────────────
resource "aws_security_group" "alb" {
  name   = "${var.app_name}-alb-sg"
  vpc_id = aws_vpc.main.id
  ingress { from_port=80;  to_port=80;  protocol="tcp"; cidr_blocks=["0.0.0.0/0"] }
  ingress { from_port=443; to_port=443; protocol="tcp"; cidr_blocks=["0.0.0.0/0"] }
  egress  { from_port=0;   to_port=0;   protocol="-1";  cidr_blocks=["0.0.0.0/0"] }
}

resource "aws_security_group" "app" {
  name   = "${var.app_name}-app-sg"
  vpc_id = aws_vpc.main.id
  ingress { from_port=3000; to_port=3000; protocol="tcp"; security_groups=[aws_security_group.alb.id] }
  ingress { from_port=22;   to_port=22;   protocol="tcp"; cidr_blocks=["0.0.0.0/0"] }
  egress  { from_port=0;    to_port=0;    protocol="-1";  cidr_blocks=["0.0.0.0/0"] }
}

# ── IAM Role for EC2 ─────────────────────────────────────────────────────
resource "aws_iam_role" "ec2" {
  name               = "${var.app_name}-ec2-role"
  assume_role_policy = jsonencode({ Version="2012-10-17"; Statement=[{ Effect="Allow"; Principal={ Service="ec2.amazonaws.com" }; Action="sts:AssumeRole" }] })
}

resource "aws_iam_role_policy_attachment" "cw_agent"  { role=aws_iam_role.ec2.name; policy_arn="arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy" }
resource "aws_iam_role_policy_attachment" "ssm"       { role=aws_iam_role.ec2.name; policy_arn="arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore" }

resource "aws_iam_role_policy" "sns_s3" {
  name = "${var.app_name}-sns-s3"
  role = aws_iam_role.ec2.id
  policy = jsonencode({ Version="2012-10-17"; Statement=[
    { Effect="Allow"; Action=["sns:Publish"]; Resource=aws_sns_topic.alerts.arn },
    { Effect="Allow"; Action=["s3:PutObject","s3:GetObject"]; Resource="${aws_s3_bucket.logs.arn}/*" },
  ]})
}

resource "aws_iam_instance_profile" "ec2" {
  name = "${var.app_name}-profile"
  role = aws_iam_role.ec2.name
}

# ── S3 Bucket ─────────────────────────────────────────────────────────────
resource "aws_s3_bucket" "logs" {
  bucket = "${var.app_name}-logs-${data.aws_caller_identity.current.account_id}"
  tags   = { Name="${var.app_name}-logs" }
}

data "aws_caller_identity" "current" {}

resource "aws_s3_bucket_lifecycle_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id
  rule {
    id     = "expire-logs"
    status = "Enabled"
    filter { prefix = "logs/" }
    expiration { days = 90 }
    transition { days=30; storage_class="STANDARD_IA" }
  }
}

# ── SNS ───────────────────────────────────────────────────────────────────
resource "aws_sns_topic" "alerts" {
  name = "${var.app_name}-alerts"
}

resource "aws_sns_topic_subscription" "email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# ── CloudWatch Log Group ──────────────────────────────────────────────────
resource "aws_cloudwatch_log_group" "app" {
  name              = "/log-monitor/app"
  retention_in_days = 30
}

# Metric filters
resource "aws_cloudwatch_log_metric_filter" "errors" {
  name           = "ErrorCount"
  log_group_name = aws_cloudwatch_log_group.app.name
  pattern        = "{ $.level = \"ERROR\" }"
  metric_transformation { name="ErrorCount"; namespace="LogMonitor"; value="1"; default_value="0" }
}

resource "aws_cloudwatch_log_metric_filter" "warnings" {
  name           = "WarnCount"
  log_group_name = aws_cloudwatch_log_group.app.name
  pattern        = "{ $.level = \"WARN\" }"
  metric_transformation { name="WarnCount"; namespace="LogMonitor"; value="1"; default_value="0" }
}

# CloudWatch Alarms
resource "aws_cloudwatch_metric_alarm" "high_errors" {
  alarm_name          = "${var.app_name}-high-errors"
  metric_name         = "ErrorCount"
  namespace           = "LogMonitor"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 5
  comparison_operator = "GreaterThanOrEqualToThreshold"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"
}

# ── Application Load Balancer ─────────────────────────────────────────────
resource "aws_lb" "main" {
  name               = "${var.app_name}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.public[*].id
}

resource "aws_lb_target_group" "app" {
  name     = "${var.app_name}-tg"
  port     = 3000
  protocol = "HTTP"
  vpc_id   = aws_vpc.main.id
  health_check {
    path                = "/api/health/deep"
    interval            = 30
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"
  default_action { type="forward"; target_group_arn=aws_lb_target_group.app.arn }
}

# ── Launch Template ───────────────────────────────────────────────────────
resource "aws_launch_template" "app" {
  name_prefix   = "${var.app_name}-"
  image_id      = data.aws_ami.ubuntu.id
  instance_type = var.instance_type
  iam_instance_profile { name = aws_iam_instance_profile.ec2.name }
  vpc_security_group_ids = [aws_security_group.app.id]

  user_data = base64encode(<<-EOF
    #!/bin/bash
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
    npm install -g pm2
    cd /home/ubuntu
    git clone https://github.com/YOUR_USER/log-monitor.git app || true
    cd app/backend && npm install --production
    mkdir -p logs
    pm2 start src/app.js       --name log-monitor-api
    pm2 start src/logGenerator.js --name log-generator
    pm2 start src/alertSystem.js  --name log-alerter \
      --env AWS_SNS_TOPIC_ARN=${aws_sns_topic.alerts.arn}
    pm2 save && pm2 startup | tail -1 | bash
  EOF
  )

  tag_specifications {
    resource_type = "instance"
    tags = { Name="${var.app_name}-instance" }
  }
}

# ── Auto Scaling Group ─────────────────────────────────────────────────────
resource "aws_autoscaling_group" "app" {
  name                = "${var.app_name}-asg"
  min_size            = var.min_size
  max_size            = var.max_size
  desired_capacity    = var.desired
  vpc_zone_identifier = aws_subnet.public[*].id
  target_group_arns   = [aws_lb_target_group.app.arn]
  health_check_type   = "ELB"
  health_check_grace_period = 120

  launch_template { id=aws_launch_template.app.id; version="$Latest" }

  tag { key="Name"; value="${var.app_name}-asg-instance"; propagate_at_launch=true }
}

# Scale-out: CPU > 70%
resource "aws_autoscaling_policy" "scale_out" {
  name                   = "${var.app_name}-scale-out"
  autoscaling_group_name = aws_autoscaling_group.app.name
  policy_type            = "TargetTrackingScaling"
  target_tracking_configuration {
    predefined_metric_specification { predefined_metric_type = "ASGAverageCPUUtilization" }
    target_value = 70.0
  }
}

# ── Outputs ───────────────────────────────────────────────────────────────
output "alb_dns"       { value = aws_lb.main.dns_name }
output "sns_topic_arn" { value = aws_sns_topic.alerts.arn }
output "s3_bucket"     { value = aws_s3_bucket.logs.bucket }
output "log_group"     { value = aws_cloudwatch_log_group.app.name }

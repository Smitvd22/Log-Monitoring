# Log Monitoring & Alert System
## Complete Project Documentation

**Course**: Cloud Computing  
**Phase**: 3 — Final Submission  
**Stack**: AWS (EC2, Lambda, CloudWatch, S3, SNS, Auto Scaling) + Node.js + WebSockets + Docker + Terraform + Kubernetes

---

## 1. Problem Statement

Modern cloud-deployed applications generate thousands of log entries per minute across multiple microservices. Without a centralised, real-time monitoring system, engineers face:

- **Delayed incident detection** — issues discovered by users before engineers
- **Alert fatigue** — static threshold rules generate too much noise
- **Log fragmentation** — logs scattered across services with no unified view
- **No anomaly awareness** — gradual degradation goes unnoticed until it becomes critical

This project builds a complete production-grade log monitoring and alerting system that collects, stores, analyses, and visualises logs from multiple services in real time, with intelligent anomaly detection and automated alerting.

---

## 2. Objectives

1. Collect logs from multiple application services and system sources in real time
2. Store and process logs efficiently using AWS cloud services and local ring buffers
3. Visualise logs and metrics on a live, interactive dashboard
4. Detect anomalies automatically using statistical methods (Z-score, IQR)
5. Generate actionable alerts via email/SMS using AWS SNS
6. Deploy the system on AWS with auto-scaling and production reliability

---

## 3. Methodology

### 3.1 Architecture

The system follows a layered pipeline architecture:

```
Log Sources → Ingest Layer → Processing → Storage → Visualisation → Alerting
```

**Layer 1 — Log Sources**
- Node.js Express application (HTTP request logging)
- Multi-service simulator (5 microservices with realistic traffic)
- Syslog UDP listener (system logs from Linux)
- Lambda bulk ingest endpoint (serverless batch logs)

**Layer 2 — Ingest & Processing**
- In-memory ring buffer (5,000 entries, O(1) push)
- WebSocket broadcast to all connected dashboards
- Log enrichment: traceId, requestId, source, version

**Layer 3 — Anomaly Detection**
- Z-score error spike detection: 20-minute sliding baseline
- IQR response-time outlier detection: 500-sample history
- Anomalies published to `/api/anomalies` and WS channel

**Layer 4 — Storage**
- JSON-lines flat file with 100 MB rotation
- AWS CloudWatch Logs (via Filebeat)
- AWS S3 (via Lambda processor, 90-day lifecycle)

**Layer 5 — Visualisation**
- REST API: search, timeline, heatmap, trace, top-errors, stats
- WebSocket: real-time log push with server-side filtering
- Prometheus metrics endpoint for Grafana integration

**Layer 6 — Alerting**
- 9 alert rules (error count, rate, P95, P99, velocity, budget, anomalies)
- Alert escalation: WARNING → CRITICAL after 3 violations
- Delivery: console, AWS SNS (email + SMS), Slack webhook
- Alert suppression: maintenance window toggle

### 3.2 Anomaly Detection Algorithm

**Z-Score method (error spikes):**
```
Z = (current_rate - baseline_mean) / baseline_stddev
Alert if Z ≥ 2.5
```
The baseline is computed over a 20-minute sliding window of per-minute error counts. This adapts to natural traffic patterns and avoids false positives during normal traffic spikes.

**IQR method (response-time outliers):**
```
fence = Q3 + 3 × (Q3 - Q1)
Alert if response_time > fence AND response_time > 2000ms
```
The IQR fence rejects extreme outliers regardless of absolute scale, making it robust against different application latency profiles.

### 3.3 Auto-Scaling Strategy

The system uses AWS Auto Scaling with:
- **Scale-out trigger**: CPU utilisation > 70% for 2 consecutive periods
- **Readiness probe**: `/api/health/deep` — returns 503 if error rate > 50% or memory > 512 MB
- **Rolling deployment**: maxUnavailable=0 ensures zero-downtime updates
- **Kubernetes HPA**: scales pods between 2–10 replicas on CPU and memory

### 3.4 Technology Choices

| Decision | Choice | Rationale |
|---|---|---|
| Runtime | Node.js 20 | Non-blocking I/O ideal for high-throughput log writes |
| Real-time delivery | WebSocket (ws) | Lower latency than polling; server-side filter reduces client load |
| Anomaly detection | Z-score + IQR | Statistical, parameter-free, adapts to baseline automatically |
| IaC | Terraform | Reproducible, version-controlled cloud infrastructure |
| Orchestration | Kubernetes | Industry standard for scaling containerised workloads |
| Log format | JSON-lines | Structured, streamable, Elasticsearch/Athena compatible |
| Alert delivery | AWS SNS | Managed, reliable, supports email + SMS + HTTP + Lambda |

---

## 4. System Components

### 4.1 Backend API (`app.js`)

**Endpoints:**

| Method | Path | Phase | Description |
|---|---|---|---|
| GET | `/health` | 1 | Basic liveness |
| GET | `/api/health/deep` | 3 | Auto-scaling readiness probe |
| GET | `/api/metrics` | 3 | Prometheus text exposition |
| GET | `/api/logs` | 2 | Full-text search with filters |
| GET | `/api/stats` | 1 | Aggregated counts + RT percentiles |
| GET | `/api/timeline` | 2 | Per-minute log volume buckets |
| GET | `/api/top-errors` | 2 | Deduplicated error frequency |
| GET | `/api/anomalies` | 3 | Detected anomaly feed |
| GET | `/api/heatmap` | 3 | Hour × day-of-week error density |
| GET | `/api/trace/:id` | 3 | Distributed trace aggregation |
| POST | `/api/ingest/bulk` | 3 | Multi-source batch ingest |
| WS | `/ws/logs` | 2 | Real-time stream with filtering |

### 4.2 Log Generator (`logGenerator.js`)

Simulates a realistic microservice environment:
- **5 services**: api-gateway, auth-service, order-service, payment-service, log-monitor-app
- **Weighted scenarios**: realistic distribution (INFO ~60%, WARN ~20%, ERROR ~12%, DEBUG ~8%)
- **Cascade failure simulation**: correlated errors across services every ~3 minutes
- **Multi-source**: HTTP API, Lambda bulk ingest, Syslog UDP

### 4.3 Alert System (`alertSystem.js`)

**9 alert rules:**

| Rule | Severity | Condition | Method |
|---|---|---|---|
| HIGH_ERROR_COUNT | CRITICAL | ≥5 errors/5min | Polling |
| HIGH_ERROR_RATE | CRITICAL | Error rate ≥ 20% | Polling |
| HIGH_WARN_COUNT | WARNING | ≥10 warnings/5min | Polling |
| SLOW_AVG_RT | WARNING | Avg RT ≥ 500ms | Polling |
| SLOW_P95_RT | CRITICAL | P95 RT ≥ 2000ms | Polling |
| SLOW_P99_RT | CRITICAL | P99 RT ≥ 5000ms | Polling |
| ERROR_VELOCITY | CRITICAL | Rate increasing ≥ 3/min | Polling |
| ERROR_BUDGET_BURN | CRITICAL | Error rate ≥ SLA target | Polling |
| ANOMALY_* | CRITICAL/WARN | Z-score ≥ 2.5 / IQR breach | WebSocket push |

### 4.4 Lambda Processor (`lambda/index.js`)

Triggered by CloudWatch Logs subscription filter:
1. Decodes gzipped base64 log events
2. Enriches each entry with severity score (0–10)
3. Writes JSON-lines to S3 with date-partitioned keys
4. Publishes SNS alert if error count exceeds threshold in batch

### 4.5 Infrastructure

**Terraform** (`terraform/main.tf`):
- VPC with 2 public subnets across availability zones
- Application Load Balancer with health-check-based routing
- Launch Template + Auto Scaling Group (1–5 EC2 instances)
- CloudWatch Logs, metric filters, and alarms
- SNS topic with email/SMS subscriptions
- S3 bucket with 90-day lifecycle and IA transition

**Kubernetes** (`k8s/deployment.yaml`):
- Namespace isolation
- HorizontalPodAutoscaler (2–10 replicas)
- Shared PVC for log persistence
- Nginx Ingress with WebSocket support
- Resource requests and limits per container

---

## 5. Deployment Guide

### Local (Development)
```bash
cd backend
npm install
npm start          # API on :3000, WS on :3000/ws/logs
npm run generate   # Log traffic simulator
npm run alerts     # Alert engine
npm test           # Integration tests (17 test cases)
```

### Docker
```bash
cd docker
docker-compose up --build
```

### AWS (Production)
```bash
# Full infrastructure
cd terraform
terraform init
terraform apply -var="alert_email=you@example.com"

# Phase 2 features
bash scripts/setup-phase2-aws.sh you@email.com +91XXXXXXXXXX

# Phase 3 auto-scaling + Kubernetes
kubectl apply -f k8s/
```

---

## 6. Results

### Functional Results

| Requirement | Status |
|---|---|
| Collect logs from multiple services | ✅ 5 services + Syslog + Lambda |
| Store logs in the cloud | ✅ CloudWatch Logs + S3 |
| Visualise with dashboard | ✅ Real-time WS dashboard, timeline, heatmap |
| Real-time alert generation | ✅ 9 rules, SNS email/SMS, <100ms WS delivery |
| Anomaly detection | ✅ Z-score + IQR, adaptive baseline |
| Auto-scaling | ✅ ASG + HPA + readiness probe |
| Production deployment | ✅ Terraform + Kubernetes + Docker |

### Performance Characteristics

| Metric | Value |
|---|---|
| Log write latency | < 5ms (in-memory buffer + async file write) |
| WebSocket broadcast latency | < 50ms |
| Ring buffer capacity | 5,000 entries (~5 min at peak load) |
| Log file rotation | Automatic at 100 MB |
| Alert detection latency | 10s (polling) / <100ms (WebSocket real-time) |
| Anomaly detection window | 20 minutes rolling baseline |
| Max log ingest rate | ~500 entries/second (single instance) |

---

## 7. Conclusion

The system successfully implements a complete, production-grade log monitoring and alerting pipeline across three development phases:

- **Phase 1** established the foundation: log generation, file persistence, REST API, and threshold-based alerts
- **Phase 2** added real-time delivery (WebSocket), advanced search, multi-service support, AWS SNS, and P95 tracking
- **Phase 3** completed the system with anomaly detection, auto-scaling, distributed tracing, bulk ingest, Terraform IaC, Kubernetes orchestration, and a full integration test suite

The statistical anomaly detection (Z-score + IQR) is particularly notable — it adapts to normal traffic patterns and detects genuine outliers without manual threshold tuning, reducing alert fatigue while improving incident detection accuracy.

---

## 8. Future Scope

1. **Machine learning anomaly detection** — LSTM or Isolation Forest replacing Z-score for more complex patterns
2. **Elasticsearch integration** — Full-text search at scale with Kibana visualisation
3. **OpenTelemetry** — Industry-standard distributed tracing replacing custom traceId
4. **Log sampling** — Probabilistic sampling at high ingestion rates to control cost
5. **Multi-region** — Active-active replication across AWS regions for disaster recovery
6. **RBAC dashboard** — Role-based access control for team members

---

## 9. Viva Preparation

### Core Concepts

**Q: What is log monitoring and why is it important?**  
Log monitoring is the practice of collecting, aggregating, and analysing application log data in real time to detect errors, performance issues, and anomalies. It enables proactive incident response — engineers detect problems before users report them.

**Q: Explain the difference between polling and WebSocket-based monitoring.**  
Polling sends a new HTTP request every N seconds regardless of whether new data exists, wasting bandwidth and introducing latency equal to the polling interval. WebSockets maintain a persistent TCP connection over which the server pushes new log entries immediately as they are generated — latency is effectively zero and bandwidth is used only when there is new data.

**Q: How does your Z-score anomaly detection work?**  
We maintain a 20-minute rolling baseline of per-minute error counts. For each incoming error, we compute `Z = (current_rate - mean) / stdDev`. If Z ≥ 2.5 (2.5 standard deviations above the mean), the system records an anomaly. This is statistically meaningful — a Z-score ≥ 2.5 occurs by chance only ~0.6% of the time in a normal distribution, so it represents a genuine spike rather than random noise.

**Q: What is IQR-based anomaly detection?**  
The Interquartile Range method identifies outliers as values beyond `Q3 + 3×(Q3−Q1)`, known as the outer fence. Unlike mean/stddev, IQR is robust to extreme values — a single very slow request doesn't skew the fence. We apply it to response times to catch individual pathologically slow requests.

**Q: How does auto-scaling work in your system?**  
The AWS Auto Scaling Group monitors CPU utilisation. When the average exceeds 70%, a new EC2 instance is launched using the Launch Template, which runs our startup script to deploy the application with PM2. The ALB's health check hits `/api/health/deep` — new instances only receive traffic once this endpoint returns 200, preventing unhealthy instances from being included. In Kubernetes, the HPA scales pods between 2–10 replicas based on CPU and memory.

**Q: What is CloudWatch and how do you use it?**  
AWS CloudWatch is a monitoring service. We use it for: (1) Log Groups — structured log storage and querying; (2) Metric Filters — extracting ErrorCount/WarnCount from log entries; (3) Alarms — triggering SNS notifications when metrics cross thresholds; (4) Dashboards — visual charts of log metrics in the AWS Console.

**Q: What is SNS and how does it send alerts?**  
Amazon Simple Notification Service is a managed pub/sub messaging service. We create a Topic and subscribe email addresses and phone numbers to it. When our alert system detects a threshold violation, it calls `sns.publish()` with the topic ARN. SNS fans out the message to all subscribers simultaneously — email goes via SES and SMS via carrier networks.

**Q: Explain JSON-lines log format.**  
JSON-lines (NDJSON) stores one JSON object per line with a newline separator. Each line is independently parseable — you can stream the file without loading it all into memory, append atomically with a single write, and process it with standard Unix tools like `grep` or `jq`. It is also compatible with Elasticsearch bulk API and AWS Athena.

**Q: What is Terraform and why use Infrastructure as Code?**  
Terraform is a declarative IaC tool that provisions cloud resources by writing configuration files. Benefits: (1) reproducibility — running `terraform apply` twice creates identical infrastructure; (2) version control — infrastructure changes are reviewed like code; (3) disaster recovery — entire cloud environment can be recreated in minutes; (4) collaboration — teams share and review infra changes.

**Q: How did you divide the project into 3 phases?**  
Phase 1 (solo-implementable): Core functionality — log generation, file storage, REST API, basic console alerts. Phase 2 (2 people): Enhancements — WebSocket streaming, multi-service, AWS SNS, search/filter, P95 metrics, Filebeat, Lambda. Phase 3 (3 people): Advanced features — anomaly detection, auto-scaling, distributed tracing, bulk ingest, Prometheus metrics, Terraform, Kubernetes, full test suite.

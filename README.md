# Log Monitoring & Alert System — Phase 3 (Final)

**Cloud Computing University Project** | AWS + Node.js + WebSockets + Anomaly Detection + Terraform + Kubernetes

---

## What's New in Phase 3

| Feature | Phase 2 | Phase 3 |
|---|---|---|
| Anomaly detection | None | **Z-score + IQR statistical detection** |
| Ingest sources | HTTP + Syslog | + **Lambda bulk + UDP listener** |
| Distributed tracing | traceId field | **/api/trace/:id span aggregation** |
| Error heatmap | None | **Hour × day-of-week density** |
| Prometheus metrics | None | **/api/metrics exposition** |
| Readiness probe | /health | **/api/health/deep (503 on degradation)** |
| Log rotation | None | **Auto-rotate at 100 MB** |
| Infrastructure | Manual | **Terraform (VPC + ASG + ALB + CW)** |
| Orchestration | Docker Compose | **Kubernetes with HPA (2–10 replicas)** |
| Alert escalation | None | **WARNING → CRITICAL after 3 hits** |
| Slack alerts | None | **SLACK_WEBHOOK_URL** |
| Alert rules | 7 | **9 rules + error budget burn** |
| Tests | None | **17 integration tests** |

---

## Quick Start

```bash
cd backend && npm install

npm start          # API + WebSocket + Syslog UDP + anomaly engine
npm run generate   # Multi-source traffic (HTTP, Lambda bulk, Syslog)
npm run alerts     # 9-rule alert engine
npm test           # 17 integration tests
```

**Docker:** `cd docker && docker-compose up --build`  
**Terraform:** `cd terraform && terraform apply -var="alert_email=you@example.com"`  
**Kubernetes:** `kubectl apply -f k8s/`

---

## New APIs

| Endpoint | Description |
|---|---|
| `GET /api/anomalies` | Z-score + IQR detected anomalies |
| `GET /api/heatmap` | 7×24 error density matrix |
| `GET /api/trace/:id` | Distributed trace span aggregation |
| `GET /api/metrics` | Prometheus text format |
| `GET /api/health/deep` | Readiness probe (200/503) |
| `POST /api/ingest/bulk` | Batch ingest (Lambda/Filebeat) |
| `GET /api/aws/status` | AWS connectivity status (CloudWatch, S3, SNS, Lambda) |
| `GET /api/aws/cloudwatch/log-groups` | CloudWatch log groups (limit, region) |
| `GET /api/aws/s3/buckets` | S3 buckets |
| `GET /api/aws/sns/topics` | SNS topics (limit, region) |
| `GET /api/aws/lambda/functions` | Lambda functions (limit, region) |

### AWS Connectivity

Create a backend environment file (see `backend/.env.example`) and set:

```bash
API_KEY=your-api-key
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_SESSION_TOKEN=optional
```

If `API_KEY` is set, the dashboard must send it as `x-api-key` for `/api/aws/*` routes.

---

## File Structure

```
log-monitor-p3/
├── backend/
│   ├── src/
│   │   ├── app.js               # Anomaly engine + heatmap + trace + Prometheus
│   │   ├── logGenerator.js      # 5 services + Lambda bulk + Syslog UDP
│   │   ├── alertSystem.js       # 9 rules + escalation + SNS + Slack
│   │   └── wsClient.js          # CLI test client
│   ├── tests/integration.test.js
│   └── package.json
├── lambda/index.js              # CW → S3 + SNS
├── filebeat/filebeat.yml
├── docker/docker-compose.yml
├── terraform/main.tf            # Full AWS infra
├── k8s/deployment.yaml          # HPA + Ingress + PVC
├── scripts/
└── docs/PROJECT_DOCUMENTATION.md  # Full submission report
```

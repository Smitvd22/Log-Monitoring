/**
 * AWS Lambda — Log Processor (Phase 2)
 *
 * Trigger: CloudWatch Logs subscription filter → Lambda
 * Purpose:
 *   1. Decode & parse incoming log events
 *   2. Enrich each entry (geo stub, severity score)
 *   3. Store processed entries in S3 (Parquet-friendly JSON-lines)
 *   4. Publish alert to SNS if thresholds exceeded
 *
 * Deploy:
 *   zip -r lambda.zip index.js node_modules/
 *   aws lambda create-function \
 *     --function-name log-processor \
 *     --runtime nodejs20.x \
 *     --handler index.handler \
 *     --role arn:aws:iam::ACCOUNT:role/lambda-log-processor \
 *     --zip-file fileb://lambda.zip \
 *     --environment Variables="{SNS_TOPIC_ARN=arn:...,S3_BUCKET=log-monitor-processed}"
 */

const zlib = require('zlib');
const { S3Client, PutObjectCommand }    = require('@aws-sdk/client-s3');
const { SNSClient, PublishCommand }     = require('@aws-sdk/client-sns');

const s3  = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
const sns = new SNSClient({ region: process.env.AWS_REGION || 'us-east-1' });

const S3_BUCKET   = process.env.S3_BUCKET    || 'log-monitor-processed';
const SNS_ARN     = process.env.SNS_TOPIC_ARN || '';
const ERROR_LIMIT = parseInt(process.env.ERROR_LIMIT) || 5;

// ── severity scoring ───────────────────────────────────────────────────────
const SEVERITY_SCORE = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

function scoreLog(log) {
  const base = SEVERITY_SCORE[log.level] || 1;
  let score  = base;
  if (log.responseTime > 5000) score += 2;
  if (log.message.toLowerCase().includes('payment'))  score += 2;
  if (log.message.toLowerCase().includes('timeout'))  score += 1;
  if (log.message.toLowerCase().includes('critical')) score += 3;
  return Math.min(score, 10);
}

// ── enrich log entry ───────────────────────────────────────────────────────
function enrichLog(log) {
  return {
    ...log,
    severityScore: scoreLog(log),
    processedAt  : new Date().toISOString(),
    lambdaRegion : process.env.AWS_REGION || 'us-east-1',
    // In production: add MaxMind GeoIP lookup on log.ip here
    geoCountry   : log.ip ? 'IN' : null,
  };
}

// ── main handler ───────────────────────────────────────────────────────────
exports.handler = async (event) => {
  // CloudWatch sends gzipped base64 payload
  const compressed = Buffer.from(event.awslogs.data, 'base64');
  const payload    = JSON.parse(zlib.gunzipSync(compressed).toString('utf8'));

  console.log(`Processing ${payload.logEvents.length} log events from ${payload.logGroup}`);

  const entries    = [];
  let   errorCount = 0;

  for (const logEvent of payload.logEvents) {
    let parsed;
    try {
      parsed = JSON.parse(logEvent.message);
    } catch {
      // Non-JSON log line — wrap it
      parsed = { timestamp: new Date(logEvent.timestamp).toISOString(), level: 'INFO', message: logEvent.message };
    }

    const enriched = enrichLog(parsed);
    entries.push(enriched);
    if (enriched.level === 'ERROR') errorCount++;
  }

  // ── Store in S3 ────────────────────────────────────────────────────────
  const now    = new Date();
  const s3Key  = `logs/${now.getUTCFullYear()}/${String(now.getUTCMonth()+1).padStart(2,'0')}/${String(now.getUTCDate()).padStart(2,'0')}/${Date.now()}.jsonl`;
  const body   = entries.map(e => JSON.stringify(e)).join('\n');

  try {
    await s3.send(new PutObjectCommand({
      Bucket     : S3_BUCKET,
      Key        : s3Key,
      Body       : body,
      ContentType: 'application/x-ndjson',
      Metadata   : {
        'log-group'  : payload.logGroup,
        'entry-count': String(entries.length),
        'error-count': String(errorCount),
      },
    }));
    console.log(`✅ Stored ${entries.length} entries → s3://${S3_BUCKET}/${s3Key}`);
  } catch (e) {
    console.error('S3 write failed:', e.message);
  }

  // ── Alert via SNS if errors exceed threshold ───────────────────────────
  if (errorCount >= ERROR_LIMIT && SNS_ARN) {
    try {
      await sns.send(new PublishCommand({
        TopicArn: SNS_ARN,
        Subject : `[CRITICAL] Lambda: ${errorCount} errors detected in ${payload.logGroup}`,
        Message : JSON.stringify({
          logGroup  : payload.logGroup,
          errorCount,
          totalEvents: entries.length,
          topErrors : entries.filter(e => e.level === 'ERROR').slice(0, 3).map(e => e.message),
          s3Key,
          timestamp : new Date().toISOString(),
        }, null, 2),
      }));
      console.log(`📨 SNS alert sent — ${errorCount} errors`);
    } catch (e) {
      console.error('SNS publish failed:', e.message);
    }
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ processed: entries.length, errors: errorCount, s3Key }),
  };
};

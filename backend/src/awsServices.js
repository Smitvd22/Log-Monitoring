const { CloudWatchLogsClient, DescribeLogGroupsCommand } = require('@aws-sdk/client-cloudwatch-logs');
const { S3Client, ListBucketsCommand } = require('@aws-sdk/client-s3');
const { SNSClient, ListTopicsCommand } = require('@aws-sdk/client-sns');
const { LambdaClient, ListFunctionsCommand } = require('@aws-sdk/client-lambda');

function resolveRegion(input) {
  return input || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
}

function buildClients(region) {
  const cfg = { region: resolveRegion(region) };
  return {
    region: cfg.region,
    cloudwatch: new CloudWatchLogsClient(cfg),
    s3: new S3Client(cfg),
    sns: new SNSClient(cfg),
    lambda: new LambdaClient(cfg),
  };
}

async function safeCall(fn) {
  try {
    const data = await fn();
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: error.message || 'AWS call failed' };
  }
}

async function getAwsStatus(regionInput) {
  const { region, cloudwatch, s3, sns, lambda } = buildClients(regionInput);

  const [cwRes, s3Res, snsRes, lambdaRes] = await Promise.all([
    safeCall(() => cloudwatch.send(new DescribeLogGroupsCommand({ limit: 1 }))),
    safeCall(() => s3.send(new ListBucketsCommand({}))),
    safeCall(() => sns.send(new ListTopicsCommand({ MaxResults: 1 }))),
    safeCall(() => lambda.send(new ListFunctionsCommand({ MaxItems: 1 }))),
  ]);

  return {
    region,
    timestamp: new Date().toISOString(),
    services: {
      cloudwatch: {
        ok: cwRes.ok,
        count: cwRes.ok ? (cwRes.data.logGroups || []).length : 0,
        error: cwRes.ok ? null : cwRes.error,
      },
      s3: {
        ok: s3Res.ok,
        count: s3Res.ok ? (s3Res.data.Buckets || []).length : 0,
        error: s3Res.ok ? null : s3Res.error,
      },
      sns: {
        ok: snsRes.ok,
        count: snsRes.ok ? (snsRes.data.Topics || []).length : 0,
        error: snsRes.ok ? null : snsRes.error,
      },
      lambda: {
        ok: lambdaRes.ok,
        count: lambdaRes.ok ? (lambdaRes.data.Functions || []).length : 0,
        error: lambdaRes.ok ? null : lambdaRes.error,
      },
    },
  };
}

async function listLogGroups(regionInput, limit = 20) {
  const { region, cloudwatch } = buildClients(regionInput);
  const res = await cloudwatch.send(new DescribeLogGroupsCommand({ limit }));
  return {
    region,
    groups: (res.logGroups || []).map((g) => ({
      name: g.logGroupName,
      retentionInDays: g.retentionInDays || null,
      storedBytes: g.storedBytes || 0,
    })),
  };
}

async function listBuckets(regionInput) {
  const { region, s3 } = buildClients(regionInput);
  const res = await s3.send(new ListBucketsCommand({}));
  return {
    region,
    buckets: (res.Buckets || []).map((b) => ({
      name: b.Name,
      createdAt: b.CreationDate ? b.CreationDate.toISOString() : null,
    })),
  };
}

async function listTopics(regionInput, limit = 20) {
  const { region, sns } = buildClients(regionInput);
  const res = await sns.send(new ListTopicsCommand({ MaxResults: limit }));
  return {
    region,
    topics: (res.Topics || []).map((t) => ({ arn: t.TopicArn })),
  };
}

async function listFunctions(regionInput, limit = 20) {
  const { region, lambda } = buildClients(regionInput);
  const res = await lambda.send(new ListFunctionsCommand({ MaxItems: limit }));
  return {
    region,
    functions: (res.Functions || []).map((fn) => ({
      name: fn.FunctionName,
      runtime: fn.Runtime || null,
      lastModified: fn.LastModified || null,
    })),
  };
}

module.exports = {
  resolveRegion,
  getAwsStatus,
  listLogGroups,
  listBuckets,
  listTopics,
  listFunctions,
};

# AWS deployment

Geeky runs as a Node.js 24 HTTP server on AWS Lambda Web Functions in `us-east-1`. The AWS endpoint bootstraps OpenAI WebRTC sessions; audio and data then flow directly between the visitor's browser and OpenAI.

## Required inputs

- An authenticated AWS CLI profile and the intended AWS account ID. The deployer needs Lambda Web Functions, IAM role/pass-role, deployment S3, CloudWatch Logs and Secrets Manager metadata permissions.
- An OpenAI project API key stored in AWS Secrets Manager. Supply the secret's full ARN to the deployment, never its value. Use either a plain string or JSON with an `OPENAI_API_KEY` string field. The project must have access to the configured Realtime model.
- Production origin: `https://guategeeks.com`. Do not include `/cotizador` in `ALLOWED_ORIGINS`.

The runtime uses `OPENAI_API_KEY_SECRET_ID` and optionally `OPENAI_API_KEY_SECRET_REGION`. The execution role needs `secretsmanager:GetSecretValue` for that one secret ARN. If the secret uses a customer-managed KMS key, add `kms:Decrypt` for that key with a Secrets Manager service condition. Never pass the API key through CLI arguments, revision environment variables, GitHub configuration, build artifacts or source control.

If creating a new secret, enter the value privately in the AWS Secrets Manager console. Share only its name/ARN with the deployment operator. Do not paste credentials into chat.

## Package and configure

Run the tests before packaging. Create a clean staging directory containing only `index.js`, `src/`, `package.json`, `package-lock.json` and production dependencies installed with `npm ci --omit=dev`. Do not deploy the repository directory: it can contain local `.env` files, test artifacts and development data.

Use a dedicated execution role named `geeky-agent-production`. Its trust policy permits `lambda.amazonaws.com` to call `sts:AssumeRole`. Its permissions should cover only:

- `secretsmanager:GetSecretValue` on the selected secret ARN.
- `logs:CreateLogGroup`, `logs:CreateLogStream`, `logs:PutLogEvents` on `/aws/lambda/web/geeky-agent-production` and `/aws/lambda/web/geeky-agent-production.local` in the selected account and region.

Use a versioned deployment bucket with the Lambda service read policy described in the AWS deployment documentation, or let `aws lambda-web deploy` create its managed deployment bucket. The execution role is supplied explicitly so its secret permission remains scoped.

After resolving the account, role ARN, secret ARN and clean staging path, the deployment command has this shape:

```sh
aws lambda-web deploy \
  --name geeky-agent-production \
  --code "$staging_dir" \
  --create \
  --region us-east-1 \
  --runtime nodejs24.x \
  --entry-point index.js \
  --execution-role-arn "$execution_role_arn" \
  --env "OPENAI_API_KEY_SECRET_ID=$secret_arn" \
  --env OPENAI_API_KEY_SECRET_REGION=us-east-1 \
  --env ALLOWED_ORIGINS=https://guategeeks.com \
  --env OPENAI_REALTIME_MODEL=gpt-realtime-2.1 \
  --endpoint-name production \
  --endpoint-type HomeRegion \
  --auth-type ApplicationManaged \
  --auto-deployment-mode LatestRevision \
  --timeout-seconds 30 \
  --max-concurrency-per-environment 20 \
  --max-environments 2 \
  --rate-limit 100 \
  --application-log-level INFO \
  --system-log-level INFO \
  --no-cli-pager
```

AWS accepts a minimum nonzero endpoint rate of 100 requests per second. The application additionally limits each process to 100 bootstrap attempts per minute, 10 per socket IP per minute, and 20 concurrent upstream calls. These are initial deployment limits, not a guarantee of a fixed bill. Endpoint limits apply to bootstrap requests, not the length or token usage of an established OpenAI session. CORS is not authentication. This endpoint intentionally serves public visitors; evaluate shared edge abuse controls and monitor OpenAI usage before a broad public rollout. Never add request-body logging: SDP and transcripts should not be logged.

The CLI returning an Active revision does not prove the server starts or that OpenAI accepts sessions. Verify HTTP behavior and a live browser session before connecting production traffic.

## Connect Cotizador

Use the returned HTTPS endpoint domain with `/session` appended. Put that public URL in Cotizador's `asesor/agent-config.js`, or configure the optional GitHub repository variable `GEEKY_AGENT_ENDPOINT`. No API key belongs in either place.

Publish the reviewed Cotizador PR through its Pages workflow. Verify `https://guategeeks.com/cotizador/agent-config.js`, then test text, explicit voice activation, voice off, a quote mutation, a campus camera action and undo on the production page. Distinguish mocked/local tests from a real credentialed OpenAI session in the deployment report.

## Rollback

Record the endpoint's prior revision and configuration before updating it. To restore that revision, use `update-web-function-endpoint` with `autoDeploymentMode` set to `Disabled` and `revisionWeights` assigning the previous revision a weight of 100. To stop new agent sessions immediately, set the Cotizador config to `enabled: false` and redeploy Pages; existing OpenAI sessions may continue until closed. Deleting the AWS function does not automatically remove its S3 deployment versions, IAM role or log groups.

## References

- [Create and deploy Lambda Web Functions](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-create.html)
- [Runtime entrypoint and HTTP binding](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-runtimes.html)
- [Execution role permissions](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-permissions.html)
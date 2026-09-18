process.env.AUTH_MODE ??= 'dev';
process.env.AWS_REGION ??= 'us-east-1';

// Gateway tests use fixture session hosts under this domain; production sets it from the deployment.
// DASHBOARD_ORIGIN stays unset here because API tests rely on request-origin fallback; gateway tests pass it explicitly.
process.env.GATEWAY_BASE_DOMAIN ??= 'apps.physical-ai.hi-yoo.com';

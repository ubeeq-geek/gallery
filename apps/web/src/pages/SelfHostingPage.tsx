import { Link } from 'react-router-dom';

export function SelfHostingPage() {
  return (
    <main className="layout self-hosting-page">
      <section className="space-rules-heading">
        <p className="auth-eyebrow">Early deployment guide</p>
        <h1>Run Ubeeq in your own AWS account.</h1>
        <p>This is a deliberately small starting point, not a production-ready managed-service promise. It will grow alongside the public Space product.</p>
      </section>
      <section className="self-hosting-grid">
        <article className="panel space-rules-card">
          <h2>What is available now</h2>
          <ul>
            <li>A CDK stack for API Gateway, Lambda, DynamoDB, S3, CloudFront, Cognito, and synchronization workers.</li>
            <li>Creator-owned DeviantArt application credentials encrypted in the deployment environment.</li>
            <li>Local catalogue storage and a Studio interface.</li>
          </ul>
        </article>
        <article className="panel space-rules-card">
          <h2>Before deploying</h2>
          <ol>
            <li>Create an AWS account and configure the AWS CLI for your target region.</li>
            <li>Choose the domain and email identity you will operate.</li>
            <li>Set secrets through your deployment environment, not source control.</li>
            <li>Review your own moderation, privacy, retention, and incident-response obligations.</li>
          </ol>
        </article>
      </section>
      <section className="panel self-hosting-command">
        <h2>Current repository path</h2>
        <pre><code>npm --workspace infra run build
npx cdk deploy --app "npx ts-node --prefer-ts-exts infra/bin/ubeeq.ts"</code></pre>
        <p className="small">A complete deploy guide, custom domains, backups, observability, and production hardening are placeholders. Do not treat this early path as a compliant production deployment without completing that work.</p>
      </section>
      <Link className="auth-secondary-btn" to="/space-rules">Back to Ubeeq Space Rules</Link>
    </main>
  );
}

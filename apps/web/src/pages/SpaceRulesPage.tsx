import { Link } from 'react-router-dom';
import { brand } from '../brand';

export function SpaceRulesPage() {
  return (
    <main className="layout space-rules-page">
      <section className="space-rules-heading">
        <p className="auth-eyebrow">{brand.rulesName}</p>
        <h1>Make a {brand.workspaceName} for your work. Keep it safe for people.</h1>
        <p>These are the starter rules for {brand.productName}-hosted {brand.workspacePlural}. They will be expanded into the full Terms of Service and community standards before public launch.</p>
      </section>

      <section className="space-rules-grid">
        <article className="panel space-rules-card">
          <p className="space-rules-kicker">Hosted {brand.workspaceName} limits</p>
          <h2>What cannot be published on {brand.workspaceFullName}</h2>
          <ul>
            <li>Hardcore pornography. Non-hardcore fetish content is allowed in hosted {brand.productName} {brand.workspacePlural}.</li>
            <li>Content that is illegal where it is hosted or distributed.</li>
            <li>Impersonation, scams, malware, or deceptive collection of personal information.</li>
            <li>Copyright infringement or material you do not have the right to share.</li>
          </ul>
          <p className="small">Age-appropriate artistic work and mature themes will have clearer ratings and visibility controls as the policy matures. A {brand.workspaceName} may be limited or removed when it violates these hosted-service rules.</p>
        </article>
        <article className="panel space-rules-card space-rules-hard-limit">
          <p className="space-rules-kicker">Non-negotiable</p>
          <h2>Never allowed anywhere in {brand.productName}</h2>
          <ul>
            <li>Child sexual abuse material, grooming, or sexual exploitation of minors.</li>
            <li>Hate, violent extremism, or content that targets people for protected characteristics.</li>
            <li>Credible threats, doxxing, or material that facilitates violence or exploitation.</li>
          </ul>
          <p className="small">These are not simply hosting preferences. {brand.productName} will remove, report, and preserve evidence where required to protect people and comply with law.</p>
        </article>
      </section>

      <section className="panel space-rules-next">
        <div>
          <p className="auth-eyebrow">Control and portability</p>
          <h2>Want to operate your own environment?</h2>
          <p>{brand.productName} is powered by Ubeeq so creator assets and integrations do not depend on a single hosted service. The Ubeeq self-hosting guide describes the initial AWS deployment path and its current limits.</p>
        </div>
        <Link className="auth-primary-btn" to="/self-hosting">View self-hosting guide</Link>
      </section>
    </main>
  );
}

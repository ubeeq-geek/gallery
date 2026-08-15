import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../api';
import { brand, creatorBaseUrl } from '../../brand';
import { Card } from '../components/Card';
import type { StudioCreator } from '../types';

const suggestSlug = (name: string) => name
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 60);

export function CreatorOnboardingView({ onCreated }: { onCreated: (creator: StudioCreator) => Promise<void> }) {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const resolvedSlug = useMemo(() => slug.trim() || suggestSlug(name), [name, slug]);

  const createSpace = async () => {
    if (!name.trim() || !resolvedSlug || !accepted) return;
    setLoading(true);
    setError('');
    try {
      const creator = await api.studioCreateCreator({ name: name.trim(), slug: resolvedSlug }) as StudioCreator;
      await onCreated(creator);
      navigate(`/studio/workspace?section=dashboard&creatorId=${encodeURIComponent(creator.creatorId)}`, { replace: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Unable to create your ${brand.workspaceName}.`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="creator-onboarding">
      <Card title={`Create your ${brand.workspaceFullName}`} eyebrow="Free creator setup" className="creator-onboarding-primary">
        <p className="creator-onboarding-lede">You are already {brand.id === 'eversally' ? 'an' : 'a'} {brand.memberName}. A {brand.workspaceName} makes you {brand.id === 'eversally' ? 'an' : 'a'} {brand.formalCreatorName} and gives your creative identity a public home and Studio.</p>
        <ol className="creator-onboarding-steps">
          <li><strong>Name your {brand.workspaceName}</strong><span>Use the name your audience recognizes. You can change it later.</span></li>
          <li><strong>Choose its address</strong><span>{brand.productName} uses this to create your public creator URL.</span></li>
          <li><strong>Set it up your way</strong><span>Start with a profile, connect DeviantArt, or publish later.</span></li>
        </ol>
        <div className="creator-onboarding-form">
          <label>
            <span>{brand.workspaceName} name</span>
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Your creative name" autoComplete="organization" />
          </label>
          <label>
            <span>{brand.workspaceName} address</span>
            <div className="creator-onboarding-slug"><span>{creatorBaseUrl.replace(/^https?:\/\//, '')}</span><input value={slug} onChange={(event) => setSlug(event.target.value)} placeholder={suggestSlug(name) || 'your-space'} autoCapitalize="none" autoCorrect="off" /></div>
          </label>
        </div>
        <label className="creator-onboarding-consent">
          <input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} />
          <span>I agree to the <Link to="/space-rules">{brand.rulesName}</Link>, including the content restrictions for hosted {brand.workspacePlural}.</span>
        </label>
        <div className="creator-onboarding-actions">
          <button type="button" className="auth-primary-btn" disabled={!name.trim() || !resolvedSlug || !accepted || loading} onClick={() => void createSpace()}>{loading ? `Creating ${brand.workspaceName}...` : `Create free ${brand.workspaceName}`}</button>
          <Link className="auth-secondary-btn" to="/for-creators">Explore creator tools</Link>
        </div>
        {error && <p className="error">{error}</p>}
      </Card>

      <Card title={`Your ${brand.workspaceName}, your choice`} eyebrow={`How ${brand.productName} works`}>
        <div className="creator-onboarding-side-list">
          <div><strong>Free {brand.workspaceName}</strong><span>Every {brand.memberName} can make a {brand.workspaceName}. It is not an application or approval process.</span></div>
          <div><strong>Approved {brand.formalCreatorName}</strong><span>An invitation-only support tier for creators {brand.productName} chooses to back. It adds benefits; it never unlocks the basic right to create.</span></div>
          <div><strong>Run it yourself</strong><span>Need a different policy or infrastructure? Review the early <Link to="/self-hosting">self-hosting deployment guide</Link>.</span></div>
        </div>
      </Card>
    </section>
  );
}

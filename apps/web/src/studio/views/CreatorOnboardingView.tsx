import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../api';
import { brand, creatorBaseUrl } from '../../brand';
import { Card } from '../components/Card';
import { siBluesky, siDeviantart, type SimpleIcon } from 'simple-icons';
import { studioIntegrationPlatforms, type StudioCreator, type StudioIntegrationPlatform } from '../types';

const creatorOnboardingPlatformIcons: Partial<Record<StudioIntegrationPlatform, SimpleIcon>> = {
  bluesky: siBluesky,
  deviantart: siDeviantart
};

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
  const [visibleIntegrations, setVisibleIntegrations] = useState<StudioIntegrationPlatform[]>(['deviantart', 'bluesky']);
  // The rules acknowledgement is opt-out rather than a gate the user has to
  // discover. The creator still has to explicitly submit the form.
  const [accepted, setAccepted] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const resolvedSlug = useMemo(() => slug.trim() || suggestSlug(name), [name, slug]);

  const becomeCreator = async () => {
    if (!name.trim() || !resolvedSlug || !accepted) return;
    setLoading(true);
    setError('');
    try {
      const creator = await api.studioCreateCreator({ name: name.trim(), slug: resolvedSlug, visibleIntegrations }) as StudioCreator;
      await onCreated(creator);
      navigate(`/studio/workspace?section=dashboard&creatorId=${encodeURIComponent(creator.creatorId)}`, { replace: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Unable to create your ${brand.creatorName.toLowerCase()} identity.`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="creator-onboarding">
      <Card title="Become a Creator" eyebrow="Creator setup" className="creator-onboarding-primary">
        <p className="creator-onboarding-lede">You’re already {brand.id === 'eversally' ? 'an' : 'a'} {brand.memberName}. Choose your {brand.creatorName.toLowerCase()} identity — a {brand.workspaceFullName} comes included as its public home and Studio.</p>
        <ol className="creator-onboarding-steps">
          <li><strong>Choose your {brand.creatorName.toLowerCase()} name</strong><span>Use the name your audience recognizes. You can change it later.</span></li>
          <li><strong>Confirm its handle</strong><span>We’ll suggest one from your name — this becomes your public creator URL.</span></li>
          <li><strong>Set up your profile</strong><span>Add branding, connect a platform, or publish later.</span></li>
        </ol>
        <div className="creator-onboarding-form">
          <label>
            <span>{brand.creatorName} name</span>
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Your creative name" autoComplete="organization" />
          </label>
          <label>
            <span>{brand.creatorName} handle</span>
            <div className="creator-onboarding-slug"><span>{creatorBaseUrl.replace(/^https?:\/\//, '')}</span><input value={slug} onChange={(event) => setSlug(event.target.value)} placeholder={suggestSlug(name) || 'your-space'} autoCapitalize="none" autoCorrect="off" /></div>
          </label>
          <fieldset className="studio-integration-choice">
            <legend>Platforms you work with</legend>
            <p className="small">Choose the platforms you currently use. More integrations are coming — you can always connect more later.</p>
            <div className="studio-integration-choice-grid creator-onboarding-platforms">
              {studioIntegrationPlatforms.map((platform) => <label className="studio-work-metadata-option creator-onboarding-platform-option" key={platform.id}>
                <span className="creator-onboarding-platform-icon" aria-hidden="true">
                  {creatorOnboardingPlatformIcons[platform.id] ? <svg viewBox="0 0 24 24" fill="currentColor"><path d={creatorOnboardingPlatformIcons[platform.id]?.path} /></svg> : <span>◉</span>}
                </span>
                <span>{platform.label}</span>
                <input
                  type="checkbox"
                  checked={visibleIntegrations.includes(platform.id)}
                  onChange={(event) => setVisibleIntegrations((current) => event.target.checked
                    ? [...new Set([...current, platform.id])]
                    : current.filter((item) => item !== platform.id))}
                />
                <span className="creator-onboarding-platform-check" aria-hidden="true">✓</span>
              </label>)}
            </div>
            <a className="creator-onboarding-request-link" href="mailto:hello@eversally.com?subject=Request%20an%20integration">Don’t see your platform? Request an integration →</a>
          </fieldset>
        </div>
        <label className="creator-onboarding-consent">
          <input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} />
          <span>I agree to the <Link to="/space-rules">{brand.rulesName}</Link>, including the content restrictions for hosted {brand.workspacePlural}.</span>
        </label>
        <div className="creator-onboarding-actions">
          <button type="button" className="auth-primary-btn" disabled={!name.trim() || !resolvedSlug || !accepted || loading} onClick={() => void becomeCreator()}>{loading ? 'Creating Creator...' : <>Become a Creator <span aria-hidden="true">→</span></>}</button>
          <Link className="auth-secondary-btn" to="/for-creators">Explore creator tools</Link>
        </div>
        {error && <p className="error">{error}</p>}
      </Card>

      <Card title={`Your ${brand.workspaceFullName}, your choice`} eyebrow={`How ${brand.productName} works`}>
        <div className="creator-onboarding-side-list">
          <div><small>No approval needed</small><strong>Become a Creator</strong><span>Every {brand.memberName} can create a creator identity. It’s not an application or approval process.</span></div>
          <div><small>Public + private</small><strong>Your {brand.workspaceName}</strong><span>Each creator identity includes a public home and Studio you can shape at your own pace.</span></div>
          <div><small>Bring your own infra</small><strong>Run it yourself</strong><span>Need a different policy or infrastructure? Review the <Link to="/self-hosting">self-hosting deployment guide</Link>.</span></div>
        </div>
      </Card>
    </section>
  );
}

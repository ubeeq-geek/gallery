import { Link } from 'react-router-dom';
import { brand } from '../brand';

export function LandingPage() {
  const hosted = brand.id === 'eversally';
  return <main className={`product-landing product-landing-${brand.id}`}>
    <section className="product-landing-hero">
      <p className="auth-eyebrow">{hosted ? 'A home for creative work' : 'Open source creative infrastructure'}</p>
      <h1>{hosted ? 'Your work deserves a home that stays yours.' : 'Own the place where your creative work lives.'}</h1>
      <p>{hosted
        ? 'Eversally gives creators a public Space, portable catalogue, and calm control over where every Work is shared.'
        : 'Ubeeq is the open-source foundation for creator-owned Spaces, publishing, and portable content.'}</p>
      <div className="product-landing-actions">
        <Link className="auth-primary-btn no-underline" to="/auth/signup">{hosted ? 'Create your Space' : 'Explore Ubeeq'}</Link>
        <Link className="auth-secondary-btn no-underline" to="/discover">Discover creators</Link>
      </div>
    </section>
    <section className="product-landing-grid" aria-label="Product principles">
      <article><strong>One canonical catalogue</strong><span>Create, import, organize, and keep a durable record of your work.</span></article>
      <article><strong>Publish intentionally</strong><span>Your Space, DeviantArt, Bluesky, and future destinations stay independent.</span></article>
      <article><strong>Portable by design</strong><span>Download a Ubeeq-compatible export whenever you need it.</span></article>
    </section>
    <section className="product-landing-footer">
      <span>{hosted ? 'Eversally is managed hosting, powered by Ubeeq.' : 'Ubeeq is open source. Eversally is an optional managed host.'}</span>
      <Link to="/for-creators">For creators</Link>
      <Link to="/self-hosting">Self-hosting</Link>
    </section>
  </main>;
}

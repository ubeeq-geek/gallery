import { Link } from 'react-router-dom';

export function ForCreatorsPage() {
  return (
    <div className="container py-10 space-y-8">
      <header className="space-y-3">
        <p className="text-sm uppercase tracking-wide text-slate-400">For Creators</p>
        <h1 className="text-3xl font-semibold">Creator invitations at Ubeeq</h1>
        <p className="text-slate-300 max-w-3xl">
          Ubeeq is currently invite-only for Creators while we refine publishing and hosting tools.
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="text-xl font-medium">How invitations happen</h2>
        <p className="text-slate-300 max-w-3xl">
          We invite a small number of creators we know and love, and we also get to know new work through
          challenges and curated participation.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-medium">Best way to be seen</h2>
        <p className="text-slate-300 max-w-3xl">
          If you&rsquo;d like us to get to know your work, participating in a challenge is a great way to start.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-medium">What to expect</h2>
        <p className="text-slate-300 max-w-3xl">
          Challenges are open to participate in for their own sake. Creator access is a possible outcome,
          not the purpose.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-medium">Get involved</h2>
        <div className="flex flex-wrap gap-3">
          <Link to="/trending" className="btn btn-primary">View active challenges</Link>
          <Link to="/auth/register" className="btn btn-secondary">Subscribe for announcements</Link>
        </div>
      </section>
    </div>
  );
}

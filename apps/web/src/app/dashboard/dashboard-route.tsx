export function DashboardRoute({
  description,
  title,
}: {
  readonly description: string;
  readonly title: string;
}) {
  return (
    <header className="dashboard-header">
      <div>
        <p className="section-kicker">Personal Account</p>
        <h1>{title}</h1>
        <p className="dashboard-subtitle">{description}</p>
      </div>
    </header>
  );
}
